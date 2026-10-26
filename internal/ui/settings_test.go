package ui

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"hibana/desktop/internal/api"
	"hibana/desktop/internal/auth"
	"hibana/desktop/internal/update"
)

// The settings round's language layer (the plan §5's gate list): the enum,
// the PATCH round-trip against a stub client, the stale-`me` fix (AuthState
// before/after), the failure paths (offline / 5xx → {ok:false}, a.me
// untouched), the emit-not-wired degradation, and the serve-time lang/dir
// stamping (InjectShellState + the middleware's live language).

// settingsFake is loginFake grown the /api/settings PATCH route the binding
// rides (the web's own settings page write, routes/settings.ts @ pin): a
// valid session cookie + {language_pref} → 200 {ok:true}; the PATCH body and
// the Origin header are CAPTURED so the tests prove the write rode the same
// session/Origin machinery every write rides (hard rule 5).
func settingsFake(t *testing.T) (*httptest.Server, *auth.MemStore, *API, *settingsCapture) {
	t.Helper()
	cap := &settingsCapture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/auth/login":
			var body struct {
				Login    string `json:"login"`
				Password string `json:"password"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body.Login == "user@example.com" && body.Password == "pw" {
				w.Header().Set("Set-Cookie", api.SessionCookie+"=tok-1; Path=/; Secure; HttpOnly; SameSite=Lax")
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"ok":true}`))
				return
			}
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"invalid_credentials"}`))
		case "/api/auth/me":
			ck, err := r.Cookie(api.SessionCookie)
			if err != nil || ck.Value == "" {
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
				return
			}
			_, _ = w.Write([]byte(`{"user":{"id":"u1","username":"user","email":"user@example.com","role":"member","language_pref":"en","calendar_pref":"gregorian"}}`))
		case "/api/settings":
			if r.Method != http.MethodPatch {
				w.WriteHeader(http.StatusMethodNotAllowed)
				_, _ = w.Write([]byte(`{"error":"method_not_allowed"}`))
				return
			}
			ck, err := r.Cookie(api.SessionCookie)
			if err != nil || ck.Value == "" {
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
				return
			}
			body, _ := io.ReadAll(r.Body)
			cap.mu.Lock()
			cap.patches = append(cap.patches, patchRecord{body: string(body), origin: r.Header.Get("Origin"), contentType: r.Header.Get("Content-Type")})
			cap.mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true}`))
		case "/api/auth/logout":
			w.Header().Set("Set-Cookie", api.SessionCookie+"=; Path=/; Max-Age=0")
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true}`))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"not_found"}`))
		}
	}))
	t.Cleanup(srv.Close)
	c, err := api.New(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	a := New(c, "0.1.17-test", "e6661c8")
	st := &auth.MemStore{}
	a.SetSessionStore(st)
	return srv, st, a, cap
}

type patchRecord struct {
	body        string
	origin      string
	contentType string
}

type settingsCapture struct {
	mu      sync.Mutex
	patches []patchRecord
}

func (c *settingsCapture) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.patches)
}

func (c *settingsCapture) last() patchRecord {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.patches) == 0 {
		return patchRecord{}
	}
	return c.patches[len(c.patches)-1]
}

// settingsSignin logs the fake user in so a.me is live (language_pref "en").
func settingsSignin(t *testing.T, a *API) {
	t.Helper()
	if _, err := a.Login("user@example.com", "pw"); err != nil {
		t.Fatalf("login: %v", err)
	}
}

