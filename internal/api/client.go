package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"sync"
	"time"
)

// The web client's resilience recipe, re-homed from devboard.js:10-64: every
// GET dispatches with a deadline + ONE fresh retry (the browser/edge
// dispatch-hang workaround); mutations never retry blind. The second deadline
// is generous (the web used 10s for the retry leg).
const (
	getDeadline      = 3 * time.Second
	getRetryDeadline = 10 * time.Second

	// SessionCookie is the host-only session cookie (SEC-10, sessions.ts:15).
	// A desktop client cannot share the browser's jar — it logs in itself and
	// holds its own cookie (contract §2).
	SessionCookie = "__Host-hibana_session"
)

// StatusError carries an HTTP status so callers branch 404-gone vs transient —
// the err.status contract of devboard.js:56-61, preserved across the seam.
type StatusError struct {
	Status int
	Method string
	Path   string
	Code   string // the uniform {error:'<code>'} body's code, when parseable
	Body   string
}

func (e *StatusError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("hibana api: %s %s: %d %s", e.Method, e.Path, e.Status, e.Code)
	}
	return fmt.Sprintf("hibana api: %s %s: %d", e.Method, e.Path, e.Status)
}

// ErrNotModified reports a 304 from an If-None-Match cheap-poll (contract §8):
// nothing changed since the last pull — zero body work done.
var ErrNotModified = errors.New("hibana api: not modified (304)")

// Response is one API round-trip's wire result.
type Response struct {
	Status int
	Body   []byte
	ETag   string // the weak FNV-1a validator on ETag-wrapped GETs ("" when none)
}

// Client is the cloud API client. It owns the cookie jar, the Origin header on
// writes (the T6 gate), the per-path ETag store, and the rate-limit pacing —
// the island never touches any of these (GO-DESKTOP-PORT-PLAN §2.1).
type Client struct {
	base   *url.URL
	origin string // the trusted origin stamped on every write (T6 gate)
	http   *http.Client
	jar    *cookiejar.Jar

	mu    sync.Mutex
	etags map[string]string // path → last ETag

	paceMu   sync.Mutex
	paceHits map[string][]time.Time // bucket → window timestamps

	getDeadline      time.Duration
	getRetryDeadline time.Duration
	now              func() time.Time // injectable for tests
}

// New builds a client for a base host (e.g. "https://hibana.ir"). The origin is
// the trusted origin sent on writes — the same host for the prod deployment
// (both hosts serve the identical app, contract §6, and the gate accepts
// self-origin; the desktop is not a browser origin, so it presents the
// canonical one).
func New(baseURL string) (*Client, error) {
	base, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return nil, fmt.Errorf("hibana api: invalid base URL %q", baseURL)
	}
	jar, err := cookiejar.New(nil)
	if err != nil {
		return nil, err
	}
	return &Client{
		base:             base,
		origin:           base.String(),
		http:             &http.Client{Transport: nil, Jar: jar},
		jar:              jar,
		etags:            map[string]string{},
		paceHits:         map[string][]time.Time{},
		getDeadline:      getDeadline,
		getRetryDeadline: getRetryDeadline,
		now:              time.Now,
	}, nil
}

// SetSessionToken restores a persisted session cookie into the jar (auth
// package's Restore path). The token is the cookie VALUE only — never logged.
func (c *Client) SetSessionToken(token string) {
	c.jar.SetCookies(c.base, []*http.Cookie{{
		Name:   SessionCookie,
		Value:  token,
		Path:   "/",
		Secure: true,
	}})
}

// SessionToken returns the current session cookie value ("" when logged out).
func (c *Client) SessionToken() string {
	for _, ck := range c.jar.Cookies(c.base) {
		if ck.Name == SessionCookie {
			return ck.Value
		}
	}
	return ""
}

