package sync

import (
	"context"
	"strings"
	"testing"
)

// The S217 manual sync round — the choreography the modal proves live.
// Every outcome is a real verdict, never a cosmetic green.

// collect records the emitted transitions in order.
type collect struct{ events []string }

func (c *collect) emit(step Step, state State, detail string) {
	c.events = append(c.events, string(step)+":"+string(state)+":"+detail)
}

func (c *collect) has(ev string) bool {
	for _, e := range c.events {
		if e == ev {
			return true
		}
	}
	return false
}

func TestSyncRoundHappyPathChoreographyAndOrder(t *testing.T) {
	f := newSyncFake()
	f.bodies["/api/projects"] = `{"projects":[{"id":"p1","title":"T","type":"personal","status":"operational","updated_at":"2026-01-01T00:00:00.000Z"}]}`
	f.bodies["/api/projects/p1/devboard"] = testBoard
	eng, _, done := newEngine(t, f)
	defer done()
	ctx := context.Background()

	// Seed one board into the mirror so the sync step has work.
	if _, err := eng.Pull(ctx, "p1"); err != nil {
		t.Fatalf("seed pull: %v", err)
	}

	var c collect
	out, err := eng.SyncRound(ctx, c.emit)
	if err != nil {
		t.Fatalf("SyncRound: %v", err)
	}
	if !out.OK || out.Code != OutcomeOK {
		t.Fatalf("outcome = %+v, want ok", out)
	}
	if out.Uploaded != 0 {
		t.Fatalf("uploaded = %d, want 0 (the queue was empty — never a fake count)", out.Uploaded)
	}
	if out.Projects != 1 || out.Boards != 1 {
		t.Fatalf("projects/boards = %d/%d, want 1/1", out.Projects, out.Boards)
	}
	// v0.1.12: the outcome carries the boards whose mirror rows MOVED (live
	// 200s — the fake serves no ETags, so the seeded p1 re-pulls as a 200) —
	// the count that drives the modal's ok fact + the close-time board reload.
	if out.Pulled != 1 {
		t.Fatalf("pulled = %d, want 1 (the fake has no ETags — the board re-mirrored)", out.Pulled)
	}
	if out.At.IsZero() {
		t.Fatal("the outcome must carry the round's time (the modal's last-synced line)")
	}

	// The choreography, in order: connect active → done, upload active →
	// done (the honest empty-queue fact), sync active → done (the moved-board
	// fact + the counts — the v0.1.12 detail names the delta).
	want := []string{
		"connect:active:hibana.ir",
		"connect:done:hibana.ir reached",
		"upload:active:",
		"upload:done:no pending changes — everything is already saved live",
		"sync:active:",
		"sync:done:1 board(s) updated · 1 project(s) · 1 board(s) checked",
	}
	if len(c.events) != len(want) {
		t.Fatalf("emitted %d events, want %d:\n  %v", len(c.events), len(want), c.events)
	}
	for i, w := range want {
		if c.events[i] != w {
			t.Fatalf("event %d = %q, want %q\n  full: %v", i, c.events[i], w, c.events)
		}
	}
}

func TestSyncRoundSessionIsHonestOn401(t *testing.T) {
	f := newSyncFake()
	eng, _, done := newEngine(t, f)
	defer done()
	f.session = false // the stored session is dead

	var c collect
	out, err := eng.SyncRound(context.Background(), c.emit)
	if err != nil {
		t.Fatalf("SyncRound: %v", err)
	}
	if out.OK || out.Code != OutcomeSession {
		t.Fatalf("outcome = %+v, want session", out)
	}
	if !c.has("connect:failed:session expired") {
		t.Fatalf("the connect step must fail honestly: %v", c.events)
	}
	// The round never reached the later steps.
	if len(c.events) != 2 {
		t.Fatalf("a session verdict must stop the round: %v", c.events)
	}
}

func TestSyncRoundUnreachableOnTransport(t *testing.T) {
	f := newSyncFake()
	eng, _, done := newEngine(t, f)
	defer done()
	done() // server gone — the Cloudflare round-trip itself fails

	var c collect
	out, err := eng.SyncRound(context.Background(), c.emit)
	if err != nil {
		t.Fatalf("SyncRound: %v", err)
	}
	if out.OK || out.Code != OutcomeUnreachable {
		t.Fatalf("outcome = %+v, want unreachable", out)
	}
	if !c.has("connect:failed:cannot reach hibana.ir") {
		t.Fatalf("the connect step must name the reach failure: %v", c.events)
	}
}

func TestSyncRoundUploadsQueuedOps(t *testing.T) {
	f := newSyncFake()
	f.bodies["/api/projects"] = `{"projects":[]}`
	eng, st, done := newEngine(t, f)
	defer done()
	ctx := context.Background()

	// One queued mutation: the drain must land it and the upload step must
	// say the count — the honest "N change(s) uploaded".
	if err := st.Enqueue(ctx, "POST", "devtask.create", "p1", `{"title":"x"}`, ""); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	var c collect
	out, err := eng.SyncRound(ctx, c.emit)
	if err != nil {
		t.Fatalf("SyncRound: %v", err)
	}
	if !out.OK || out.Code != OutcomeOK {
		t.Fatalf("outcome = %+v, want ok", out)
	}
	if out.Uploaded != 1 {
		t.Fatalf("uploaded = %d, want 1", out.Uploaded)
	}
	if !c.has("upload:done:1 change(s) uploaded") {
		t.Fatalf("the upload fact line must carry the count: %v", c.events)
	}
	n, err := st.OutboxLen(ctx)
	if err != nil || n != 0 {
		t.Fatalf("outbox after the round = %d (err %v), want 0", n, err)
	}
}

