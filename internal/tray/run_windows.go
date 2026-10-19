//go:build windows

// The Windows tray plumbing — pure syscalls over user32/shell32, no cgo, no
// new modules. The recipe is the well-trodden one Wails' own winc layer and
// getlantern/systray (read as reference, not imported) both use:
//
//   - a hidden top-level window (NOT HWND_MESSAGE — SetForegroundWindow +
//     TrackPopupMenu dismiss-on-outside-click need a real window) owning the
//     Shell_NotifyIcon callback;
//   - the ICONDIR bytes passed straight to CreateIconFromResourceEx (the
//     .ico file format IS the RT_GROUP_ICON resource format), sized to
//     SM_CXSMICON × SM_CYSMICON so the directory lookup picks the 16×16
//     frame at 100% DPI — with getlantern's temp-file LoadImageW path as
//     the fallback;
//   - TaskbarCreated (RegisterWindowMessage) → re-add the icon, so an
//     explorer.exe restart never orphans the tray;
//   - the popup menu rebuilt fresh on every right-click with
//     TrackPopupMenuEx(TPM_RETURNCMD), the KB135788 foreground fix around
//     it (SetForegroundWindow before, WM_NULL after);
//   - WM_CLOSE → DestroyWindow → WM_DESTROY → NIM_DELETE + PostQuitMessage,
//     reachable from any thread via Stop()'s PostMessage — that is the
//     app-shutdown path Wails' OnShutdown takes.
//
// Every mapping decision (which mouse message means what, which command id
// maps to which callback) lives in tray.go as pure functions with tests;
// this file only translates.
package tray

import (
	"fmt"
	"log"
	"os"
	"runtime"
	"sync/atomic"
	"syscall"
	"unsafe"
)

var (
	u32 = syscall.NewLazyDLL("user32.dll")
	k32 = syscall.NewLazyDLL("kernel32.dll")
	s32 = syscall.NewLazyDLL("shell32.dll")

	pRegisterClassExW         = u32.NewProc("RegisterClassExW")
	pCreateWindowExW          = u32.NewProc("CreateWindowExW")
	pDefWindowProcW           = u32.NewProc("DefWindowProcW")
	pGetMessageW              = u32.NewProc("GetMessageW")
	pTranslateMessage         = u32.NewProc("TranslateMessage")
	pDispatchMessageW         = u32.NewProc("DispatchMessageW")
	pPostQuitMessage          = u32.NewProc("PostQuitMessage")
	pPostMessageW             = u32.NewProc("PostMessageW")
	pDestroyWindow            = u32.NewProc("DestroyWindow")
	pRegisterWindowMessageW   = u32.NewProc("RegisterWindowMessageW")
	pCreateIconFromResourceEx = u32.NewProc("CreateIconFromResourceEx")
	pLoadImageW               = u32.NewProc("LoadImageW")
	pGetSystemMetrics         = u32.NewProc("GetSystemMetrics")
	pCreatePopupMenu          = u32.NewProc("CreatePopupMenu")
	pAppendMenuW              = u32.NewProc("AppendMenuW")
	pTrackPopupMenuEx         = u32.NewProc("TrackPopupMenuEx")
	pDestroyMenu              = u32.NewProc("DestroyMenu")
	pSetForegroundWindow      = u32.NewProc("SetForegroundWindow")
	pGetCursorPos             = u32.NewProc("GetCursorPos")
	pGetModuleHandleW         = k32.NewProc("GetModuleHandleW")
	pShellNotifyIconW         = s32.NewProc("Shell_NotifyIconW")
)

// winuser/winshell constants — the exact ones this file uses, nothing spare.
const (
	wmNull         = 0x0000 // the KB135788 menu-dismiss companion message
	wmDestroy      = 0x0002
	wmClose        = 0x0010
	wmApp          = 0x8000
	wmTrayCallback = wmApp + 1 // Shell_NotifyIcon's uCallbackMessage

	nimAdd     = 0x00000000
	nimDelete  = 0x00000002
	nifMessage = 0x00000001
	nifIcon    = 0x00000002
	nifTip     = 0x00000004

	smCXSMIcon = 49 // GetSystemMetrics: small-icon width  (tray tile at 100% DPI)
	smCYSMIcon = 50 // GetSystemMetrics: small-icon height

	imageIcon      = 1 // LoadImage type
	lrDefaultColor = 0x00000000
	lrLoadFromFile = 0x00000010

	mfString    = 0x00000000
	mfChecked   = 0x00000008
	mfSeparator = 0x00000800
	mfPopup     = 0x00000010 // a submenu: the id parameter carries the child-menu handle

	tpmReturnCmd   = 0x0100
	tpmRightAlign  = 0x0008
	tpmBottomAlign = 0x0020

	maxTipUTF16 = 127 // NOTIFYICONDATAW.szTip minus the terminator
)

