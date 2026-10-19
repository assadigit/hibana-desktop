//go:build !windows

// The non-Windows surface: the desktop app targets Windows only (ADR-001),
// but the module must still vet, test, and cross-build from the Linux CI
// side — Run is a loud no-op there, Stop a safe one. Never a stub on
// Windows itself: run_windows.go is the real implementation.
package tray

import "log"

// Run reports the tray as unsupported and returns. main.go turns the error
// into the close-to-tray safety: without a tray, the X button must quit.
func Run(cfg Config) error {
	log.Printf("hibana tray: unsupported on this platform — close button quits")
	return errTray{"tray: unsupported platform"}
}

// Stop is a no-op where there is no tray.
func Stop() {}