func TestNormalizeLanguageAllowList(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{LangEn, LangEn},
		{LangFa, LangFa},
		{"", LangEn},
		{"garbage", LangEn},
		{"FA", LangEn},
		{"persian", LangEn},
	} {
		if got := NormalizeLanguage(tc.in); got != tc.want {
			t.Fatalf("NormalizeLanguage(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestSetLanguageValidatesTheEnum(t *testing.T) {
	a, _ := newBridge(t)
	// A hostile/garbage value from the JS boundary is rejected loudly (the
	// errBadTheme shape) — never a server round-trip.
	for _, hostile := range []string{"", "fa ", "FA", "en-US", "ar", "<script>"} {
		if _, err := a.SetLanguage(hostile); err == nil {
			t.Fatalf("SetLanguage(%q) must reject outside the allow-list", hostile)
		}
	}
	if _, err := a.SetLanguage(LangEn); err != nil {
		t.Fatalf("SetLanguage(en) must pass validation: %v", err)
	}
	if _, err := a.SetLanguage(LangFa); err != nil {
		t.Fatalf("SetLanguage(fa) must pass validation: %v", err)
	}
}

func TestSetLanguageHappyPathPatchesAndUnStalesMe(t *testing.T) {
	_, _, a, cap := settingsFake(t)
	settingsSignin(t, a)
	if got := a.LanguagePref(); got != LangEn {
		t.Fatalf("the seeded session must read en, got %q", got)
	}

	var events []string
	a.SetLanguageEmit(func(name string, payload map[string]any) {
		events = append(events, name)
		if name != "hibana:lang" || payload["lang"] != LangFa {
			t.Errorf("the emit must carry the new language: %v", payload)
		}
	})

	res, err := a.SetLanguage(LangFa)
	if err != nil {
		t.Fatalf("SetLanguage(fa): %v", err)
	}
	if !res.OK || res.Lang != LangFa {
		t.Fatalf("res=%+v — the happy path resolves {ok:true, lang}", res)
	}

	// THE STALE-ME FIX (the plan §7 risk #1): AuthState must tell the truth
	// immediately — the island's reload reflex re-reads __hibanaMe, and a
	// stale snapshot would re-resolve the OLD language.
	snap := a.AuthState()
	if !snap.Authenticated || snap.User == nil || snap.User.LanguagePref != LangFa {
		t.Fatalf("AuthState after the flip: %+v — the snapshot must be un-staled", snap)
	}
	if got := a.LanguagePref(); got != LangFa {
		t.Fatalf("LanguagePref after the flip: %q", got)
	}

	// The write rode the web's own contract: PATCH /api/settings with the
	// language_pref body, the JSON content type, and the SAME Origin stamp
	// every write rides (hard rule 5).
	if cap.count() != 1 {
		t.Fatalf("exactly one PATCH must cross, saw %d", cap.count())
	}
	last := cap.last()
	var wire map[string]string
	if json.Unmarshal([]byte(last.body), &wire) != nil || wire["language_pref"] != LangFa {
		t.Fatalf("the PATCH body must be the web's own {language_pref} shape, got %q", last.body)
	}
	if last.contentType != "application/json" {
		t.Fatalf("the PATCH must carry the JSON content type, got %q", last.contentType)
	}
	if last.origin == "" {
		t.Fatal("the PATCH must carry the Origin header (the T6 write gate)")
	}

	if len(events) != 1 || events[0] != "hibana:lang" {
		t.Fatalf("the emit must fire exactly once: %v", events)
	}

	// A same-language flip still resolves OK (the no-op honesty — the server
	// write is idempotent; the emit fires, the sheet's active state simply
	// stays).
	res, err = a.SetLanguage(LangFa)
	if err != nil || !res.OK {
		t.Fatalf("the same-language flip resolves OK: res=%+v err=%v", res, err)
	}
	if got := a.LanguagePref(); got != LangFa {
		t.Fatalf("LanguagePref after the no-op: %q", got)
	}
}

func TestSetLanguageOfflineResolvesHonestAndNeverTouchesMe(t *testing.T) {
	// A dead host: the transport failure must resolve {ok:false} with the
	// honest can't-reach message — never a rejected promise, never a claimed
	// success, and a.me stays EXACTLY as it was.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"server_error"}`))
	}))
	t.Cleanup(srv.Close)
	c, err := api.New(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	a := New(c, "t", "r")
	a.SetAuthed(&api.Me{User: api.MeUser{ID: "u1", Email: "user@example.com", LanguagePref: "en"}}, true)

	res, err := a.SetLanguage(LangFa)
	if err != nil {
		t.Fatalf("an offline flip must RESOLVE (never reject): %v", err)
	}
	if res.OK || res.Lang != "" || res.Message == "" {
		t.Fatalf("res=%+v — the offline path must be the honest {ok:false, message}", res)
	}
	snap := a.AuthState()
	if snap.User == nil || snap.User.LanguagePref != "en" {
		t.Fatalf("a.me must be untouched by the failed flip: %+v", snap)
	}
	if got := a.LanguagePref(); got != LangEn {
		t.Fatalf("LanguagePref must stay en, got %q", got)
	}

	// The unreachable-host variant (connection refused): same honest verdict.
	dead, err := api.New("http://127.0.0.1:1")
	if err != nil {
		t.Fatal(err)
	}
	b := New(dead, "t", "r")
	b.SetAuthed(&api.Me{User: api.MeUser{ID: "u1", LanguagePref: "en"}}, true)
	res, err = b.SetLanguage(LangFa)
	if err != nil {
		t.Fatalf("the unreachable flip must resolve, not reject: %v", err)
	}
	if res.OK {
		t.Fatalf("res=%+v — an unreachable host must never claim success", res)
	}
	if got := b.LanguagePref(); got != LangEn {
		t.Fatalf("LanguagePref must stay en, got %q", got)
	}
}