// ClearSession drops the session cookie AND the per-path ETag cache — the
// two account-scoped states the client holds in memory. Logout (and only
// logout) calls it: the pair must die together, because a surviving
// validator would let the post-login pulls cheap-poll 304 against a mirror
// that was just wiped (the engine's 304 path assumes the mirror still holds
// the content — after a logout wipe it does not). The cookie is retired by
// an expired Set-Cookie (the jar drops the entry); the belt in SessionToken
// is the "" value check below it.
func (c *Client) ClearSession() {
	c.jar.SetCookies(c.base, []*http.Cookie{{
		Name:    SessionCookie,
		Value:   "",
		Path:    "/",
		Secure:  true,
		MaxAge:  -1,              // the jar's "delete now" semantics
		Expires: time.Unix(1, 0), // the epoch — belt for jars keying on Expires
	}})
	c.mu.Lock()
	c.etags = map[string]string{}
	c.mu.Unlock()
}

// SetETag seeds the ETag store (e.g. from the local mirror's meta table after
// a restart) so the first poll is already cheap.
func (c *Client) SetETag(path, etag string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if etag == "" {
		delete(c.etags, path)
	} else {
		c.etags[path] = etag
	}
}

// ETag returns the last-seen validator for a path ("" when none).
func (c *Client) ETag(path string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.etags[path]
}

// Request executes one API call. GETs carry the 3s deadline + ONE retry and
// the stored If-None-Match; a 304 yields (nil, ErrNotModified). Writes carry
// Origin + Content-Type and NEVER retry blind — the outbox owns their retry
// semantics (contract §10). Non-2xx/304 statuses come back as *StatusError
// with the {error:code} body parsed in.
func (c *Client) Request(ctx context.Context, method, path string, body []byte) (*Response, error) {
	method = strings.ToUpper(method)
	switch method {
	case http.MethodGet, http.MethodHead:
		return c.get(ctx, method, path)
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return c.write(ctx, method, path, body)
	default:
		return nil, fmt.Errorf("hibana api: method not allowed: %s", method)
	}
}

// RequestFresh executes one INTERACTIVE call — the bridge's transport (the
// S215 dogfood root cause: "change project → Couldn't load the board — Try
// again"). The engine and the island share ONE client, and the engine's §8
// cheap-poll seeds an If-None-Match for every board path it pulls — a
// validator the island's own GET of the SAME path then carried, so the
// server answered 304 to a renderer that holds no cached copy (the WEB
// island never sees this: its fetches ride cache:'no-store', which never
// conditional-polls). Fresh GETs therefore send NO If-None-Match; a 200
// still refreshes the stored validator (absorb), so the engine's NEXT
// cheap-poll 304s correctly instead of double-pulling. An unexpected 304
// (no validator was sent — RFC 9110 §15.4.5 allows 304 only for
// conditional requests) is a loud error, never a silently-empty board.
// Writes are byte-identical to Request (Origin stamp, no blind retry).
func (c *Client) RequestFresh(ctx context.Context, method, path string, body []byte) (*Response, error) {
	method = strings.ToUpper(method)
	switch method {
	case http.MethodGet, http.MethodHead:
		return c.getFresh(ctx, method, path)
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return c.write(ctx, method, path, body)
	default:
		return nil, fmt.Errorf("hibana api: method not allowed: %s", method)
	}
}

// getFresh is the conditional-less GET: no validator out, full 200 back.
func (c *Client) getFresh(ctx context.Context, method, path string) (*Response, error) {
	resp, err := c.do(ctx, method, path, nil, "", c.getDeadline)
	if err != nil {
		// ONE fresh retry on transport failure — the same contract as get().
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		resp, err = c.do(ctx, method, path, nil, "", c.getRetryDeadline)
		if err != nil {
			return nil, err
		}
	}
	if resp.status == http.StatusNotModified {
		return nil, fmt.Errorf("hibana api: unexpected 304 on fresh %s %s (no If-None-Match was sent)", method, path)
	}
	return c.absorb(method, path, resp)
}

func (c *Client) get(ctx context.Context, method, path string) (*Response, error) {
	etag := c.ETag(path)
	resp, err := c.do(ctx, method, path, nil, etag, c.getDeadline)
	if err != nil {
		// ONE fresh retry on transport failure (devboard.js:33-53) — unless the
		// caller cancelled, in which case the retry would be pointless.
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		resp, err = c.do(ctx, method, path, nil, etag, c.getRetryDeadline)
		if err != nil {
			return nil, err
		}
	}
	return c.absorb(method, path, resp)
}

