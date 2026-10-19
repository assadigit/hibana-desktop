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

func TestInjectAuthAttrBothStates(t *testing.T) {
	for _, tc := range []struct {
		authed bool
		attr   string
	}{
		{true, "true"},
		{false, "false"},
	} {
		out := string(InjectAuthAttr([]byte(cannedIndex), tc.authed))
		want := "<html lang=\"en\" data-desktop-authed=\"" + tc.attr + "\">"
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
	out := InjectAuthAttr(body, true)
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
