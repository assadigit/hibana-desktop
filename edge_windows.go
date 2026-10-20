//go:build windows

// edge_windows.go — THE ROUNDED WINDOW EDGE (S222 — v0.1.10, the owner ask:
// "make the edge of app rounded and modern"): the native frame keeps every
// behavior (drag, resize, snap, the S214 close-to-tray contract) and gains
// the modern Windows 11 edge — DWM corner rounding, set EXPLICITLY so the
// look never depends on the OS policy du jour: DWMWA_WINDOW_CORNER_PREFERENCE
// takes the 22H2+ "large" DWMWCP_ROUND2 first, falls back to the 21H2
// DWMWCP_ROUND, and a pre-Win11 decline is logged and survived (Win10 has no
// corner API at all — the themed title bar from the CustomTheme block in
// main.go is that platform's half of the round).
//
// The HWND hunt: Wails v2 never hands the window handle to app code, so this
// finds it the plain Win32 way — FindWindowW by winc's registered class plus
// the exact window title, then a PID check so a same-titled window in ANOTHER
// process can never be touched. The class name is Wails v2.17's own (winc
// form.go registers "winc_Form" — verified in the module source); the title
// is options.Title verbatim.
//
// Same syscall discipline as theme_windows.go + internal/tray: lazy DLL
// procs, no new Go dependencies, every failure path a log line — never a
// broken window.
package main

import (
	"log"
	"syscall"
	"time"
	"unsafe"
)

// The FindWindowW needles — they MUST match the wails window's identity:
// edgeWindowTitle is options.Title verbatim, edgeWindowClass is winc's
// registered form class (wails v2.17 internal/frontend/desktop/windows/winc/
// form.go: RegClassOnlyOnce("winc_Form")). If either ever drifts, the probe
// below simply never finds the window and the corners stay OS-default —
// fail-visible in the log, never fail-broken.
const (
	edgeWindowClass  = "winc_Form"
	edgeWindowTitle  = "Hibana Kanban"
	edgeFindTries    = 50 // 50 × 100ms ≈ 5s — past any window-creation lag
	edgeFindInterval = 100 * time.Millisecond
)

// DWMWA_WINDOW_CORNER_PREFERENCE (attribute 33, Windows 11 22000+) and the
// documented DWM_WINDOW_CORNER_PREFERENCE values it takes. ROUND is the
// standard Win11 radius; ROUND2 is the 22H2+ larger radius.
const (
	dwmwaWindowCornerPreference uintptr = 33
	dwmwcpRound                         = int32(2)
	dwmwcpRound2                        = int32(3)
)

var (
	edgeUser32   = syscall.NewLazyDLL("user32.dll")
	edgeKernel32 = syscall.NewLazyDLL("kernel32.dll")
	edgeDwmapi   = syscall.NewLazyDLL("dwmapi.dll")

	procFindWindowW              = edgeUser32.NewProc("FindWindowW")
	procGetWindowThreadProcessId = edgeUser32.NewProc("GetWindowThreadProcessId")
	procGetCurrentProcessId      = edgeKernel32.NewProc("GetCurrentProcessId")
	procDwmSetWindowAttribute    = edgeDwmapi.NewProc("DwmSetWindowAttribute")
)

// findOwnWindow returns THIS process's main wails window, or 0 while it has
// not been created yet (the caller retries). FindWindowW walks top-level
// windows only, and the PID check turns the class+title pair into a
// process-unique match — a stray same-titled window elsewhere is ignored.
func findOwnWindow() uintptr {
	class, err := syscall.UTF16PtrFromString(edgeWindowClass)
	if err != nil {
		return 0
	}
	title, err := syscall.UTF16PtrFromString(edgeWindowTitle)
	if err != nil {
		return 0
	}
	hwnd, _, _ := procFindWindowW.Call(
		uintptr(unsafe.Pointer(class)),
		uintptr(unsafe.Pointer(title)))
	if hwnd == 0 {
		return 0
	}
	var pid uint32
	procGetWindowThreadProcessId.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	if pid == 0 {
		return 0
	}
	own, _, _ := procGetCurrentProcessId.Call()
	if uint32(own) != pid {
		return 0 // someone else's window — never touch it
	}
	return hwnd
}

// applyCornerPreference sets the DWM corner preference on one window.
// True when DWM accepted the value (ret == S_OK).
func applyCornerPreference(hwnd uintptr, pref int32) bool {
	ret, _, _ := procDwmSetWindowAttribute.Call(
		hwnd,
		dwmwaWindowCornerPreference,
		uintptr(unsafe.Pointer(&pref)),
		uintptr(unsafe.Sizeof(pref)))
	return ret == 0
}

// applyWindowEdge rounds the main window's corners (Windows 11+). Best-effort
// by design: every decline is a log line and the app stays fully usable with
// the OS-default frame. Runs in its own goroutine from OnStartup — the retry
// sleep must never stall the startup callback or the message loop.
func applyWindowEdge() {
	hwnd := uintptr(0)
	for i := 0; i < edgeFindTries; i++ {
		if hwnd = findOwnWindow(); hwnd != 0 {
			break
		}
		time.Sleep(edgeFindInterval)
	}
	if hwnd == 0 {
		log.Printf("hibana edge: window not found after %d tries — corners stay OS-default", edgeFindTries)
		return
	}
	// The modern look first: the 22H2+ larger radius, then the 21H2 radius,
	// and a pre-Win11 decline logged once (no API there — the CustomTheme
	// title bar from main.go is that platform's half of the round).
	switch {
	case applyCornerPreference(hwnd, dwmwcpRound2):
		log.Printf("hibana edge: window corners rounded (DWMWCP_ROUND2)")
	case applyCornerPreference(hwnd, dwmwcpRound):
		log.Printf("hibana edge: window corners rounded (DWMWCP_ROUND)")
	default:
		log.Printf("hibana edge: DWM declined corner rounding (pre-Win11?) — frame stays OS-default")
	}
}