func TestSetLanguageSessionDeathReopensTheCard(t *testing.T) {
	// A 401 on the settings write: the session died mid-dialog — the login
	// card reopens (the §5.5 expiry path) AND the flip resolves {ok:false}
	// honestly (the language never changed).
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
	}))
	t.Cleanup(srv.Close)
	c, err := api.New(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	a := New(c, "t", "r")
	lost := false
	a.SetOnAuthLost(func(string) { lost = true })
	a.SetAuthed(&api.Me{User: api.MeUser{ID: "u1", LanguagePref: "en"}}, true)

	res, err := a.SetLanguage(LangFa)
	if err != nil {
		t.Fatalf("the 401 flip must resolve, not reject: %v", err)
	}
	if res.OK {
		t.Fatalf("res=%+v — a dead session must never claim the write", res)
	}
	if !lost {
		t.Fatal("the 401 must fire NotifyAuthLost so the login card reopens")
	}
}

func TestSetLanguageEmitNotWiredDegradesQuietly(t *testing.T) {
	_, _, a, _ := settingsFake(t)
	settingsSignin(t, a)
	// No SetLanguageEmit: the write still lands, the snapshot still moves —
	// only the live event relay is absent (the SetUpdateEmit degradation
	// precedent; tests + a future shell without the wiring).
	res, err := a.SetLanguage(LangFa)
	if err != nil || !res.OK || res.Lang != LangFa {
		t.Fatalf("res=%+v err=%v — the emit-less round must still resolve OK", res, err)
	}
	if got := a.LanguagePref(); got != LangFa {
		t.Fatalf("LanguagePref after the emit-less flip: %q", got)
	}
}

func TestSetLanguageSignedOutRefusesHonestlyAndServesEn(t *testing.T) {
	// The signed-out state: the settings sheet is unreachable (the login gate
	// IS the sign-in surface — the plan §1.3), but the belt still holds: the
	// write needs a live session (the web's own settings route is authed), so
	// it resolves {ok:false} honestly — never a claimed success — and the
	// serve-time language stays the en default.
	_, _, a, _ := settingsFake(t)
	if got := a.LanguagePref(); got != LangEn {
		t.Fatalf("a signed-out bridge must serve en, got %q", got)
	}
	res, err := a.SetLanguage(LangFa)
	if err != nil {
		t.Fatalf("the signed-out flip must resolve, not reject: %v", err)
	}
	if res.OK {
		t.Fatalf("res=%+v — a signed-out write must never claim success", res)
	}
	if got := a.LanguagePref(); got != LangEn {
		t.Fatalf("with no session, the serve language stays the en default, got %q", got)
	}
}

func TestInjectShellStateStampsLangAndDir(t *testing.T) {
	for _, tc := range []struct {
		lang string
		want string
	}{
		{LangEn, `<html lang="en" dir="ltr" data-desktop-lang="en"`},
		{LangFa, `<html lang="fa" dir="rtl" data-desktop-lang="fa"`},
		{"", `<html lang="en" dir="ltr" data-desktop-lang="en"`},
		{"junk", `<html lang="en" dir="ltr" data-desktop-lang="en"`},
		{"FA", `<html lang="en" dir="ltr" data-desktop-lang="en"`},
	} {
		out := string(InjectShellState([]byte(cannedIndex), true, ThemeSystem, tc.lang))
		if !strings.Contains(out, tc.want) {
			t.Fatalf("lang=%q: %q missing in %q", tc.lang, tc.want, out)
		}
		if strings.Count(out, "data-desktop-lang") != 1 {
			t.Fatalf("lang=%q: the lang attr must be injected exactly once: %q", tc.lang, out)
		}
	}
}

