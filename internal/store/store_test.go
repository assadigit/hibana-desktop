package store

import (
	"context"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

// openTestStore opens a throwaway mirror under t.TempDir() (guide rule: tests
// never touch a real profile dir).
func openTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "mirror.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Fatalf("Close: %v", err)
		}
	})
	return s
}

func ptr[T any](v T) *T { return &v }

func hasTaskID(ts []Task, id string) bool {
	for _, t := range ts {
		if t.ID == id {
			return true
		}
	}
	return false
}

func count(t *testing.T, s *Store, query string, args ...any) int {
	t.Helper()
	var n int
	if err := s.db.QueryRowContext(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatalf("count %q: %v", query, err)
	}
	return n
}

// 1. Migrations are idempotent: re-opening an existing mirror applies nothing
// twice, and data written before the reopen survives.
func TestMigrationsIdempotent(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "mirror.db")

	s1, err := Open(path)
	if err != nil {
		t.Fatalf("first Open: %v", err)
	}
	if err := s1.SetMeta(ctx, "pull_cursor", "2026-10-21T00:00:00.000Z"); err != nil {
		t.Fatalf("SetMeta before close: %v", err)
	}
	if err := s1.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}

	s2, err := Open(path) // same file: every version already applied
	if err != nil {
		t.Fatalf("second Open: %v", err)
	}
	defer s2.Close() //nolint:errcheck // test teardown

	var n, distinct int
	if err := s2.db.QueryRowContext(ctx,
		`SELECT COUNT(*), COUNT(DISTINCT version) FROM desktop_meta_migrations`).Scan(&n, &distinct); err != nil {
		t.Fatalf("read bookkeeping: %v", err)
	}
	if n != len(migrations) || distinct != len(migrations) {
		t.Fatalf("applied versions = %d (distinct %d), want %d — migrations must apply exactly once",
			n, distinct, len(migrations))
	}
	if v, ok, err := s2.GetMeta(ctx, "pull_cursor"); err != nil || !ok || v != "2026-10-21T00:00:00.000Z" {
		t.Fatalf("meta after reopen = (%q, %v, %v), want persisted cursor", v, ok, err)
	}
}

// 2. WAL mode + foreign_keys (and busy_timeout) are actually set on the
// connections the pool hands out.
func TestPragmas(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)

	var mode string
	if err := s.db.QueryRowContext(ctx, `PRAGMA journal_mode`).Scan(&mode); err != nil {
		t.Fatalf("PRAGMA journal_mode: %v", err)
	}
	if !strings.EqualFold(mode, "wal") {
		t.Fatalf("journal_mode = %q, want wal", mode)
	}

	var fk int
	if err := s.db.QueryRowContext(ctx, `PRAGMA foreign_keys`).Scan(&fk); err != nil {
		t.Fatalf("PRAGMA foreign_keys: %v", err)
	}
	if fk != 1 {
		t.Fatalf("foreign_keys = %d, want 1", fk)
	}

	var bt int
	if err := s.db.QueryRowContext(ctx, `PRAGMA busy_timeout`).Scan(&bt); err != nil {
		t.Fatalf("PRAGMA busy_timeout: %v", err)
	}
	if bt != 5000 {
		t.Fatalf("busy_timeout = %d, want 5000", bt)
	}
}

func boardFixture(projectID string) (Project, []Task, []Sprint, []Category, []Tag, []TaskTag, []CategoryRef) {
	p := Project{
		ID: projectID, UserID: "u1", Title: "Hibana", Description: "", Type: "personal",
		Status: "developing", SortOrder: 0, LatestNote: "",
		CreatedAt: "2026-10-20T00:00:00.000Z", UpdatedAt: "2026-10-21T00:00:00.000Z",
	}
	task := func(id, pri string, sort int64, created string) Task {
		return Task{
			ID: id, ProjectID: projectID, Title: strings.ToUpper(id), Status: "idea",
			Priority: pri, SortOrder: sort, CreatedAt: created, SearchTags: "",
		}
	}
	tasks := []Task{
		task("t-a", "low", 0, "2026-10-20T01:00:00.000Z"),
		task("t-b", "urgent", 5, "2026-10-20T02:00:00.000Z"),
		task("t-c", "medium", 0, "2026-10-20T03:00:00.000Z"),
	}
	sprints := []Sprint{{
		ID: "sp-1", ProjectID: projectID, Name: "Sprint 1",
		StartedAt: "2026-10-20T00:00:00.000Z", CreatedAt: "2026-10-20T00:00:00.000Z", IsDraft: 0,
	}}
	cats := []Category{{
		ID: "cat-1", UserID: "u1", Name: "Bug", ColorFill: "#333333", ColorText: "#ffffff",
		CreatedAt: "2026-10-20T00:00:00.000Z",
	}}
	tags := []Tag{{
		ID: "tag-1", UserID: "u1", Name: "urgent", Color: "#ff0000", UsageCount: 1,
		CreatedAt: "2026-10-20T00:00:00.000Z",
	}}
	taskTags := []TaskTag{{TaskID: "t-b", TagID: "tag-1"}}
	projCats := []CategoryRef{{ProjectID: projectID, CategoryID: "cat-1"}}
	return p, tasks, sprints, cats, tags, taskTags, projCats
}