// write executes one write round-trip (the shared Request/RequestFresh path).
func (c *Client) write(ctx context.Context, method, path string, body []byte) (*Response, error) {
	resp, err := c.do(ctx, method, path, body, "", 0)
	if err != nil {
		return nil, err
	}
	return c.absorb(method, path, resp)
}

// UploadResult is one streamed upload's wire outcome: the same status/body
// pair write returns, plus the response's Content-Type (the media proxy
// needs it; the upload POST itself answers JSON).
type UploadResult struct {
	Status      int
	Body        []byte
	ContentType string
}

// progressReader counts bytes AS THE SOCKET ACCEPTS THEM (net/http reads the
// request body through this wrapper while writing it to the wire), so the
// callback reports REAL network progress, not a simulation. The callback is
// throttled to one call per 120ms (plus the final call) so a multi-megabyte
// upload cannot flood the event relay.
type progressReader struct {
	r        io.Reader
	total    int64
	sent     int64
	fn       func(sent, total int64)
	lastTick time.Time
}

func (pr *progressReader) Read(p []byte) (int, error) {
	n, err := pr.r.Read(p)
	pr.sent += int64(n)
	if pr.fn != nil {
		now := time.Now()
		if pr.sent >= pr.total || now.Sub(pr.lastTick) >= 120*time.Millisecond {
			pr.lastTick = now
			pr.fn(pr.sent, pr.total)
		}
	}
	return n, err
}

// WriteStream is the UPLOAD round-trip (guide §5.4's M4 contract): a write
// with a KNOWN body length (never chunked — the server's 413 boundary reads
// Content-Length) whose bytes-in-flight report through progress as the
// transport accepts them. The Origin stamp, the cookie jar and the no-blind-
// retry rule are byte-identical to write(); the ETag store is untouched (an
// upload response carries no validator).
func (c *Client) WriteStream(ctx context.Context, method, path string, body []byte, progress func(sent, total int64)) (*UploadResult, error) {
	method = strings.ToUpper(method)
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
	default:
		return nil, fmt.Errorf("hibana api: method not allowed: %s", method)
	}
	if !strings.HasPrefix(path, "/") {
		return nil, fmt.Errorf("hibana api: path must be root-relative, got %q", path)
	}

	callCtx, cancel := context.WithTimeout(ctx, uploadDeadline)
	defer cancel()
	req, err := http.NewRequestWithContext(callCtx, method, c.base.String()+path, nil)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.ContentLength = int64(len(body))
		rdr := &progressReader{r: bytes.NewReader(body), total: int64(len(body)), fn: progress, lastTick: time.Now()}
		req.Body = io.NopCloser(rdr)
		req.GetBody = func() (io.ReadCloser, error) {
			return io.NopCloser(bytes.NewReader(body)), nil
		}
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	// T6 gate: headerless writers are 403'd — the desktop presents the origin.
	req.Header.Set("Origin", c.origin)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	if err != nil {
		return nil, fmt.Errorf("hibana api: reading %s %s: %w", method, path, err)
	}
	return &UploadResult{Status: resp.StatusCode, Body: b, ContentType: resp.Header.Get("Content-Type")}, nil
}

// uploadDeadline bounds one streamed upload: a 5MB image on a slow uplink is
// tens of seconds, not the 3s GET window — a media-rich round must finish.
const uploadDeadline = 10 * time.Minute

// MediaResult is one media GET's outcome: the raw bytes plus the response's
// Content-Type and Cache-Control (the desktop's media proxy forwards them so
// the WebView caches exactly like the browser would on the web).
type MediaResult struct {
	Status       int
	ContentType  string
	CacheControl string
	Body         []byte
}

