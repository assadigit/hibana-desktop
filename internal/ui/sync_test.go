package ui

import (
	"context"
	"sync"
	"testing"
	"time"

	hibanasync "hibana/desktop/internal/sync"
)

// The S217 SyncNow binding — the busy guard, the emit relay, the deadline,
// the not-wired verdict, and the re-arm contract on every exit path.

func TestSyncNowNotWired(t *testing.T) {
	a, _ := newBridge(t)
	// No SetSyncRun: the promise must reject so the modal shows its own
	// "The desktop bridge is not wired — restart the app." panel.
	if _, err := a.SyncNow(); err == nil {
		t.Fatal("SyncNow without a runner must reject the JS promise")
	}
}

func TestSyncNowRelaysTheTransitions(t *testing.T) {
	a, _ := newBridge(t)
	var mu sync.Mutex
	var saw []string
	a.SetSyncEmit(func(step, state, detail string) {
		mu.Lock()
		saw = append(saw, step+":"+state+":"+detail)
		mu.Unlock()
	})
	a.SetSyncRun(func(ctx context.Context, emit hibanasync.Emit) (hibanasync.RoundOutcome, error) {
		emit(hibanasync.StepConnect, hibanasync.StateActive, "hibana.ir")
		emit(hibanasync.StepConnect, hibanasync.StateDone, "signed in as user@example.com")
		return hibanasync.RoundOutcome{OK: true, Code: hibanasync.OutcomeOK}, nil
	})
	out, err := a.SyncNow()
	if err != nil || !out.OK {
		t.Fatalf("out=%+v err=%v", out, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(saw) != 2 || saw[0] != "connect:active:hibana.ir" || saw[1] != "connect:done:signed in as user@example.com" {
		t.Fatalf("the relay must carry every transition verbatim: %v", saw)
	}
}

func TestSyncNowBusyGuardAndRearm(t *testing.T) {
	a, _ := newBridge(t)
	release := make(chan struct{})
	started := make(chan struct{})
	var once sync.Once
	a.SetSyncRun(func(ctx context.Context, emit hibanasync.Emit) (hibanasync.RoundOutcome, error) {
		once.Do(func() { close(started) })
		<-release // hold the round open so the busy path is provable (later rounds read it closed: instant)
		return hibanasync.RoundOutcome{OK: true, Code: hibanasync.OutcomeOK}, nil
	})
	go a.SyncNow()
	<-started

	// Second click while the round runs → the honest busy verdict, no panic.
	out, err := a.SyncNow()
	if err != nil || out.OK || out.Code != "busy" {
		t.Fatalf("second click: out=%+v err=%v, want {code:busy}", out, err)
	}
	close(release)
	time.Sleep(50 * time.Millisecond) // let the first round finish + re-arm

	// The guard RE-ARMS: a finished round can always start a new one.
	out, err = a.SyncNow()
	if err != nil || !out.OK || out.Code != hibanasync.OutcomeOK {
		t.Fatalf("after completion: out=%+v err=%v, want a fresh ok round", out, err)
	}
}

func TestSyncNowTimeoutIsHonestAndRearms(t *testing.T) {
	a, _ := newBridge(t)
	// syncDeadline is a VAR precisely so this branch is testable fast.
	old := syncDeadline
	syncDeadline = 40 * time.Millisecond
	defer func() { syncDeadline = old }()

	a.SetSyncRun(func(ctx context.Context, emit hibanasync.Emit) (hibanasync.RoundOutcome, error) {
		<-ctx.Done() // a round that outlives its window (a relogin that never came)
		return hibanasync.RoundOutcome{}, ctx.Err()
	})
	out, err := a.SyncNow()
	if err != nil {
		t.Fatalf("a timeout must resolve as an outcome, not a rejection: %v", err)
	}
	if out.OK || out.Code != hibanasync.OutcomeError {
		t.Fatalf("out=%+v, want the honest timeout error verdict", out)
	}
	if out.Message == "" {
		t.Fatal("the timeout message must be user-readable (the modal's red panel)")
	}

	// Re-armed: the next call runs.
	a.SetSyncRun(func(ctx context.Context, emit hibanasync.Emit) (hibanasync.RoundOutcome, error) {
		return hibanasync.RoundOutcome{OK: true, Code: hibanasync.OutcomeOK}, nil
	})
	out, err = a.SyncNow()
	if err != nil || !out.OK {
		t.Fatalf("after a timeout the guard must re-arm: out=%+v err=%v", out, err)
	}
}

func TestSyncNowMapsRunnerVerdictsVerbatim(t *testing.T) {
	a, _ := newBridge(t)
	// Every honest outcome the engine can produce resolves to the modal's
	// panel contract verbatim — busy lives in the same namespace too.
	for _, tc := range []struct {
		run  hibanasync.RoundOutcome
		want hibanasync.RoundOutcome
	}{
		{hibanasync.RoundOutcome{OK: true, Code: hibanasync.OutcomeOK, Uploaded: 3, Projects: 2, Boards: 2},
			hibanasync.RoundOutcome{OK: true, Code: hibanasync.OutcomeOK, Uploaded: 3, Projects: 2, Boards: 2}},
		{hibanasync.RoundOutcome{Code: hibanasync.OutcomeSession}, hibanasync.RoundOutcome{Code: hibanasync.OutcomeSession}},
		{hibanasync.RoundOutcome{Code: hibanasync.OutcomePending, Message: "still uploading"},
			hibanasync.RoundOutcome{Code: hibanasync.OutcomePending, Message: "still uploading"}},
	} {
		out := tc.run // capture
		a.SetSyncRun(func(context.Context, hibanasync.Emit) (hibanasync.RoundOutcome, error) { return out, nil })
		got, err := a.SyncNow()
		if err != nil {
			t.Fatalf("verdict %s: %v", out.Code, err)
		}
		if got.OK != tc.want.OK || got.Code != tc.want.Code || got.Uploaded != tc.want.Uploaded ||
			got.Projects != tc.want.Projects || got.Boards != tc.want.Boards || got.Message != tc.want.Message {
			t.Fatalf("verdict %s: got %+v, want %+v", out.Code, got, tc.want)
		}
	}
}