// 3. ReplaceBoard round-trip: full replace, disappearance → 7-day grace,
// restore within the window, and grace purge past 7 days (old seen_missing_at
// injected directly).
func TestReplaceBoardDisappearanceAndGrace(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)
	const pid = "p1"
	p, tasks, sprints, cats, tags, taskTags, projCats := boardFixture(pid)

	// Full board: three tasks mirrored, board order is PRIO_ORDER (b, c, a).
	if err := s.ReplaceBoard(ctx, pid, p, tasks, sprints, cats, tags, taskTags, projCats); err != nil {
		t.Fatalf("ReplaceBoard full: %v", err)
	}
	board, err := s.GetBoard(ctx, pid)
	if err != nil {
		t.Fatalf("GetBoard: %v", err)
	}
	if len(board) != 3 {
		t.Fatalf("board = %d tasks, want 3", len(board))
	}
	want := []string{"t-b", "t-c", "t-a"}
	for i, id := range want {
		if board[i].ID != id {
			t.Fatalf("board order = [%s %s %s], want %v", board[0].ID, board[1].ID, board[2].ID, want)
		}
	}
	if n := count(t, s, `SELECT COUNT(*) FROM local_grace_tasks`); n != 0 {
		t.Fatalf("grace rows after full board = %d, want 0", n)
	}

	// Smaller pull: t-b vanished → moved to grace, absent from the board; its
	// dev_task_tags rows are gone too.
	rest := []Task{tasks[0], tasks[2]}
	if err := s.ReplaceBoard(ctx, pid, p, rest, sprints, cats, tags,
		[]TaskTag{{TaskID: "t-a", TagID: "tag-1"}}, projCats); err != nil {
		t.Fatalf("ReplaceBoard smaller: %v", err)
	}
	board, err = s.GetBoard(ctx, pid)
	if err != nil {
		t.Fatalf("GetBoard after shrink: %v", err)
	}
	if hasTaskID(board, "t-b") {
		t.Fatalf("vanished t-b still on the board")
	}
	if n := count(t, s, `SELECT COUNT(*) FROM local_grace_tasks WHERE id = 't-b' AND project_id = ?`, pid); n != 1 {
		t.Fatalf("grace rows for t-b = %d, want 1", n)
	}
	var title string
	if err := s.db.QueryRowContext(ctx,
		`SELECT title FROM local_grace_tasks WHERE id = 't-b'`).Scan(&title); err != nil || title != "T-B" {
		t.Fatalf("grace title = %q err = %v, want T-B", title, err)
	}
	if n := count(t, s, `SELECT COUNT(*) FROM dev_tasks WHERE id = 't-b'`); n != 0 {
		t.Fatalf("t-b still in dev_tasks, want 0")
	}
	if n := count(t, s, `SELECT COUNT(*) FROM dev_task_tags WHERE task_id = 't-b'`); n != 0 {
		t.Fatalf("t-b join rows survived, want 0")
	}

	// t-b re-appears within 7 days → restored onto the board, shadow dropped.
	if err := s.ReplaceBoard(ctx, pid, p, tasks, sprints, cats, tags, taskTags, projCats); err != nil {
		t.Fatalf("ReplaceBoard restore: %v", err)
	}
	if board, err = s.GetBoard(ctx, pid); err != nil {
		t.Fatalf("GetBoard after restore: %v", err)
	}
	if !hasTaskID(board, "t-b") {
		t.Fatalf("restored t-b missing from the board")
	}
	if n := count(t, s, `SELECT COUNT(*) FROM local_grace_tasks WHERE id = 't-b'`); n != 0 {
		t.Fatalf("restored t-b kept its shadow, want 0")
	}

	// Vanish again, then age the shadow past 7 days (injected directly) and
	// pull once more: the shadow is purged for good.
	if err := s.ReplaceBoard(ctx, pid, p, rest, sprints, cats, tags, nil, projCats); err != nil {
		t.Fatalf("ReplaceBoard vanish again: %v", err)
	}
	if n := count(t, s, `SELECT COUNT(*) FROM local_grace_tasks WHERE id = 't-b'`); n != 1 {
		t.Fatalf("grace rows for t-b after re-vanish = %d, want 1", n)
	}
	stale := time.Now().UTC().Add(-8 * 24 * time.Hour).Format(isoLayout)
	if _, err := s.db.ExecContext(ctx,
		`UPDATE local_grace_tasks SET seen_missing_at = ? WHERE id = 't-b'`, stale); err != nil {
		t.Fatalf("inject stale seen_missing_at: %v", err)
	}
	if err := s.ReplaceBoard(ctx, pid, p, rest, sprints, cats, tags, nil, projCats); err != nil {
		t.Fatalf("ReplaceBoard purge pull: %v", err)
	}
	if n := count(t, s, `SELECT COUNT(*) FROM local_grace_tasks WHERE id = 't-b'`); n != 0 {
		t.Fatalf("shadow older than 7 days not purged, want 0")
	}
}

