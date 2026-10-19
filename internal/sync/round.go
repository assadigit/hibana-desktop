package sync

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"hibana/desktop/internal/api"
)

// THE MANUAL SYNC ROUND (S217 — v0.1.6; the owner ask: "Add a physical and
// visible sync button. everytime user clicks sync a modal pop's up , shows
// connecting to cloudflare serever > upload > sync with success modal. so
// user is 100% sure it's synced and will not vanish").
//
// SyncRound is the choreography the modal PROVES live: one honest pass
// connect → upload → sync, every transition emitted so js/desktop-sync.js
// can animate the step rows (spinner → check/cross + the server-minted
// fact lines). The outcome is NEVER cosmetic — each code is a real verdict:
//
//	ok          every step landed: the boards are on the Hibana cloud
//	session     the stored session died (a 401 anywhere in the round that
//	            survives the drain's relogin-retry) — the shell reopens the
//	            login card above the modal
//	unreachable the Cloudflare round-trip itself failed (offline/DNS) —
//	            the red panel offers an in-place Try again
//	pending     the sync itself worked but outbox ops are still queued
//	      (backoff/ban/unknown-transport) — named honestly, with the
//	            never-lost note: they are IN THE QUEUE and drain on the
//	            next round; nothing is dropped silently
//	error       something failed mid-round (a board pull error, a decode) —
//	            the red panel + Try again
type (
	// Step names the modal's rows (the JS side's li[data-step] values).
	Step string
	// State is a row's transition (the CSS data-state values).
	State string
)

const (
	StepConnect Step = "connect"
	StepUpload  Step = "upload"
	StepSync    Step = "sync"
)

// The row states (li[data-state] values — the CSS branches on these).
const (
	StatePending State = "pending"
	StateActive  State = "active"
	StateDone    State = "done"
	StateFailed  State = "failed"
)

// Emit is the transition listener the shell relays to the modal
// (main.go: EventsEmit hibana:sync-progress {step, state, detail}).
// detail is the live fact line ("signed in as …", "3 change(s) uploaded"…);
// an empty detail means "no fact yet". Emit may be nil — the round still
// runs to completion (the Go-side verdict does not depend on the UI).
type Emit func(step Step, state State, detail string)

// emitStep is the nil-safe relay.
func emitStep(emit Emit, step Step, state State, detail string) {
	if emit == nil {
		return
	}
	emit(step, state, detail)
}

// RoundOutcome is the binding's wire result (ui.SyncNow → the modal's
// onDone). The JSON shape is the JS contract (desktop-sync.js):
// {ok, code, uploaded, projects, boards, at, message}.
type RoundOutcome struct {
	OK       bool      `json:"ok"`
	Code     string    `json:"code,omitempty"`
	Uploaded int       `json:"uploaded"`
	Projects int       `json:"projects"`
	Boards   int       `json:"boards"`
	At       time.Time `json:"at"`
	Message  string    `json:"message,omitempty"`
}

// The honest verdict codes.
const (
	OutcomeOK          = "ok"
	OutcomeSession     = "session"
	OutcomeUnreachable = "unreachable"
	OutcomePending     = "pending"
	OutcomeError       = "error"
)

func (o RoundOutcome) with(code string) RoundOutcome { o.Code = code; return o }

