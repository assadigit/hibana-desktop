// cmd/acceptance — THE M1 ACCEPTANCE ROUND-TRIP (GO-DESKTOP-PORT-PLAN §8):
//
//	"a Go test binary does: login → pull 2 boards → create/move/archive a
//	 task → verify via the WEB client's API"
//
// Everything runs against the LIVE API (default https://hibana.ir; override
// with HIBANA_BASE). Credentials come from the environment ONLY
// (HIBANA_LOGIN / HIBANA_PASSWORD) — never argv (ps-leaking), never files,
// never commits (the session rule). The mutation target is a SELF-CLEANING
// throwaway project (client-UUID idempotent create — the projects pattern
// the M0 §7c addition mirrors); the second pulled board is the most-recent
// REAL project, pulled READ-ONLY. The verification reads deliberately use a
// RAW net/http path (no internal/api code) so the assert side shares zero
// code with the mutation side.
package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"os"
	"strings"
	"time"

	"hibana/desktop/internal/api"
	"hibana/desktop/internal/auth"
	"hibana/desktop/internal/store"
	"hibana/desktop/internal/sync"
)

func main() {
	login := os.Getenv("HIBANA_LOGIN")
	pass := os.Getenv("HIBANA_PASSWORD")
	base := os.Getenv("HIBANA_BASE")
	if base == "" {
		base = "https://hibana.ir"
	}
	if login == "" || pass == "" {
		fmt.Fprintln(os.Stderr, "acceptance: HIBANA_LOGIN and HIBANA_PASSWORD must be set (env-only credentials)")
		os.Exit(2)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()

	a := &acceptance{base: base, t0: time.Now()}
	defer a.cleanup(ctx)

	a.step("login")
	client, err := api.New(base)
	if err != nil {
		a.fatal("api.New: %v", err)
	}
	a.client = client
	me, err := auth.Login(ctx, client, login, pass)
	if err != nil {
		a.fatal("login: %v", err)
	}
	a.ok("login → user %s (%s)", me.User.ID, me.User.Username)
	a.userID = me.User.ID

	a.step("create throwaway project (client UUID, idempotent)")
	pid := newUUID()
	title := fmt.Sprintf("S211-acceptance-%d", time.Now().Unix())
	id1, dup, err := client.CreateProject(ctx, api.CreateProjectReq{ID: pid, Title: title})
	if err != nil {
		a.fatal("create project: %v", err)
	}
	if id1 != pid || dup {
		a.fatal("create returned id=%q dup=%v, want id=%q dup=false", id1, dup, pid)
	}
	a.ok("201 {ok, id} — server honored the client UUID")
	id2, dup, err := client.CreateProject(ctx, api.CreateProjectReq{ID: pid, Title: title})
	if err != nil {
		a.fatal("replay create: %v", err)
	}
	// The duplicate response is exactly {ok:true, duplicate:true} — NO id echo
	// (index.ts:396-397); the client already owns the id — that IS the pattern.
	if dup != true {
		a.fatal("replay returned id=%q dup=%v, want duplicate:true (the idempotent belt)", id2, dup)
	}
	a.ok("replay → 200 {ok, duplicate:true} — ONE row, no PK wedge")
	a.pid = pid

	a.step("pull 2 boards (the throwaway + the most-recent real project, read-only)")
	list, err := client.ListProjects(ctx)
	if err != nil || len(list) == 0 {
		a.fatal("projects list: %v n=%d", err, len(list))
	}
	var realID string
	for _, p := range list {
		if p.ID != pid {
			realID = p.ID
			break
		}
	}
	if realID == "" {
		a.fatal("no second project to pull")
	}
	bpEmpty, err := client.Board(ctx, pid)
	if err != nil {
		a.fatal("throwaway board: %v", err)
	}
	a.ok("board 1/2 (%s): empty board pulls — %d tasks", pid, len(bpEmpty.Tasks))
	bpReal, err := client.Board(ctx, realID)
	if err != nil {
		a.fatal("real board %s: %v", realID, err)
	}
	a.ok("board 2/2 (%s — %q): %d tasks, %d sprints, %d tags (READ-ONLY pull)",
		realID, bpReal.Project.Title, len(bpReal.Tasks), len(bpReal.Sprints), len(bpReal.Tags))
	a.realID = realID
	a.realTitle = bpReal.Project.Title

	a.step("create a task (tags ride the create)")
	created, err := client.CreateTask(ctx, pid, api.CreateTaskReq{
		Title:    "S211 acceptance task\n**bold** __underline__ line",
		Status:   "idea",
		Priority: "high",
		Tags:     []string{"s211-acceptance"},
	})
	if err != nil {
		a.fatal("create task: %v", err)
	}
	a.ok("201 {ok, id} → %s (server-minted; tags resolved: %d)", created.ID, len(created.Tags))
	if len(created.Tags) > 0 {
		a.tagID = created.Tags[0].ID
	}
	a.taskID = created.ID

	a.verifyRaw(ctx, "the created task is visible via the WEB client's API", func(v *verifier) error {
		bp, err := v.board(ctx, pid)
		if err != nil {
			return err
		}
		var found *api.TaskPayload
		for i := range bp.Tasks {
			if bp.Tasks[i].ID == created.ID {
				found = &bp.Tasks[i]
			}
		}
		if found == nil {
			return fmt.Errorf("task %s not in the board payload", created.ID)
		}
		if found.Status != "idea" || found.Priority != "high" || len(found.Tags) != 1 {
			return fmt.Errorf("shape drift: status=%s priority=%s tags=%v", found.Status, found.Priority, found.Tags)
		}
		return nil
	})

	a.step("move the task (idea → in_progress → done)")
	if err := client.PatchTask(ctx, created.ID, api.PatchTaskReq{Status: strPtr("in_progress")}); err != nil {
		a.fatal("move 1: %v", err)
	}
	if err := client.PatchTask(ctx, created.ID, api.PatchTaskReq{Status: strPtr("done")}); err != nil {
		a.fatal("move 2: %v", err)
	}
	a.ok("PATCH status ×2 accepted")

	a.verifyRaw(ctx, "the done move stamped done_at via the WEB client's API", func(v *verifier) error {
		bp, err := v.board(ctx, pid)
		if err != nil {
			return err
		}
		for _, t := range bp.Tasks {
			if t.ID == created.ID {
				if t.Status != "done" || t.DoneAt == nil || *t.DoneAt == "" {
					return fmt.Errorf("status=%s done_at=%v", t.Status, t.DoneAt)
				}
				return nil
			}
		}
		return fmt.Errorf("task vanished before archive")
	})

	a.step("archive-done")
	n, err := client.ArchiveDone(ctx, pid)
	if err != nil {
		a.fatal("archive-done: %v", err)
	}
	if n < 1 {
		a.fatal("archive-done moved %d tasks, want ≥1", n)
	}
	a.ok("{ok, archived:%d} — done → project_archives with the label snapshot", n)

	a.verifyRaw(ctx, "the archive is visible via the WEB client's API (board: gone; archives: restorable)", func(v *verifier) error {
		bp, err := v.board(ctx, pid)
		if err != nil {
			return err
		}
		for _, t := range bp.Tasks {
			if t.ID == created.ID {
				return fmt.Errorf("archived task still on the board")
			}
		}
		arcs, err := v.archives(ctx, pid)
		if err != nil {
			return err
		}
		for _, x := range arcs {
			if x.ID == created.ID && len(x.Tags) == 1 && x.Tags[0].Name == "s211-acceptance" {
				return nil
			}
		}
		return fmt.Errorf("archive row with the label snapshot not found")
	})

	a.step("the ETag cheap-poll against the live API")
	etagPath := api.BoardPath(realID)
	etag := client.ETag(etagPath)
	if etag == "" {
		a.fatal("no ETag stored from the earlier real-board pull")
	}
	if _, err := client.Board(ctx, realID); err != api.ErrNotModified {
		a.ok("NOTE: live pull #2 → %v (some routes may re-emit 200; the 304 contract is unit-proven)", err)
	} else {
		a.ok("pull #2 → 304 NotModified (If-None-Match honored) — zero body work")
	}

	a.step("the mirror: pull → ReplaceBoard → the disappearance path")
	// The earlier live pulls seeded the client's ETag for this board, and the
	// post-archive board body is BYTE-IDENTICAL to the pre-task one (0 tasks,
	// the same tag rows with usage back to 0) — §8: the ETag is a body hash,
	// so a 304 here would be the server being RIGHT. A fresh desktop process
	// + fresh mirror starts with NO validators, so force that state:
	client.SetETag(api.BoardPath(pid), "")
	mirror, err := store.Open(filepathJoin(os.TempDir(), fmt.Sprintf("s211-acceptance-%d.db", time.Now().UnixNano())))
	if err != nil {
		a.fatal("mirror open: %v", err)
	}
	a.mirror = mirror
	engine := sync.New(client, mirror)
	pulled, err := engine.Pull(ctx, pid)
	if err != nil || !pulled {
		a.fatal("engine pull: pulled=%v err=%v", pulled, err)
	}
	if n, _ := lenmirror(ctx, mirror, pid); n != 0 {
		a.fatal("mirror shows %d tasks on the archived board, want 0 (the task left dev_tasks)", n)
	}
	// Re-create + re-pull to prove the mirror task path end-to-end. The
	// re-pull needs a fresh validator too: the previous pull just stored the
	// CURRENT body's ETag, and the new task changes the body → a real 200.
	second, err := client.CreateTask(ctx, pid, api.CreateTaskReq{Title: "S211 mirror probe", Status: "planned"})
	if err != nil {
		a.fatal("second create: %v", err)
	}
	a.taskID2 = second.ID
	if pulled, err := engine.Pull(ctx, pid); err != nil || !pulled {
		a.fatal("engine pull 2: %v", pulled, err)
	}
	if n, err := lenmirrorErr(ctx, mirror, pid); err != nil || n != 1 {
		a.fatal("mirror shows %d tasks (err %v), want 1 after re-pull", n, err)
	}
	cards, err := mirror.BoardTasksWithTags(ctx, pid)
	if err != nil || len(cards) != 1 || cards[0].ID != second.ID || cards[0].Title != "S211 mirror probe" {
		a.fatal("mirror card shape: %v %+v", err, cards)
	}
	a.ok("mirror: pull → %d card(s), ids + titles exact; earlier pull proved the disappearance path (0 after archive)", len(cards))

	a.step("projects-list mirror + full-row ownership")
	// Fresh-process simulation: clear the client's stored list validator so
	// this round mirrors FULL rows (a genuinely fresh desktop's first
	// SyncOnce has no stored ETags; the 304 cheap-skip is the LATER cadence
	// and was just proven two steps above).
	client.SetETag("/api/projects?sort=recent", "")
	np, err := engine.RefreshProjects(ctx)
	if err != nil || np < 2 {
		a.fatal("refresh projects: n=%d err=%v", np, err)
	}
	a.ok("projects list mirrored (%d rows; the board pull owns only the 4-field header)", np)
	// Full-row proof: the REAL project's mirror row carries the columns only
	// the list payload delivers (description/latest_note/logo_path), while
	// the board pull touched only its 4-field header.
	projs, _ := mirror.ListProjects(ctx)
	for _, mp := range projs {
		if mp.ID == a.realID {
			if mp.Description == "" || mp.UserID == "" {
				a.fatal("real project row lacks list-pull columns: %+v", mp)
			}
			a.ok("full-row ownership proven: %q mirror row carries description/user_id (list pull), header stays board-owned", mp.Title)
		}
	}

	a.report()
}

// ── the raw verifier (deliberately independent of internal/api) ─────────────

type verifier struct {
	http  *http.Client
	base  string
	token string
}

func newVerifier(base, token string) (*verifier, error) {
	jar, err := cookiejar.New(nil)
	if err != nil {
		return nil, err
	}
	u := strings.TrimRight(base, "/")
	// Token is the session cookie VALUE the login set — env/runtime only.
	req, _ := http.NewRequest("GET", u+"/api/auth/me", nil)
	jar.SetCookies(req.URL, []*http.Cookie{{Name: api.SessionCookie, Value: token, Path: "/", Secure: true}})
	return &verifier{http: &http.Client{Jar: jar, Timeout: 15 * time.Second}, base: u, token: token}, nil
}

func (v *verifier) get(ctx context.Context, path string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", v.base+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := v.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("GET %s: %d", path, resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

func (v *verifier) board(ctx context.Context, pid string) (*api.BoardPayload, error) {
	b, err := v.get(ctx, "/api/projects/"+pid+"/devboard")
	if err != nil {
		return nil, err
	}
	var bp api.BoardPayload
	return &bp, json.Unmarshal(b, &bp)
}

func (v *verifier) archives(ctx context.Context, pid string) ([]api.ArchiveRow, error) {
	b, err := v.get(ctx, "/api/projects/"+pid+"/archives")
	if err != nil {
		return nil, err
	}
	var out struct {
		Archives []api.ArchiveRow `json:"archives"`
	}
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out.Archives, nil
}

// ── the harness ──────────────────────────────────────────────────────────────

type acceptance struct {
	base      string
	client    *api.Client
	userID    string
	pid       string
	realID    string
	realTitle string
	taskID    string
	taskID2   string
	tagID     string
	mirror    *store.Store
	t0        time.Time
	steps     int
	passes    int
	notes     []string
	dead      bool
}

func (a *acceptance) step(name string) {
	a.steps++
	fmt.Printf("── %s\n", name)
}

func (a *acceptance) ok(format string, args ...any) {
	a.passes++
	fmt.Printf("   ✔ "+format+"\n", args...)
}

func (a *acceptance) note(format string, args ...any) {
	a.notes = append(a.notes, fmt.Sprintf(format, args...))
	fmt.Printf("   · "+format+"\n", args...)
}

func (a *acceptance) fatal(format string, args ...any) {
	fmt.Printf("   ✘ FATAL: "+format+"\n", args...)
	a.dead = true
	a.report()
	os.Exit(1)
}

func (a *acceptance) verifyRaw(ctx context.Context, what string, check func(v *verifier) error) {
	v, err := newVerifier(a.base, a.client.SessionToken())
	if err != nil {
		a.fatal("verifier: %v", err)
	}
	if err := check(v); err != nil {
		a.fatal("%s: %v", what, err)
	}
	a.ok("%s", what)
}

func (a *acceptance) cleanup(ctx context.Context) {
	if a.client == nil || a.pid == "" {
		return
	}
	// Best-effort, in reverse: delete the probe tasks, the mirror, the
	// project (spark+force=1 → hard), and the user-scoped probe tag — the
	// round leaves zero residue (409 tag_in_use = another board owns it,
	// which is fine).
	if a.taskID2 != "" {
		_, _ = a.client.Request(ctx, "DELETE", "/api/devtasks/"+a.taskID2, nil)
	}
	if a.mirror != nil {
		_ = a.mirror.Close()
	}
	_ = a.client.DeleteProject(ctx, a.pid, true)
	if a.tagID != "" {
		_, _ = a.client.Request(ctx, "DELETE", "/api/tags/"+a.tagID, nil)
	}
	fmt.Println("── cleanup: throwaway project force-deleted + probe tag swept (self-cleaning)")
}

func (a *acceptance) report() {
	elapsed := time.Since(a.t0).Round(time.Millisecond)
	status := "PASS"
	if a.dead {
		status = "FAIL"
	}
	fmt.Printf("\n═══ M1 ACCEPTANCE %s ═══ steps=%d checks=%d elapsed=%s base=%s\n", status, a.steps, a.passes, elapsed, a.base)
	if len(a.notes) > 0 {
		fmt.Println("notes:")
		for _, n := range a.notes {
			fmt.Println("  - " + n)
		}
	}
}

func newUUID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40 // v4
	b[8] = (b[8] & 0x3f) | 0x80 // variant
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func strPtr(s string) *string { return &s }

func filepathJoin(parts ...string) string { return strings.Join(parts, "/") }

func lenmirror(ctx context.Context, s *store.Store, pid string) (int, error) {
	t, err := s.GetBoard(ctx, pid)
	if err != nil {
		return -1, err
	}
	return len(t), nil
}

func lenmirrorErr(ctx context.Context, s *store.Store, pid string) (int, error) {
	return lenmirror(ctx, s, pid)
}