// 4. CHECK constraints fire loudly: bogus enum values are rejected by the
// schema itself (DATA-MODEL.md §6, mapping notes).
func TestCheckConstraintsFireLoudly(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)

	// Control: valid rows land.
	if _, err := s.db.ExecContext(ctx,
		`INSERT INTO dev_tasks (id, project_id, title, status, priority, sort_order, created_at)
                 VALUES ('t-ok', 'p-x', 'ok', 'idea', 'medium', 0, '2026-10-21T00:00:00.000Z')`); err != nil {
		t.Fatalf("valid dev_tasks insert failed: %v", err)
	}
	if _, err := s.db.ExecContext(ctx,
		`INSERT INTO projects (id, user_id, title, created_at, updated_at)
                 VALUES ('p-ok', 'u1', 'ok', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z')`); err != nil {
		t.Fatalf("valid projects insert failed: %v", err)
	}

	// Bogus dev_tasks.status.
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO dev_tasks (id, project_id, title, status, priority, sort_order, created_at)
                 VALUES ('t-bad', 'p-x', 'bad', 'bogus', 'medium', 0, '2026-10-21T00:00:00.000Z')`)
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "check") {
		t.Fatalf("bogus dev_tasks.status: want CHECK constraint error, got %v", err)
	}
	// Bogus dev_tasks.priority.
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO dev_tasks (id, project_id, title, status, priority, sort_order, created_at)
                 VALUES ('t-bad2', 'p-x', 'bad', 'idea', 'whenever', 0, '2026-10-21T00:00:00.000Z')`)
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "check") {
		t.Fatalf("bogus dev_tasks.priority: want CHECK constraint error, got %v", err)
	}
	// Bogus projects.type.
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO projects (id, user_id, title, type, created_at, updated_at)
                 VALUES ('p-bad', 'u1', 'bad', 'bogus', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z')`)
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "check") {
		t.Fatalf("bogus projects.type: want CHECK constraint error, got %v", err)
	}
	// Bogus projects.status.
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO projects (id, user_id, title, status, created_at, updated_at)
                 VALUES ('p-bad2', 'u1', 'bad', 'vaporware', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z')`)
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "check") {
		t.Fatalf("bogus projects.status: want CHECK constraint error, got %v", err)
	}

	// And nothing bogus actually landed.
	if n := count(t, s, `SELECT COUNT(*) FROM dev_tasks WHERE id LIKE 't-bad%'`); n != 0 {
		t.Fatalf("bogus task rows landed = %d, want 0", n)
	}
	if n := count(t, s, `SELECT COUNT(*) FROM projects WHERE id LIKE 'p-bad%'`); n != 0 {
		t.Fatalf("bogus project rows landed = %d, want 0", n)
	}
}

