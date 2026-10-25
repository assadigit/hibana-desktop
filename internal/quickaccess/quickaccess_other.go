//go:build !windows

// The non-Windows ladder: quick access IS a Windows shell concept (Start
// Menu + Startup .lnk + the tray) — on every other platform this package is
// a pure no-op so the module still vets, tests, and cross-builds from Linux
// (the tray package's run_other.go precedent).
package quickaccess

import "errors"

// ErrNoQuickAccess is the single honest verdict off Windows.
var ErrNoQuickAccess = errors.New("quickaccess: not available on this platform")

// Ensure is a no-op off Windows.
func Ensure(exePath, dataDir string, startupOn bool) error { return nil }

// SetStartup is a no-op off Windows.
func SetStartup(on bool, exePath, dataDir string) error { return nil }

// StartupLnkPath always reports absent off Windows (the tray menu is only
// built on Windows anyway — run_windows.go owns the menu).
func StartupLnkPath() (string, error) { return "", ErrNoQuickAccess }
