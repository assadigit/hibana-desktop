package ui

import (
	"errors"
	"strings"
	"sync"
	"testing"
)

// The S216 theme layer — 10 tests: normalization/validation, the flip +
// hooks choreography, the persist-failure-never-breaks-the-flip contract,
// the seed, and the serve-state (auth × theme) injection.

func TestNormalizeThemeAllowList(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{ThemeLight, ThemeLight},
		{ThemeDark, ThemeDark},
		{ThemeSystem, ThemeSystem},
		{"dark", ThemeDark}, // the legacy alias migrates once
		{"", ThemeSystem},
		{"garbage", ThemeSystem},
		{"CLAUDE-DARK", ThemeSystem},
	} {
		if got := NormalizeTheme(tc.in); got != tc.want {
			t.Fatalf("NormalizeTheme(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestThemePrefDefaultsAndNormalizesOnRead(t *testing.T) {
	a, _ := newBridge(t)
	if got := a.ThemePref(); got != ThemeSystem {
		t.Fatalf("a fresh bridge must read 'system' (the S87 default), got %q", got)
	}
	a.SetThemeSeed("dark") // a legacy meta row must normalize on read
	if got := a.ThemePref(); got != ThemeDark {
		t.Fatalf("seed 'dark' must read as the alias %q, got %q", ThemeDark, got)
	}
	a.SetThemeSeed("  ")
	if got := a.ThemePref(); got != ThemeSystem {
		t.Fatalf("garbage seed must read as system, got %q", got)
	}
}

func TestSetThemeValidates(t *testing.T) {
	a, _ := newBridge(t)
	// A hostile/garbage value from the JS boundary is rejected loudly.
	if _, err := a.SetTheme("nonsense"); err == nil {
		t.Fatal("SetTheme must reject a value outside the allow-list")
	}
	if got := a.ThemePref(); got != ThemeSystem {
		t.Fatalf("a rejected flip must not change the pref, got %q", got)
	}
	// The legacy alias passes.
	res, err := a.SetTheme("dark")
	if err != nil || !res.OK || res.Pref != ThemeDark {
		t.Fatalf("legacy alias flip: res=%+v err=%v", res, err)
	}
	if got := a.ThemePref(); got != ThemeDark {
		t.Fatalf("alias flip must land claude-dark, got %q", got)
	}
}

func TestSetThemeFlipFiresHooks(t *testing.T) {
	a, _ := newBridge(t)
	var mu sync.Mutex
	var persisted []string
	var emitted []string
	a.SetThemePersist(func(p string) error {
		mu.Lock()
		persisted = append(persisted, p)
		mu.Unlock()
		return nil
	})
	a.SetThemeChange(func(p string) {
		mu.Lock()
		emitted = append(emitted, p)
		mu.Unlock()
	})
	for _, p := range []string{ThemeLight, ThemeDark, ThemeSystem} {
		if _, err := a.SetTheme(p); err != nil {
			t.Fatalf("flip %s: %v", p, err)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(persisted, ",") != "light,claude-dark,system" {
		t.Fatalf("persist hook saw %v", persisted)
	}
	if strings.Join(emitted, ",") != "light,claude-dark,system" {
		t.Fatalf("change hook saw %v", emitted)
	}
}

func TestSetThemeSamePrefIsQuiet(t *testing.T) {
	a, _ := newBridge(t)
	calls := 0
	a.SetThemePersist(func(string) error { calls++; return nil })
	a.SetThemeChange(func(string) { calls++ })
	if _, err := a.SetTheme(ThemeSystem); err != nil { // already the pref
		t.Fatal(err)
	}
	if calls != 0 {
		t.Fatalf("a no-op flip must not fire hooks (fired %d)", calls)
	}
	if _, err := a.SetTheme(ThemeSystem); err != nil {
		t.Fatal(err)
	}
	if calls != 0 {
		t.Fatalf("repeated no-op flips must stay quiet (fired %d)", calls)
	}
}

func TestSetThemePersistFailureKeepsTheFlip(t *testing.T) {
	a, _ := newBridge(t)
	a.SetThemePersist(func(string) error { return errors.New("meta row locked") })
	res, err := a.SetTheme(ThemeDark)
	if err != nil || !res.OK {
		t.Fatalf("a persist failure must NEVER fail the flip: res=%+v err=%v", res, err)
	}
	if got := a.ThemePref(); got != ThemeDark {
		t.Fatalf("the live pref must hold the flip, got %q", got)
	}
}

func TestSetThemeSeedNeverPersistsOrEmits(t *testing.T) {
	a, _ := newBridge(t)
	calls := 0
	a.SetThemePersist(func(string) error { calls++; return nil })
	a.SetThemeChange(func(string) { calls++ })
	a.SetThemeSeed(ThemeDark)
	if calls != 0 {
		t.Fatalf("the boot seed must be silent (fired %d)", calls)
	}
	if got := a.ThemePref(); got != ThemeDark {
		t.Fatalf("seed must land, got %q", got)
	}
}

func TestInjectShellStateAuthAndTheme(t *testing.T) {
	for _, tc := range []struct {
		authed bool
		pref   string
		attrs  string
	}{
		{true, ThemeSystem, `data-desktop-authed="true" data-desktop-theme="system"`},
		{false, ThemeSystem, `data-desktop-authed="false" data-desktop-theme="system"`},
		{true, ThemeDark, `data-desktop-authed="true" data-desktop-theme="claude-dark" data-theme="claude-dark"`},
		{false, ThemeLight, `data-desktop-authed="false" data-desktop-theme="light" data-theme="light"`},
	} {
		out := string(InjectShellState([]byte(cannedIndex), tc.authed, tc.pref))
		if !strings.Contains(out, tc.attrs) {
			t.Fatalf("authed=%v pref=%s: %q missing in %q", tc.authed, tc.pref, tc.attrs, out)
		}
		if strings.Count(out, "data-desktop-theme") != 1 {
			t.Fatalf("theme attr injected more than once: %q", out)
		}
	}
}

func TestInjectShellStateSystemCarriesNoDataTheme(t *testing.T) {
	out := string(InjectShellState([]byte(cannedIndex), true, ThemeSystem))
	if strings.Contains(out, "data-theme=") {
		t.Fatalf("'system' must NOT carry data-theme (the OS resolves pre-paint): %q", out)
	}
	// A garbage pref normalizes to system → also no data-theme.
	out = string(InjectShellState([]byte(cannedIndex), true, "junk"))
	if strings.Contains(out, "data-theme=") {
		t.Fatalf("garbage pref must normalize to system (no data-theme): %q", out)
	}
	if !strings.Contains(out, `data-desktop-theme="system"`) {
		t.Fatalf("garbage pref must serve data-desktop-theme=system: %q", out)
	}
}

func TestInjectShellStateFailOpenOnMarkerDrift(t *testing.T) {
	// An island re-pin could change the <html> tag shape — the bytes must
	// pass through UNTOUCHED (fail-open; desktop-theme.js reads a missing
	// data-desktop-theme as 'system').
	drifted := []byte("<!doctype html>\n<html lang=\"en\" data-x=\"pin-drift\">\n</html>\n")
	out := InjectShellState(drifted, true, ThemeDark)
	if string(out) != string(drifted) {
		t.Fatalf("marker drift must pass through, got %q", out)
	}
}