// 5. Outbox: FIFO by seq, attempts counting, drop = completion.
func TestOutboxFIFOAttemptsDrop(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)

	if n, err := s.OutboxLen(ctx); err != nil || n != 0 {
		t.Fatalf("OutboxLen on empty = (%d, %v), want (0, nil)", n, err)
	}
	if e, ok, err := s.NextOutbox(ctx); err != nil || ok || e != nil {
		t.Fatalf("NextOutbox on empty = (%v, %v, %v), want (nil, false, nil)", e, ok, err)
	}

	for i, op := range []string{"create_task", "patch_task", "delete_task"} {
		if err := s.Enqueue(ctx, op, "dev_task", fmt.Sprintf("id-%d", i+1), `{"x":1}`, "ik-"+op); err != nil {
			t.Fatalf("Enqueue %s: %v", op, err)
		}
	}

	// FIFO: the oldest seq comes first, untouched fields intact.
	e, ok, err := s.NextOutbox(ctx)
	if err != nil || !ok {
		t.Fatalf("NextOutbox #1 = (%v, %v, %v)", e, ok, err)
	}
	if e.Seq != 1 || e.Op != "create_task" || e.Entity != "dev_task" || e.ID != "id-1" {
		t.Fatalf("entry #1 = %+v, want seq 1 create_task dev_task id-1", e)
	}
	if e.IdempotencyKey == nil || *e.IdempotencyKey != "ik-create_task" {
		t.Fatalf("idempotency key = %v, want ik-create_task", e.IdempotencyKey)
	}
	if e.Attempts != 0 || e.LastError != nil {
		t.Fatalf("fresh entry has attempts=%d lastError=%v, want 0/nil", e.Attempts, e.LastError)
	}
	if e.CreatedAt == "" {
		t.Fatalf("created_at not stamped")
	}

	// A failed attempt keeps the entry queued: attempts++ and last_error set.
	if err := s.MarkOutboxAttempt(ctx, e.Seq, "503 upstream"); err != nil {
		t.Fatalf("MarkOutboxAttempt: %v", err)
	}
	e2, ok, err := s.NextOutbox(ctx)
	if err != nil || !ok || e2.Seq != 1 {
		t.Fatalf("NextOutbox after failure = (%v, %v, %v), want seq 1 still", e2, ok, err)
	}
	if e2.Attempts != 1 || e2.LastError == nil || *e2.LastError != "503 upstream" {
		t.Fatalf("after failure: attempts=%d lastError=%v, want 1 / 503 upstream", e2.Attempts, e2.LastError)
	}
	if e2.Dead() {
		t.Fatalf("entry dead after 1 attempt, want alive")
	}

	// An empty error message clears last_error (the unknown-outcome hold) but
	// still counts the attempt.
	if err := s.MarkOutboxAttempt(ctx, 1, ""); err != nil {
		t.Fatalf("MarkOutboxAttempt clear: %v", err)
	}
	e3, _, err := s.NextOutbox(ctx)
	if err != nil {
		t.Fatalf("NextOutbox after clear: %v", err)
	}
	if e3.Attempts != 2 || e3.LastError != nil {
		t.Fatalf("after clear: attempts=%d lastError=%v, want 2 / nil", e3.Attempts, e3.LastError)
	}

	// Drop = the only completion path; the queue moves on to seq 2.
	if err := s.DropOutbox(ctx, 1); err != nil {
		t.Fatalf("DropOutbox: %v", err)
	}
	if e4, ok, _ := s.NextOutbox(ctx); !ok || e4.Seq != 2 || e4.Op != "patch_task" {
		t.Fatalf("NextOutbox after drop = (%v, %v), want seq 2 patch_task", e4, ok)
	}
	if n, _ := s.OutboxLen(ctx); n != 2 {
		t.Fatalf("OutboxLen after drop = %d, want 2", n)
	}

	// Enqueue after a drop keeps minting seqs FIFO-style; an empty
	// idempotency key stores NULL.
	if err := s.Enqueue(ctx, "upload_shot", "screenshot", "sh-1", `{"b64":"…"}`, ""); err != nil {
		t.Fatalf("Enqueue shot: %v", err)
	}
	e5, _, err := s.NextOutbox(ctx)
	if err != nil {
		t.Fatalf("NextOutbox mid: %v", err)
	}
	if e5.Seq != 2 { // still the oldest — FIFO, not LIFO
		t.Fatalf("FIFO broken: oldest is seq %d, want 2", e5.Seq)
	}
	for _, seq := range []int64{2, 3, 4} {
		if err := s.DropOutbox(ctx, seq); err != nil {
			t.Fatalf("DropOutbox %d: %v", seq, err)
		}
	}
	if n, err := s.OutboxLen(ctx); err != nil || n != 0 {
		t.Fatalf("OutboxLen after drains = (%d, %v), want (0, nil)", n, err)
	}
	if _, ok, err := s.NextOutbox(ctx); err != nil || ok {
		t.Fatalf("NextOutbox after drains = (%v, %v), want empty", ok, err)
	}

	// Dead-letter shape: an entry that keeps failing stays queued with
	// attempts ≥ OutboxMaxAttempts and last_error set — still visible to
	// NextOutbox (and OutboxLen) until the engine decides to drop it.
	if err := s.Enqueue(ctx, "patch_task", "dev_task", "id-9", `{}`, "ik-9"); err != nil {
		t.Fatalf("Enqueue doomed: %v", err)
	}
	doomed, ok, err := s.NextOutbox(ctx)
	if err != nil || !ok {
		t.Fatalf("NextOutbox doomed = (%v, %v, %v)", doomed, ok, err)
	}
	for i := 0; i < OutboxMaxAttempts; i++ {
		if err := s.MarkOutboxAttempt(ctx, doomed.Seq, "503 upstream"); err != nil {
			t.Fatalf("MarkOutboxAttempt %d: %v", i, err)
		}
	}
	dead, ok, err := s.NextOutbox(ctx)
	if err != nil || !ok || dead.Seq != doomed.Seq || !dead.Dead() {
		t.Fatalf("dead entry = (%v, %v, err %v), want seq %d alive-in-queue and Dead()=true",
			dead, ok, err, doomed.Seq)
	}
	if dead.LastError == nil || *dead.LastError != "503 upstream" || dead.Attempts != OutboxMaxAttempts {
		t.Fatalf("dead entry attempts/last_error = %d / %v", dead.Attempts, dead.LastError)
	}
	if n, _ := s.OutboxLen(ctx); n != 1 {
		t.Fatalf("OutboxLen with dead entry = %d, want 1 (kept for the engine)", n)
	}
	if err := s.DropOutbox(ctx, doomed.Seq); err != nil {
		t.Fatalf("DropOutbox dead: %v", err)
	}
	if n, _ := s.OutboxLen(ctx); n != 0 {
		t.Fatalf("OutboxLen after dead drop = %d, want 0", n)
	}
}

