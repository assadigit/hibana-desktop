package ui

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"hibana/desktop/internal/update"
)

// The v0.1.14 auto-update bindings: the not-wired verdicts, the cached
// verdict contract, the busy guard shared by the check and the apply, the
// progress relay, the honest timeout, and the re-arm on every exit path.

func TestUpdateCheckNotWired(t *testing.T) {
	a, _ := newBridge(t)
	if _, err := a.CheckForUpdates(); err == nil {
		t.Fatal("CheckForUpdates without a checker must reject")
	}
}

func TestUpdateApplyNotWiredAndNeedsACachedVerdict(t *testing.T) {
	a, _ := newBridge(t)
	// No SetUpdateApply: the promise must reject.
	if _, err := a.ApplyUpdate(); err == nil {
		t.Fatal("ApplyUpdate without an applier must reject")
	}
	// Wired applier but NO cached available verdict: the honest no-op.
	a.SetUpdateApply(func(context.Context, func(update.Progress)) (update.ApplyResult, error) {
		t.Fatal("the applier must never run without a cached available verdict")
		return update.ApplyResult{}, nil
	})
	out, err := a.ApplyUpdate()
	if err != nil {
		t.Fatalf("a missing verdict resolves, never rejects: %v", err)
	}
	if out.OK || out.Message == "" {
		t.Fatalf("out=%+v — the message must name the no-update fact", out)
	}
}