// Media fetches one authed media object (GET /api/media/… — screenshots and
// their ?variant=thumb tiles, avatars). It rides the SAME cookie jar as every
// other call (the route is authed), never stores ETags (media is not a
// conditional-poll surface), and carries the media deadline — a few MB of
// image must not die on the interactive GET window.
func (c *Client) Media(ctx context.Context, path string) (*MediaResult, error) {
	if !strings.HasPrefix(path, "/") {
		return nil, fmt.Errorf("hibana api: path must be root-relative, got %q", path)
	}
	callCtx, cancel := context.WithTimeout(ctx, mediaDeadline)
	defer cancel()
	req, err := http.NewRequestWithContext(callCtx, http.MethodGet, c.base.String()+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "image/avif,image/webp,image/*,video/*;q=0.9,*/*;q=0.8")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxMediaBytes))
	if err != nil {
		return nil, fmt.Errorf("hibana api: reading media %s: %w", path, err)
	}
	return &MediaResult{
		Status:       resp.StatusCode,
		ContentType:  resp.Header.Get("Content-Type"),
		CacheControl: resp.Header.Get("Cache-Control"),
		Body:         b,
	}, nil
}

// mediaDeadline bounds one media GET (screenshots are ≤5MB uploads).
const mediaDeadline = 45 * time.Second

// maxMediaBytes caps media reads at 16MB — a screenshot can never exceed the
// server's own 5MB upload cap, so this is a generous belt against a runaway
// object, not a real ceiling.
const maxMediaBytes = 16 << 20

// wireResult is the fully-buffered outcome of one round-trip: the body is
// read to EOF INSIDE do, before the request context's cancel runs — the Go
// http client ties body streaming to the request context, so returning a
// live resp.Body out of the cancel scope would race every caller (the bug
// the first live acceptance run caught: "context canceled" mid-body).
type wireResult struct {
	status int
	etag   string
	body   []byte
}

// do executes one round-trip with deadline + header contract, buffering the
// whole body before the deadline-context cancels.
func (c *Client) do(ctx context.Context, method, path string, body []byte, ifNoneMatch string, deadline time.Duration) (*wireResult, error) {
	if !strings.HasPrefix(path, "/") {
		return nil, fmt.Errorf("hibana api: path must be root-relative, got %q", path)
	}
	callCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	if deadline > 0 {
		t := time.AfterFunc(deadline, cancel)
		defer t.Stop()
	}
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(callCtx, method, c.base.String()+path, rdr)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json") // JSON mode — NEVER HX-Request (§3)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		// T6 gate: headerless writers are 403'd (app.ts:189-192). The desktop
		// presents the trusted origin on every write.
		req.Header.Set("Origin", c.origin)
	}
	if ifNoneMatch != "" {
		req.Header.Set("If-None-Match", ifNoneMatch) // the §8 cheap-poll
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	if err != nil {
		return nil, fmt.Errorf("hibana api: reading %s %s: %w", method, path, err)
	}
	return &wireResult{status: resp.StatusCode, etag: resp.Header.Get("ETag"), body: b}, nil
}

// maxBodyBytes caps reads at ~64MB — the payloads are full-board JSON (no
// pagination server-side, contract §5.1); boards are single-user scale.
const maxBodyBytes = 64 << 20

// absorb converts the buffered wire result into the public Response /
// *StatusError / ErrNotModified contract and records ETags on 200s.
func (c *Client) absorb(method, path string, resp *wireResult) (*Response, error) {
	out := &Response{Status: resp.status, Body: resp.body, ETag: resp.etag}
	if resp.status == http.StatusNotModified {
		c.mu.Lock()
		c.etags[path] = out.ETag // re-store (the 304 carries the same validator)
		c.mu.Unlock()
		return nil, ErrNotModified
	}
	if resp.status >= 200 && resp.status < 300 {
		if resp.status == http.StatusOK && out.ETag != "" && (method == http.MethodGet || method == http.MethodHead) {
			c.mu.Lock()
			c.etags[path] = out.ETag
			c.mu.Unlock()
		}
		return out, nil
	}
	se := &StatusError{Status: resp.status, Method: method, Path: path, Body: string(resp.body)}
	var wire struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(resp.body, &wire) == nil && wire.Error != "" {
		se.Code = wire.Error
	}
	return out, se
}