// 6. Tags UNIQUE(user_id,name) is respected on upserts: re-delivering the same
// tag never errors, and a pull carrying a NEW id for an existing
// (user_id, name) retargets the row instead of duplicating it.
func TestTagsUniqueUpsert(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)
	const pid = "p1"
	p, tasks, sprints, cats, tags, taskTags, projCats := boardFixture(pid)

	// Same tag delivered by two consecutive pulls: the id conflict is handled
	// quietly, exactly one row exists.
	if err := s.ReplaceBoard(ctx, pid, p, tasks, sprints, cats, tags, taskTags, projCats); err != nil {
		t.Fatalf("first pull: %v", err)
	}
	if err := s.ReplaceBoard(ctx, pid, p, tasks, sprints, cats, tags, taskTags, projCats); err != nil {
		t.Fatalf("second pull with identical tags: %v (UNIQUE(user_id,name) must not fire on identical upserts)", err)
	}
	if n := count(t, s, `SELECT COUNT(*) FROM tags WHERE user_id = 'u1' AND name = 'urgent'`); n != 1 {
		t.Fatalf("rows for (u1, urgent) = %d, want 1", n)
	}

	// A different id for the same (user_id, name): the second conflict clause
	// retargets the existing row; the chips follow the new id.
	retarget := []Tag{{
		ID: "tag-9", UserID: "u1", Name: "urgent", Color: "#00ff00", UsageCount: 2,
		CreatedAt: "2026-10-21T00:00:00.000Z",
	}}
	rejoin := []TaskTag{{TaskID: "t-b", TagID: "tag-9"}}
	if err := s.ReplaceBoard(ctx, pid, p, tasks, sprints, cats, retarget, rejoin, projCats); err != nil {
		t.Fatalf("pull with retargeted tag id: %v", err)
	}
	var id, color string
	if err := s.db.QueryRowContext(ctx,
		`SELECT id, color FROM tags WHERE user_id = 'u1' AND name = 'urgent'`).Scan(&id, &color); err != nil {
		t.Fatalf("retargeted tag row: %v", err)
	}
	if id != "tag-9" || color != "#00ff00" {
		t.Fatalf("retargeted tag = (%q, %q), want (tag-9, #00ff00)", id, color)
	}
	if n := count(t, s, `SELECT COUNT(*) FROM tags WHERE user_id = 'u1'`); n != 1 {
		t.Fatalf("user tags total = %d, want 1 (no duplicates)", n)
	}

	// A genuinely new tag name still inserts normally.
	mixed := append(retarget, Tag{
		ID: "tag-10", UserID: "u1", Name: "later", Color: "#f6d365", UsageCount: 0,
		CreatedAt: "2026-10-21T00:00:00.000Z",
	})
	if err := s.ReplaceBoard(ctx, pid, p, tasks, sprints, cats, mixed, rejoin, projCats); err != nil {
		t.Fatalf("pull with a new tag name: %v", err)
	}
	if n := count(t, s, `SELECT COUNT(*) FROM tags WHERE user_id = 'u1'`); n != 2 {
		t.Fatalf("user tags total = %d, want 2", n)
	}
}

