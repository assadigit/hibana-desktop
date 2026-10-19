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
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if p := r.URL.Path; p == "/kanban" || p == "/kanban.html" || p == "/board.html" {
				r.URL.Path = "/"
				kanbanLane.ServeHTTP(w, r)
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