// point — the win32 POINT (GetCursorPos / MSG.pt).
type point struct{ X, Y int32 }

// msg — the win32 MSG (GetMessage's out-buffer).
type msg struct {
	Hwnd    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      point
}

// wndClassEx — WNDCLASSEXW, field-for-field (Go's implicit padding matches
// the C x64 layout: uint32, uint32, then 8-byte fields — verified against
// Wails' own winc typedef.go).
type wndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   uintptr
	Icon       uintptr
	Cursor     uintptr
	Background uintptr
	MenuName   *uint16
	ClassName  *uint16
	IconSm     uintptr
}

// notifyIconData — NOTIFYICONDATAW, field-for-field in C order (the layout
// getlantern/systray ships on millions of Windows installs; the union members
// become their own fields). GuidItem as [16]byte: same bytes, same offset.
type notifyIconData struct {
	Size                       uint32
	Wnd                        uintptr
	ID, Flags, CallbackMessage uint32
	Icon                       uintptr
	Tip                        [128]uint16
	State, StateMask           uint32
	Info                       [256]uint16
	Timeout, Version           uint32
	InfoTitle                  [64]uint16
	InfoFlags                  uint32
	GuidItem                   [16]byte
	BalloonIcon                uintptr
}

// trayState is the package-level singleton — the wndProc callback receiver
// must stay alive and fixed for the process lifetime (syscall.NewCallback).
type trayState struct {
	cfg              Config
	hwnd             uintptr
	nid              notifyIconData
	wmTaskbarCreated uint32
}

var (
	state    trayState
	trayHwnd atomic.Uintptr // set once the window exists; Stop()'s handle from other threads
)

// Run starts the tray and blocks until Stop (or WM_DESTROY). Call it in a
// goroutine; it locks its own OS thread for the message loop.
func Run(cfg Config) error {
	if _, err := parseICO(cfg.Icon); err != nil {
		return fmt.Errorf("tray: %w", err)
	}
	if n := utf16Units(cfg.Tooltip); n > maxTipUTF16 {
		return fmt.Errorf("tray: tooltip is %d UTF-16 units, over the %d NIF_TIP limit", n, maxTipUTF16)
	}
	if cfg.OnShow == nil || cfg.OnToggle == nil || cfg.OnQuit == nil || cfg.IsOn == nil {
		return fmt.Errorf("tray: Config requires Icon, Tooltip, IsOn, OnShow, OnToggle, OnQuit")
	}

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	state.cfg = cfg
	if err := initInstance(); err != nil {
		return fmt.Errorf("tray: %w", err)
	}
	defer trayHwnd.Store(0)
	defer func() { state.hwnd = 0 }()
	messageLoop()
	return nil
}

// Stop tears the tray down from any thread (main calls it from Wails'
// OnShutdown). No-op when the tray never came up.
func Stop() {
	if h := trayHwnd.Load(); h != 0 {
		pPostMessageW.Call(h, wmClose, 0, 0)
	}
}

// utf16Units counts the UTF-16 units of s (the size limit is in UTF-16
// units, not runes — a rune above BMP costs two).
func utf16Units(s string) int {
	n := 0
	for range s {
		n++
	}
	for _, r := range s {
		if r > 0xFFFF {
			n++
		}
	}
	return n
}

