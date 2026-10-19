package ui

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"hibana/desktop/internal/api"
	"hibana/desktop/internal/auth"
)

func newBridge(t *testing.T) (*API, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// A minimal API echo: 200 {ok} + the ETag contract.
		if r.Header.Get("Accept") != "application/json" {
			w.WriteHeader(400)
			return
		}
		w.Header().Set("ETag", `W/"bridge"`)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(srv.Close)
	c, err := api.New(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	return New(c, "0.1.0-test", "e6661c8"), srv
}

func TestBridgeAllowLists(t *testing.T) {
	a, _ := newBridge(t)

	// Method allow-list.
	if _, err := a.Request("TRACE", "/api/x", ""); err == nil {
		t.Fatal("TRACE must be rejected")
	}
	// Path allow-list: only /api/… (the media file route lives under it too).
	if _, err := a.Request("GET", "/etc/passwd", ""); err == nil {
		t.Fatal("non-API path must be rejected")
	}
	if _, err := a.Request("GET", "https://evil.example/api/x", ""); err == nil {
		t.Fatal("absolute URL must be rejected")
	}
	if _, err := a.Request("GET", "/api/../../secret", ""); err == nil {
		t.Fatal("traversal must be rejected")
	}
	if _, err := a.Request("GET", "/api/ping\r\nX-Injected: 1", ""); err == nil {
		t.Fatal("CRLF must be rejected")
	}
	// The size cap (7MB — the server's own 413 boundary).
	if _, err := a.Request("POST", "/api/x", makeBody(maxBridgeBody+1)); err == nil {
		t.Fatal("oversized body must be rejected")
	}
	// A legit call passes through and carries the ETag.
	res, err := a.Request("GET", "/api/projects/p1/devboard", "")
	if err != nil {
		t.Fatalf("legit call: %v", err)
	}
	if res.Status != 200 || res.ETag != `W/"bridge"` {
		t.Fatalf("bridge response: %+v", res)
	}
	var wire map[string]any
	if json.Unmarshal([]byte(res.Body), &wire) != nil || wire["ok"] != true {
		t.Fatalf("body lost across the bridge: %q", res.Body)
	}
}

func TestBridgeStatusErrorFlowsAsStatus(t *testing.T) {
	// The island's err.status branching must survive: a 404 comes back as a
	// JS-visible {status:404}, not a rejected promise.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		_, _ = w.Write([]byte(`{"error":"not_found"}`))
	}))
	defer srv.Close()
	c, _ := api.New(srv.URL)
	a := New(c, "v", "r")
	res, err := a.Request("GET", "/api/projects/p1/devboard", "")
	if err != nil {
		t.Fatalf("404 must flow as a response, not an error: %v", err)
	}
	if res.Status != 404 {
		t.Fatalf("status lost: %+v", res)
	}
}

func TestAppInfoStamps(t *testing.T) {
	a, _ := newBridge(t)
	info := a.AppInfo()
	if info.Version != "0.1.0-test" || info.WebRef != "e6661c8" {
		t.Fatalf("stamps lost: %+v", info)
	}
}

// ---------------------------------------------------------------------------
// The §5.5 login surface (guide §5.5 — the island-rendered login card).
// ---------------------------------------------------------------------------

// loginFake implements exactly the two endpoints Login touches, with the
// shapes the live probe verified on prod: 200 + Set-Cookie __Host-hibana_session
// on success; 401 {"error":"invalid_credentials"} on a wrong password; the
// Me payload as /api/auth/me serves it.
func loginFake(t *testing.T) (*httptest.Server, *auth.MemStore, *API) {
	t.Helper()
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
			_, _ = w.Write([]byte(`{"user":{"id":"u1","username":"user","email":"user@example.com","role":"member","language_pref":"fa","calendar_pref":"gregorian"}}`))
		case "/api/ping":
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
	a := New(c, "0.1.1-test", "e6661c8")
	st := &auth.MemStore{}
	a.SetSessionStore(st)
	return srv, st, a
}

