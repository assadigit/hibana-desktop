// Package quickaccess — the taskbar QUICK ACCESS round (the owner's ask:
// "Hibana desktop, even portable app, must have an automatic appearance in
// the taskbar (quick access) so next time windows runs it's easily
// accessible").
//
// The gap was real: the installed build's NSIS wizard drops a Start Menu
// shortcut, but the PORTABLE zip ships NO shortcuts at all — the exe lives in
// whatever folder the user unzipped it to, Windows Search cannot find it,
// and after a reboot nothing Hibana remains on the taskbar until the user
// remembers the folder path.
//
// This package closes it, per user (no UAC, no admin, WPP §1.1) and
// idempotent on every boot:
//
//  1. THE START MENU SHORTCUT — %APPDATA%\Microsoft\Windows\Start Menu\
//     Programs\Hibana Kanban.lnk → the exe (no arguments; a normal launch
//     opens the board window). Windows "All apps", Search, and the
//     taskbar's pin flow all see it — the easy access surface.
//  2. THE STARTUP SHORTCUT — %APPDATA%\Microsoft\Windows\Start Menu\
//     Programs\Startup\Hibana Kanban.lnk → the exe with --autostart, so
//     "next time Windows runs" Hibana boots itself to the TRAY (the
//     --autostart flag hides the window; the notification-area icon is
//     the taskbar presence) — one click on the tray icon and the board is
//     back.
//
// Both ride the same .lnk writer: a PowerShell helper (WScript.Shell COM —
// the apply_windows.go technique: named -File params, never a string-built
// command line). The DECISION of when to write is pure Go and unit-tested:
// a marker file in the DATA dir (never-mix rule — the data dir survives exe
// moves and updates) records the exe path + the startup-enabled state the
// shortcuts were built for; a marker that matches the current truth means
// ZERO PowerShell spawns on boot. A stale marker (the portable folder
// moved, the exe replaced at a new path, the startup toggle flipped)
// rebuilds them.
//
// The STARTUP half is user-controllable (the tray menu's "Start with
// Windows" checkable — default ON per the owner's "must have an automatic
// appearance"): SetStartup(false) removes the Startup .lnk + updates the
// marker; SetStartup(true) re-creates it.
package quickaccess

import "strings"

// AppName is the shortcut's visible name (Start Menu + Startup + the .lnk
// file names).
const AppName = "Hibana Kanban"

// AutostartFlag is the argument the Startup shortcut passes so the shell
// boots HIDDEN (main.go reads it: StartHidden — the tray icon is the visible
// presence, the board opens on the tray icon's click, like every tray-first
// app; a full window on every login would read as noise).
const AutostartFlag = "--autostart"

// markerFile is the data-dir sidecar recording the state the shortcuts were
// last written for (see ShouldEnsure).
const markerFile = "shortcuts.marker"

// ShortcutState is the pure decision input: the exe path the shortcuts
// would point at, and whether the Startup shortcut is wanted.
type ShortcutState struct {
	ExePath   string
	StartupOn bool
}

// ShouldEnsure is the pure boot decision: true when the shortcuts must be
// (re)written. The marker records one fact per line:
//
//	exe=<abs path>
//	startup=<0|1>
//
// A marker matching the CURRENT state means the .lnk files already tell the
// truth — no PowerShell spawn (boot stays quiet). Any divergence (missing
// marker, moved exe, flipped startup) rebuilds both.
func ShouldEnsure(marker string, want ShortcutState) bool {
	exe, startup, ok := parseMarker(marker)
	if !ok {
		return true
	}
	return exe != want.ExePath || startup != want.StartupOn
}

// MarkerFor renders the marker for a state (parseMarker's inverse).
func MarkerFor(s ShortcutState) string {
	startup := "0"
	if s.StartupOn {
		startup = "1"
	}
	return "exe=" + s.ExePath + "\nstartup=" + startup + "\n"
}

// parseMarker reads the marker's facts back. ok=false for anything that is
// not the exact two-line shape (missing, truncated, hand-mangled — all
// read as "rebuild").
func parseMarker(marker string) (exe string, startup bool, ok bool) {
	var exeLine, startupLine string
	for _, line := range strings.Split(marker, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "exe="):
			exeLine = strings.TrimSpace(strings.TrimPrefix(line, "exe="))
		case strings.HasPrefix(line, "startup="):
			startupLine = strings.TrimSpace(strings.TrimPrefix(line, "startup="))
		}
	}
	if exeLine == "" || (startupLine != "0" && startupLine != "1") {
		return "", false, false
	}
	return exeLine, startupLine == "1", true
}

// startupLnkName is the Startup shortcut's file name (shared by the windows
// writer + the tray toggle's probe so they can never drift).
func startupLnkName() string { return AppName + ".lnk" }