// initInstance registers the class, creates the hidden window, loads the
// icon, and adds the Shell_NotifyIcon entry.
func initInstance() error {
	taskbarName, _ := syscall.UTF16PtrFromString("TaskbarCreated")
	tbMsg, _, _ := pRegisterWindowMessageW.Call(uintptr(unsafe.Pointer(taskbarName)))
	state.wmTaskbarCreated = uint32(tbMsg)

	instance, _, err := pGetModuleHandleW.Call(0)
	if instance == 0 {
		return fmt.Errorf("GetModuleHandleW: %v", err)
	}

	className, err := syscall.UTF16PtrFromString("HibanaTrayClass")
	if err != nil {
		return err
	}
	wc := wndClassEx{
		WndProc:   syscall.NewCallback(state.wndProc),
		Instance:  instance,
		ClassName: className,
	}
	wc.Size = uint32(unsafe.Sizeof(wc))
	if a, _, err := pRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc))); a == 0 {
		return fmt.Errorf("RegisterClassExW: %v", err)
	}

	// A hidden top-level window (never shown, style 0): NOT a message-only
	// HWND_MESSAGE child — the SetForegroundWindow + TrackPopupMenu dismiss
	// contract in showMenu needs a real window.
	windowName, _ := syscall.UTF16PtrFromString("HibanaTrayWindow")
	hwnd, _, err := pCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(windowName)),
		0, // hidden forever
		0, 0, 0, 0,
		0, 0,
		instance,
		0)
	if hwnd == 0 {
		return fmt.Errorf("CreateWindowExW: %v", err)
	}
	state.hwnd = hwnd
	trayHwnd.Store(hwnd)

	icon, err := createHICON(state.cfg.Icon)
	if err != nil {
		pDestroyWindow.Call(hwnd)
		state.hwnd = 0
		trayHwnd.Store(0)
		return err
	}

	state.nid = notifyIconData{
		Wnd:             hwnd,
		ID:              1,
		Flags:           nifMessage | nifIcon | nifTip,
		CallbackMessage: wmTrayCallback,
		Icon:            icon,
	}
	tip, _ := syscall.UTF16FromString(state.cfg.Tooltip)
	copy(state.nid.Tip[:], tip) // Run capped the length; UTF16FromString added the terminator
	state.nid.Size = uint32(unsafe.Sizeof(state.nid))

	if r, _, err := pShellNotifyIconW.Call(nimAdd, uintptr(unsafe.Pointer(&state.nid))); r == 0 {
		pDestroyWindow.Call(hwnd)
		state.hwnd = 0
		trayHwnd.Store(0)
		return fmt.Errorf("Shell_NotifyIconW NIM_ADD: %v", err)
	}
	return nil
}

// messageLoop is the classic GetMessage pump (getlantern's nativeLoop shape).
func messageLoop() {
	var m msg
	for {
		ret, _, err := pGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		switch int32(ret) {
		case -1:
			log.Printf("hibana tray: message loop error: %v", err)
			return
		case 0: // WM_QUIT
			return
		default:
			pTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
			pDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
		}
	}
}

// wndProc — the tray window's procedure. Runs on the tray's OS thread.
func (s *trayState) wndProc(hwnd uintptr, message uint32, wParam, lParam uintptr) uintptr {
	switch message {
	case wmTrayCallback:
		switch mouseAction(uint32(lParam)) {
		case actShow:
			s.cfg.OnShow()
		case actMenu:
			s.showMenu(hwnd)
		}
		return 0
	case wmClose:
		pDestroyWindow.Call(hwnd)
		return 0
	case wmDestroy:
		pShellNotifyIconW.Call(nimDelete, uintptr(unsafe.Pointer(&s.nid)))
		pPostQuitMessage.Call(0)
		return 0
	}
	if message == s.wmTaskbarCreated && s.wmTaskbarCreated != 0 {
		// explorer.exe restarted: the icon slot is gone, re-add it.
		pShellNotifyIconW.Call(nimAdd, uintptr(unsafe.Pointer(&s.nid)))
		return 0
	}
	r, _, _ := pDefWindowProcW.Call(hwnd, uintptr(message), wParam, lParam)
	return r
}

