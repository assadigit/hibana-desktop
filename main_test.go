package main

import (
	"testing"

	"github.com/wailsapp/wails/v2/pkg/options/windows"

	"hibana/desktop/internal/ui"
)

// TestChromeThemeFor pins the pref→chrome map (S222 — the merged chrome):
// callers pass ALREADY-NORMALIZED values (ui.NormalizeTheme output — the
// boot read, the SetTheme binding, the change hook), so the legacy 'dark'
// alias and any garbage land on 'system' here BY CONTRACT — the same
// fail-visible default every other theme surface uses.
func TestChromeThemeFor(t *testing.T) {
	cases := []struct {
		pref string
		want windowChromeTheme
	}{
		{ui.ThemeDark, chromeDark},   // 'claude-dark' — the stored dark look
		{ui.ThemeLight, chromeLight}, // 'light'
		{ui.ThemeSystem, chromeFollowsSystem},
		{"dark", chromeFollowsSystem}, // the legacy alias — normalized upstream, never reaches here raw
		{"", chromeFollowsSystem},     // missing
		{"garbage", chromeFollowsSystem},
	}
	for _, tc := range cases {
		if got := chromeThemeFor(tc.pref); got != tc.want {
			t.Errorf("chromeThemeFor(%q) = %v, want %v", tc.pref, got, tc.want)
		}
	}
}

// TestBootWindowTheme pins the boot seeding of the wails window Theme (the
// options block resolves it before wails.Run so the very first frame never
// wears the OS scheme's bar).
func TestBootWindowTheme(t *testing.T) {
	cases := []struct {
		pref string
		want windows.Theme
	}{
		{ui.ThemeDark, windows.Dark},
		{ui.ThemeLight, windows.Light},
		{ui.ThemeSystem, windows.SystemDefault},
		{"dark", windows.SystemDefault}, // legacy alias — normalized upstream
		{"", windows.SystemDefault},
		{"garbage", windows.SystemDefault},
	}
	for _, tc := range cases {
		if got := bootWindowTheme(tc.pref); got != tc.want {
			t.Errorf("bootWindowTheme(%q) = %v, want %v", tc.pref, got, tc.want)
		}
	}
}
