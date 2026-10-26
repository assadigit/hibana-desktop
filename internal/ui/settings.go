package ui

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"hibana/desktop/internal/api"
	"hibana/desktop/internal/update"
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

// ---------------------------------------------------------------------------
// THE GITHUB CREDENTIALS BINDINGS (v0.1.18 — the owner ask: "hibana desktop
// might be a private repo so in setting, add a github credentials so it can
// connect to the private repo").
//
// Three bound methods over the wired update.TokenStore (main.go passes the
// Updater's OWN data dir + repo — one token file, one truth):
//
//      SetGithubToken("")        → CLEAR the stored token ({ok, cleared})
//      SetGithubToken("ghp_…")   → shape-gate → VERIFY against GitHub → save
//                                   per the verdict matrix below
//      GithubTokenState()        → {set, hint} — the display state (ghp_…ABCD,
//                                   never the token; the login password's
//                                   never-crosses-back discipline)
//      TestGithubConnection(…)   → the v0.1.19 TEST round: verify a typed
//                                   candidate (or the stored token, or the
//                                   anonymous round) WITHOUT writing anything
//                                   — the owner's "test connection" ask
//
// THE VERDICT MATRIX (every cell honest):
//
//      200 (verified)      → SAVE → {ok, saved, verified}
//      401 (invalid)       → NOT saved → {ok:false, code:"invalid"}
//      404 (no repo access)→ NOT saved → {ok:false, code:"no_access"}
//      unreachable/403/5xx → SAVE (the write is LOCAL; only the verification
//                             didn't happen) → {ok, saved, message: the honest
//                             saved-unverified note} — the next real check
//                             reveals the truth
//      garbage shape       → a REJECTED promise (errBadGithubToken — the
//                             hostile-input law, errBadLanguage's shape)
//      no store wired      → {ok:false, code:"not_wired"}
//
// The busy guard is deliberately NOT taken: the updateBusy guard would make
// saving a setting wait out a 45-minute download window, and the rounds
// themselves are safe to overlap (the in-flight check simply runs with the
// previous token; the NEXT round reads the fresh file).
// ---------------------------------------------------------------------------

// githubTokenDeadline bounds one save's verify round-trip (one cheap GET
// /repos/<repo> — the langDeadline budget discipline).
const githubTokenDeadline = 10 * time.Second

// SetGithubTokenResult is what SetGithubToken resolves to JS.
type SetGithubTokenResult struct {
	OK       bool   `json:"ok"`
	Saved    bool   `json:"saved,omitempty"`
	Cleared  bool   `json:"cleared,omitempty"`
	Verified bool   `json:"verified,omitempty"`
	Code     string `json:"code,omitempty"` // invalid | no_access | not_wired | save_failed
	Message  string `json:"message,omitempty"`
}

// GithubTokenStateResult is the display state the sheet's status line paints.
type GithubTokenStateResult struct {
	Set  bool   `json:"set"`
	Hint string `json:"hint,omitempty"`
}

// SetGithubTokenStore wires the token store (main.go: the Updater's own
// data dir + repo). Without it the bindings resolve the honest not-wired
// verdict (the SetUpdateCheck precedent).
func (a *API) SetGithubTokenStore(s *update.TokenStore) {
	a.settingsMu.Lock()
	a.ghTokens = s
	a.settingsMu.Unlock()
}

// ghStore snapshots the wired store under the settings lock.
func (a *API) ghStore() *update.TokenStore {
	a.settingsMu.Lock()
	defer a.settingsMu.Unlock()
	return a.ghTokens
}

