package ui

// The v0.1.2 dogfood fix, proven through the Wails asset-server CONTRACT.
//
// Why a replica and not the real pkg/assetserver: that package embeds
// pkg/assetserver/webview, whose linux build requires gtk/webkit cgo headers —
// unavailable (and irrelevant) on this sandbox; the WINDOWS production path
// cross-builds with go-webview2. The replica below reproduces wails v2.17.0's
// AssetServer.ServeHTTP dispatch VERBATIM (pkg/assetserver/assetserver.go:109-185
// + common.go's insertScriptInHead semantics via x/net/html, the same parser
// wails uses) so the middleware contract is exercised exactly as the real
// server exercises it:
//
//   - "/" ("/"-suffix) paths go through the bodyRecorder + processIndexHTML —
//     Wails injects /wails/ipc.js + /wails/runtime.js AFTER the middleware;
//   - "/kanban" (the path the island's entry bounce lands on —
//     board-page.js:29) is NOT an isRuntimeInjectionMatch → served by the raw
//     handler chain → KanbanIndexMiddleware must carry the runtime tags;
//   - /wails/* are intercepted ABOVE the middleware and never reach it.
//
// The v0.1.0 white board AND the v0.1.1 "The desktop bridge is not wired —
// restart the app." dogfood report were both the /kanban lane's missing tags.
// The S249 "clicking Sprints sends me back to login" report was the SAME
// disease on the /sprint.html lane — S235 embedded the page but never wired
// its serving path, so an authed user's sprint navigation was served verbatim
// (gate over a live session + no runtime). The lane tests below hold all
// three lanes to the contract.

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	xhtml "golang.org/x/net/html"
)

type replicaServer struct {
	handler http.Handler // the middleware-wrapped asset handler (main.go's contract)
}

// isRuntimeInjectionMatch — wails v2.17.0 assetserver.go:248-255.
func (replicaServer) isRuntimeInjectionMatch(path string) bool {
	if path == "" {
		path = "/"
	}
	return strings.HasSuffix(path, "/") || strings.HasSuffix(path, "/index.html")
}

// processIndexHTML — wails v2.17.0 assetserver.go:187-221 (the same x/net/html
// parse + insertScriptInHead at <head>'s FIRST children, ipc before runtime).
func processIndexHTML(indexHTML []byte) ([]byte, error) {
	htmlNode, err := xhtml.Parse(bytes.NewReader(indexHTML))
	if err != nil {
		return nil, err
	}
	insert := func(scriptName string) {
		var find func(n *xhtml.Node) *xhtml.Node // findFirstTag — recursive, verbatim
		find = func(n *xhtml.Node) *xhtml.Node {
			if n != nil && n.Type == xhtml.ElementNode && n.Data == "head" {
				return n
			}
			for c := n; c != nil; c = c.NextSibling {
				if r := find(c.FirstChild); r != nil {
					return r
				}
			}
			return nil
		}
		headNode := find(htmlNode)
		if headNode == nil {
			return
		}
		scriptNode := &xhtml.Node{
			Type: xhtml.ElementNode,
			Data: "script",
			Attr: []xhtml.Attribute{{Key: "src", Val: scriptName}},
		}
		if headNode.FirstChild != nil {
			headNode.InsertBefore(scriptNode, headNode.FirstChild)
		} else {
			headNode.AppendChild(scriptNode)
		}
	}
	insert("/wails/runtime.js")
	insert("/wails/ipc.js")
	var buf bytes.Buffer
	if err := xhtml.Render(&buf, htmlNode); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func (s replicaServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/wails/ipc.js" || r.URL.Path == "/wails/runtime.js":
		_, _ = w.Write([]byte("/* wails runtime blob */"))
		return
	case s.isRuntimeInjectionMatch(r.URL.Path):
		cw := &captureWriter{hdr: make(http.Header), status: http.StatusOK}
		s.handler.ServeHTTP(cw, r)
		body := cw.buf.Bytes()
		h := w.Header()
		for k, v := range cw.hdr {
			h[k] = v
		}
		if cw.status == http.StatusOK && strings.Contains(cw.hdr.Get("Content-Type"), "text/html") {
			out, err := processIndexHTML(body)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			body = out
		}
		h.Del("Content-Length")
		h.Set("Content-Length", strconv.Itoa(len(body)))
		w.WriteHeader(cw.status)
		_, _ = w.Write(body)
	default:
		s.handler.ServeHTTP(w, r)
	}
}

