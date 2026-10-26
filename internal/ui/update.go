package ui

import (
	"context"
	"fmt"
	"time"

	"hibana/desktop/internal/update"
)

// THE AUTO-UPDATE BINDINGS (v0.1.14 — the owner ask: "Add an auto update for
// the app. when the new version releases in the github, app syncs with the
// internet and github, and if new version, whether portable or installer
// released, show a button for update. it must update from github and replace
// without losing data or needing user to re login."). This file is the
// BRIDGE HALF — the busy guards, the deadline, the event relays, and the
// cached check verdict; the download/verify/replace core lives in
// internal/update, the shell's wiring in main.go:
//
//      SetUpdateCheck → updater.Check (GitHub /releases/latest vs main.Version)
//      SetUpdateEmit  → EventsEmit "hibana:update-available" {…CheckResult} +
//                       EventsEmit "hibana:update-progress" {stage,received,total,pct}
//      SetUpdateApply → updater.Prepare + updater.Apply, then the shell's
//                       restart (quitRequested + Quit — the close-to-tray
//                 contract must NOT intercept an update restart)
//
// The island half (js/desktop-update.js via the island sync) listens for
// hibana:update-available to show the toolbar's Update pill + this modal.
//
// ZERO arguments cross either binding (nothing hostile to validate — the
// same discipline as SyncNow/Logout): the check reads the -X stamped
// main.Version Go-side, the apply re-fetches the release Go-side and re-earns
// its verdict; the cached CheckResult is display state only, never authority.

// updateDeadline bounds one ApplyUpdate round: download + verify of a 5-8MB
// asset on a slow link. A VAR so the timeout branch is testable in
// milliseconds (the syncDeadline precedent).
var updateDeadline = 45 * time.Minute

// updateEventAvailable / updateEventProgress are the two Wails events the
// island controller subscribes to (the names are its contract, like
// hibana:sync-progress).
const (
	updateEventAvailable = "hibana:update-available"
	updateEventProgress  = "hibana:update-progress"
)

// SetUpdateCheck wires the release check (main.go: updater.Check — a live
// GitHub round-trip against the -X stamped version). Without it
// CheckForUpdates resolves as not-wired.
func (a *API) SetUpdateCheck(fn func(ctx context.Context) (update.CheckResult, error)) {
	a.updateMu.Lock()
	a.updateCheck = fn
	a.updateMu.Unlock()
}

// SetUpdateApply wires the apply round (main.go: updater.Prepare — download +
// the checksums chain — then updater.Apply — the detached helper — and the
// shell's own restart scheduling).
func (a *API) SetUpdateApply(fn func(ctx context.Context, progress func(update.Progress)) (update.ApplyResult, error)) {
	a.updateMu.Lock()
	a.updateApply = fn
	a.updateMu.Unlock()
}

// SetUpdateEmit wires the event relay (main.go: EventsEmit — the ONLY way the
// bridge's goroutines reach the WebView).
func (a *API) SetUpdateEmit(fn func(name string, payload map[string]any)) {
	a.updateMu.Lock()
	a.updateEmit = fn
	a.updateMu.Unlock()
}

// SetUpdateOpenURL wires the MANUAL-FALLBACK browser open (v0.1.19 — the
// owner ask: "auto-open release page when an apply fails": main.go passes
// wailsruntime.BrowserOpenURL over the same appCtx the emit/quit relays
// ride). Every FAILED apply verdict opens the release's human page, so a
// machine the auto-round cannot finish on — no shell interpreter for the
// swap helper, a link that died mid-download, a tamper refusal — still
// gets the human path with zero extra clicks. Without the hook the reflex
// degrades quietly (the verdict is the truth; the page claim stays false).
func (a *API) SetUpdateOpenURL(fn func(url string)) {
	a.updateMu.Lock()
	a.updateOpenURL = fn
	a.updateMu.Unlock()
}

// NotifyUpdateAvailable caches a fresh check verdict and relays it to the
// island (the toolbar pill is born). Exported so the shell's periodic loop
// can run its check through the updater and still emit through the bridge's
// single relay — the same event the bound CheckForUpdates fires, so the
// island has ONE contract.
func (a *API) NotifyUpdateAvailable(res update.CheckResult) {
	a.updateMu.Lock()
	a.updateLast = res
	a.updateHasLast = true
	emit := a.updateEmit
	a.updateMu.Unlock()
	if res.Available && emit != nil {
		emit(updateEventAvailable, map[string]any{
			"available": res.Available,
			"current":   res.Current,
			"latest":    res.Latest,
			"kind":      res.Kind,
			"size":      res.Size,
			"notes":     res.Notes,
			"url":       res.URL,
		})
	}
}