// SetGithubToken is the bound write the GitHub-access row calls. The token
// exists in bridge memory only for this call — shape-gated, verified against
// GitHub, persisted to the data dir on the honest verdicts, never logged.
func (a *API) SetGithubToken(token string) (SetGithubTokenResult, error) {
	token = strings.TrimSpace(token)
	store := a.ghStore()
	if store == nil {
		return SetGithubTokenResult{Code: "not_wired", Message: "The update credentials store is not wired — restart the app."}, nil
	}

	// The explicit CLEAR: "" removes the stored token; the round goes back to
	// anonymous (the public-repo default, byte-identical to v0.1.14-0.1.17).
	if token == "" {
		if err := store.Clear(); err != nil {
			return SetGithubTokenResult{Code: "save_failed", Message: "Couldn't clear the saved token — try again."}, nil
		}
		return SetGithubTokenResult{OK: true, Cleared: true}, nil
	}

	// The hostile-input law: an Authorization header value must be RFC-clean —
	// anything outside the PAT alphabet is refused before disk or wire.
	if !update.ValidTokenShape(token) {
		return SetGithubTokenResult{}, errBadGithubToken
	}

	// The verify round (one cheap GET /repos/<repo> with the token riding the
	// same header the update rounds will send).
	ctx, cancel := context.WithTimeout(context.Background(), githubTokenDeadline)
	defer cancel()
	status := store.Verify(ctx, token)
	switch status {
	case update.TokenInvalid:
		return SetGithubTokenResult{Code: "invalid", Message: "GitHub rejected the token — nothing was saved."}, nil
	case update.TokenNoAccess:
		return SetGithubTokenResult{Code: "no_access", Message: "The token cannot see this repository — check its repository access; nothing was saved."}, nil
	}

	// Verified, or honestly unverified (offline / rate-limited / 5xx): the
	// write itself is LOCAL, so it stands either way — an unreachable GitHub
	// must never block saving a setting; the next real check reveals the truth.
	if err := store.Save(token); err != nil {
		return SetGithubTokenResult{Code: "save_failed", Message: "Couldn't save the token — try again."}, nil
	}
	if status != update.TokenVerified {
		return SetGithubTokenResult{
			OK:      true,
			Saved:   true,
			Message: "Saved — GitHub couldn't be reached to verify it; the next check uses it.",
		}, nil
	}
	return SetGithubTokenResult{OK: true, Saved: true, Verified: true}, nil
}

// GithubTokenState reports the display state: whether a token is stored and
// its HINT ("ghp_…ABCD"). The token itself never crosses back.
func (a *API) GithubTokenState() (GithubTokenStateResult, error) {
	store := a.ghStore()
	if store == nil {
		return GithubTokenStateResult{}, nil
	}
	if tok := store.Load(); tok != "" {
		return GithubTokenStateResult{Set: true, Hint: update.TokenHint(tok)}, nil
	}
	return GithubTokenStateResult{}, nil
}

// ---------------------------------------------------------------------------
// THE TEST-CONNECTION BINDING (v0.1.19 — the owner ask: "Yes add a test
// connection"): ONE more bound method over the same store, so the
// GitHub-access row can ask GitHub "can I actually see the repository?"
// BEFORE anything is saved or any update round is spent:
//
//      TestGithubConnection("ghp_…") → shape-gate → verify THAT token →
//                                       verdict only, NOTHING is written
//      TestGithubConnection("")      → verify the STORED token if one is
//                                       saved, else the ANONYMOUS round —
//                                       the exact credential mix the next
//                                       release check would ride
//
// The verdict matrix (every cell honest, the SetGithubToken grammar):
//
//      200 (verified)      → {ok, code:"verified", using, hint}
//      401 (invalid)       → {ok:false, code:"invalid"} — for using:"saved"
//                            the line names the SAVED token (a revoked PAT
//                            is exactly the fact the user needs)
//      404 (no access)     → {ok:false, code:"no_access"} — the ANONYMOUS
//                            404 is the owner's private-repo signal: "GitHub
//                            can't see the repository without credentials"
//      unreachable/403/5xx → {ok:false, code:"unreachable"} — never a
//                            verdict on any token
//      garbage shape       → a REJECTED promise (errBadGithubToken)
//      no store wired      → {ok:false, code:"not_wired"}
//
// `using` is the island's one branching fact: "typed" (a value crossed the
// bridge this call), "saved" (the stored token was tested), "anonymous"
// (nothing is in play — the public-repo round). A pure READ: no file write,
// no busy guard (the same 10s verify budget SetGithubToken rides; the
// updateBusy guard would make a settings row wait out a 45-minute download
// window for nothing).
// ---------------------------------------------------------------------------