// Pace blocks until the named rate bucket has a free slot (contract §3.6:
// auth 30/60s, upload 30/60s). The desktop stays under the ceilings so the
// shared-user prod API never sees a 429 from us.
func (c *Client) Pace(ctx context.Context, bucket string) error {
	for {
		now := c.now()
		c.paceMu.Lock()
		hits := c.paceHits[bucket]
		fresh := hits[:0]
		for _, t := range hits {
			if now.Sub(t) < rateWindow {
				fresh = append(fresh, t)
			}
		}
		if len(fresh) < rateCeiling {
			fresh = append(fresh, now)
			c.paceHits[bucket] = fresh
			c.paceMu.Unlock()
			return nil
		}
		wait := rateWindow - now.Sub(fresh[0]) + time.Millisecond
		c.paceMu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
	}
}

// Login runs the PBKDF2 round-trip: POST /api/auth/login (JSON — the route
// accepts JSON and form-encoded, auth.ts:63-78) → Set-Cookie lands in the jar.
// The password exists in memory only for this call — never logged, never
// stored (guide §5.1). Paced by the auth bucket.
func (c *Client) Login(ctx context.Context, login, password string) error {
	if err := c.Pace(ctx, authBucket); err != nil {
		return err
	}
	body, err := json.Marshal(map[string]string{"login": login, "password": password})
	if err != nil {
		return err
	}
	resp, err := c.write(ctx, http.MethodPost, "/api/auth/login", body)
	if err != nil {
		return err
	}
	if resp.Status != http.StatusOK {
		return &StatusError{Status: resp.Status, Method: http.MethodPost, Path: "/api/auth/login", Body: string(resp.Body), Code: codeOf(resp.Body)}
	}
	if c.SessionToken() == "" {
		return fmt.Errorf("hibana api: login 200 without a session cookie")
	}
	return nil
}

// Logout ends the server-side session (POST /api/auth/logout — the web app's
// own routes/auth.ts:165: destroySession + a clearing Set-Cookie, answered
// {ok:true}). The CALLER treats the round-trip as best-effort by design: an
// offline sign-out must still complete locally, and a 401 here means the
// server session is already dead — exactly the wanted end state, not an
// error worth reporting.
func (c *Client) Logout(ctx context.Context) error {
	resp, err := c.write(ctx, http.MethodPost, "/api/auth/logout", nil)
	if err != nil {
		return err
	}
	if resp.Status != http.StatusOK {
		return &StatusError{Status: resp.Status, Method: http.MethodPost, Path: "/api/auth/logout", Body: string(resp.Body), Code: codeOf(resp.Body)}
	}
	return nil
}

// Me is GET /api/auth/me — the identity + prefs read; also the session
// validity probe (a 401 means the jar's session is dead).
func (c *Client) Me(ctx context.Context) (*Me, error) {
	resp, err := c.get(ctx, http.MethodGet, "/api/auth/me")
	if err != nil {
		return nil, err
	}
	var me Me
	if err := json.Unmarshal(resp.Body, &me); err != nil {
		return nil, err
	}
	return &me, nil
}

// ListProjects is GET /api/projects?sort=recent — the switcher's model with
// its 60s client cache on the web (board-page.js:283-287); the desktop caches
// in the mirror instead.
func (c *Client) ListProjects(ctx context.Context) ([]ProjectListItem, error) {
	resp, err := c.get(ctx, http.MethodGet, "/api/projects?sort=recent")
	if err != nil {
		return nil, err
	}
	var out projectsListResp
	if err := json.Unmarshal(resp.Body, &out); err != nil {
		return nil, err
	}
	return out.Projects, nil
}

// BoardPath is the one-board GET path for a project.
func BoardPath(projectID string) string {
	return "/api/projects/" + url.PathEscape(projectID) + "/devboard"
}

// Board pulls the full board payload (ONE request — no pagination, §4).
func (c *Client) Board(ctx context.Context, projectID string) (*BoardPayload, error) {
	resp, err := c.get(ctx, http.MethodGet, BoardPath(projectID))
	if err != nil {
		return nil, err
	}
	var bp BoardPayload
	if err := json.Unmarshal(resp.Body, &bp); err != nil {
		return nil, err
	}
	return &bp, nil
}

