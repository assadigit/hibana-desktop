//go:build windows

// theme_windows.go — the BOOT WINDOW BACKGROUND (S216 — v0.1.5): the frame
// the WebView paints over before any HTML loads must match the resolved
// look, or a dark-mode OS would flash white on every launch. The colors are
// the CSS's own tokens (themes.css): light --bg #E7E7E7, dark --bg #141413.
//
// 'system' resolves against HKCU\...\Themes\Personalize!AppsUseLightTheme
// (the Windows app-mode DWORD: 1 = light apps, 0 = dark apps) — read via
// pure advapi32 syscalls, ZERO new dependencies (the same discipline as
// internal/tray; golang.org/x/sys stays indirect). A missing value or any
// registry trouble reads as LIGHT — the pre-v0.1.5 baseline, never a
// regression.
package main

import (
	"syscall"
	"unsafe"

	"github.com/wailsapp/wails/v2/pkg/options"

	"hibana/desktop/internal/ui"
)

// The two looks, from the island's own themes.css (--bg tokens).
var (
	bootBgDark  = options.RGBA{R: 0x14, G: 0x14, B: 0x13, A: 255} // #141413
	bootBgLight = options.RGBA{R: 0xE7, G: 0xE7, B: 0xE7, A: 255} // #E7E7E7
)

var (
	advapi32          = syscall.NewLazyDLL("advapi32.dll")
	pRegOpenKeyExW    = advapi32.NewProc("RegOpenKeyExW")
	pRegQueryValueExW = advapi32.NewProc("RegQueryValueExW")
	pRegCloseKey      = advapi32.NewProc("RegCloseKey")

	// Personalize is the Windows app-mode key (the Theme settings page's
	// backing store). Pre-composed UTF-16 so the read is one Open + one Query.
	themeKeyPath, _   = syscall.UTF16PtrFromString(`Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`)
	themeValueName, _ = syscall.UTF16PtrFromString("AppsUseLightTheme")

	keyQueryValue = uintptr(0x0001) // KEY_QUERY_VALUE
	regDword      = uint32(4)       // REG_DWORD (the type RegQueryValueExW reports)
)

// appsUseLightTheme reads the OS app-mode (true = light apps). Missing key,
// missing value, wrong type, or any syscall trouble → true (the historical
// light baseline; a registry hiccup must never flash the wrong look).
func appsUseLightTheme() bool {
	var key uintptr
	if r, _, _ := pRegOpenKeyExW.Call(0xFFFFFFFF, // HKEY_CURRENT_USER
		uintptr(unsafe.Pointer(themeKeyPath)), 0, keyQueryValue,
		uintptr(unsafe.Pointer(&key))); r != 0 || key == 0 {
		return true
	}
	defer pRegCloseKey.Call(key)
	var (
		val     uint32
		valSize uint32 = 4
		valType uint32
	)
	r, _, _ := pRegQueryValueExW.Call(key,
		uintptr(unsafe.Pointer(themeValueName)), 0,
		uintptr(unsafe.Pointer(&valType)),
		uintptr(unsafe.Pointer(&val)), uintptr(unsafe.Pointer(&valSize)))
	if r != 0 || valType != regDword {
		return true
	}
	return val != 0
}

// resolveBootBackground maps the stored theme preference to the pre-WebView
// frame color: explicit prefs paint directly; 'system' asks the OS.
func resolveBootBackground(pref string) options.RGBA {
	switch pref {
	case ui.ThemeDark:
		return bootBgDark
	case ui.ThemeLight:
		return bootBgLight
	default: // 'system' (and any garbage — same read as the served default)
		if appsUseLightTheme() {
			return bootBgLight
		}
		return bootBgDark
	}
}