func TestLoginHappyPath(t *testing.T) {
	_, st, a := loginFake(t)
	hooked := make(chan *api.MeUser, 1)
	a.SetOnLogin(func(u *api.MeUser) { hooked <- u })

	res, err := a.Login("user@example.com", "pw")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if !res.OK || res.User == nil || res.User.Email != "user@example.com" || res.User.LanguagePref != "fa" {
		t.Fatalf("login result: %+v", res)
	}
	// The live snapshot flips (the served index.html injection + __hibanaMe feed).
	snap := a.AuthState()
	if !snap.Authenticated || snap.User == nil || snap.User.LanguagePref != "fa" {
		t.Fatalf("AuthState after login: %+v", snap)
	}
	// The session persisted (survives restarts; 0600 FileStore in the shell).
	tok, _ := st.LoadSession()
	if tok != "tok-1" {
		t.Fatalf("persisted session token: %q", tok)
	}
	// The post-login hook fired with the identity.
	select {
	case u := <-hooked:
		if u.Email != "user@example.com" {
			t.Fatalf("hook identity: %+v", u)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("onLogin hook did not fire")
	}
}

func TestLoginWrongCredentialsIsAResultNotAnError(t *testing.T) {
	_, st, a := loginFake(t)
	res, err := a.Login("user@example.com", "wrong-password")
	if err != nil {
		t.Fatalf("auth failures must resolve (the card branches on res), not reject: %v", err)
	}
	if res.OK || res.Code != "invalid_credentials" || res.Message == "" {
		t.Fatalf("login result: %+v", res)
	}
	if a.AuthState().Authenticated {
		t.Fatal("state must stay unauthenticated on failure")
	}
	if tok, _ := st.LoadSession(); tok != "" {
		t.Fatal("no session may persist on a failed login")
	}
}

func TestLoginValidationAndTransport(t *testing.T) {
	_, _, a := loginFake(t)
	if _, err := a.Login("", ""); err == nil {
		t.Fatal("empty credentials must reject")
	}
	if _, err := a.Login("   user@example.com   ", "pw"); err != nil {
		t.Fatalf("login input is trimmed: %v", err)
	}
	// Transport-level failure → rejected promise (the card's can't-reach branch).
	c, _ := api.New("http://127.0.0.1:1") // nothing listens
	b := New(c, "v", "r")
	if _, err := b.Login("user@example.com", "pw"); err == nil {
		t.Fatal("unreachable host must reject, not resolve")
	}
}

func TestRequest401ReopensTheLoginCard(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
	}))
	defer srv.Close()
	c, _ := api.New(srv.URL)
	a := New(c, "v", "r")
	a.SetAuthed(&api.Me{User: api.MeUser{ID: "u1", Email: "user@example.com"}}, true)
	reasons := make(chan string, 8)
	a.SetOnAuthLost(func(reason string) { reasons <- reason })

	if !a.AuthState().Authenticated {
		t.Fatal("precondition: authed")
	}
	res, err := a.Request("GET", "/api/projects/p1/devboard", "")
	if err != nil {
		t.Fatalf("401 flows as a response: %v", err)
	}
	if res.Status != 401 {
		t.Fatalf("status: %+v", res)
	}
	select {
	case r := <-reasons:
		if r != "island-401" {
			t.Fatalf("auth-lost reason: %q", r)
		}
	default:
		t.Fatal("the island 401 must fire the auth-lost notifier")
	}
	if a.AuthState().Authenticated {
		t.Fatal("state must flip to unauthenticated")
	}
	// Idempotent: an already-dead session never spams the event.
	a.NotifyAuthLost("again")
	select {
	case <-reasons:
		t.Fatal("a second notify on a dead session must be silent")
	default:
	}
}

