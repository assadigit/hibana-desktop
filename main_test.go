package main

import (
	"testing"

	"github.com/wailsapp/wails/v2/pkg/options/windows"

	"hibana/desktop/internal/quickaccess"
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

// TestHasAutostartFlag — the quick-access boot decision: the Startup
// shortcut's exact flag (and only it — a lookalike or a flag buried in a
// different argument never counts) boots hidden to the tray.
func TestHasAutostartFlag(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want bool
	}{
		{"the startup shortcut's boot", []string{quickaccess.AutostartFlag}, true},
		{"flags around it still find it", []string{"--portable", quickaccess.AutostartFlag}, true},
		{"a manual launch shows the window", []string{}, false},
		{"a portable manual launch shows the window", []string{"--portable"}, false},
		{"a lookalike never counts", []string{"--autostart=1"}, false},
		{"a value-carrying flag never counts", []string{"--flag", "value", "--other"}, false},
	}
	for _, tc := range cases {
		if got := hasAutostartFlag(tc.args); got != tc.want {
			t.Errorf("%s: hasAutostartFlag(%v) = %v, want %v", tc.name, tc.args, got, tc.want)
		}
	}
}

// TestStartupPreference — the persisted start-with-Windows preference
// (the owner's "must have an automatic appearance" is the DEFAULT: only an
// explicit opt-out counts, the same grammar as the close-to-tray pref).
func TestStartupPreference(t *testing.T) {
	cases := []struct {
		v    string
		ok   bool
		want bool
	}{
		{"", false, true},  // no row yet — default ON
		{"", true, true},   // an empty row reads as ON
		{"1", true, true},  // an explicit ON
		{"0", true, false}, // the explicit opt-out
		{"garbage", true, true},
		{"garbage", false, true},
	}
	for _, tc := range cases {
		if got := startupPreference(tc.v, tc.ok); got != tc.want {
			t.Errorf("startupPreference(%q, %v) = %v, want %v", tc.v, tc.ok, got, tc.want)
		}
	}
}