func TestIndexMiddlewareServesTheLiveLanguage(t *testing.T) {
	// The serve-time stamping end to end: an EN session serves lang="en"
	// dir="ltr"; after the language flips (the binding), the NEXT document
	// serve carries lang="fa" dir="rtl" — the post-flip reload paints FA/RTL
	// at the FIRST frame (the FOUC fix, and the plan §2.4 side effect).
	_, _, a, _ := settingsFake(t)
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(cannedIndex))
	})
	h := a.IndexMiddleware(next)

	get := func() string {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Body.String()
	}

	settingsSignin(t, a) // the fake's /me carries language_pref "en"
	if body := get(); !strings.Contains(body, `lang="en" dir="ltr"`) {
		t.Fatalf("the EN session must serve lang=en dir=ltr: %q", body)
	}
	if _, err := a.SetLanguage(LangFa); err != nil {
		t.Fatalf("the flip: %v", err)
	}
	body := get()
	if !strings.Contains(body, `lang="fa" dir="rtl" data-desktop-lang="fa"`) {
		t.Fatalf("the post-flip serve must stamp FA/RTL at first paint: %q", body)
	}
	if strings.Contains(body, `lang="en"`) {
		t.Fatalf("no EN remnant may survive the flip: %q", body)
	}
}

func TestLanguagePrefAfterLogoutReadsEn(t *testing.T) {
	_, _, a, _ := settingsFake(t)
	settingsSignin(t, a)
	if _, err := a.SetLanguage(LangFa); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Logout(); err != nil {
		t.Fatal(err)
	}
	if got := a.LanguagePref(); got != LangEn {
		t.Fatalf("the signed-out serve language must read en, got %q", got)
	}
}

// ---------------------------------------------------------------------------
// The v0.1.18 GitHub-credentials bindings (settings.go's second half): the
// shape gate (a rejected promise, never a round-trip), the not-wired verdict,
// the clear path, the verify-then-save verdict matrix (200 → saved+verified,
// 401 → NOT saved, 404 → NOT saved, unreachable → saved with the honest
// unverified note), and the state hint's never-leak-the-secret contract.
// ---------------------------------------------------------------------------

// ghVerifyServer answers GET /repos/assadigit/hibana-desktop with status and
// captures the Authorization header the binding's verify round sent.
func ghVerifyServer(t *testing.T, status int, sawAuth *string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/assadigit/hibana-desktop" {
			http.NotFound(w, r)
			return
		}
		*sawAuth = r.Header.Get("Authorization")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(srv.Close)
	return srv
}

// ghTokenAPI wires a settings-style API with a token store over a temp data
// dir and a verify server answering status.
func ghTokenAPI(t *testing.T, status int, sawAuth *string) (*API, string) {
	t.Helper()
	srv := ghVerifyServer(t, status, sawAuth)
	_, _, a, _ := settingsFake(t)
	dir := t.TempDir()
	a.SetGithubTokenStore(&update.TokenStore{
		DataDir: dir,
		Repo:    "assadigit/hibana-desktop",
		APIBase: srv.URL,
	})
	return a, dir
}

const ghTestToken = "ghp_0123456789abcdefghijklmnopqrstuv"

func TestSetGithubTokenShapeRejected(t *testing.T) {
	saw := ""
	a, dir := ghTokenAPI(t, http.StatusOK, &saw)
	for _, hostile := range []string{"no", "has spaces", "line\nbreak", strings.Repeat("x", 300)} {
		if _, err := a.SetGithubToken(hostile); err == nil {
			t.Errorf("SetGithubToken(%q) must reject outside the PAT alphabet", hostile)
		}
	}
	if saw != "" {
		t.Errorf("a malformed token must never reach the wire, saw Authorization %q", saw)
	}
	if _, err := os.Stat(update.TokenPath(dir)); err == nil {
		t.Errorf("a malformed token must never reach the disk")
	}
}

func TestSetGithubTokenNotWired(t *testing.T) {
	_, _, a, _ := settingsFake(t) // no SetGithubTokenStore call
	res, err := a.SetGithubToken(ghTestToken)
	if err != nil {
		t.Fatalf("not-wired resolves a verdict, not a rejection: %v", err)
	}
	if res.OK || res.Code != "not_wired" {
		t.Errorf("not-wired verdict = %+v, want {ok:false, code:not_wired}", res)
	}
	if st, _ := a.GithubTokenState(); st.Set || st.Hint != "" {
		t.Errorf("not-wired state = %+v, want unset", st)
	}
}