func TestAwaitReloginWakesOnLogin(t *testing.T) {
	_, _, a := loginFake(t)
	dead := make(chan error, 1)
	go func() { dead <- a.AwaitRelogin(context.Background()) }()
	// Wait for the waiter to register before logging in.
	for i := 0; i < 400; i++ {
		a.mu.Lock()
		n := len(a.reloginWaiters)
		a.mu.Unlock()
		if n == 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if _, err := a.Login("user@example.com", "pw"); err != nil {
		t.Fatalf("login: %v", err)
	}
	select {
	case err := <-dead:
		if err != nil {
			t.Fatalf("AwaitRelogin must resolve nil on Login: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("AwaitRelogin did not wake on Login")
	}
}

func TestAwaitReloginHonorsContext(t *testing.T) {
	_, _, a := loginFake(t)
	ctx, cancel := context.WithCancel(context.Background())
	dead := make(chan error, 1)
	go func() { dead <- a.AwaitRelogin(ctx) }()
	for i := 0; i < 400; i++ {
		a.mu.Lock()
		n := len(a.reloginWaiters)
		a.mu.Unlock()
		if n == 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	select {
	case err := <-dead:
		if err == nil {
			t.Fatal("a cancelled wait must return an error")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("AwaitRelogin did not observe the context")
	}
}

func TestRollingSessionRefreshPersists(t *testing.T) {
	_, st, a := loginFake(t)
	if _, err := a.Login("user@example.com", "pw"); err != nil {
		t.Fatalf("login: %v", err)
	}
	if tok, _ := st.LoadSession(); tok != "tok-1" {
		t.Fatalf("initial persist: %q", tok)
	}
	// The server re-Set-Cookies on use (30-day rolling): the jar updates…
	a.client.SetSessionToken("tok-2")
	// …and the next successful Request persists the new token.
	if _, err := a.Request("GET", "/api/ping", ""); err != nil {
		t.Fatalf("ping: %v", err)
	}
	if tok, _ := st.LoadSession(); tok != "tok-2" {
		t.Fatalf("rolling refresh not persisted: %q", tok)
	}
}

// makeBody builds a deterministic oversized string without pulling in strings.
func makeBody(n int) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = 'a'
	}
	return string(b)
}

// TestBridgeFreshAfterEngineSeededETag — THE S215 DOGFOOD REGRESSION, end to
// end at the bridge: the sync engine's pull rounds run on the SAME client and
// leave an If-None-Match cached for every board path (the engine's §8
// cheap-poll). The owner's report — "when i wanted to change project got
// this error: couldn't load - try again" — was the island's switcher GET
// hitting that cached validator: the server answered 304 and the board
// renderer, which holds no cached copy, threw on the non-ok status. The
// bridge is the INTERACTIVE transport: the same-path GET through it must
// come back the full 200 + body, every time, whatever the engine cached.
func TestBridgeFreshAfterEngineSeededETag(t *testing.T) {
	const boardPath = "/api/projects/p9/devboard"
	const etag = `W/"s215"`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != boardPath {
			w.WriteHeader(404)
			_, _ = w.Write([]byte(`{"error":"not_found"}`))
			return
		}
		// http.ts:103-127 semantics: exact If-None-Match match → 304, else the
		// full 200 + validator.
		if inm := r.Header.Get("If-None-Match"); inm == etag {
			w.Header().Set("ETag", etag)
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", etag)
		_, _ = w.Write([]byte(`{"project":{"id":"p9"},"tasks":[]}`))
	}))
	t.Cleanup(srv.Close)
	c, err := api.New(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	// 1) The engine's first pull seeds the validator (exactly what a sync
	//    round leaves in the shared client).
	if _, err := c.Request(ctx, http.MethodGet, boardPath, nil); err != nil {
		t.Fatalf("engine first pull: %v", err)
	}
	// 2) The engine's cheap re-poll 304s (its own contract — unchanged).
	if _, err := c.Request(ctx, http.MethodGet, boardPath, nil); err != api.ErrNotModified {
		t.Fatalf("engine re-poll must stay ErrNotModified, got %v", err)
	}

	// 3) THE BUG SCENARIO: the island's switcher GETs the same path through
	//    the bridge. Must be the full 200 + body — pre-fix this returned
	//    {status:304, body:""} and the board showed "Couldn't load the board".
	a := New(c, "0.1.4-dev", "e6661c8")
	res, err := a.Request("GET", boardPath, "")
	if err != nil {
		t.Fatalf("bridge switcher GET: %v", err)
	}
	if res.Status != http.StatusOK {
		t.Fatalf("the island's interactive GET must be a full 200, got %+v", res)
	}
	var wire map[string]any
	if json.Unmarshal([]byte(res.Body), &wire) != nil || wire["project"] == nil {
		t.Fatalf("the island must receive the full board body, got %q", res.Body)
	}

	// 4) Repeat: even after the fresh 200 refreshed the validator, the NEXT
	//    switch (or any later island fetch of the same path) is still a 200.
	res2, err := a.Request("GET", boardPath, "")
	if err != nil || res2.Status != http.StatusOK {
		t.Fatalf("every interactive GET must stay 200, got err=%v %+v", err, res2)
	}
}
