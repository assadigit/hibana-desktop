package ui

import (
	"context"
	"fmt"
	"time"

	hibanasync "hibana/desktop/internal/sync"
)

// THE MANUAL SYNC BINDING (S217 — v0.1.6): the island's #db-sync-button →
// the Go round (engine.SyncRound), with the modal proving every transition
// live. This file is the BRIDGE HALF only — the busy guard, the deadline,
// the emit relay, and the wire mapping; the choreography lives in
// internal/sync/round.go, the shell's wiring in main.go:
//
//	SetSyncEmit → EventsEmit hibana:sync-progress {step, state, detail}
//	SetSyncRun  → engine.SyncRound + the session outcome → NotifyAuthLost
//	             (the login card reopens ABOVE the modal)
//
// The internal/sync package imports aliased hibanasync — this package also
// uses the stdlib sync (the API struct's Mutex), so the names would collide.

// syncDeadline bounds one manual round. It equals the relogin wait cap by
// design: the drain's 401 path may legitimately WAIT for the user to sign
// back in via the login card (§10's re-auth-then-retry-once), and a sync
// that covers a re-login is a SUCCESS, not a timeout. A VAR so the timeout
// branch is testable in milliseconds.
var syncDeadline = 10 * time.Minute

// SetSyncRun wires the round runner (main.go: engine.SyncRound + the session
// outcome's NotifyAuthLost). Without it SyncNow resolves as not-wired — the
// modal's own "The desktop bridge is not wired — restart the app." panel.
func (a *API) SetSyncRun(fn func(ctx context.Context, emit hibanasync.Emit) (hibanasync.RoundOutcome, error)) {
	a.syncMu.Lock()
	a.syncRun = fn
	a.syncMu.Unlock()
}

// SetSyncEmit wires the transition relay (main.go: EventsEmit
// "hibana:sync-progress" {step, state, detail} — js/desktop-sync.js paints
// the step rows live).
func (a *API) SetSyncEmit(fn func(step, state, detail string)) {
	a.syncMu.Lock()
	a.syncEmit = fn
	a.syncMu.Unlock()
}

// SyncNow is the binding the sync button calls (click-time resolution in
// js/desktop-sync.js — no arguments, so there is nothing hostile to
// validate). The busy guard makes the round single-flight: a second click
// while one runs resolves {code:"busy"} (the modal's own busy panel), and
// the guard RE-ARMS on every exit path — success, failure, or timeout —
// so a finished round can always start a new one.
func (a *API) SyncNow() (hibanasync.RoundOutcome, error) {
	if !a.syncBusy.CompareAndSwap(false, true) {
		return hibanasync.RoundOutcome{Code: "busy"}, nil
	}
	defer a.syncBusy.Store(false) // the re-arm: every exit path unguards

	a.syncMu.Lock()
	run := a.syncRun
	emitFn := a.syncEmit
	a.syncMu.Unlock()
	if run == nil {
		// Not wired (tests / a shell that never wired the round) — reject
		// the JS promise; the modal's onReject shows its not-wired panel.
		return hibanasync.RoundOutcome{}, fmt.Errorf("bridge: sync: not wired")
	}

	ctx, cancel := context.WithTimeout(context.Background(), syncDeadline)
	defer cancel()

	relay := func(step hibanasync.Step, state hibanasync.State, detail string) {
		if emitFn != nil {
			emitFn(string(step), string(state), detail)
		}
	}
	out, err := run(ctx, relay)
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			// The honest timeout: the round ran out of its 10-minute window
			// (a relogin that never came, a stuck request). The red panel
			// offers Try again — nothing was lost; the outbox keeps its ops.
			return hibanasync.RoundOutcome{Code: hibanasync.OutcomeError, Message: "the sync round timed out — try again"}, nil
		}
		return hibanasync.RoundOutcome{Code: hibanasync.OutcomeError, Message: err.Error()}, nil
	}
	return out, nil
}