// 7. BoardTasksWithTags: chips + shot badge counts, in board order.
func TestBoardTasksWithTags(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)
	const pid = "p1"

	p := Project{
		ID: pid, UserID: "u1", Title: "Cards", Type: "personal", Status: "developing",
		CreatedAt: "2026-10-20T00:00:00.000Z", UpdatedAt: "2026-10-21T00:00:00.000Z",
	}
	task := func(id, status, pri string, sort int64, created string) Task {
		return Task{ID: id, ProjectID: pid, Title: strings.ToUpper(id), Status: status,
			Priority: pri, SortOrder: sort, CreatedAt: created}
	}
	tasks := []Task{
		task("t-a", "idea", "low", 0, "2026-10-20T05:00:00.000Z"),
		task("t-b", "in_progress", "urgent", 5, "2026-10-20T02:00:00.000Z"),
		task("t-m1", "planned", "medium", 1, "2026-10-20T03:00:00.000Z"),
		task("t-m2", "planned", "medium", 1, "2026-10-20T04:00:00.000Z"),
	}
	tags := []Tag{
		{ID: "tag-hi", UserID: "u1", Name: "hotfix", Color: "#ff0000", UsageCount: 1, CreatedAt: "2026-10-20T00:00:00.000Z"},
		{ID: "tag-2nd", UserID: "u1", Name: "needs-review", Color: "#00ff00", UsageCount: 1, CreatedAt: "2026-10-20T00:00:00.000Z"},
		{ID: "tag-md", UserID: "u1", Name: "infra", Color: "#0000ff", UsageCount: 1, CreatedAt: "2026-10-20T00:00:00.000Z"},
	}
	taskTags := []TaskTag{
		{TaskID: "t-b", TagID: "tag-hi"},
		{TaskID: "t-b", TagID: "tag-2nd"},
		{TaskID: "t-m1", TagID: "tag-md"},
	}
	if err := s.ReplaceBoard(ctx, pid, p, tasks, nil, nil, tags, taskTags, nil); err != nil {
		t.Fatalf("ReplaceBoard: %v", err)
	}

	shot := func(id, taskID string) Shot {
		var tid *string
		if taskID != "" {
			tid = &taskID
		}
		return Shot{
			ID: id, ProjectID: pid, GitHubPath: "u/shots/" + id + ".png", MimeType: "image/png",
			CreatedAt: "2026-10-21T00:00:00.000Z", Resolved: 0, TaskID: tid, Bytes: 1234,
			Filename: ptr(id + ".png"),
		}
	}
	for _, sc := range []Shot{shot("shot-1", "t-b"), shot("shot-2", "t-b"), shot("shot-3", "t-m1"), shot("shot-4", "")} {
		if err := s.UpsertScreenshot(ctx, sc); err != nil {
			t.Fatalf("UpsertScreenshot %s: %v", sc.ID, err)
		}
	}

	cards, err := s.BoardTasksWithTags(ctx, pid)
	if err != nil {
		t.Fatalf("BoardTasksWithTags: %v", err)
	}
	if len(cards) != 4 {
		t.Fatalf("cards = %d, want 4", len(cards))
	}
	// Board order: PRIO_ORDER, then sort_order, then created_at.
	wantOrder := []string{"t-b", "t-m1", "t-m2", "t-a"}
	for i, id := range wantOrder {
		if cards[i].ID != id {
			t.Fatalf("card order = %v, want %v", []string{cards[0].ID, cards[1].ID, cards[2].ID, cards[3].ID}, wantOrder)
		}
	}

	chipSet := func(c TaskCard) []string {
		out := []string{}
		for _, ch := range c.Tags {
			out = append(out, ch.ID+"|"+ch.Name+"|"+ch.Color)
		}
		sort.Strings(out)
		return out
	}

	// t-b: two chips, two pinned shots.
	if got := chipSet(cards[0]); !equalStrings(got, []string{"tag-2nd|needs-review|#00ff00", "tag-hi|hotfix|#ff0000"}) {
		t.Fatalf("t-b chips = %v", got)
	}
	if cards[0].ShotCount != 2 {
		t.Fatalf("t-b shot count = %d, want 2", cards[0].ShotCount)
	}
	// t-m1: one chip, one shot.
	if got := chipSet(cards[1]); !equalStrings(got, []string{"tag-md|infra|#0000ff"}) {
		t.Fatalf("t-m1 chips = %v", got)
	}
	if cards[1].ShotCount != 1 {
		t.Fatalf("t-m1 shot count = %d, want 1", cards[1].ShotCount)
	}
	// t-m2 and t-a: no chips, no shots — and the project-level shot (task_id
	// NULL) counts toward no card.
	if len(cards[2].Tags) != 0 || cards[2].ShotCount != 0 {
		t.Fatalf("t-m2 = %d chips / %d shots, want 0/0", len(cards[2].Tags), cards[2].ShotCount)
	}
	if len(cards[3].Tags) != 0 || cards[3].ShotCount != 0 {
		t.Fatalf("t-a = %d chips / %d shots, want 0/0", len(cards[3].Tags), cards[3].ShotCount)
	}

	// UpsertScreenshot is a true upsert: re-delivering shot-1 re-pinned to
	// t-m2 updates the row instead of duplicating it.
	reShot := shot("shot-1", "t-m2")
	reShot.Caption = "re-pinned"
	reShot.Resolved = 1
	if err := s.UpsertScreenshot(ctx, reShot); err != nil {
		t.Fatalf("UpsertScreenshot re-pin: %v", err)
	}
	if n := count(t, s, `SELECT COUNT(*) FROM screenshots WHERE id = 'shot-1'`); n != 1 {
		t.Fatalf("shot-1 rows = %d, want 1 (upsert, not insert)", n)
	}
	cards, err = s.BoardTasksWithTags(ctx, pid)
	if err != nil {
		t.Fatalf("BoardTasksWithTags after re-pin: %v", err)
	}
	if cards[0].ShotCount != 1 || cards[2].ShotCount != 1 {
		t.Fatalf("after re-pin: t-b=%d t-m2=%d shot counts, want 1/1", cards[0].ShotCount, cards[2].ShotCount)
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// Archives are a replace-set per project — archived ≠ deleted, other projects'
// archives are never touched.
func TestUpsertArchivesReplaceSet(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)
	arc := func(id, pid, title string) Archive {
		return Archive{
			ID: id, ProjectID: pid, Title: title, Status: "done", Priority: "medium",
			OriginalCreatedAt: "2026-10-01T00:00:00.000Z", ArchivedAt: "2026-10-20T00:00:00.000Z",
			Tags: `["someday"]`,
		}
	}
	if err := s.UpsertArchives(ctx, "p1", []Archive{arc("ar-1", "p1", "A1"), arc("ar-2", "p1", "A2")}); err != nil {
		t.Fatalf("UpsertArchives p1: %v", err)
	}
	if err := s.UpsertArchives(ctx, "p2", []Archive{arc("ar-3", "p2", "B1")}); err != nil {
		t.Fatalf("UpsertArchives p2: %v", err)
	}
	if n := count(t, s, `SELECT COUNT(*) FROM project_archives WHERE project_id = 'p1'`); n != 2 {
		t.Fatalf("p1 archives = %d, want 2", n)
	}

	// Replace-set: p1's list swaps wholesale; p2 stays untouched.
	if err := s.UpsertArchives(ctx, "p1", []Archive{arc("ar-4", "p1", "A4")}); err != nil {
		t.Fatalf("UpsertArchives p1 replace: %v", err)
	}
	if n := count(t, s, `SELECT COUNT(*) FROM project_archives WHERE project_id = 'p1'`); n != 1 {
		t.Fatalf("p1 archives after replace = %d, want 1", n)
	}
	if n := count(t, s, `SELECT COUNT(*) FROM project_archives WHERE project_id = 'p1' AND id = 'ar-4'`); n != 1 {
		t.Fatalf("p1 survivor = ar-4? rows = %d, want 1", n)
	}
	if n := count(t, s, `SELECT COUNT(*) FROM project_archives WHERE project_id = 'p2'`); n != 1 {
		t.Fatalf("p2 archives = %d, want 1 (untouched)", n)
	}
}

