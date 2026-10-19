package ui

import (
	"log"
	"sync"
)

// THE DESKTOP THEME (S216 — "The app doesnt have darkmode, add dark mode
// and it's toggle"): the app ships the WEB'S OWN two looks — light and
// claude-dark (S87: a CSS token swap; themes.css + claude-dark-theme.css
// ship in the island VERBATIM) — plus 'system' as the default (the web's
// own default).
//
// ONE SOURCE OF TRUTH: the mirror's meta row ui.theme
// ('light' | 'claude-dark' | 'system'; the legacy value 'dark' migrates to
// 'claude-dark' once). The Go shell owns the preference end to end:
//
//   - the SERVED document carries it as data-desktop-theme on <html>
//     (InjectShellState — a ZERO-JS first paint; explicit prefs ALSO carry
//     data-theme so the look paints before any script runs; 'system' lets
//     js/desktop-theme.js resolve the OS scheme pre-paint, boot.js S87
//     byte-parity);
//   - the island's TWO toggle surfaces (the login gate's .theme-floater +
//     the board toolbar's #db-theme-toggle) call the SetTheme binding at
//     CLICK time (optimistic apply — a dead bridge never breaks the flip);
//   - the TRAY's Theme submenu (Light / Dark / Follow system, radio-checked)
//     rides the same path, then emits hibana:theme so the LIVE document
//     flips without a reload.
//
// NO localStorage anywhere: the desktop pref never forks from the meta row
// (the web's 'hibana-theme' key stays web-only).
const (
	// ThemeMetaKey is the mirror meta-table row the preference persists
	// under ("ui.theme"). main.go seeds the bridge from it at boot and
	// wires the persist hook back to the same row.
	ThemeMetaKey = "ui.theme"

	// ThemeDark / ThemeLight / ThemeSystem — the allow-list, exactly the
	// web's own vocabulary (app.js:181-182, boot.js S87).
	ThemeDark   = "claude-dark"
	ThemeLight  = "light"
	ThemeSystem = "system"
)

// themeMu guards pref (SetTheme is callable from the WebView thread while
// the tray thread asks ThemePref for the radio state — same discipline as
// the auth state).
type themeState struct {
	mu   sync.Mutex
	pref string

	// persist writes the meta row (main.go wires mirror.SetMeta). A
	// persist failure is LOGGED, never a failed flip — the live document
	// already changed and the next boot re-reads the last persisted value;
	// refusing the flip over a meta write would make the toggle feel broken.
	persist func(pref string) error
	// change fires after a successful flip (main.go emits hibana:theme so
	// the live document follows without a reload; the tray menu re-reads
	// ThemePref for its radio state on the next open).
	change func(pref string)
}

// NormalizeTheme is the single validation point for a stored-or-incoming
// preference: the allow-list plus the legacy alias. A garbage/missing value
// resolves to 'system' (the web's own default — S87), NEVER an error: a
// corrupt meta row must not lock the app into one look.
func NormalizeTheme(pref string) string {
	switch pref {
	case ThemeDark, ThemeLight, ThemeSystem:
		return pref
	case "dark":
		return ThemeDark // the legacy alias from before the vocabulary settled
	default:
		return ThemeSystem
	}
}

// ThemePref reports the live preference (the tray's radio state + the
// served document's data-desktop-theme). Normalized on read.
func (a *API) ThemePref() string {
	a.theme.mu.Lock()
	defer a.theme.mu.Unlock()
	return NormalizeTheme(a.theme.pref)
}

// SetThemeSeed plants the boot preference (main.go reads the meta row).
// Seeds do NOT persist or emit — the row already exists and no document is
// live yet.
func (a *API) SetThemeSeed(pref string) {
	a.theme.mu.Lock()
	a.theme.pref = NormalizeTheme(pref)
	a.theme.mu.Unlock()
}

// SetThemePersist wires the meta-row writer. Optional: without it flips
// apply + emit but do not survive a restart (tests).
func (a *API) SetThemePersist(fn func(pref string) error) {
	a.theme.mu.Lock()
	a.theme.persist = fn
	a.theme.mu.Unlock()
}

// SetThemeChange wires the post-flip hook (the shell emits hibana:theme —
// the LIVE document follows the tray menu without a reload).
func (a *API) SetThemeChange(fn func(pref string)) {
	a.theme.mu.Lock()
	a.theme.change = fn
	a.theme.mu.Unlock()
}

// SetThemeResult is what the binding resolves to JS: the new pref (the
// island's flip is optimistic — it applied already; this confirms + the
// normalized value for the 'dark' alias).
type SetThemeResult struct {
	OK   bool   `json:"ok"`
	Pref string `json:"pref"`
}

// SetTheme is the binding both island toggle surfaces call (click-time
// resolution in js/desktop-theme.js): validate against the allow-list
// (legacy 'dark' migrates), flip the live pref, persist (a failure logs but
// NEVER fails the flip), fire the change hook. A no-op flip (same pref)
// still resolves OK.
func (a *API) SetTheme(pref string) (SetThemeResult, error) {
	p := NormalizeTheme(pref)
	if pref != p && pref != "dark" {
		// Not a bare alias — a hostile/garbage value from the JS boundary.
		return SetThemeResult{}, errBadTheme
	}
	a.theme.mu.Lock()
	changed := a.theme.pref != p
	a.theme.pref = p
	persist := a.theme.persist
	change := a.theme.change
	a.theme.mu.Unlock()

	if changed && persist != nil {
		if err := persist(p); err != nil {
			log.Printf("hibana theme: persisting %s failed (flip kept, next boot re-reads the row): %v", p, err)
		}
	}
	if changed && change != nil {
		change(p) // synchronous: the emit lands BEFORE the JS promise resolves,
		// so the live document has already flipped when the island's .then runs
	}
	return SetThemeResult{OK: true, Pref: p}, nil
}

// errBadTheme keeps the invalid-value path out of fmt (and the JS console
// gets Wails' rejected-promise shape, which the island's .catch already
// swallows — the optimistic flip stands).
var errBadTheme = &themeError{}

type themeError struct{}

func (*themeError) Error() string { return "bridge: theme: unknown preference" }