func TestUpdateCheckEmitsOnlyOnAvailable(t *testing.T) {
	a, _ := newBridge(t)
	var mu sync.Mutex
	var events []string
	a.SetUpdateEmit(func(name string, payload map[string]any) {
		mu.Lock()
		defer mu.Unlock()
		events = append(events, name)
		if name != "hibana:update-available" {
			return
		}
		if payload["latest"] != "0.1.14" || payload["kind"] != "portable" || payload["available"] != true {
			t.Errorf("the available payload must carry the verdict: %v", payload)
		}
	})
	// A no-update verdict resolves quietly — no event, no claim.
	a.SetUpdateCheck(func(context.Context) (update.CheckResult, error) {
		return update.CheckResult{Available: false, Current: "0.1.14", Latest: "0.1.14"}, nil
	})
	res, err := a.CheckForUpdates()
	if err != nil || res.Available {
		t.Fatalf("res=%+v err=%v — the no-update verdict must resolve quiet", res, err)
	}
	// An available verdict fires the event exactly once with the facts.
	a.SetUpdateCheck(func(context.Context) (update.CheckResult, error) {
		return update.CheckResult{Available: true, Current: "0.1.13", Latest: "0.1.14", Kind: "portable", Size: 7560000, URL: "https://github.com/x/releases/latest"}, nil
	})
	res, err = a.CheckForUpdates()
	if err != nil || !res.Available {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(events) != 1 || events[0] != "hibana:update-available" {
		t.Fatalf("events = %v, want exactly the one available event", events)
	}
}

func TestUpdateApplyRelaysProgressAndCachesTheVerdict(t *testing.T) {
	a, _ := newBridge(t)
	var mu sync.Mutex
	var saw []map[string]any
	a.SetUpdateEmit(func(name string, payload map[string]any) {
		mu.Lock()
		defer mu.Unlock()
		if name == "hibana:update-progress" {
			saw = append(saw, payload)
		}
	})
	a.SetUpdateCheck(func(context.Context) (update.CheckResult, error) {
		return update.CheckResult{Available: true, Current: "0.1.13", Latest: "0.1.14", Kind: "portable", Size: 100}, nil
	})
	if _, err := a.CheckForUpdates(); err != nil {
		t.Fatalf("check: %v", err)
	}
	a.SetUpdateApply(func(ctx context.Context, progress func(update.Progress)) (update.ApplyResult, error) {
		progress(update.Progress{Stage: "download", Received: 25, Total: 100, Pct: 25})
		progress(update.Progress{Stage: "download", Received: 100, Total: 100, Pct: 100})
		progress(update.Progress{Stage: "verify", Received: 100, Total: 100, Pct: 100})
		return update.ApplyResult{OK: true}, nil
	})
	out, err := a.ApplyUpdate()
	if err != nil || !out.OK {
		t.Fatalf("out=%+v err=%v", out, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(saw) != 3 {
		t.Fatalf("the progress relay must carry every tick: saw %v", saw)
	}
	if saw[0]["stage"] != "download" || saw[0]["pct"] != 25.0 || saw[2]["stage"] != "verify" {
		t.Fatalf("the ticks must carry stage+pct verbatim: %v", saw)
	}
}

func TestUpdateSharedBusyGuardAndRearm(t *testing.T) {
	a, _ := newBridge(t)
	release := make(chan struct{})
	started := make(chan struct{})
	var once sync.Once
	a.SetUpdateCheck(func(context.Context) (update.CheckResult, error) {
		once.Do(func() { close(started) })
		<-release // hold the check open so the busy path is provable
		return update.CheckResult{Available: true, Current: "0.1.13", Latest: "0.1.14"}, nil
	})
	go a.CheckForUpdates()
	<-started

	// A second check while one runs → the honest busy refusal; an APPLY while
	// one runs must refuse too (the one guard serves both — two live GitHub
	// round-trips at once buy nothing).
	if _, err := a.CheckForUpdates(); err == nil {
		t.Fatal("the second check must refuse while the first runs")
	}
	// Wire an applier and arm the cached verdict via the emitter so ApplyUpdate
	// reaches its own not-busy path… it must STILL refuse: the shared guard is
	// held by the in-flight check.
	a.NotifyUpdateAvailable(update.CheckResult{Available: true, Current: "0.1.13", Latest: "0.1.14"})
	a.SetUpdateApply(func(context.Context, func(update.Progress)) (update.ApplyResult, error) {
		return update.ApplyResult{OK: true}, nil
	})
	out, err := a.ApplyUpdate()
	if err != nil || out.OK || out.Message != "busy" {
		t.Fatalf("out=%+v err=%v — the apply must refuse {busy} under the shared guard", out, err)
	}
	close(release)
	time.Sleep(50 * time.Millisecond) // let the check finish + re-arm

	// Re-armed: both surfaces run fresh rounds again.
	out, err = a.ApplyUpdate()
	if err != nil || !out.OK {
		t.Fatalf("after the check finished the apply must run: out=%+v err=%v", out, err)
	}
}

func TestUpdateApplyErrorAndTimeoutAreVerdictsNeverRejections(t *testing.T) {
	a, _ := newBridge(t)
	a.NotifyUpdateAvailable(update.CheckResult{Available: true, Current: "0.1.13", Latest: "0.1.14"})
	a.SetUpdateApply(func(context.Context, func(update.Progress)) (update.ApplyResult, error) {
		return update.ApplyResult{}, errors.New("github answered 502")
	})
	out, err := a.ApplyUpdate()
	if err != nil {
		t.Fatalf("a failing apply must resolve as a verdict (the modal's red panel), not a rejection: %v", err)
	}
	if out.OK || out.Message == "" {
		t.Fatalf("out=%+v — the message must carry the error for the modal", out)
	}

	// The honest timeout branch (updateDeadline is a VAR for exactly this).
	old := updateDeadline
	updateDeadline = 40 * time.Millisecond
	defer func() { updateDeadline = old }()
	a.SetUpdateApply(func(ctx context.Context, _ func(update.Progress)) (update.ApplyResult, error) {
		<-ctx.Done() // a download that outlives its window
		return update.ApplyResult{}, ctx.Err()
	})
	out, err = a.ApplyUpdate()
	if err != nil {
		t.Fatalf("the timeout must resolve as a verdict: %v", err)
	}
	if out.OK || out.Message == "" {
		t.Fatalf("out=%+v — the timeout message must be user-readable", out)
	}
	// Re-armed after the timeout.
	a.SetUpdateApply(func(context.Context, func(update.Progress)) (update.ApplyResult, error) {
		return update.ApplyResult{OK: true}, nil
	})
	if out, err = a.ApplyUpdate(); err != nil || !out.OK {
		t.Fatalf("after a timeout the guard must re-arm: out=%+v err=%v", out, err)
	}
}

func TestNotifyUpdateAvailableRefusesSilence(t *testing.T) {
	// The emitter must NOT fire for a not-available verdict — a boot-time
	// "no update" event would flash a pill that does not exist.
	a, _ := newBridge(t)
	var mu sync.Mutex
	fired := 0
	a.SetUpdateEmit(func(name string, _ map[string]any) {
		mu.Lock()
		defer mu.Unlock()
		fired++
	})
	a.NotifyUpdateAvailable(update.CheckResult{Available: false, Current: "0.1.14", Latest: "0.1.14"})
	mu.Lock()
	defer mu.Unlock()
	if fired != 0 {
		t.Fatalf("a not-available verdict must never fire the event (fired %d)", fired)
	}
}
