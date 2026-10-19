// Package ui — the JS↔Go bridge (the Wails binding surface).
//
// THE BRIDGE IS AN API SURFACE (GO-DESKTOP-IMPLEMENTATION-GUIDE.md §4.4, hard
// rule 10). Every bound method is callable from the island's JS — and the
// island renders user-authored task titles, so the bridge must assume
// hostile input at the JS boundary even though the renderer is our own code:
//
//  1. The bound transport surface is exactly ONE method —
//     Request(method, path, body) — plus the read-only AppInfo getter.
//     NEVER generic file/system/exec bindings; the upload stream joins at M4
//     with the same discipline.
//  2. Request validates the method against an allow-list, the path against
//     the API prefix allow-list (/api/… — which contains the media file
//     route), and enforces the body size cap (the 5 MB upload ceiling is the
//     server's own; the bridge mirrors the server's 7 MB rejection boundary,
//     core.ts:468 — bigger bodies never cross the bridge).
//  3. Go never trusts island-supplied credentials — the cookie jar lives
//     Go-side only (auth package; DPAPI at rest per WINDOWS-PACKAGING-PLAN §8).
//     There is no method to set a cookie/token from JS, by design.
//
// THE LOGIN WINDOW EXCEPTION (guide §5.5 — the M2 pick landed: the
// island-rendered login card): the user's typed email/username + password
// cross the bridge exactly ONCE, for the Login round-trip (Go performs
// POST /api/auth/login and stores the Set-Cookie Go-side; the cookie value
// NEVER crosses back into JS). The password exists in memory only for that
// call — never logged, never stored (guide §5.1). AuthState is the read-only
// boot snapshot (the shell injects it into the served index.html so the login
// card's visibility resolves at first paint; it also feeds the island's
// window.__hibanaMe language hook, i18n.js:69-77).
package ui

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"hibana/desktop/internal/api"
	"hibana/desktop/internal/auth"
)

// maxBridgeBody mirrors the server's own rejection boundary: uploads are
// ≤5MB base64 and Content-Length >7MB is 413'd before parsing (core.ts:468).
// A body bigger than this never crosses the bridge.
const maxBridgeBody = 7 << 20

// reloginWaitCap bounds how long the outbox's 401-relogin-once rule (§10)
// waits for the user to sign back in before the op is held for the next
// drain round.
const reloginWaitCap = 10 * time.Minute

// BridgeResponse is what Request returns to JS (the desktop-shim's contract,
// guide §4.3): {status, body, etag}.
type BridgeResponse struct {
	Status int    `json:"status"`
	Body   string `json:"body"`
	ETag   string `json:"etag"`
}

// AppInfo carries the two version stamps (hard rule 9: both versions on
// every release — the desktop semver + the embedded web ref, -X stamped).
type AppInfo struct {
	Version string `json:"version"`
	WebRef  string `json:"webRef"`
}

// AuthInfo is the live session snapshot: the boot-time visibility signal for
// the login card (injected into the served index.html) + the identity feed
// for the island's window.__hibanaMe language hook (i18n.js:69-77).
type AuthInfo struct {
	Authenticated bool        `json:"authenticated"`
	User          *api.MeUser `json:"user,omitempty"`
}

// LoginResult is one sign-in attempt's wire result. Auth failures come back
// as {ok:false, code, message} with a NIL error so the login card can branch
// wrong-password vs suspended vs rate-limited without parsing Go error
// strings; a non-nil error means transport-level trouble (unreachable host),
// which the card reports as its own can't-reach message.
type LoginResult struct {
	OK      bool        `json:"ok"`
	Code    string      `json:"code,omitempty"`
	Message string      `json:"message,omitempty"`
	User    *api.MeUser `json:"user,omitempty"`
}

// API is the struct Wails binds into the WebView (window.go.<pkg>.API).
type API struct {
	client  *api.Client
	version string
	webRef  string

	mu     sync.Mutex
	authed bool
	me     *api.MeUser

	store      auth.Store // optional (nil = tests / no persistence)
	onLogin    func(me *api.MeUser)
	onAuthLose func(reason string)

	reloginWaiters []chan struct{}

	// lastPersisted tracks the session token as last written to the store so
	// the 30-day rolling refresh (the server re-Set-Cookies on use) survives
	// restarts without re-writing the file on every request.
	lastPersisted string
}

// New wires the bridge. The client is the cloud client (cookie jar, Origin
// stamping, ETag store — all Go-side; the island has no access to them).
func New(c *api.Client, version, webRef string) *API {
	return &API{client: c, version: version, webRef: webRef}
}

