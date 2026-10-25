package ui

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"hibana/desktop/internal/api"
)

// THE SETTINGS BINDING — the language half of the settings round (the owner
// ask 2026-10-26: "Plan for a settings page for hibana's desktop", section 4:
// "fa/en and dark mode / light mode"). The settings page itself is a
// COMPOSITION surface: Sync / Update / Sign out / Theme all delegate to the
// live, proven rounds (the sync modal, the update modal, the logout confirm,
// SetTheme). Language is the ONE genuinely new capability, and it needs a
// dedicated binding because the language is a SERVER-SIDE user record field
// (users.language_pref, multi-device by design — spec §5.8): a JS-side
// hibanaFetch PATCH would leave the Go-side AuthState snapshot stale, and the
// island's window.__hibanaMe → i18n.apply() chain would then re-resolve the
// OLD language on the reload reflex. The Go side must own the write, exactly
// the way it owns login/logout/theme.
//
// SetLanguage mirrors SetTheme's discipline (a validated enum, never free
// text) and the write path of the web's own settings page
// (hibana-source routes/settings.ts PATCH /api/settings {language_pref} at
// the pin — 200 {ok:true}; the calendar follows the language server-side):
//
//      SetLanguage("fa")
//        1. validate: allow-list {"en","fa"} — anything else is a rejected
//           promise (the hostile-input law; errBadTheme's shape);
//        2. PATCH /api/settings {"language_pref": lang} through the Go client —
//           the SAME session/Origin machinery every write rides (the T6 gate);
//        3. on 2xx: update a.me.LanguagePref under a.mu (the AuthState snapshot
//           un-stales — __hibanaMe now tells the truth), then emit
//           hibana:lang {lang} through the shell's emit relay;
//        4. resolve {ok:true, lang}.
//           On a transport/4xx/5xx failure: resolve {ok:false} with the honest
//           message — the sheet shows "Couldn't reach hibana.ir — the language
//           is unchanged." and the segmented control stays put. An offline flip
//           must never claim success.
//
// The event name is the island controller's contract (the hibana:theme /
// hibana:update-available family): main.go wires SetLanguageEmit →
// EventsEmit("hibana:lang", …) so the live surfaces can follow a language
// change without a reload.

// LangEn / LangFa — the allow-list, exactly the web's own vocabulary
// (routes/settings.ts prefsSchema: z.enum(['en','fa']) at the pin).
const (
	LangEn = "en"
	LangFa = "fa"
)

// langEvent is the Wails event the settings controller subscribes to (the
// tray and the settings sheet must agree — the hibana:theme precedent).
const langEvent = "hibana:lang"

// langDeadline bounds one language PATCH round-trip: the same 10s budget
// Logout's best-effort server call uses — a dead host must never hang the
// settings dialog.
const langDeadline = 10 * time.Second

// NormalizeLanguage is the single validation point for a stored-or-incoming
// language: the allow-list, with everything else resolving to 'en' (the
// island's own pin default and the serve-time fallback). NEVER an error: a
// garbage value must not lock the document out of a direction.
func NormalizeLanguage(lang string) string {
	switch lang {
	case LangFa:
		return LangFa
	default:
		return LangEn
	}
}

// SetLanguageEmit wires the event relay (main.go: EventsEmit — the ONLY way
// the bridge's goroutines reach the WebView; the SetUpdateEmit precedent).
func (a *API) SetLanguageEmit(fn func(name string, payload map[string]any)) {
	a.settingsMu.Lock()
	a.langEmit = fn
	a.settingsMu.Unlock()
}

// SetLanguageResult is what the binding resolves to JS: {ok, lang} on a
// successful server write, {ok:false, message} with the honest reason
// otherwise (never a rejected promise for a failed write — the sheet branches
// on the verdict, the loginFailCode shape).
type SetLanguageResult struct {
	OK      bool   `json:"ok"`
	Lang    string `json:"lang,omitempty"`
	Message string `json:"message,omitempty"`
}

// SetLanguage is the bound write the settings sheet's segmented control
// calls. Enum-validated (the hostile-input law), deadline-bounded, honest on
// every failure path: the a.me snapshot moves ONLY on a confirmed 2xx, and
// the emit fires only then too.
func (a *API) SetLanguage(lang string) (SetLanguageResult, error) {
	if lang != LangEn && lang != LangFa {
		// A hostile/garbage value from the JS boundary — the errBadTheme shape
		// (a rejected promise the island's .catch already swallows).
		return SetLanguageResult{}, errBadLanguage
	}

	// The write rides the Go client's write path (Origin stamp, cookie jar,
	// no blind retry) — the SAME machinery the web's own settings page trusts.
	body, err := json.Marshal(map[string]string{"language_pref": lang})
	if err != nil {
		return SetLanguageResult{}, fmt.Errorf("bridge: language: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), langDeadline)
	defer cancel()
	resp, err := a.client.RequestFresh(ctx, http.MethodPatch, "/api/settings", body)
	if err != nil {
		var se *api.StatusError
		if errors.As(err, &se) && se.Status == http.StatusUnauthorized {
			// The session died mid-dialog: reopen the login card (the §5.5
			// session-expiry path — the island's own read would 401 the same
			// way) AND resolve honestly — the language never changed.
			a.NotifyAuthLost("settings-401")
			return SetLanguageResult{Message: "Your session expired — sign in again."}, nil
		}
		// Transport-level (deadline/connection): the honest can't-reach verdict.
		return SetLanguageResult{Message: "Couldn't reach hibana.ir — the language is unchanged."}, nil
	}
	if resp.Status < 200 || resp.Status >= 300 {
		return SetLanguageResult{Message: "hibana.ir refused the change — the language is unchanged."}, nil
	}

	// 2xx: the server record moved. Un-stale the AuthState snapshot under the
	// SAME mutex AuthState reads (the plan §7's first risk, answered): the
	// reload reflex's __hibanaMe → i18n.apply() must resolve the NEW language.
	a.mu.Lock()
	if a.me != nil {
		a.me.LanguagePref = lang
	}
	a.mu.Unlock()

	a.settingsMu.Lock()
	relay := a.langEmit
	a.settingsMu.Unlock()
	if relay != nil {
		relay(langEvent, map[string]any{"lang": lang})
	}
	return SetLanguageResult{OK: true, Lang: lang}, nil
}

// LanguagePref reports the live session language (the serve-time stamping
// input — InjectShellState). Normalized on read; a signed-out or unknown
// state reads 'en' (the island's pin default).
func (a *API) LanguagePref() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.authed || a.me == nil {
		return LangEn
	}
	return NormalizeLanguage(a.me.LanguagePref)
}

// errBadLanguage keeps the invalid-value path out of fmt (and the JS console
// gets Wails' rejected-promise shape — the errBadTheme precedent).
var errBadLanguage = &languageError{}

type languageError struct{}

func (*languageError) Error() string { return "bridge: language: unknown preference" }