// CreateTask posts a new card (tags ride the create as find-or-create names).
func (c *Client) CreateTask(ctx context.Context, projectID string, req CreateTaskReq) (*CreateTaskResp, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	resp, err := c.write(ctx, http.MethodPost, "/api/projects/"+url.PathEscape(projectID)+"/devtasks", body)
	if err != nil {
		return nil, err
	}
	if resp.Status != http.StatusCreated {
		return nil, &StatusError{Status: resp.Status, Method: http.MethodPost, Path: "…/devtasks", Body: string(resp.Body), Code: codeOf(resp.Body)}
	}
	var out CreateTaskResp
	if err := json.Unmarshal(resp.Body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// PatchTask patches a card by canonical id — only the fields carried are
// written (the LWW-per-field merge, §10).
func (c *Client) PatchTask(ctx context.Context, taskID string, req PatchTaskReq) error {
	body, err := json.Marshal(req)
	if err != nil {
		return err
	}
	resp, err := c.write(ctx, http.MethodPatch, "/api/devtasks/"+url.PathEscape(taskID), body)
	if err != nil {
		return err
	}
	if resp.Status != http.StatusOK {
		return &StatusError{Status: resp.Status, Method: http.MethodPatch, Path: "/api/devtasks/:id", Body: string(resp.Body), Code: codeOf(resp.Body)}
	}
	return nil
}

// ArchiveDone moves done → project_archives with a label snapshot
// (devboard.ts:334-376). Returns the archived count.
func (c *Client) ArchiveDone(ctx context.Context, projectID string) (int64, error) {
	resp, err := c.write(ctx, http.MethodPost, "/api/projects/"+url.PathEscape(projectID)+"/devtasks/archive-done", nil)
	if err != nil {
		return 0, err
	}
	if resp.Status != http.StatusOK {
		return 0, &StatusError{Status: resp.Status, Method: http.MethodPost, Path: "…/archive-done", Body: string(resp.Body), Code: codeOf(resp.Body)}
	}
	var out okResp
	if err := json.Unmarshal(resp.Body, &out); err != nil {
		return 0, err
	}
	return out.Count, nil
}

// Archives reads the done-task archive (restorable snapshots, devboard.ts:381-399).
func (c *Client) Archives(ctx context.Context, projectID string) ([]ArchiveRow, error) {
	resp, err := c.get(ctx, http.MethodGet, "/api/projects/"+url.PathEscape(projectID)+"/archives")
	if err != nil {
		return nil, err
	}
	var out archivesResp
	if err := json.Unmarshal(resp.Body, &out); err != nil {
		return nil, err
	}
	return out.Archives, nil
}

// CreateProject is the ONE idempotent create today: a client UUID replays as
// 200 {ok, duplicate:true} (index.ts:394-402) — the offline-replay belt.
func (c *Client) CreateProject(ctx context.Context, req CreateProjectReq) (id string, duplicate bool, err error) {
	body, err := json.Marshal(req)
	if err != nil {
		return "", false, err
	}
	resp, err := c.write(ctx, http.MethodPost, "/api/projects", body)
	if err != nil {
		return "", false, err
	}
	if resp.Status != http.StatusOK && resp.Status != http.StatusCreated {
		return "", false, &StatusError{Status: resp.Status, Method: http.MethodPost, Path: "/api/projects", Body: string(resp.Body), Code: codeOf(resp.Body)}
	}
	var out okResp
	if err := json.Unmarshal(resp.Body, &out); err != nil {
		return "", false, err
	}
	return out.ID, out.Dup, nil
}

// DeleteProject soft-deletes; hard delete only for sparks + force=1
// (index.ts:716-733) — the self-cleaning path for throwaway probes.
func (c *Client) DeleteProject(ctx context.Context, projectID string, force bool) error {
	path := "/api/projects/" + url.PathEscape(projectID)
	if force {
		path += "?force=1"
	}
	resp, err := c.write(ctx, http.MethodDelete, path, nil)
	if err != nil {
		return err
	}
	if resp.Status != http.StatusOK {
		return &StatusError{Status: resp.Status, Method: http.MethodDelete, Path: path, Body: string(resp.Body), Code: codeOf(resp.Body)}
	}
	return nil
}

func codeOf(body []byte) string {
	var wire struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(body, &wire) == nil {
		return wire.Error
	}
	return ""
}