func TestSetGithubTokenClear(t *testing.T) {
	saw := ""
	a, dir := ghTokenAPI(t, http.StatusOK, &saw)
	if err := update.SaveToken(dir, ghTestToken); err != nil {
		t.Fatal(err)
	}
	res, err := a.SetGithubToken("")
	if err != nil || !res.OK || !res.Cleared || res.Saved {
		t.Fatalf("clear verdict = %+v, %v — want {ok, cleared}", res, err)
	}
	if _, err := os.Stat(update.TokenPath(dir)); !os.IsNotExist(err) {
		t.Errorf("the clear must remove the stored token file")
	}
	// Trailing whitespace still means clear (the binding trims).
	if err := update.SaveToken(dir, ghTestToken); err != nil {
		t.Fatal(err)
	}
	if res, _ := a.SetGithubToken("   "); !res.OK || !res.Cleared {
		t.Errorf("a whitespace-only input must clear: %+v", res)
	}
}

func TestSetGithubTokenSaveVerified(t *testing.T) {
	saw := ""
	a, dir := ghTokenAPI(t, http.StatusOK, &saw)
	res, err := a.SetGithubToken(ghTestToken)
	if err != nil {
		t.Fatalf("SetGithubToken: %v", err)
	}
	if !res.OK || !res.Saved || !res.Verified || res.Code != "" {
		t.Fatalf("verified verdict = %+v, want {ok, saved, verified}", res)
	}
	if saw != "Bearer "+ghTestToken {
		t.Errorf("the verify round must send the update round's own Bearer header, saw %q", saw)
	}
	if got := update.LoadToken(dir); got != ghTestToken {
		t.Errorf("the token file = %q", got)
	}
	st, err := a.GithubTokenState()
	if err != nil {
		t.Fatal(err)
	}
	if !st.Set || st.Hint != "ghp_…stuv" {
		t.Errorf("state = %+v, want {set, hint ghp_…stuv}", st)
	}
	// The never-leak contract: the full token appears nowhere in the wire JSON.
	blob, _ := json.Marshal(st)
	if strings.Contains(string(blob), ghTestToken) || strings.Contains(string(blob), "ghp_0123456789") {
		t.Errorf("the state JSON leaked the secret: %s", blob)
	}
}

func TestSetGithubTokenInvalidNotSaved(t *testing.T) {
	saw := ""
	a, dir := ghTokenAPI(t, http.StatusUnauthorized, &saw)
	res, err := a.SetGithubToken(ghTestToken)
	if err != nil {
		t.Fatalf("a 401 resolves a verdict, not a rejection: %v", err)
	}
	if res.OK || res.Code != "invalid" || res.Saved {
		t.Fatalf("401 verdict = %+v, want {ok:false, code:invalid, nothing saved}", res)
	}
	if _, err := os.Stat(update.TokenPath(dir)); err == nil {
		t.Errorf("a rejected token must never reach the disk")
	}
}

func TestSetGithubTokenNoAccessNotSaved(t *testing.T) {
	saw := ""
	a, dir := ghTokenAPI(t, http.StatusNotFound, &saw)
	res, err := a.SetGithubToken(ghTestToken)
	if err != nil {
		t.Fatalf("a 404 resolves a verdict, not a rejection: %v", err)
	}
	if res.OK || res.Code != "no_access" || res.Saved {
		t.Fatalf("404 verdict = %+v, want {ok:false, code:no_access, nothing saved}", res)
	}
	if _, err := os.Stat(update.TokenPath(dir)); err == nil {
		t.Errorf("a no-access token must never reach the disk")
	}
}

func TestSetGithubTokenUnreachableStillSaves(t *testing.T) {
	saw := ""
	a, dir := ghTokenAPI(t, http.StatusOK, &saw)
	// A DEAD verify target: the write is local, so the save must stand with
	// the honest saved-unverified note (the offline discipline).
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	srv.Close()
	a.ghTokens.APIBase = srv.URL
	res, err := a.SetGithubToken(ghTestToken)
	if err != nil {
		t.Fatalf("SetGithubToken: %v", err)
	}
	if !res.OK || !res.Saved || res.Verified {
		t.Fatalf("unreachable verdict = %+v, want {ok, saved, NOT verified}", res)
	}
	if !strings.Contains(res.Message, "couldn't be reached") {
		t.Errorf("the saved-unverified note must say why verification didn't happen: %q", res.Message)
	}
	if got := update.LoadToken(dir); got != ghTestToken {
		t.Errorf("the offline save must still land on disk, got %q", got)
	}
}

func TestGithubTokenStateUnset(t *testing.T) {
	saw := ""
	a, _ := ghTokenAPI(t, http.StatusOK, &saw)
	st, err := a.GithubTokenState()
	if err != nil {
		t.Fatal(err)
	}
	if st.Set || st.Hint != "" {
		t.Errorf("unset state = %+v, want the zero shape", st)
	}
}
