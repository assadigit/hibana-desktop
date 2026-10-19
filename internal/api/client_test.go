package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeWorker is a minimal stand-in for the Hono app implementing the EXACT
// contract bits the client depends on (API-AND-SYNC-CONTRACT.md):
//
//   - T6 CSRF/origin gate: writes without Origin are 403'd (app.ts:172-194)
//   - cookie session: login mints __Host-hibana_session; /api/auth/me
//     401s without it
//   - weak ETag on the hot GET (http.ts:103-127): If-None-Match exact match →
//     304 carrying the same validator
//   - the uniform error body {error:'<code>'}
type fakeWorker struct {
	mu sync.Mutex

	session   string // the minted cookie value ("" = no logins yet)
	sessions  map[string]bool
	logins    int
	failNext  int32 // GETs to fail once (transport-ish 503) for the retry test
	boardHits *int32
	etag      string
	body      string
}

func newFakeWorker() *fakeWorker {
	hits := new(int32)
	return &fakeWorker{sessions: map[string]bool{}, boardHits: hits, etag: `W/"abc123"`, body: `{"ok":true}`}
}

func (f *fakeWorker) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/auth/login", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.logins++
		f.mu.Unlock()
		var body struct {
			Login    string `json:"login"`
			Password string `json:"password"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Login == "" || body.Password == "" {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"invalid_input"}`))
			return
		}
		f.mu.Lock()
		f.session = fmt.Sprintf("tok-%d", f.logins)
		f.sessions[f.session] = true
		s := f.session
		f.mu.Unlock()
		w.Header().Set("Set-Cookie", SessionCookie+"="+s+"; Path=/; Secure; HttpOnly; SameSite=Lax")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"user":{"id":"u1"}}`))
	})
	mux.HandleFunc("/api/auth/me", func(w http.ResponseWriter, r *http.Request) {
		ck, err := r.Cookie(SessionCookie)
		if err != nil || ck.Value == "" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
			return
		}
		f.mu.Lock()
		ok := f.sessions[ck.Value]
		f.mu.Unlock()
		if !ok {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
			return
		}
		_, _ = w.Write([]byte(`{"user":{"id":"u1","username":"t"}}`))
	})
	mux.HandleFunc("/api/projects/p1/devboard", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(f.boardHits, 1)
		if atomic.LoadInt32(&f.failNext) > 0 {
			atomic.AddInt32(&f.failNext, -1)
			// A transport-ish failure the retry leg must survive: hang the
			// request past the client's 3s deadline.
			time.Sleep(2 * getDeadline)
			w.WriteHeader(http.StatusGatewayTimeout)
			return
		}
		ck, err := r.Cookie(SessionCookie)
		if err != nil || ck.Value == "" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
			return
		}
		f.mu.Lock()
		etag, body := f.etag, f.body
		f.mu.Unlock()
		if inm := r.Header.Get("If-None-Match"); inm != "" && inm == etag {
			w.Header().Set("ETag", etag)
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", etag)
		w.Header().Set("Cache-Control", "private, no-cache")
		_, _ = w.Write([]byte(body))
	})
	mux.HandleFunc("/api/devtasks/t1", func(w http.ResponseWriter, r *http.Request) {
		// The T6 gate: any write without an Origin/Referer is 403'd.
		if r.Header.Get("Origin") == "" && r.Header.Get("Referer") == "" {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"error":"forbidden"}`))
			return
		}
		if _, err := r.Cookie(SessionCookie); err != nil {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
			return
		}
		_, _ = w.Write([]byte(`{"ok":true,"tags":[]}`))
	})
	mux.HandleFunc("/boom", func(w http.ResponseWriter, r *http.Request) { // always 500 on GET
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"internal_error"}`))
	})
	return mux
}

func newTestClient(t *testing.T, fw *fakeWorker) *Client {
	t.Helper()
	srv := httptest.NewServer(fw.handler())
	t.Cleanup(srv.Close)
	c, err := New(srv.URL)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// The httptest server is plain HTTP; the jar cookie is Secure — Go still
	// stores/sends it since we inject it via SetCookies on the same URL.
	return c
}

func TestLoginRoundTrip(t *testing.T) {
	fw := newFakeWorker()
	c := newTestClient(t, fw)
	ctx := context.Background()
	if err := c.Login(ctx, "user@example.com", "pw"); err != nil {
		t.Fatalf("login: %v", err)
	}
	if c.SessionToken() == "" {
		t.Fatal("no session cookie in jar after login")
	}
	me, err := c.Me(ctx)
	if err != nil || me.User.ID != "u1" {
		t.Fatalf("me after login: %v %+v", err, me)
	}
}

func TestLoginInvalidInput(t *testing.T) {
	fw := newFakeWorker()
	c := newTestClient(t, fw)
	err := c.Login(context.Background(), "", "")
	se, ok := err.(*StatusError)
	if !ok || se.Status != 400 || se.Code != "invalid_input" {
		t.Fatalf("want 400 invalid_input StatusError, got %v", err)
	}
}

func TestT6OriginGate(t *testing.T) {
	fw := newFakeWorker()
	c := newTestClient(t, fw)
	ctx := context.Background()
	if err := c.Login(ctx, "u", "p"); err != nil {
		t.Fatalf("login: %v", err)
	}
	// The client stamps Origin on every write → the gate passes.
	if err := c.PatchTask(ctx, "t1", PatchTaskReq{}); err != nil {
		t.Fatalf("patch with Origin should pass the T6 gate: %v", err)
	}
}

func TestUnauthorizedSurfacesStatus(t *testing.T) {
	fw := newFakeWorker()
	c := newTestClient(t, fw) // never logged in
	_, err := c.Board(context.Background(), "p1")
	se, ok := err.(*StatusError)
	if !ok || se.Status != 401 || se.Code != "unauthorized" {
		t.Fatalf("want 401 unauthorized StatusError, got %v", err)
	}
}

func TestETagCheapPoll(t *testing.T) {
	fw := newFakeWorker()
	c := newTestClient(t, fw)
	ctx := context.Background()
	if err := c.Login(ctx, "u", "p"); err != nil {
		t.Fatalf("login: %v", err)
	}
	bp, err := c.Board(ctx, "p1")
	if err != nil || bp == nil {
		t.Fatalf("first board pull: %v", err)
	}
	if c.ETag(BoardPath("p1")) != `W/"abc123"` {
		t.Fatalf("etag not stored after 200: %q", c.ETag(BoardPath("p1")))
	}
	hitsBefore := atomic.LoadInt32(fw.boardHits)
	_, err = c.Board(ctx, "p1")
	if err != ErrNotModified {
		t.Fatalf("second pull should be ErrNotModified, got %v", err)
	}
	if got := atomic.LoadInt32(fw.boardHits); got != hitsBefore+1 {
		t.Fatalf("cheap poll should still hit the wire once (validator check), hits %d→%d", hitsBefore, got)
	}
}

func TestGetRetryOnce(t *testing.T) {
	fw := newFakeWorker()
	c := newTestClient(t, fw)
	ctx := context.Background()
	if err := c.Login(ctx, "u", "p"); err != nil {
		t.Fatalf("login: %v", err)
	}
	atomic.StoreInt32(&fw.failNext, 1)
	// The first attempt hangs past the 3s deadline; the ONE retry (10s leg)
	// lands after the fake's sleep released. To keep the test fast we shrink
	// the deadlines instead of waiting real seconds.
	c.getDeadline = 40 * time.Millisecond
	c.getRetryDeadline = 300 * time.Millisecond
	done := make(chan error, 1)
	go func() {
		_, err := c.Board(ctx, "p1")
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("board pull with one hung attempt should succeed on retry: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("retry leg never completed")
	}
}

func TestStatusErrorCarriesCode(t *testing.T) {
	fw := newFakeWorker()
	c := newTestClient(t, fw)
	_, err := c.get(context.Background(), http.MethodGet, "/boom")
	se, ok := err.(*StatusError)
	if !ok || se.Status != 500 || se.Code != "internal_error" {
		t.Fatalf("want 500 internal_error StatusError, got %v", err)
	}
}

func TestPacerCeiling(t *testing.T) {
	fw := newFakeWorker()
	c := newTestClient(t, fw)
	c.now = func() time.Time { return fakeNow } // frozen clock
	ctx := context.Background()
	for i := 0; i < rateCeiling; i++ {
		if err := c.Pace(ctx, authBucket); err != nil {
			t.Fatalf("pace %d: %v", i, err)
		}
	}
	// The ceiling is hit — with a frozen clock the next Pace must block until
	// context dies (never a silent 31st hit in one window).
	cctx, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	if err := c.Pace(cctx, authBucket); err == nil {
		t.Fatal("pace beyond the ceiling must block (or fail on ctx), never pass")
	}
}

var fakeNow = time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)

func TestSetSessionTokenRestores(t *testing.T) {
	fw := newFakeWorker()
	c := newTestClient(t, fw)
	// Mint a session via login, then move it to a "fresh" client (restart).
	if err := c.Login(context.Background(), "u", "p"); err != nil {
		t.Fatalf("login: %v", err)
	}
	tok := c.SessionToken()
	c2 := newTestClient(t, fw)
	c2.SetSessionToken(tok)
	me, err := c2.Me(context.Background())
	if err != nil || me.User.ID != "u1" {
		t.Fatalf("restored session should validate: %v", err)
	}
}

// TestRequestFreshNeverConditional — the S215 dogfood root cause, as a
// client-level contract: after the ENGINE's pulls seed the shared ETag store
// (exactly what the sync loop leaves behind), the ENGINE's next poll stays
// the §8 cheap-poll (304 → ErrNotModified) while the INTERACTIVE fetch on
// the very same path carries NO validator and takes the full 200 home.
func TestRequestFreshNeverConditional(t *testing.T) {
	fw := newFakeWorker()
	c := newTestClient(t, fw)
	ctx := context.Background()
	if err := c.Login(ctx, "u", "p"); err != nil {
		t.Fatalf("login: %v", err)
	}
	// 1) The engine's first pull: 200, validator stored.
	if _, err := c.Board(ctx, "p1"); err != nil {
		t.Fatalf("first board pull: %v", err)
	}
	if c.ETag(BoardPath("p1")) == "" {
		t.Fatal("validator not stored after the engine pull")
	}
	// 2) The engine's re-pull: still the cheap poll (regression guard — the
	//    Request path keeps its conditional contract).
	if _, err := c.Board(ctx, "p1"); err != ErrNotModified {
		t.Fatalf("engine re-pull must stay ErrNotModified, got %v", err)
	}
	// 3) The island's interactive GET of the SAME path (the project switcher):
	//    no If-None-Match rides along, so the fake (304 only on an exact
	//    validator match, like http.ts:103-127) must serve the full 200.
	resp, err := c.RequestFresh(ctx, http.MethodGet, BoardPath("p1"), nil)
	if err != nil {
		t.Fatalf("fresh GET after the engine's poll: %v", err)
	}
	if resp == nil || resp.Status != http.StatusOK || string(resp.Body) != fw.body {
		t.Fatalf("fresh GET must be the full 200 body, got %+v", resp)
	}
	// 4) The fresh 200 refreshed the validator — the engine's NEXT poll is
	//    still cheap (304), never a double-pull.
	if _, err := c.Board(ctx, "p1"); err != ErrNotModified {
		t.Fatalf("engine poll after a fresh GET must stay ErrNotModified, got %v", err)
	}
}

// TestRequestFreshRejectsUnexpected304 — a 304 answering a request that sent
// NO validator is malformed (RFC 9110 §15.4.5: 304 is a conditional answer);
// the interactive path errors loudly instead of returning a body-less "ok".
func TestRequestFreshRejectsUnexpected304(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("ETag", `W/"x"`)
		w.WriteHeader(http.StatusNotModified)
	}))
	t.Cleanup(srv.Close)
	c, err := New(srv.URL)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	_, err = c.RequestFresh(context.Background(), http.MethodGet, "/api/x", nil)
	if err == nil || err == ErrNotModified {
		t.Fatalf("unexpected 304 must be a loud error, got %v", err)
	}
}

// TestRequestFreshWritesStillStampOrigin — the interactive write path is
// byte-identical to Request: the T6 Origin gate passes on the bridge's writes.
func TestRequestFreshWritesStillStampOrigin(t *testing.T) {
	fw := newFakeWorker()
	c := newTestClient(t, fw)
	ctx := context.Background()
	if err := c.Login(ctx, "u", "p"); err != nil {
		t.Fatalf("login: %v", err)
	}
	if _, err := c.RequestFresh(ctx, http.MethodPatch, "/api/devtasks/t1", []byte(`{"title":"x"}`)); err != nil {
		t.Fatalf("fresh write without Origin would be 403'd at the gate: %v", err)
	}
}