// Meta: pull cursors / ETag map — missing key, set, overwrite. (NEVER
// credentials — enforced by convention + review, asserted here only for shape.)
func TestMeta(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)

	if v, ok, err := s.GetMeta(ctx, "missing"); err != nil || ok || v != "" {
		t.Fatalf("GetMeta missing = (%q, %v, %v), want (\"\", false, nil)", v, ok, err)
	}
	if err := s.SetMeta(ctx, "etag_map", `{"p1":"W/\"abc\""}`); err != nil {
		t.Fatalf("SetMeta: %v", err)
	}
	if err := s.SetMeta(ctx, "etag_map", `{"p1":"W/\"def\""}`); err != nil { // upsert overwrite
		t.Fatalf("SetMeta overwrite: %v", err)
	}
	if v, ok, err := s.GetMeta(ctx, "etag_map"); err != nil || !ok || v != `{"p1":"W/\"def\""}` {
		t.Fatalf("GetMeta after overwrite = (%q, %v, %v)", v, ok, err)
	}
}

// ListProjects: updated_at DESC order, nullable columns round-trip both ways.
func TestListProjectsOrderAndNullables(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)
	mk := func(id, updated string) Project {
		return Project{
			ID: id, UserID: "u1", Title: id, Type: "personal", Status: "operational",
			CreatedAt: "2026-10-20T00:00:00.000Z", UpdatedAt: updated,
		}
	}
	pOld := mk("p-old", "2026-10-20T00:00:00.000Z")
	pNew := mk("p-new", "2026-10-21T00:00:00.000Z")
	pNew.ClientName = ptr("Acme")
	pNew.DueDate = ptr("2026-11-01")
	pNew.ProgressPercent = ptr(int64(40))
	pNew.PinnedAt = ptr("2026-10-21T00:00:00.000Z")

	for _, p := range []Project{pOld, pNew} {
		if err := s.UpsertProject(ctx, p); err != nil {
			t.Fatalf("UpsertProject %s: %v", p.ID, err)
		}
	}

	got, err := s.ListProjects(ctx)
	if err != nil {
		t.Fatalf("ListProjects: %v", err)
	}
	if len(got) != 2 || got[0].ID != "p-new" || got[1].ID != "p-old" {
		t.Fatalf("order = %v, want [p-new p-old] (updated_at DESC)", got)
	}
	if *got[0].ClientName != "Acme" || *got[0].DueDate != "2026-11-01" ||
		*got[0].ProgressPercent != 40 || *got[0].PinnedAt != "2026-10-21T00:00:00.000Z" {
		t.Fatalf("p-new nullable fields = %+v", got[0])
	}
	if got[1].ClientName != nil || got[1].ProgressPercent != nil ||
		got[1].DeletedAt != nil || got[1].PinnedAt != nil || got[1].CoverShotID != nil {
		t.Fatalf("p-old nullable fields should scan back nil: %+v", got[1])
	}

	// UpsertProject is a real upsert: bumping updated_at flips the order.
	pOld.UpdatedAt = "2026-10-22T00:00:00.000Z"
	if err := s.UpsertProject(ctx, pOld); err != nil {
		t.Fatalf("UpsertProject p-old bump: %v", err)
	}
	got, err = s.ListProjects(ctx)
	if err != nil {
		t.Fatalf("ListProjects after bump: %v", err)
	}
	if got[0].ID != "p-old" {
		t.Fatalf("order after bump = [%s %s], want p-old first", got[0].ID, got[1].ID)
	}
}