// serveIsland builds the production middleware contract (main.go) over the
// REAL generated island (frontend/dist) and wraps it in the replica dispatch.
func serveIsland(t *testing.T, a *API) http.Handler {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", "..", "frontend", "dist"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "index.html")); err != nil {
		t.Fatalf("island not found at %s — run the sync first: %v", root, err)
	}
	islandFS := os.DirFS(root)
	fileServer := http.FileServerFS(islandFS) // serves index.html at / per the embed semantics

	middleware := func(next http.Handler) http.Handler {
		rootLane := a.IndexMiddleware(next)
		kanbanLane := a.KanbanIndexMiddleware(next)
		sprintLane := a.SprintMiddleware(next)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if p := r.URL.Path; p == "/kanban" || p == "/kanban.html" || p == "/board.html" {
				r.URL.Path = "/"
				kanbanLane.ServeHTTP(w, r)
				return
			}
			if r.URL.Path == "/sprint.html" {
				sprintLane.ServeHTTP(w, r)
				return
			}
			rootLane.ServeHTTP(w, r)
		})
	}
	return replicaServer{handler: middleware(fileServer)}
}

func get(t *testing.T, h http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

func TestKanbanLaneCarriesTheRuntime(t *testing.T) {
	_, _, a := loginFake(t)
	h := serveIsland(t, a)

	// The alias lane: the island's own entry guard bounces "/" → /kanban, so
	// this is the document the user actually boots on. Wails' injection does
	// NOT fire for this path — the middleware must have provided the tags.
	rec := get(t, h, "/kanban")
	if rec.Code != http.StatusOK {
		t.Fatalf("/kanban status %d", rec.Code)
	}
	body := rec.Body.String()
	for _, need := range []string{
		`<script src="/wails/ipc.js"></script>`,
		`<script src="/wails/runtime.js"></script>`,
		`<script src="/js/desktop-shim.js"></script>`,
		`<script src="/js/desktop-login.js"></script>`,
		`data-desktop-authed="false"`,
	} {
		if !strings.Contains(body, need) {
			t.Fatalf("/kanban missing %q:\n%s", need, body[:400])
		}
	}
	if strings.Count(body, "/wails/ipc.js") != 1 || strings.Count(body, "/wails/runtime.js") != 1 {
		t.Fatalf("/kanban must carry the runtime tags exactly once (got ipc=%d runtime=%d)",
			strings.Count(body, "/wails/ipc.js"), strings.Count(body, "/wails/runtime.js"))
	}
	ipcAt := strings.Index(body, "/wails/ipc.js")
	shimAt := strings.Index(body, "js/desktop-shim.js")
	loginAt := strings.Index(body, "js/desktop-login.js")
	if !(ipcAt < shimAt && shimAt < loginAt) {
		t.Fatalf("/kanban runtime order broken: ipc@%d shim@%d login@%d", ipcAt, shimAt, loginAt)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("/kanban Cache-Control %q", got)
	}

	// Signed in → the same lane serves the live state (the card never shows).
	if _, err := a.Login("user@example.com", "pw"); err != nil {
		t.Fatalf("login: %v", err)
	}
	rec = get(t, h, "/kanban")
	if !strings.Contains(rec.Body.String(), `data-desktop-authed="true"`) {
		t.Fatal("/kanban must carry the live authed state after login")
	}
}

func TestRootLaneKeepsWailsInjectionSingle(t *testing.T) {
	_, _, a := loginFake(t)
	h := serveIsland(t, a)

	// The true root: Wails' OWN processIndexHTML injects the runtime AFTER the
	// middleware — the body must carry the tags exactly once (the middleware's
	// Contains guard keeps the pair from doubling when both lanes would fire).
	rec := get(t, h, "/")
	if rec.Code != http.StatusOK {
		t.Fatalf("/ status %d", rec.Code)
	}
	body := rec.Body.String()
	if strings.Count(body, "/wails/ipc.js") != 1 || strings.Count(body, "/wails/runtime.js") != 1 {
		t.Fatalf("/ runtime tags ipc=%d runtime=%d (expected exactly one each)",
			strings.Count(body, "/wails/ipc.js"), strings.Count(body, "/wails/runtime.js"))
	}
	if !strings.Contains(body, `data-desktop-authed="false"`) {
		t.Fatal("/ must carry the auth state")
	}
}

// TestSprintLaneCarriesTheRuntime — the S249 dogfood regression: the S235
// sprint-page embed wired the LINK (board-page.js's db-sprint-link →
// /sprint.html?project=…) and its probe, but never the SERVING lane — the
// path fell through to the raw file server and was served VERBATIM, so an
// AUTHED user clicking Sprints got the fail-visible login gate painted over
// a live session ("it goes back to login even though I'm logged in") and a
// dead bridge underneath (no window.go). The lane must serve the sprint
// document ITSELF (not index.html) with the live auth state + the runtime
// tags, exactly like the kanban lane.
func TestSprintLaneCarriesTheRuntime(t *testing.T) {
	_, _, a := loginFake(t)
	h := serveIsland(t, a)

	// Unauthed first: the gate is SUPPOSED to show here (fresh session).
	rec := get(t, h, "/sprint.html?project=11111111-1111-4111-8111-111111111111")
	if rec.Code != http.StatusOK {
		t.Fatalf("/sprint.html status %d", rec.Code)
	}
	body := rec.Body.String()
	for _, need := range []string{
		// The sprint document itself — NOT the board (index.html).
		`<title>Sprints — Hibana</title>`,
		`id="sp-timeline"`,
		`id="sp-new-sprint"`,
		// The desktop chain + the gate markup both live in sprint.html.
		`<script src="/js/desktop-shim.js"></script>`,
		`<script src="/js/desktop-login.js"></script>`,
		`class="login-gate auth-page auth-split-page"`,
		// The fresh-session stamp.
		`data-desktop-authed="false"`,
		// The runtime tags the raw lane never carried.
		`<script src="/wails/ipc.js"></script>`,
		`<script src="/wails/runtime.js"></script>`,
	} {
		if !strings.Contains(body, need) {
			t.Fatalf("/sprint.html missing %q (head: %.200s)", need, body)
		}
	}
	if strings.Count(body, "/wails/ipc.js") != 1 || strings.Count(body, "/wails/runtime.js") != 1 {
		t.Fatalf("/sprint.html must carry the runtime tags exactly once (got ipc=%d runtime=%d)",
			strings.Count(body, "/wails/ipc.js"), strings.Count(body, "/wails/runtime.js"))
	}
	// Parse order: ipc.js must precede the island's own desktop chain (the
	// shim resolves window.go at USE time, but the tags must be first-head
	// children exactly like Wails' own injection order).
	ipcAt := strings.Index(body, "/wails/ipc.js")
	shimAt := strings.Index(body, "js/desktop-shim.js")
	loginAt := strings.Index(body, "js/desktop-login.js")
	if !(ipcAt < shimAt && shimAt < loginAt) {
		t.Fatalf("/sprint.html runtime order broken: ipc@%d shim@%d login@%d", ipcAt, shimAt, loginAt)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("/sprint.html Cache-Control %q", got)
	}
	// The authed <html> stamp replaces the verbatim marker — the verbatim
	// tag on the wire is how the bug manifested (gate over a live session).
	if strings.Contains(body, "<html lang=\"en\">") {
		t.Fatal("/sprint.html was served VERBATIM — the shell state never landed (the S249 bug)")
	}

	// THE REPORTED SYMPTOM: an authed session clicks Sprints and must NOT
	// be sent back to login — the same document, now stamped authed.
	if _, err := a.Login("user@example.com", "pw"); err != nil {
		t.Fatalf("login: %v", err)
	}
	rec = get(t, h, "/sprint.html?project=11111111-1111-4111-8111-111111111111")
	if rec.Code != http.StatusOK {
		t.Fatalf("/sprint.html (authed) status %d", rec.Code)
	}
	authedBody := rec.Body.String()
	if !strings.Contains(authedBody, `data-desktop-authed="true"`) {
		t.Fatal("/sprint.html must carry the live authed state after login — the gate would paint over a live session")
	}
	// Still the sprint document, still exactly one runtime pair.
	if !strings.Contains(authedBody, `<title>Sprints — Hibana</title>`) {
		t.Fatal("/sprint.html (authed) must still be the sprint document")
	}
	if strings.Count(authedBody, "/wails/ipc.js") != 1 {
		t.Fatal("/sprint.html (authed) must not double the runtime tags")
	}
	// And the board lane still serves the BOARD (no cross-contamination
	// from the sprint lane's path set).
	rec = get(t, h, "/kanban")
	if !strings.Contains(rec.Body.String(), `<script src="/js/board-page.js`) {
		t.Fatal("/kanban must still serve the board document")
	}
}

func TestIslandAssetsPassThrough(t *testing.T) {
	_, _, a := loginFake(t)
	h := serveIsland(t, a)

	for _, tc := range []struct{ path, need string }{
		{"/js/devboard.js?v=28", "window.hibanaFetch("},
		{"/js/desktop-login.js", "resolveBoundMethod('Login')"},
		{"/css/desktop-login.css?v=2", "auth-split"},
		{"/icon.svg", "Hibana"},
		{"/Login.webp", "\x00"},
		{"/logo-dark.png", "\x00"},
	} {
		rec := get(t, h, tc.path)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status %d", tc.path, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), tc.need) {
			t.Fatalf("%s missing %q", tc.path, tc.need)
		}
	}

	// The favicon link + the split gate ride in the served root document.
	rec := get(t, h, "/")
	body := rec.Body.String()
	for _, need := range []string{
		`rel="icon" type="image/svg+xml" href="/icon.svg"`,
		`class="login-gate auth-page auth-split-page"`,
		`class="auth-visual"`,
		`src="/logo-dark.png"`,
	} {
		if !strings.Contains(body, need) {
			t.Fatalf("/ missing the v0.1.2 island insert %q", need)
		}
	}
}