// SetSessionStore wires the session persistence (auth.FileStore in the
// shell; auth.MemStore in tests). Optional: without it Login works but the
// session dies with the process.
func (a *API) SetSessionStore(s auth.Store) { a.store = s }

// SetOnLogin wires the post-login hook (the shell kicks a fresh sync round
// so the mirror fills immediately). Runs after the auth state flips and the
// relogin waiters wake; a slow hook never blocks the Login call.
func (a *API) SetOnLogin(fn func(me *api.MeUser)) { a.onLogin = fn }

// SetOnAuthLost wires the session-death notifier (the shell emits the
// hibana:auth-required Wails event so the login card reopens, guide §5.5's
// "401 mid-session → the session-expiry dialog"). Fires only on the true→false
// transition — a cold-start unauthenticated boot never spams it.
func (a *API) SetOnAuthLost(fn func(reason string)) { a.onAuthLose = fn }

// SetAuthed seeds the boot state (auth.Restore's outcome). me may be nil.
func (a *API) SetAuthed(me *api.Me, live bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.me = nil
	if live && me != nil {
		u := me.User
		a.authed = true
		a.me = &u
	} else {
		a.authed = false
	}
	if a.store != nil {
		a.lastPersisted = a.client.SessionToken()
	}
}

// AuthState reports the live session snapshot.
func (a *API) AuthState() AuthInfo {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.authed {
		return AuthInfo{}
	}
	return AuthInfo{Authenticated: true, User: a.me}
}

// Login performs the guide §5.5 round-trip: POST /api/auth/login Go-side
// (paced by the auth bucket), read the identity, persist the session token,
// flip the auth state, wake any outbox relogin waiters, fire the onLogin
// hook. The password exists in memory only for this call.
func (a *API) Login(login, password string) (LoginResult, error) {
	login = strings.TrimSpace(login)
	if login == "" || password == "" {
		return LoginResult{}, fmt.Errorf("bridge: login: email and password are required")
	}
	if len(login) > 320 || len(password) > 512 {
		return LoginResult{}, fmt.Errorf("bridge: login: credentials exceed size limits")
	}
	me, err := auth.Login(context.Background(), a.client, login, password)
	if err != nil {
		var se *api.StatusError
		if errors.As(err, &se) {
			return LoginResult{OK: false, Code: loginFailCode(se), Message: loginFailMessage(se)}, nil
		}
		// Transport-level (deadline/connection): the card's can't-reach branch.
		return LoginResult{}, fmt.Errorf("bridge: login: %w", err)
	}

	u := me.User
	a.mu.Lock()
	a.authed = true
	a.me = &u
	waiters := a.reloginWaiters
	a.reloginWaiters = nil
	hook := a.onLogin
	a.mu.Unlock()

	// Wake the outbox's retry-once waiters FIRST (guide §5.5: re-POST → the
	// failing op retries once) — the fresh cookie is already in the jar.
	for _, ch := range waiters {
		close(ch)
	}

	if a.store != nil {
		if tok := a.client.SessionToken(); tok != "" && tok != a.lastPersisted {
			if err := a.store.SaveSession(tok); err != nil {
				log.Printf("hibana auth: persisting session failed (continuing in-memory): %v", err)
			} else {
				a.lastPersisted = tok
			}
		}
	}

	if hook != nil {
		go hook(&u)
	}
	return LoginResult{OK: true, User: &u}, nil
}

// loginFailCode maps the API's {error:code} body to a stable machine code
// for the card's branching (verified live: wrong password → 401
// {"error":"invalid_credentials"}).
func loginFailCode(se *api.StatusError) string {
	switch se.Status {
	case http.StatusUnauthorized:
		return "invalid_credentials"
	case http.StatusForbidden:
		return "forbidden"
	case http.StatusTooManyRequests:
		return "rate_limited"
	default:
		if se.Status >= 500 {
			return "server_error"
		}
		if se.Code != "" {
			return se.Code
		}
		return fmt.Sprintf("status_%d", se.Status)
	}
}

func loginFailMessage(se *api.StatusError) string {
	switch loginFailCode(se) {
	case "invalid_credentials":
		return "Wrong email or password — try again."
	case "forbidden":
		return "Sign-in was refused (403) — the account may be suspended."
	case "rate_limited":
		return "Too many attempts — wait a minute and try again."
	case "server_error":
		return "hibana.ir is having trouble right now — try again in a moment."
	default:
		return "Sign-in failed — try again."
	}
}

// NotifyAuthLost marks the session dead (a 401 crossed the bridge, the pull
// loop, or the outbox drain) and fires the onAuthLost notifier on the
// true→false transition. Idempotent: an already-dead session is silent.
func (a *API) NotifyAuthLost(reason string) {
	a.mu.Lock()
	was := a.authed
	a.authed = false
	a.me = nil
	hook := a.onAuthLose
	a.mu.Unlock()
	if was && hook != nil {
		hook(reason)
	}
}

