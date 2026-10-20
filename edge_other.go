//go:build !windows

// edge_other.go — the non-Windows half of the window-edge pair (ADR-001: the
// desktop app is Windows-only, but the module vets + tests + cross-builds
// from Linux — the theme_windows.go/theme_other.go precedent). The DWM
// corner pass has no meaning here: a no-op, so OnStartup's call site stays
// platform-uniform.
package main

// applyWindowEdge rounds the main window's corners via DWM on Windows 11+
// (edge_windows.go). Non-Windows hosts have no such edge — a silent no-op.
func applyWindowEdge() {}
