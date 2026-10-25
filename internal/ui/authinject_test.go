package ui

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

// cannedIndex mirrors the generated island index.html's exact <html> open tag
// (sync-island.mjs emits `<html lang="en">` verbatim from board.html @ pin).
const cannedIndex = "<!doctype html>\n<html lang=\"en\">\n<head><title>t</title></head>\n<body>board</body>\n</html>\n"

// cannedIslandIndex mirrors the generated island's SCRIPT ORDER in <head>:
// desktop-shim.js then desktop-login.js (both blocking, both before the
// deferred island scripts) — the order the runtime-tag splice must respect.
const cannedIslandIndex = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Progress board — Hibana</title>
  <link rel="stylesheet" href="/css/quicknotes.css?v=50">
<script src="/js/desktop-shim.js"></script>
<script src="/js/desktop-login.js"></script>
<script src="/js/devboard.js?v=28" defer></script>
</head>
<body>
  <main class="shell shell-flush board-shell" id="main" tabindex="-1"><div class="db-frame"></div></main>
  <script src="/js/board-page.js?v=21" defer></script>
</body>
</html>
`

func TestInjectAuthAttrBothStates(t *testing.T) {
	for _, tc := range []struct {
		authed bool
		attr   string
	}{
		{true, "true"},
		{false, "false"},
	} {
		out := string(InjectShellState([]byte(cannedIndex), tc.authed, ThemeSystem, LangEn))
		want := "<html lang=\"en\" dir=\"ltr\" data-desktop-lang=\"en\" data-desktop-authed=\"" + tc.attr + "\" data-desktop-theme=\"system\">"
		if !strings.Contains(out, want) {
			t.Fatalf("authed=%v: %q missing in %q", tc.authed, want, out)
		}
		if strings.Count(out, "data-desktop-authed") != 1 {
			t.Fatalf("authed=%v: injected more than once: %q", tc.authed, out)
		}
	}
}

func TestInjectAuthAttrMissingMarkerPassesThrough(t *testing.T) {
	// Fail-open by design: a drifted island serves untouched bytes (the
	// login JS then resolves visibility via AuthState — a flash at worst,
	// never a lockout).
	body := []byte("<html lang=\"fa\">no marker here</html>")
	out := InjectShellState(body, true, ThemeDark, LangFa)
	if string(out) != string(body) {
		t.Fatalf("passthrough broken: %q", out)
	}
}

func TestIndexMiddlewareServesLiveState(t *testing.T) {
	_, _, a := loginFake(t)

	sawConditional := false
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("If-Modified-Since") != "" || r.Header.Get("If-None-Match") != "" || r.Header.Get("Range") != "" {
			sawConditional = true
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Last-Modified", "Mon, 02 Jan 2006 15:04:05 GMT")
		_, _ = w.Write([]byte(cannedIndex))
	})
	h := a.IndexMiddleware(next)

	get := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		// A conditional document request: the WebView revalidating must never
		// sneak a 304 past the injection.
		req.Header.Set("If-Modified-Since", "Mon, 02 Jan 2006 15:04:05 GMT")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}

	// Unauthenticated boot: the login card shows at first paint.
	rec := get()
	if !strings.Contains(rec.Body.String(), `data-desktop-authed="false"`) {
		t.Fatalf("unauthenticated serve: %q", rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control: %q", got)
	}
	if got := rec.Header().Get("Content-Length"); got != strconv.Itoa(rec.Body.Len()) {
		t.Fatalf("Content-Length %q != body %d", got, rec.Body.Len())
	}
	if rec.Header().Get("Last-Modified") != "" {
		t.Fatal("Last-Modified must be stripped from the rewritten document")
	}
	if sawConditional {
		t.Fatal("conditional headers must be stripped before the asset handler")
	}

	// Sign in: the next serve carries the live state — the card never flashes.
	if _, err := a.Login("user@example.com", "pw"); err != nil {
		t.Fatalf("login: %v", err)
	}
	rec = get()
	if !strings.Contains(rec.Body.String(), `data-desktop-authed="true"`) {
		t.Fatalf("authenticated serve: %q", rec.Body.String())
	}
}

func TestIndexMiddlewareLeavesNonRootAlone(t *testing.T) {
	_, _, a := loginFake(t)
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript")
		_, _ = w.Write([]byte("var island = true\n"))
	})
	h := a.IndexMiddleware(next)

	req := httptest.NewRequest(http.MethodGet, "/js/devboard.js?v=28", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Body.String() != "var island = true\n" {
		t.Fatalf("non-root asset must pass through untouched: %q", rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "data-desktop-authed") {
		t.Fatal("island assets must never carry the gate attribute")
	}

	// Non-GET methods bypass the rewrite (HEAD etc. keep their own semantics).
	req = httptest.NewRequest(http.MethodHead, "/", nil)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Header().Get("Content-Type") != "application/javascript" {
		t.Fatal("non-GET must bypass the html rewrite entirely")
	}
}

func TestInjectWailsRuntimeSplicesAfterHead(t *testing.T) {
	out := string(InjectWailsRuntime([]byte(cannedIndex)))
	const ipc = `<script src="/wails/ipc.js"></script>`
	const runtime = `<script src="/wails/runtime.js"></script>`
	if !strings.Contains(out, ipc+runtime) {
		t.Fatalf("runtime tags missing or out of order: %q", out)
	}
	headAt := strings.Index(out, "<head>")
	firstIslandScript := strings.Index(out, "js/desktop-login.js") // the first island tag in a real serve
	if headAt < 0 {
		t.Fatal("no <head> in canned index")
	}
	if firstIslandScript != -1 {
		t.Fatalf("canned index unexpectedly references island scripts: %q", out)
	}
	// The tags must be <head>'s FIRST children — exactly where the Wails asset
	// server puts them for "/" documents (processIndexHTML).
	if strings.Index(out, ipc) != headAt+len("<head>") {
		t.Fatalf("ipc.js tag must sit immediately after <head>: %q", out)
	}
}

func TestInjectWailsRuntimeIdempotent(t *testing.T) {
	// A document Wails already injected (a future isRuntimeInjectionMatch
	// covering /kanban, or a double hop) must never carry the tags twice.
	body := `<html><head><script src="/wails/ipc.js"></script><script src="/wails/runtime.js"></script></head></html>`
	out := string(InjectWailsRuntime([]byte(body)))
	if strings.Count(out, "/wails/ipc.js") != 1 || strings.Count(out, "/wails/runtime.js") != 1 {
		t.Fatalf("double injection: %q", out)
	}
}

func TestInjectWailsRuntimeMissingHeadPassesThrough(t *testing.T) {
	body := []byte("<html><body>no head</body></html>")
	out := InjectWailsRuntime(body)
	if string(out) != string(body) {
		t.Fatalf("passthrough broken: %q", out)
	}
}

func TestKanbanIndexMiddlewareCarriesTheRuntimeScripts(t *testing.T) {
	// The v0.1.1 dogfood root cause, as a regression gate: the /kanban alias
	// (main.go rewrites it to "/" before this middleware runs) must serve a
	// document that defines window.go BEFORE the island's own blocking scripts
	// — the login controller resolves the Login binding while parsing, so
	// ipc.js + runtime.js have to be on the wire ahead of desktop-login.js.
	_, _, a := loginFake(t)

	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(cannedIslandIndex))
	})
	h := a.KanbanIndexMiddleware(next)

	req := httptest.NewRequest(http.MethodGet, "/", nil) // the path AFTER the main.go alias rewrite
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	body := rec.Body.String()

	const ipc = `<script src="/wails/ipc.js"></script>`
	const runtime = `<script src="/wails/runtime.js"></script>`
	const loginTag = `<script src="/js/desktop-login.js"></script>`
	const shimTag = `<script src="/js/desktop-shim.js"></script>`
	for _, need := range []string{ipc, runtime, loginTag, shimTag, `data-desktop-authed="false"`} {
		if !strings.Contains(body, need) {
			t.Fatalf("aliased serve missing %q: %q", need, body)
		}
	}
	if !(strings.Index(body, ipc) < strings.Index(body, shimTag) && strings.Index(body, runtime) < strings.Index(body, shimTag) && strings.Index(body, shimTag) < strings.Index(body, loginTag)) {
		t.Fatalf("runtime tags must precede desktop-shim.js → desktop-login.js: %q", body)
	}
	if strings.Count(body, "/wails/ipc.js") != 1 {
		t.Fatalf("ipc.js must appear exactly once: %q", body)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control: %q", got)
	}
	if got := rec.Header().Get("Content-Length"); got != strconv.Itoa(rec.Body.Len()) {
		t.Fatalf("Content-Length %q != body %d", got, rec.Body.Len())
	}
}

func TestIndexMiddlewareNeverDoubleInjectsRuntime(t *testing.T) {
	// The true "/" lane: the Wails asset server injects the runtime AFTER this
	// middleware (its top-level bodyRecorder + processIndexHTML), so the
	// middleware's own output must not carry the tags — Wails adds them, once.
	_, _, a := loginFake(t)
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(cannedIslandIndex))
	})
	h := a.IndexMiddleware(next)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if strings.Contains(rec.Body.String(), "/wails/") {
		t.Fatalf("the / lane must leave runtime injection to the asset server: %q", rec.Body.String())
	}
}

func TestKanbanIndexMiddlewareLeavesNonRootAlone(t *testing.T) {
	_, _, a := loginFake(t)
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript")
		_, _ = w.Write([]byte("var island = true\n"))
	})
	h := a.KanbanIndexMiddleware(next)
	for _, p := range []string{"/js/devboard.js?v=28", "/css/quicknotes.css?v=50", "/Login.webp"} {
		req := httptest.NewRequest(http.MethodGet, p, nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Body.String() != "var island = true\n" || strings.Contains(rec.Body.String(), "data-desktop-authed") {
			t.Fatalf("asset %s must pass through untouched: %q", p, rec.Body.String())
		}
	}
}