// AwaitRelogin blocks until the next successful Login, the context dies, or
// the wait cap elapses (the outbox's 401 rule: re-auth then retry ONCE — a
// nil return means the fresh session is live and the op replays).
func (a *API) AwaitRelogin(ctx context.Context) error {
	ch := make(chan struct{})
	a.mu.Lock()
	a.reloginWaiters = append(a.reloginWaiters, ch)
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		keep := a.reloginWaiters[:0]
		for _, w := range a.reloginWaiters {
			if w != ch {
				keep = append(keep, w)
			}
		}
		a.reloginWaiters = keep
		a.mu.Unlock()
	}()
	t := time.NewTimer(reloginWaitCap)
	defer t.Stop()
	select {
	case <-ch:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("relogin: %w", ctx.Err())
	case <-t.C:
		return fmt.Errorf("relogin: no sign-in within %s", reloginWaitCap)
	}
}

// AppInfo reports the build stamps (the parity pin — displayed in the shell's
// about surface and stamped into Release notes).
func (a *API) AppInfo() AppInfo {
	return AppInfo{Version: a.version, WebRef: a.webRef}
}

// Request is the ONE transport method the island calls (window.hibanaFetch →
// window.gohibana.api.Request). It executes an API call with the Go-side
// session/Origin/ETag machinery and returns the wire result. Validation
// failures return a Go error — Wails surfaces it as a rejected JS promise,
// which the shim converts to a thrown error exactly like a failed fetch.
func (a *API) Request(method, path, body string) (BridgeResponse, error) {
	method = strings.ToUpper(strings.TrimSpace(method))
	switch method {
	case http.MethodGet, http.MethodPost, http.MethodPatch, http.MethodPut, http.MethodDelete:
	default:
		return BridgeResponse{}, fmt.Errorf("bridge: method not allowed: %q", method)
	}
	path = strings.TrimSpace(path)
	if !strings.HasPrefix(path, "/api/") {
		return BridgeResponse{}, fmt.Errorf("bridge: path outside the API allow-list: %q", path)
	}
	if strings.Contains(path, "..") || strings.Contains(path, "://") || strings.ContainsAny(path, "\x00\r\n") {
		return BridgeResponse{}, fmt.Errorf("bridge: malformed path: %q", path)
	}
	if len(body) > maxBridgeBody {
		return BridgeResponse{}, fmt.Errorf("bridge: body exceeds the %d-byte cap", maxBridgeBody)
	}
	var bodyBytes []byte
	if body != "" {
		bodyBytes = []byte(body)
	}
	resp, err := a.client.Request(context.Background(), method, path, bodyBytes)
	if err == nil {
		a.noteSessionRefresh()
		return BridgeResponse{Status: resp.Status, Body: string(resp.Body), ETag: resp.ETag}, nil
	}
	// Status errors flow to JS as {status, body} so the island's err.status
	// branching (404-gone vs transient, devboard.js:56-61) keeps working —
	// the shim builds the fetch-shaped response from it.
	if se, ok := err.(*api.StatusError); ok {
		if se.Status == http.StatusUnauthorized {
			// The island's own read just 401'd while we believed the session
			// live: the cookie died mid-session — reopen the login card
			// (guide §5.5's session-expiry path). Idempotent below the
			// transition, so a cold-start unauthenticated board stays quiet.
			a.NotifyAuthLost("island-401")
		}
		return BridgeResponse{Status: se.Status, Body: se.Body, ETag: ""}, nil
	}
	if err == api.ErrNotModified {
		// A cheap-poll 304 through the bridge: status 304 + the stored ETag
		// (the shim's headers.get('etag') contract, guide §4.3).
		return BridgeResponse{Status: http.StatusNotModified, Body: "", ETag: a.client.ETag(path)}, nil
	}
	return BridgeResponse{}, fmt.Errorf("bridge: transport: %w", err)
}

// noteSessionRefresh persists the rolling session token when the server
// re-Set-Cookies on use (the 30-day rolling expiry) so a restart keeps the
// session alive without a re-login. Cheap: one jar read per 2xx call, one
// file write only when the token actually moved.
func (a *API) noteSessionRefresh() {
	if a.store == nil {
		return
	}
	tok := a.client.SessionToken()
	if tok == "" || tok == a.lastPersisted {
		return
	}
	if err := a.store.SaveSession(tok); err != nil {
		log.Printf("hibana auth: persisting rolling session failed: %v", err)
		return
	}
	a.lastPersisted = tok
}