// CheckForUpdates is the bound check the shell loop and any future surface
// call. Single-flight via the same updateBusy guard as the apply (a check is
// a live HTTP round-trip — two in parallel buy nothing), re-armed on every
// exit path. The result: on a newer release the verdict is cached + the
// event fires; on no-update or error the island stays quiet (an offline
// check must never claim "no update" either way — it simply didn't happen,
// the error rides out to the caller who logs it).
func (a *API) CheckForUpdates() (update.CheckResult, error) {
	if !a.updateBusy.CompareAndSwap(false, true) {
		return update.CheckResult{}, fmt.Errorf("bridge: update: a check or update is already running")
	}
	defer a.updateBusy.Store(false)

	a.updateMu.Lock()
	check := a.updateCheck
	a.updateMu.Unlock()
	if check == nil {
		return update.CheckResult{}, fmt.Errorf("bridge: update: not wired")
	}

	ctx, cancel := context.WithTimeout(context.Background(), checkTimeoutBound())
	defer cancel()
	res, err := check(ctx)
	if err != nil {
		return res, fmt.Errorf("bridge: update: %w", err)
	}
	if res.Available {
		a.NotifyUpdateAvailable(res)
	}
	return res, nil
}

// checkTimeoutBound isolates the round's window (the check's own 15s HTTP
// deadline inside internal/update; the context belt is for a hook that
// misbehaves).
func checkTimeoutBound() time.Duration { return 30 * time.Second }

// ApplyUpdate is the bound apply the modal's "Update now" calls. Single-flight
// with the check (a download while a check runs is fine to refuse — the
// check finishes in seconds), re-armed on every exit path. Requires a cached
// AVAILABLE verdict (the pill only exists after one, so the modal is only
// reachable with one — the belt refuses a stale call anyway).
//
// On success the result is {ok:true}: the helper is spawned and the shell is
// about to quit — the modal paints its "restarting…" panel and the app exits
// (the data dir — session, mirror, logs — is never on the replace path, so
// the relaunched exe boots straight back into the board: no re-login).
func (a *API) ApplyUpdate() (update.ApplyResult, error) {
	if !a.updateBusy.CompareAndSwap(false, true) {
		return update.ApplyResult{Message: "busy"}, nil
	}
	defer a.updateBusy.Store(false)

	a.updateMu.Lock()
	apply := a.updateApply
	emit := a.updateEmit
	last, lastOK := a.updateLast, a.updateHasLast
	a.updateMu.Unlock()
	if apply == nil {
		return update.ApplyResult{}, fmt.Errorf("bridge: update: not wired")
	}
	if !lastOK || !last.Available {
		return update.ApplyResult{Message: "no update is available"}, nil
	}
	_ = last // display state only — the apply re-fetches and re-earns everything

	ctx, cancel := context.WithTimeout(context.Background(), updateDeadline)
	defer cancel()
	relay := func(p update.Progress) {
		if emit != nil {
			emit(updateEventProgress, map[string]any{
				"stage":    p.Stage,
				"received": p.Received,
				"total":    p.Total,
				"pct":      p.Pct,
			})
		}
	}
	out, err := apply(ctx, relay)
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			// The honest timeout: the download ran out of its window
			// (nothing was applied; the staged bytes clean themselves).
			res := update.ApplyResult{Message: "the update download timed out — try again"}
			res.PageOpened = a.openReleasePage(last)
			return res, nil
		}
		res := update.ApplyResult{Message: err.Error()}
		res.PageOpened = a.openReleasePage(last)
		return res, nil
	}
	if !out.OK {
		// A failure verdict the hook resolved (the shipped hook wraps every
		// Prepare/Apply failure into a message) — the same manual-fallback
		// reflex fires; the busy and no-update verdicts above are NOT
		// failures and never open anything.
		out.PageOpened = a.openReleasePage(last)
	}
	return out, nil
}

// openReleasePage is the v0.1.19 manual-fallback reflex: every FAILED apply
// verdict opens the cached check's release page (the CheckResult's own
// deep link — ReleasePageURL(repo), no network needed) through the wired
// browser hook. Reports whether the open actually happened, so the verdict
// never claims a page the machine never saw. A missing URL or an unwired
// hook degrades to false — the error message still names the release page
// (the v0.1.18 apply errors already do).
func (a *API) openReleasePage(res update.CheckResult) bool {
	if !res.Available || res.URL == "" {
		return false
	}
	a.updateMu.Lock()
	open := a.updateOpenURL
	a.updateMu.Unlock()
	if open == nil {
		return false
	}
	open(res.URL)
	return true
}
