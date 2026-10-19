// Package tray — the Windows notification-area ("system tray") icon for
// Hibana: the minimize-to-taskbar option the owner asked for (S214).
//
// Behavior: the tray icon is ALWAYS up while the app runs. Left-clicking it
// restores the window; right-clicking opens the menu —
//
//	Open Hibana            → show + focus the window
//	☑ Hide to tray on close → the persisted close-to-tray preference
//	Quit Hibana            → the real exit path
//
// The close preference itself is NOT owned here: main.go loads it from the
// mirror's meta table (key MetaKey), holds it in an atomic, and enforces it
// in Wails' OnBeforeClose — the X button hides the window to the tray when
// the preference is on (the default), quits when off. The tray only reads it
// (menu check state) and reports flips back through Config.OnToggle.
//
// The whole implementation is pure syscalls over user32/shell32 — the same
// technique as Wails' own winc layer — so the module adds ZERO dependencies
// (golang.org/x/sys was already in the tree). The Windows plumbing lives in
// run_windows.go; every other platform gets the run_other.go no-op so the
// module still vets, tests, and cross-builds from Linux.
package tray

// MetaKey is the mirror meta-table key main.go persists the preference
// under ("ui.hide_on_close": "1" on, "0" off).
const MetaKey = "ui.hide_on_close"

// Config wires the tray to the app. Every callback may be invoked from the
// tray's own OS thread — keep them quick and thread-safe.
type Config struct {
	// Icon is a full .ico file (the RT_GROUP_ICON resource format — the
	// same bytes as build/windows/icon.ico). Validated by parseICO before
	// any win32 call; an invalid icon is a hard error, never a silent
	// fallback to a blank tray tile.
	Icon []byte

	// Tooltip is the hover text (NIF_TIP; Windows truncates at 127 UTF-16
	// units — Run refuses longer).
	Tooltip string

	// IsOn reports the current close-to-tray preference (the menu item's
	// check state). Called on every right-click.
	IsOn func() bool

	// OnShow restores the window (left-click, double-click, "Open Hibana").
	OnShow func()

	// OnToggle records a preference flip made from the menu (on = the new
	// value). Main persists it under MetaKey.
	OnToggle func(on bool)

	// OnQuit is the real exit request ("Quit Hibana"). Main must bypass
	// OnBeforeClose (its quitRequested flag) and call runtime.Quit.
	OnQuit func()
}

// action is what a tray event means. The pure mapping (mouse message →
// action, menu command → action) is split out so it is unit-testable
// without a window; run_windows.go only translates actions into callbacks.
type action int

const (
	actNone   action = iota
	actShow          // restore the window
	actMenu          // show the context menu
	actToggle        // flip the close-to-tray preference
	actQuit          // exit the app
)

// The popup-menu command ids (TrackPopupMenuEx with TPM_RETURNCMD returns
// the id instead of posting WM_COMMAND).
const (
	cmdShow   = int32(1001) // "Open Hibana"
	cmdToggle = int32(1002) // "Hide to tray on close" (checkable)
	cmdQuit   = int32(1003) // "Quit Hibana"
)

// The classic (pre-NIF_VERSION_4) Shell_NotifyIcon mouse messages the tray
// window can receive. Only these four are meaningful; everything else
// (hover, move) maps to actNone.
const (
	msgLButtonUp     = uint32(0x0202) // WM_LBUTTONUP
	msgLButtonDblClk = uint32(0x0203) // WM_LBUTTONDBLCLK
	msgRButtonUp     = uint32(0x0205) // WM_RBUTTONUP
	msgContextMenu   = uint32(0x007B) // WM_CONTEXTMENU (v4-style sent by some shells)
)

// mouseAction maps a Shell_NotifyIcon callback message to its action.
func mouseAction(msg uint32) action {
	switch msg {
	case msgLButtonUp, msgLButtonDblClk:
		return actShow
	case msgRButtonUp, msgContextMenu:
		return actMenu
	default:
		return actNone
	}
}

// commandAction maps a TrackPopupMenuEx TPM_RETURNCMD result to its action.
func commandAction(id int32) action {
	switch id {
	case cmdShow:
		return actShow
	case cmdToggle:
		return actToggle
	case cmdQuit:
		return actQuit
	default:
		return actNone // 0 = dismissed without a choice
	}
}

// parseICO validates a .ico file far enough to trust CreateIconFromResourceEx
// with it: the 6-byte ICONDIR header (reserved 0, type 1 = icon, count ≥ 1)
// and that every 16-byte ICONDIRENTRY's image slice lies inside the buffer.
// It returns the frame count. It does NOT decode the images — that is the
// shell's job — but a corrupt header would make CreateIconFromResourceEx
// return a null HICON and leave a blank tray tile, which is worse than a
// loud early error.
func parseICO(b []byte) (int, error) {
	const (
		hdrLen = 6
		entLen = 16
	)
	if len(b) < hdrLen {
		return 0, errTray{"ico: shorter than the ICONDIR header"}
	}
	res, typ, cnt := uint16(b[0])|uint16(b[1])<<8, uint16(b[2])|uint16(b[3])<<8, int(b[4])|int(b[5])<<8
	if res != 0 {
		return 0, errTray{"ico: reserved must be 0"}
	}
	if typ != 1 {
		return 0, errTray{"ico: type must be 1 (icon)"}
	}
	if cnt < 1 {
		return 0, errTray{"ico: no frames"}
	}
	if len(b) < hdrLen+cnt*entLen {
		return 0, errTray{"ico: truncated directory entries"}
	}
	for i := 0; i < cnt; i++ {
		e := b[hdrLen+i*entLen : hdrLen+(i+1)*entLen]
		size := int(e[8]) | int(e[9])<<8 | int(e[10])<<16 | int(e[11])<<24
		off := int(e[12]) | int(e[13])<<8 | int(e[14])<<16 | int(e[15])<<24
		if off < hdrLen+cnt*entLen || off+size > len(b) {
			return 0, errTray{"ico: frame outside the buffer"}
		}
	}
	return cnt, nil
}

// HideOnCloseFromMeta resolves the persisted preference: anything but an
// explicit "0" means ON — the default IS close-to-tray (the owner asked
// for the behavior, so a missing/garbage value must not silently quit the
// app on X). main.go calls this once at boot from the meta row, then keeps
// the result in an atomic for the tray menu + OnBeforeClose reads.
func HideOnCloseFromMeta(v string, ok bool) bool {
	return !(ok && v == "0")
}

// errTray is the package's tiny error type (keeps the pure file free of a
// fmt dependency; run_windows.go errors are built the same way).
type errTray struct{ msg string }

func (e errTray) Error() string { return e.msg }