// TestGithubConnectionResult is what the test resolves to JS. The token
// itself NEVER appears — only the hint, exactly like GithubTokenState.
type TestGithubConnectionResult struct {
	OK      bool   `json:"ok"`
	Code    string `json:"code,omitempty"`    // verified | invalid | no_access | unreachable | not_wired
	Using   string `json:"using,omitempty"`   // typed | saved | anonymous
	Hint    string `json:"hint,omitempty"`    // ghp_…ABCD when a token was in play
	Message string `json:"message,omitempty"` // the honest belt line (the island paints its own)
}

// TestGithubConnection verifies a candidate token (or the stored one, or the
// anonymous round) against the repository — one cheap GET /repos/<repo>
// riding the same Bearer header the update rounds send. Nothing is saved,
// nothing is cleared: the row's Test button answers "will the next check
// work with THIS?" before the user commits to anything.
func (a *API) TestGithubConnection(token string) (TestGithubConnectionResult, error) {
	token = strings.TrimSpace(token)
	store := a.ghStore()
	if store == nil {
		return TestGithubConnectionResult{
			Code:    "not_wired",
			Message: "The update credentials store is not wired — restart the app.",
		}, nil
	}

	// The hostile-input law, exactly as SetGithubToken applies it: a
	// non-empty value outside the PAT alphabet is refused before the wire.
	if token != "" && !update.ValidTokenShape(token) {
		return TestGithubConnectionResult{}, errBadGithubToken
	}

	// WHICH credential is in play: the typed value, else the stored one,
	// else the honest anonymous round — the exact mix the next release
	// check would ride, so the verdict transfers one-for-one.
	using, tested := "anonymous", ""
	if token != "" {
		using, tested = "typed", token
	} else if saved := store.Load(); saved != "" {
		using, tested = "saved", saved
	}

	ctx, cancel := context.WithTimeout(context.Background(), githubTokenDeadline)
	defer cancel()
	switch status := store.Verify(ctx, tested); status {
	case update.TokenVerified:
		res := TestGithubConnectionResult{OK: true, Code: "verified", Using: using}
		if tested != "" {
			res.Hint = update.TokenHint(tested)
		}
		return res, nil
	case update.TokenInvalid:
		if tested == "" {
			// An anonymous 401 carries no credentials to reject — GitHub
			// did not answer a question about any token; the honest
			// reading is "could not ask".
			return TestGithubConnectionResult{
				Code:    "unreachable",
				Using:   using,
				Message: "GitHub was unreachable or refused the anonymous ask — try again.",
			}, nil
		}
		return TestGithubConnectionResult{
			Code:    "invalid",
			Using:   using,
			Hint:    update.TokenHint(tested),
			Message: "GitHub rejected the token.",
		}, nil
	case update.TokenNoAccess:
		res := TestGithubConnectionResult{
			Code:    "no_access",
			Using:   using,
			Message: "The token cannot see this repository.",
		}
		if tested != "" {
			res.Hint = update.TokenHint(tested)
		} else {
			// The owner's exact scenario: no credentials in play and the
			// repo answers 404 — this is what a private flip looks like.
			res.Message = "GitHub cannot see the repository without credentials — if it is private, save a token with access to it."
		}
		return res, nil
	default: // TokenUnreachable
		return TestGithubConnectionResult{
			Code:    "unreachable",
			Using:   using,
			Message: "Couldn't reach GitHub — try again.",
		}, nil
	}
}

// errBadGithubToken keeps the malformed-token path out of fmt (and the JS
// console gets Wails' rejected-promise shape — the errBadLanguage precedent).
var errBadGithubToken = &githubTokenError{}

type githubTokenError struct{}

func (*githubTokenError) Error() string { return "bridge: github token: malformed value" }