func TestSyncRoundPendingNamesHeldOpsNeverLost(t *testing.T) {
	f := newSyncFake()
	f.bodies["/api/projects"] = `{"projects":[]}`
	eng, st, done := newEngine(t, f)
	defer done()
	ctx := context.Background()

	// A held op: a 429 stops the drain round, the entry STAYS queued.
	if err := st.Enqueue(ctx, "POST", "devtask.create", "p1", `{"title":"x"}`, ""); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	f.statuses["/api/projects/p1/devtasks"] = 429

	var c collect
	out, err := eng.SyncRound(ctx, c.emit)
	if err != nil {
		t.Fatalf("SyncRound: %v", err)
	}
	// The §10 pending-honesty keep: held ops NEVER fail the round — the sync
	// step still ran (the verdict is warn, not error) and the ops are NAMED.
	if out.OK || out.Code != OutcomePending {
		t.Fatalf("outcome = %+v, want pending", out)
	}
	if !strings.Contains(out.Message, "1 change(s) are still uploading") ||
		!strings.Contains(out.Message, "devtask.create p1") ||
		!strings.Contains(out.Message, "will not vanish") {
		t.Fatalf("the pending message must name the held op + the never-lost note: %q", out.Message)
	}
	if !c.has("sync:done:every board already current · 0 project(s) · 0 board(s) checked") {
		t.Fatalf("the sync step must still complete (the boards were checked): %v", c.events)
	}
	n, err := st.OutboxLen(ctx)
	if err != nil || n != 1 {
		t.Fatalf("the held op must SURVIVE the round: outbox = %d (err %v)", n, err)
	}
}

func TestSyncRoundBoardPullError(t *testing.T) {
	f := newSyncFake()
	f.bodies["/api/projects"] = `{"projects":[{"id":"p1","title":"T","type":"personal","status":"operational","updated_at":"2026-01-01T00:00:00.000Z"}]}`
	f.bodies["/api/projects/p1/devboard"] = testBoard
	eng, _, done := newEngine(t, f)
	defer done()
	ctx := context.Background()

	// Seed, then break the board endpoint: the sync step fails loudly.
	if _, err := eng.Pull(ctx, "p1"); err != nil {
		t.Fatalf("seed pull: %v", err)
	}
	delete(f.bodies, "/api/projects/p1/devboard")
	f.statuses["/api/projects/p1/devboard"] = 500

	var c collect
	out, err := eng.SyncRound(ctx, c.emit)
	if err != nil {
		t.Fatalf("SyncRound: %v", err)
	}
	if out.OK || out.Code != OutcomeError {
		t.Fatalf("outcome = %+v, want error", out)
	}
	if out.Message == "" {
		t.Fatal("the error verdict must carry the failure in Message (the modal's red panel)")
	}
	if !c.has("sync:failed:" + out.Message) {
		t.Fatalf("the sync step must fail with the reason: %v", c.events)
	}
}

func TestSyncRoundMidRound401ReadsAsSession(t *testing.T) {
	f := newSyncFake()
	eng, _, done := newEngine(t, f)
	defer done()
	ctx := context.Background()

	// The connect probe passes (the session cookie looks alive), then the
	// projects list 401s mid-round — a session that died between steps.
	f.bodies["/api/projects"] = ""
	f.statuses["/api/projects"] = 401

	var c collect
	out, err := eng.SyncRound(ctx, c.emit)
	if err != nil {
		t.Fatalf("SyncRound: %v", err)
	}
	if out.OK || out.Code != OutcomeSession {
		t.Fatalf("outcome = %+v, want session (a mid-round 401 that survives the drain path)", out)
	}
	if !c.has("connect:done:hibana.ir reached") {
		t.Fatalf("connect must have passed first: %v", c.events)
	}
	if !c.has("sync:failed:session expired") {
		t.Fatalf("the sync step must fail honestly as a session: %v", c.events)
	}
}

func TestSyncRoundNilEmitStillRuns(t *testing.T) {
	f := newSyncFake()
	f.bodies["/api/projects"] = `{"projects":[]}`
	eng, _, done := newEngine(t, f)
	defer done()

	// A nil emit must never panic — the Go-side verdict does not depend on
	// the UI relay (the shell may wire SetSyncEmit only after startup).
	out, err := eng.SyncRound(context.Background(), nil)
	if err != nil || !out.OK || out.Code != OutcomeOK {
		t.Fatalf("nil-emit round: out=%+v err=%v", out, err)
	}
}

// TestSyncRoundPulledZeroMeansScreenAlreadyCurrent — the v0.1.12 contract the
// modal rides: pulled=0 (every board answered 304 — the server says nothing
// changed) means the ok panel carries NO updated-boards fact and the island
// does NOT reload on close; the screen was already the cloud's truth. The
// happy-path test above proves the pulled>0 half.
func TestSyncRoundPulledZeroMeansScreenAlreadyCurrent(t *testing.T) {
	f := newSyncFake()
	f.bodies["/api/projects"] = `{"projects":[]}`
	eng, _, done := newEngine(t, f)
	defer done()

	var c collect
	out, err := eng.SyncRound(context.Background(), c.emit)
	if err != nil {
		t.Fatalf("SyncRound: %v", err)
	}
	if !out.OK || out.Code != OutcomeOK {
		t.Fatalf("outcome = %+v, want ok", out)
	}
	if out.Pulled != 0 {
		t.Fatalf("pulled = %d, want 0 (nothing moved — the ok panel must not claim updates)", out.Pulled)
	}
	if !c.has("sync:done:every board already current · 0 project(s) · 0 board(s) checked") {
		t.Fatalf("the all-current fact must name itself honestly: %v", c.events)
	}
}