// SyncRound runs the modal's choreography:
//
//	connect  client.Me — GET /api/auth/me: the Cloudflare round-trip AND the
//	         session probe. A 401 is the honest session outcome, never a
//	         retry. Transport trouble is 'unreachable'.
//	upload   engine.Drain — the §10 push rules. Pre-M3 the queue is usually
//	         empty and the step says so ("no pending changes — everything
//	         is already saved live"), NEVER a fake count.
//	sync     engine.SyncOnce — the projects list + every mirrored board.
//
// Held outbox ops (backoff/ban/unknown-transport) do not fail the round —
// the sync step still runs; the verdict is then 'pending' with the held ops
// NAMED and the never-lost note in Message.
func (e *Engine) SyncRound(ctx context.Context, emit Emit) (RoundOutcome, error) {
	out := RoundOutcome{At: e.now().UTC()}

	// ---- connect: the Cloudflare round-trip + the session probe ----
	emitStep(emit, StepConnect, StateActive, "hibana.ir")
	me, err := e.client.Me(ctx)
	if err != nil {
		var se *api.StatusError
		if errors.As(err, &se) && se.Status == http.StatusUnauthorized {
			emitStep(emit, StepConnect, StateFailed, "session expired")
			return out.with(OutcomeSession), nil
		}
		emitStep(emit, StepConnect, StateFailed, "cannot reach hibana.ir")
		return out.with(OutcomeUnreachable), nil
	}
	detail := "hibana.ir reached"
	if me != nil && me.User.Email != "" {
		detail = "signed in as " + me.User.Email
	}
	emitStep(emit, StepConnect, StateDone, detail)

	// ---- upload: drain the outbox (the §10 push rules) ----
	emitStep(emit, StepUpload, StateActive, "")
	drain, derr := e.Drain(ctx)
	if derr != nil {
		// Drain only errors on a store/queue read — treat as a hard error.
		emitStep(emit, StepUpload, StateFailed, derr.Error())
		out.Message = derr.Error()
		return out.with(OutcomeError), nil
	}
	out.Uploaded = drain.Done
	if drain.Done > 0 {
		emitStep(emit, StepUpload, StateDone, fmt.Sprintf("%d change(s) uploaded", drain.Done))
	} else {
		emitStep(emit, StepUpload, StateDone, "no pending changes — everything is already saved live")
	}
	// A 401 that survived the drain's relogin-retry reads as session.
	if drain.LastErr != nil {
		var se *api.StatusError
		if errors.As(drain.LastErr, &se) && se.Status == http.StatusUnauthorized {
			emitStep(emit, StepUpload, StateFailed, "session expired")
			return out.with(OutcomeSession), nil
		}
	}

	// ---- sync: the projects list + every mirrored board ----
	emitStep(emit, StepSync, StateActive, "")
	pulled, errs := e.SyncOnce(ctx)
	projects, perr := e.store.ListProjects(ctx)
	if perr != nil {
		errs = append(errs, fmt.Errorf("mirror list: %w", perr))
	} else {
		live := 0
		for _, p := range projects {
			if p.DeletedAt == nil {
				live++
			}
		}
		out.Projects = live
	}
	out.Boards = len(projects) // every mirrored board was checked (304s are checks)
	for _, er := range errs {
		var se *api.StatusError
		if errors.As(er, &se) && se.Status == http.StatusUnauthorized {
			// A mid-round 401 that survived the drain's relogin path.
			emitStep(emit, StepSync, StateFailed, "session expired")
			return out.with(OutcomeSession), nil
		}
	}
	if len(errs) > 0 {
		emitStep(emit, StepSync, StateFailed, errs[0].Error())
		out.Message = errs[0].Error()
		return out.with(OutcomeError), nil
	}
	emitStep(emit, StepSync, StateDone, fmt.Sprintf("%d project(s) · %d board(s) checked", out.Projects, out.Boards))
	_ = pulled

	// ---- the pending honesty: held ops are named, never hidden ----
	if drain.Held > 0 {
		out.Message = fmt.Sprintf("%d change(s) are still uploading (%s) — they are queued and will not vanish; the next sync retries them.",
			drain.Held, joinOps(drain.HeldOps))
		return out.with(OutcomePending), nil
	}

	out.OK = true
	return out.with(OutcomeOK), nil
}

// joinOps renders the held-op names compactly ("devtask.create t12, …"),
// capped so a big queue never floods the panel.
func joinOps(ops []string) string {
	const max = 3
	if len(ops) == 0 {
		return "details in data/logs/hibana.log"
	}
	s := ops[0]
	for i := 1; i < len(ops) && i < max; i++ {
		s += ", " + ops[i]
	}
	if len(ops) > max {
		s += fmt.Sprintf(" +%d more", len(ops)-max)
	}
	return s
}
