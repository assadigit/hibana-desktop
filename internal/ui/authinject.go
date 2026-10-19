package ui

import (
	"bytes"
	"net/http"
	"strconv"
	"strings"
)

// htmlOpenTag is the generated island's exact <html> open tag (sync-island.mjs
// emits it verbatim from board.html @ pin). The auth state rides on it as a
// data- attribute so the login card's visibility resolves from CSS at FIRST
// PAINT — no JS round-trip, no flash in either direction:
//
//   - a live restored session → data-desktop-authed="true" → the card never
//     appears, the board boots straight in;
//   - a fresh/dead session → "false" (or the attribute missing entirely) →
//     the card is up before the island's first paint, and the unauthenticated
//     board underneath never flashes its 401 error state at the user.
const htmlOpenTag = `<html lang="en">`

// InjectAuthAttr rewrites the island's index.html bytes with the live auth
// state. Fail-open by design: if the marker drifted (an island re-pin), the
// bytes pass through untouched — the login JS then resolves visibility via
// the AuthState bridge call (a one-frame flash at worst, never a lockout).
func InjectAuthAttr(body []byte, authed bool) []byte {
	attr := "false"
	if authed {
		attr = "true"
	}
	if !bytes.Contains(body, []byte(htmlOpenTag)) {
		return body
	}
	replacement := `<html lang="en" data-desktop-authed="` + attr + `">`
	return bytes.Replace(body, []byte(htmlOpenTag), []byte(replacement), 1)
}

// IndexMiddleware wraps the asset handler for the HTML root: every GET of /
// (or /index.html) is served with the CURRENT auth state injected into the
// <html> tag. Conditional-request headers (If-Modified-Since / If-None-Match
// / Range) are stripped for the root document so the WebView can never
// revalidate into a 304 whose cached copy would bypass the injection (the
// gate state would go stale across a sign-in); the rewritten response is
// explicitly no-store.
func (a *API) IndexMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || (r.URL.Path != "/" && r.URL.Path != "/index.html") {
			next.ServeHTTP(w, r)
			return
		}
		r.Header.Del("If-Modified-Since")
		r.Header.Del("If-None-Match")
		r.Header.Del("Range")

		cw := &captureWriter{hdr: make(http.Header), status: http.StatusOK}
		next.ServeHTTP(cw, r)
		body := cw.buf.Bytes()

		h := w.Header()
		for k, v := range cw.hdr {
			h[k] = v
		}
		if strings.Contains(cw.hdr.Get("Content-Type"), "text/html") {
			body = InjectAuthAttr(body, a.AuthState().Authenticated)
			// The document is per-session dynamic: never let the WebView cache
			// a stale gate state or revalidate into a body-less 304.
			h.Del("Last-Modified")
			h.Del("ETag")
			h.Set("Cache-Control", "no-store")
		}
		h.Del("Content-Length")
		h.Set("Content-Length", strconv.Itoa(len(body)))
		w.WriteHeader(cw.status)
		_, _ = w.Write(body)
	})
}

// captureWriter buffers one handler response so the root document can be
// rewritten before the first byte hits the wire.
type captureWriter struct {
	hdr    http.Header
	buf    bytes.Buffer
	status int
}

func (c *captureWriter) Header() http.Header         { return c.hdr }
func (c *captureWriter) Write(p []byte) (int, error) { return c.buf.Write(p) }
func (c *captureWriter) WriteHeader(code int)        { c.status = code }