// showMenu builds the popup fresh at the cursor and dispatches the chosen
// command. TrackPopupMenuEx returns the id itself (TPM_RETURNCMD) so there
// is no WM_COMMAND round-trip.
func (s *trayState) showMenu(hwnd uintptr) {
	menu, _, _ := pCreatePopupMenu.Call()
	if menu == 0 {
		log.Printf("hibana tray: CreatePopupMenu failed")
		return
	}
	defer pDestroyMenu.Call(menu)

	appendMenu := func(flags uintptr, id int32, text string) {
		var p uintptr
		if text != "" {
			u16, err := syscall.UTF16PtrFromString(text)
			if err != nil {
				log.Printf("hibana tray: menu text: %v", err)
				return
			}
			p = uintptr(unsafe.Pointer(u16))
		}
		if r, _, _ := pAppendMenuW.Call(menu, flags, uintptr(id), p); r == 0 {
			log.Printf("hibana tray: AppendMenuW failed (id %d)", id)
		}
	}

	appendMenu(mfString, cmdShow, "Open Hibana")
	appendMenu(mfSeparator, 0, "")

	// THE THEME SUBMENU (S216 — v0.1.5): "Theme" → Light / Dark / Follow
	// system, radio-checked on the current choice via MF_CHECKED on exactly
	// one item. Built fresh per right-click like the rest of the menu; the
	// submenu rides the same SetTheme path the island toggles use.
	if s.cfg.ThemePref != nil && s.cfg.OnTheme != nil {
		sub, _, _ := pCreatePopupMenu.Call()
		if sub != 0 {
			current := themeChoice(s.cfg.ThemePref())
			themeItem := func(flags uintptr, id int32, text string) {
				var p uintptr
				if u16, err := syscall.UTF16PtrFromString(text); err == nil {
					p = uintptr(unsafe.Pointer(u16))
				}
				if r, _, _ := pAppendMenuW.Call(sub, flags, uintptr(id), p); r == 0 {
					log.Printf("hibana tray: AppendMenuW failed on the Theme submenu (id %d)", id)
				}
			}
			light := uintptr(mfString)
			dark := uintptr(mfString)
			system := uintptr(mfString)
			if current == cmdThemeLight {
				light |= mfChecked
			} else if current == cmdThemeDark {
				dark |= mfChecked
			} else {
				system |= mfChecked
			}
			themeItem(light, cmdThemeLight, "Light")
			themeItem(dark, cmdThemeDark, "Dark")
			themeItem(system, cmdThemeSystem, "Follow system")
			var p uintptr
			if u16, err := syscall.UTF16PtrFromString("Theme"); err == nil {
				p = uintptr(unsafe.Pointer(u16))
			}
			if r, _, _ := pAppendMenuW.Call(menu, uintptr(mfString|mfPopup), sub, p); r == 0 {
				log.Printf("hibana tray: AppendMenuW failed on the Theme popup")
			}
			appendMenu(mfSeparator, 0, "")
		}
	}

	toggle := uintptr(mfString)
	if s.cfg.IsOn() {
		toggle |= mfChecked
	}
	appendMenu(toggle, cmdToggle, "Hide to tray on close")
	appendMenu(mfSeparator, 0, "")
	appendMenu(mfString, cmdQuit, "Quit Hibana")

	var pt point
	if r, _, _ := pGetCursorPos.Call(uintptr(unsafe.Pointer(&pt))); r == 0 {
		log.Printf("hibana tray: GetCursorPos failed")
		return
	}
	// KB135788: without the foreground switch the menu won't dismiss when
	// the user clicks elsewhere; the WM_NULL lands the menu out of its
	// modal track.
	pSetForegroundWindow.Call(hwnd)
	cmd, _, _ := pTrackPopupMenuEx.Call(
		menu,
		tpmReturnCmd|tpmRightAlign|tpmBottomAlign,
		uintptr(pt.X), uintptr(pt.Y),
		hwnd, 0)
	pPostMessageW.Call(hwnd, wmNull, 0, 0)

	switch commandAction(int32(cmd)) {
	case actShow:
		s.cfg.OnShow()
	case actToggle:
		s.cfg.OnToggle(!s.cfg.IsOn())
	case actQuit:
		s.cfg.OnQuit()
	case actTheme:
		if pref, ok := commandThemePref(int32(cmd)); ok {
			s.cfg.OnTheme(pref)
		}
	}
}

// createHICON turns .ico bytes into an HICON sized for the tray. Primary:
// CreateIconFromResourceEx directly on the bytes (the .ico format IS the
// RT_GROUP_ICON resource format; the directory lookup inside picks the
// 16×16 frame for SM_CXSMICON). Fallback: getlantern's proven temp-file
// LoadImageW path. A null handle is an error, never a blank tile.
func createHICON(icon []byte) (uintptr, error) {
	cx, _, _ := pGetSystemMetrics.Call(smCXSMIcon)
	cy, _, _ := pGetSystemMetrics.Call(smCYSMIcon)
	if cx == 0 {
		cx, cy = 16, 16
	}
	_ = icon[len(icon)-1] // pin the slice for the duration of the call below
	h, _, _ := pCreateIconFromResourceEx.Call(
		uintptr(unsafe.Pointer(&icon[0])),
		uintptr(len(icon)),
		1,          // fIcon = TRUE
		0x00030000, // the RT_GROUP_ICON version Windows has shipped since 3.0
		cx, cy,
		lrDefaultColor)
	if h != 0 {
		return h, nil
	}

	f, err := os.CreateTemp("", "hibana-tray-*.ico")
	if err != nil {
		return 0, fmt.Errorf("icon (in-memory failed, temp: %v)", err)
	}
	name := f.Name()
	defer os.Remove(name)
	if _, err := f.Write(icon); err != nil {
		f.Close()
		return 0, fmt.Errorf("icon (in-memory failed, temp write: %v)", err)
	}
	f.Close()
	np, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return 0, fmt.Errorf("icon (in-memory failed, path: %v)", err)
	}
	h, _, _ = pLoadImageW.Call(0, uintptr(unsafe.Pointer(np)), imageIcon, cx, cy, lrLoadFromFile)
	if h == 0 {
		return 0, fmt.Errorf("icon failed both in-memory (CreateIconFromResourceEx) and file (LoadImageW) paths")
	}
	return h, nil
}