// 11. ResetAccount — the v0.1.9 logout hand-off: every ACCOUNT-scoped table
// and the pull-cursor meta rows die in ONE transaction; the caller's
// keep-list (the shell passes ui.theme + tray's ui.hide_on_close) survives
// (device prefs, not account data); the wipe is idempotent; and the next
// account's first pull refills the mirror through the same ReplaceBoard path.
func TestResetAccount(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)
	const pid = "p1"
	p, tasks, sprints, cats, tags, taskTags, projCats := boardFixture(pid)
	if err := s.ReplaceBoard(ctx, pid, p, tasks, sprints, cats, tags, taskTags, projCats); err != nil {
		t.Fatalf("ReplaceBoard full: %v", err)
	}
	// Vanish one task so a deletion shadow exists (account data too).
	if err := s.ReplaceBoard(ctx, pid, p, tasks[1:2], sprints, cats, tags, nil, projCats); err != nil {
		t.Fatalf("ReplaceBoard shrink: %v", err)
	}
	if err := s.Enqueue(ctx, "create", "task", "t-z", `{"title":"Z"}`, ""); err != nil {
		t.Fatalf("Enqueue: %v", err)
	}
	for k, v := range map[string]string{
		"etag:/api/projects/p1/devboard": `W/"v1"`,
		"lastpull:p1":                    "2026-10-21T00:00:00.000Z",
		"projects-pull":                  "2026-10-21T00:00:00.000Z",
		"ui.theme":                       "claude-dark",
		"ui.hide_on_close":               "1",
	} {
		if err := s.SetMeta(ctx, k, v); err != nil {
			t.Fatalf("SetMeta %q: %v", k, err)
		}
	}

	// Precondition: the mirror is visibly loaded.
	for table, want := range map[string]int{
		"projects": 1, "dev_tasks": 1, "sprints": 1, "categories": 1, "tags": 1,
		"dev_task_tags": 0, "project_categories": 1, "local_grace_tasks": 2,
		"outbox": 1, "meta": 5,
	} {
		if n := count(t, s, `SELECT COUNT(*) FROM `+table); n != want {
			t.Fatalf("precondition %s = %d, want %d", table, n, want)
		}
	}

	// The logout wipe (the shell's keep-list: theme + close-to-tray).
	if err := s.ResetAccount(ctx, "ui.theme", "ui.hide_on_close"); err != nil {
		t.Fatalf("ResetAccount: %v", err)
	}

	// Every account-scoped table is empty…
	for _, table := range []string{
		"projects", "dev_tasks", "sprints", "categories", "tags",
		"dev_task_tags", "project_categories", "project_archives",
		"screenshots", "local_grace_tasks", "outbox",
	} {
		if n := count(t, s, `SELECT COUNT(*) FROM `+table); n != 0 {
			t.Fatalf("%s after ResetAccount = %d, want 0", table, n)
		}
	}
	// …the cursors died, the device prefs survived.
	if n := count(t, s, `SELECT COUNT(*) FROM meta`); n != 2 {
		t.Fatalf("meta after ResetAccount = %d rows, want the 2 kept device prefs", n)
	}
	if v, ok, err := s.GetMeta(ctx, "ui.theme"); err != nil || !ok || v != "claude-dark" {
		t.Fatalf("ui.theme survived = (%q, %v, %v), want claude-dark", v, ok, err)
	}
	if v, ok, err := s.GetMeta(ctx, "ui.hide_on_close"); err != nil || !ok || v != "1" {
		t.Fatalf("ui.hide_on_close survived = (%q, %v, %v), want 1", v, ok, err)
	}
	if _, ok, _ := s.GetMeta(ctx, "etag:/api/projects/p1/devboard"); ok {
		t.Fatal("the ETag cursor survived ResetAccount — validators must never cross an account boundary")
	}
	if _, ok, _ := s.GetMeta(ctx, "projects-pull"); ok {
		t.Fatal("the projects-list cursor survived ResetAccount")
	}

	// Idempotent: a second wipe is a clean no-op.
	if err := s.ResetAccount(ctx, "ui.theme", "ui.hide_on_close"); err != nil {
		t.Fatalf("ResetAccount again: %v", err)
	}
	if n := count(t, s, `SELECT COUNT(*) FROM meta`); n != 2 {
		t.Fatalf("meta after the second ResetAccount = %d, want 2", n)
	}

	// The next account's first pull refills the mirror through the same path.
	if err := s.ReplaceBoard(ctx, pid, p, tasks, sprints, cats, tags, taskTags, projCats); err != nil {
		t.Fatalf("ReplaceBoard after the wipe: %v", err)
	}
	board, err := s.GetBoard(ctx, pid)
	if err != nil {
		t.Fatalf("GetBoard after the wipe: %v", err)
	}
	if len(board) != 3 {
		t.Fatalf("board after the wipe = %d tasks, want 3", len(board))
	}

	// And a keep-less reset clears meta entirely (the plain variant).
	if err := s.SetMeta(ctx, "etag:x", "v"); err != nil {
		t.Fatalf("SetMeta etag:x: %v", err)
	}
	if err := s.ResetAccount(ctx); err != nil {
		t.Fatalf("ResetAccount (no keep list): %v", err)
	}
	if n := count(t, s, `SELECT COUNT(*) FROM meta`); n != 0 {
		t.Fatalf("meta after the keep-less ResetAccount = %d, want 0", n)
	}
}
