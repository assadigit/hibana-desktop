package sync

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"hibana/desktop/internal/api"
	"hibana/desktop/internal/store"
)

// syncFake is the httptest Worker for the engine + drain tests: it enforces
// the T6 origin gate, tracks hits per path, and returns scriptable statuses.
type syncFake struct {
	mu       chan struct{} // serialized map access via single-slot chan? simpler: no concurrency here
	statuses map[string]int
	bodies   map[string]string
	hits     map[string]int
	session  bool
}

func newSyncFake() *syncFake {
	return &syncFake{
		statuses: map[string]int{},
		bodies:   map[string]string{},
		hits:     map[string]int{},
	}
}

func (f *syncFake) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/auth/login", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Set-Cookie", api.SessionCookie+"=tok; Path=/; Secure; HttpOnly")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc("/api/auth/me", func(w http.ResponseWriter, r *http.Request) {
		if !f.session {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
			return
		}
		_, _ = w.Write([]byte(`{"user":{"id":"u1"}}`))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		f.hits[r.URL.Path]++
		// The T6 gate: headerless writes are 403'd (app.ts:189-192).
		switch r.Method {
		case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
			if r.Header.Get("Origin") == "" && r.Header.Get("Referer") == "" {
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"error":"forbidden"}`))
				return
			}
		}
		if code, ok := f.statuses[r.URL.Path]; ok {
			w.WriteHeader(code)
			_, _ = w.Write([]byte(fmt.Sprintf(`{"error":"code%d"}`, code)))
			return
		}
		if body, ok := f.bodies[r.URL.Path]; ok {
			_, _ = w.Write([]byte(body))
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	return mux
}

func newEngine(t *testing.T, f *syncFake) (*Engine, *store.Store, func()) {
	t.Helper()
	srv := httptest.NewServer(f.handler())
	c, err := api.New(srv.URL)
	if err != nil {
		t.Fatalf("api.New: %v", err)
	}
	dbPath := filepath.Join(t.TempDir(), "mirror.db")
	s, err := store.Open(dbPath)
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	if err := c.Login(context.Background(), "u", "p"); err != nil {
		t.Fatalf("login: %v", err)
	}
	f.session = true
	return New(c, s), s, func() {
		s.Close()
		srv.Close()
	}
}

const testBoard = `{
 "project":{"id":"p1","title":"T","status":"operational","type":"personal"},
 "tasks":[{"id":"t1","project_id":"p1","title":"hello","status":"idea","priority":"high","category_id":null,"sprint_id":null,"sort_order":0,"created_at":"2026-01-01T00:00:00.000Z","done_at":null,"start_at":null,"end_at":null,"search_tags":"","updated_at":"2026-01-02T00:00:00.000Z","tags":["g1"],"shot_count":1}],
 "categories":[],
 "sprints":[],
 "tags":[{"id":"g1","user_id":"u1","name":"green","color":"#0f0","usage_count":1,"created_at":"2026-01-01T00:00:00.000Z"}],
 "task_tags":[{"task_id":"t1","id":"g1","name":"green","color":"#0f0"}]
}`

func TestPullMirrorsBoardAndEtagSkip(t *testing.T) {
	f := newSyncFake()
	f.bodies["/api/projects/p1/devboard"] = testBoard
	// The httptest server does not emit ETags; emulate one via a wrapper.
	f.bodies["/api/projects"] = `{"projects":[]}`
	eng, st, done := newEngine(t, f)
	defer done()
	ctx := context.Background()

	pulled, err := eng.Pull(ctx, "p1")
	if err != nil || !pulled {
		t.Fatalf("first pull: pulled=%v err=%v", pulled, err)
	}
	cards, err := st.BoardTasksWithTags(ctx, "p1")
	if err != nil || len(cards) != 1 {
		t.Fatalf("mirror after pull: %v %+v", err, cards)
	}
	if cards[0].Title != "hello" || len(cards[0].Tags) != 1 || cards[0].Tags[0].Name != "green" {
		t.Fatalf("card shape wrong: %+v", cards[0])
	}
	// The payload's shot_count is display-only; the MIRROR recomputes the pin
	// badge from mirrored screenshots metadata (the board payload carries no
	// screenshot rows — the M4 media pipeline mirrors them). Seed one pinned
	// shot and the badge count must derive from the local table.
	taskID := "t1"
	if err := st.UpsertScreenshot(ctx, store.Shot{ID: "s1", ProjectID: "p1", GitHubPath: "p", MimeType: "image/png", CreatedAt: "2026-01-01T00:00:00.000Z", TaskID: &taskID, Bytes: 10}); err != nil {
		t.Fatalf("seed shot: %v", err)
	}
	cards, _ = st.BoardTasksWithTags(ctx, "p1")
	if cards[0].ShotCount != 1 {
		t.Fatalf("mirror shot badge must derive from mirrored screenshots: %+v", cards[0])
	}

	// Second pull without a server ETag: full 200 again (still mirrors fine).
	if _, err := eng.Pull(ctx, "p1"); err != nil {
		t.Fatalf("second pull: %v", err)
	}
}

func TestPullGone(t *testing.T) {
	f := newSyncFake()
	f.statuses["/api/projects/p1/devboard"] = http.StatusNotFound
	eng, _, done := newEngine(t, f)
	defer done()
	_, err := eng.Pull(context.Background(), "p1")
	if err != ErrProjectGone {
		t.Fatalf("want ErrProjectGone, got %v", err)
	}
}

func enqueue(t *testing.T, s *store.Store, op, entity, id, payload string) {
	t.Helper()
	if err := s.Enqueue(context.Background(), op, entity, id, payload, ""); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
}

func TestDrainHappyPathDrops(t *testing.T) {
	f := newSyncFake()
	eng, st, done := newEngine(t, f)
	defer done()
	enqueue(t, st, "PATCH", "devtask.patch", "t1", `{"title":"x"}`)
	res, err := eng.Drain(context.Background())
	if err != nil {
		t.Fatalf("drain: %v", err)
	}
	if res.Done != 1 || res.Dropped != 0 || res.Held != 0 {
		t.Fatalf("want 1 done, got %+v", res)
	}
	if n, _ := st.OutboxLen(context.Background()); n != 0 {
		t.Fatalf("queue should be empty, has %d", n)
	}
}

func TestDrainStatusTable(t *testing.T) {
	cases := []struct {
		name     string
		status   int
		wantD    int // dropped
		wantH    int // held
		wantStop bool
	}{
		{"404 gone drops", http.StatusNotFound, 1, 0, false},
		{"409 conflict drops", http.StatusConflict, 1, 0, false},
		{"429 keeps + stops", http.StatusTooManyRequests, 0, 1, true},
		{"403 ban keeps + stops", http.StatusForbidden, 0, 1, true},
		{"500 retries later (held)", http.StatusInternalServerError, 0, 1, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newSyncFake()
			f.statuses["/api/devtasks/t1"] = tc.status
			eng, st, done := newEngine(t, f)
			defer done()
			enqueue(t, st, "PATCH", "devtask.patch", "t1", `{"title":"x"}`)
			res, err := eng.Drain(context.Background())
			if err != nil {
				t.Fatalf("drain: %v", err)
			}
			if res.Done != 0 || res.Dropped != tc.wantD || res.Held != tc.wantH || res.Stopped != tc.wantStop {
				t.Fatalf("table %d: want (d=%d h=%d stop=%v), got %+v", tc.status, tc.wantD, tc.wantH, tc.wantStop, res)
			}
			// Held entries survive for the next round:
			if tc.wantH > 0 {
				if n, _ := st.OutboxLen(context.Background()); n != tc.wantH {
					t.Fatalf("held entry should survive, queue=%d", n)
				}
			}
		})
	}
}

func TestDrainDeadLetterAfterFive(t *testing.T) {
	f := newSyncFake()
	f.statuses["/api/devtasks/t1"] = http.StatusInternalServerError
	eng, st, done := newEngine(t, f)
	defer done()
	enqueue(t, st, "PATCH", "devtask.patch", "t1", `{"title":"x"}`)
	ctx := context.Background()
	// "5xx retry ≤5 then dead-letter": rounds 1-4 hold the entry (attempts
	// 1-4); the FIFTH round's failure hits the Dead() verdict (attempts=5)
	// and drops it — the queue never sees a sixth round.
	for i := 1; i <= store.OutboxMaxAttempts-1; i++ {
		res, err := eng.Drain(ctx)
		if err != nil {
			t.Fatalf("drain %d: %v", i, err)
		}
		if res.Held != 1 || res.Dropped != 0 {
			t.Fatalf("round %d should hold, got %+v", i, res)
		}
	}
	res, err := eng.Drain(ctx)
	if err != nil {
		t.Fatalf("final drain: %v", err)
	}
	if res.Dropped != 1 {
		t.Fatalf("want dead-letter drop on round %d, got %+v", store.OutboxMaxAttempts, res)
	}
	if n, _ := st.OutboxLen(ctx); n != 0 {
		t.Fatalf("dead-lettered entry must leave the queue, has %d", n)
	}
	// A sixth round on the empty queue is a clean no-op.
	res, err = eng.Drain(ctx)
	if err != nil || res.Dropped != 0 || res.Held != 0 {
		t.Fatalf("empty-queue drain should no-op: %v %+v", err, res)
	}
}

func TestDrain401ReloginRetriesOnce(t *testing.T) {
	f := newSyncFake()
	f.statuses["/api/devtasks/t1"] = http.StatusUnauthorized
	eng, st, done := newEngine(t, f)
	defer done()
	reloginCalls := 0
	eng.SetRelogin(func(ctx context.Context) error {
		reloginCalls++
		return nil
	})
	enqueue(t, st, "PATCH", "devtask.patch", "t1", `{"title":"x"}`)
	res, err := eng.Drain(context.Background())
	if err != nil {
		t.Fatalf("drain: %v", err)
	}
	// The retry ALSO 401s (the fake keeps returning 401) → hold + stop, entry survives.
	if res.Done != 0 || res.Held != 1 || !res.Stopped {
		t.Fatalf("want held-after-retry, got %+v", res)
	}
	if reloginCalls != 1 {
		t.Fatalf("relogin must fire exactly once, fired %d", reloginCalls)
	}
	if n, _ := st.OutboxLen(context.Background()); n != 1 {
		t.Fatalf("401 entry must survive (never drop), queue=%d", n)
	}
}

func TestDrainUnknownEntityDeadLetters(t *testing.T) {
	f := newSyncFake()
	eng, st, done := newEngine(t, f)
	defer done()
	enqueue(t, st, "PATCH", "bogus.entity", "x", `{}`)
	res, err := eng.Drain(context.Background())
	if err != nil {
		t.Fatalf("drain: %v", err)
	}
	if res.Dropped != 1 || res.Stopped {
		t.Fatalf("unknown entity should dead-letter + continue, got %+v", res)
	}
}

func TestSyncOnceCollectsErrorsPerBoard(t *testing.T) {
	f := newSyncFake()
	f.bodies["/api/projects"] = `{"projects":[{"id":"p1","user_id":"u1","title":"A","status":"operational","type":"personal","sort_order":0,"latest_note":"","reminders_enabled":0,"created_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-01T00:00:00.000Z","tags":[]},{"id":"p2","user_id":"u1","title":"B","status":"operational","type":"personal","sort_order":0,"latest_note":"","reminders_enabled":0,"created_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-01T00:00:00.000Z","tags":[]}]}`
	f.bodies["/api/projects/p1/devboard"] = testBoard
	f.statuses["/api/projects/p2/devboard"] = http.StatusNotFound
	eng, _, done := newEngine(t, f)
	defer done()
	pulled, errs := eng.SyncOnce(context.Background())
	if pulled != 1 || len(errs) != 0 {
		t.Fatalf("pulled=%d errs=%v — p2's 404 is the GONE branch, not an error", pulled, errs)
	}
	// Second SyncOnce: p1 re-pulls (200 again), p2 gone again — still no errs.
	if _, errs := eng.SyncOnce(context.Background()); len(errs) != 0 {
		t.Fatalf("second sync errs=%v", errs)
	}
}

// TestSyncOnceTombstonesGoneProjects — the v0.1.12 refresh-round lesson: a
// project deleted on hibana.ir vanishes from the server list and its board
// answers 404; the mirror row must STOP counting as live (the sync modal's
// success line tells the truth) and STOP being re-polled every round. The
// list pull owns resurrection: a fresh server row clears the tombstone via
// the upsert, and the board pulls again.
func TestSyncOnceTombstonesGoneProjects(t *testing.T) {
	f := newSyncFake()
	withP1 := `{"projects":[{"id":"p1","user_id":"u1","title":"A","status":"operational","type":"personal","sort_order":0,"latest_note":"","reminders_enabled":0,"created_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-01T00:00:00.000Z","tags":[]}]}`
	emptyList := `{"projects":[]}`
	f.bodies["/api/projects"] = withP1
	f.bodies["/api/projects/p1/devboard"] = testBoard
	eng, st, done := newEngine(t, f)
	defer done()
	ctx := context.Background()

	// Round 1: the list carries p1, the board mirrors.
	if _, errs := eng.SyncOnce(ctx); len(errs) != 0 {
		t.Fatalf("seed round errs=%v", errs)
	}
	if f.hits["/api/projects/p1/devboard"] == 0 {
		t.Fatal("the seed round must have pulled p1's board")
	}

	// The user deletes the project on the web: the list drops it, the board
	// answers the gone state (404).
	f.bodies["/api/projects"] = emptyList
	delete(f.bodies, "/api/projects/p1/devboard")
	f.statuses["/api/projects/p1/devboard"] = http.StatusNotFound
	if _, errs := eng.SyncOnce(ctx); len(errs) != 0 {
		t.Fatalf("gone round errs=%v (the 404 is the gone branch, never an error)", errs)
	}
	projects, err := st.ListProjects(ctx)
	if err != nil || len(projects) != 1 {
		t.Fatalf("mirror projects after the gone round: %v %+v", err, projects)
	}
	if projects[0].ID != "p1" || projects[0].DeletedAt == nil {
		t.Fatalf("the web-deleted project must be tombstoned in the mirror: %+v", projects[0])
	}

	// Round 3: the tombstoned row is skipped — the dead board is NOT re-polled.
	before := f.hits["/api/projects/p1/devboard"]
	if _, errs := eng.SyncOnce(ctx); len(errs) != 0 {
		t.Fatalf("post-tombstone round errs=%v", errs)
	}
	if f.hits["/api/projects/p1/devboard"] != before {
		t.Fatalf("a tombstoned row must not be re-polled: hits %d → %d", before, f.hits["/api/projects/p1/devboard"])
	}

	// Resurrection: the project is live again — the list carries it, the
	// upsert clears the tombstone, and the board re-mirrors (pulled=1).
	f.bodies["/api/projects"] = withP1
	f.bodies["/api/projects/p1/devboard"] = testBoard
	delete(f.statuses, "/api/projects/p1/devboard")
	pulled, errs := eng.SyncOnce(ctx)
	if len(errs) != 0 {
		t.Fatalf("resurrection round errs=%v", errs)
	}
	if pulled != 1 {
		t.Fatalf("the resurrected board must re-mirror: pulled=%d", pulled)
	}
	projects, err = st.ListProjects(ctx)
	if err != nil || len(projects) != 1 {
		t.Fatalf("mirror projects after resurrection: %v %+v", err, projects)
	}
	if projects[0].DeletedAt != nil {
		t.Fatalf("a fresh list row must clear the tombstone: %+v", projects[0])
	}
}

func TestRefreshProjectsMirrorsFullRows(t *testing.T) {
	f := newSyncFake()
	f.bodies["/api/projects"] = `{"projects":[{"id":"p1","user_id":"u1","title":"SportSignal","description":"d","type":"personal","status":"operational","sort_order":0,"latest_note":"note","reminders_enabled":0,"created_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-02T00:00:00.000Z","logo_path":"x.webp","tags":["a"]},{"id":"gone","user_id":"u1","title":"Old","type":"personal","status":"spark","sort_order":0,"latest_note":"","reminders_enabled":0,"created_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-01T00:00:00.000Z","deleted_at":"2026-01-03T00:00:00.000Z","tags":[]}]}`
	eng, st, done := newEngine(t, f)
	defer done()
	n, err := eng.RefreshProjects(context.Background())
	if err != nil || n != 2 {
		t.Fatalf("refresh: n=%d err=%v", n, err)
	}
	projects, err := st.ListProjects(context.Background())
	if err != nil || len(projects) != 2 {
		t.Fatalf("mirror projects: %v %+v", err, projects)
	}
	var got *store.Project
	for i := range projects {
		if projects[i].ID == "p1" {
			got = &projects[i]
		}
	}
	if got == nil || got.LogoPath == nil || *got.LogoPath != "x.webp" || got.LatestNote != "note" {
		t.Fatalf("full row not mirrored: %+v", got)
	}
	// The board pull AFTER the list pull must NOT clobber the full row.
	f.bodies["/api/projects/p1/devboard"] = testBoard
	if _, err := eng.Pull(context.Background(), "p1"); err != nil {
		t.Fatalf("pull after refresh: %v", err)
	}
	projects, _ = st.ListProjects(context.Background())
	for i := range projects {
		if projects[i].ID == "p1" {
			if projects[i].LatestNote != "note" || projects[i].LogoPath == nil {
				t.Fatalf("board pull clobbered the full project row: %+v", projects[i])
			}
		}
	}
}

// TestPullEtagCheapPoll304 proves the §8 wire behavior through the engine: a
// server that DOES emit ETags yields a 304 on the second pull and the mirror
// is untouched (pulled=false).
func TestPullEtagCheapPoll304(t *testing.T) {
	f := newSyncFake()
	inner := f.handler()
	const etag = `W/"k1"`
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/projects/p1/devboard" {
			hits++
			if r.Header.Get("If-None-Match") == etag {
				w.Header().Set("ETag", etag)
				w.WriteHeader(http.StatusNotModified)
				return
			}
			w.Header().Set("ETag", etag)
			_, _ = w.Write([]byte(testBoard))
			return
		}
		inner.ServeHTTP(w, r)
	}))
	defer srv.Close()
	c, err := api.New(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Login(context.Background(), "u", "p"); err != nil {
		t.Fatal(err)
	}
	s, err := store.Open(filepath.Join(t.TempDir(), "m.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	eng := New(c, s)
	ctx := context.Background()
	if pulled, err := eng.Pull(ctx, "p1"); err != nil || !pulled {
		t.Fatalf("first pull: %v %v", pulled, err)
	}
	if pulled, err := eng.Pull(ctx, "p1"); err != nil || pulled {
		t.Fatalf("second pull must be the 304 skip: pulled=%v err=%v", pulled, err)
	}
	if hits != 2 {
		t.Fatalf("expected exactly 2 wire hits, got %d", hits)
	}
	// Restart simulation: a FRESH client + the persisted meta ETag still skips.
	c2, _ := api.New(srv.URL)
	if err := c2.Login(ctx, "u", "p"); err != nil {
		t.Fatal(err)
	}
	eng2 := New(c2, s)
	if pulled, err := eng2.Pull(ctx, "p1"); err != nil || pulled {
		t.Fatalf("post-restart pull must re-skip via the persisted ETag: %v %v", pulled, err)
	}
	if hits != 3 {
		t.Fatalf("restart pull is one validator-check hit, total 3, got %d", hits)
	}
}

func TestBoardPayloadDecodesRealShape(t *testing.T) {
	// A shape guard: decode a payload with every task field set + nulls mixed,
	// then re-marshal through the converter — the round-trip must not lose the
	// nullables (category_id/sprint_id/done_at/updated_at).
	raw := strings.ReplaceAll(testBoard, `"category_id":null`, `"category_id":"c9"`)
	var bp api.BoardPayload
	if err := json.Unmarshal([]byte(raw), &bp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	p, tasks, _, _, _, joins, _ := boardToStore(&bp, "")
	if p.ID != "p1" || tasks[0].CategoryID == nil || *tasks[0].CategoryID != "c9" {
		t.Fatalf("converter lost fields: %+v %+v", p, tasks[0])
	}
	if len(joins) != 1 || joins[0].TagID != "g1" {
		t.Fatalf("joins lost: %+v", joins)
	}
}

func TestMain(m *testing.M) {
	// Silence unused-package lints on os in some build configs.
	_ = os.Getenv
	os.Exit(m.Run())
}
