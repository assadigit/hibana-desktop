package ui

import (
	"bytes"
	"net/http"
	"strconv"
	"strings"
)

// htmlOpenTag is the generated island's exact <html> open tag (sync-island.mjs
// emits it verbatim from board.html @ pin). The auth state AND the theme
// preference AND the language ride on it as data- attributes so the login
// card's visibility AND the look AND the direction resolve from CSS/at the
// document itself at FIRST PAINT — no JS round-trip, no flash in either
// direction:
//
//   - a live restored session → data-desktop-authed="true" → the card never
//     appears, the board boots straight in;
//   - a fresh/dead session → "false" (or the attribute missing entirely) →
//     the card is up before the island's first paint, and the unauthenticated
//     board underneath never flashes its 401 error state at the user;
//   - the theme (S216): data-desktop-theme carries the stored preference for
//     js/desktop-theme.js, and an EXPLICIT pref (light | claude-dark) also
//     carries data-theme directly — the token swap paints before any script
//     runs. 'system' deliberately carries NO data-theme: the OS scheme must
//     resolve pre-paint exactly the way boot.js does it for the web (S87
//     parity — a stale hardcoded look would flash on every dark-mode OS).
//   - the language (the settings round, §2.4 of the plan): lang + dir +
//     data-desktop-lang stamped from the LIVE session's language_pref. The
//     web solved the FA first-paint flash with boot.js's hibana-lang
//     localStorage read, but boot.js is STRIPPED from the island — FA users
//     got an EN/LTR flash on every boot until the async i18n.apply()
//     resolved. Stamping the tag serve-time kills the flash the same way
//     theme got its zero-JS first paint, and makes the settings round's
//     reload reflex seamless: the post-flip reload paints FA/RTL at the
//     FIRST frame. data-desktop-lang also hands the settings controller its
//     boot-time active state for the segmented control.
const htmlOpenTag = `<html lang="en">`

// wailsRuntimeScripts is byte-equivalent to what the Wails asset server itself
// injects into every "/"-suffix HTML document (pkg/assetserver/assetserver.go
// processIndexHTML: insertScriptInHead(runtimeJSPath) then
// insertScriptInHead(ipcJSPath) — the second insert lands FIRST, so the served
// order is ipc.js → runtime.js as <head>'s first children, i.e. before every
// island script tag).
//
// WHY WE MUST REPLICATE IT BY HAND: the asset server's top-level
// isRuntimeInjectionMatch() only fires for paths ending in "/" or
// "/index.html". The island's own entry guard (board-page.js:29
// `location.replace('/kanban')` when neither ?project= nor the /kanban entry
// is present) boots the WebView at "/" for a flash and then NAVIGATES it to
// /kanban — the document the user actually lands on. For /kanban the Wails
// matcher never runs, so without this injection window.go is never defined on
// the live page: the shim's hibanaFetch dies with HibanaBridgeNotWired and the
// login card fails with "The desktop bridge is not wired — restart the app."
// (the v0.1.0 white board + the v0.1.1 dogfood report — ONE root cause, fixed
// here). main.go aliases /kanban (+ /kanban.html, /board.html) to the root
// document and serves them through KanbanIndexMiddleware, which adds these
// tags; the true "/" keeps Wails' own injection (never duplicated — the
// Contains guard below skips an already-injected document).
const wailsRuntimeScripts = `<script src="/wails/ipc.js"></script><script src="/wails/runtime.js"></script>`

// InjectShellState rewrites the island's index.html bytes with the live
// auth state, the theme preference AND the session language (the v0.1.5
// evolution of the v0.1.1 InjectAuthAttr; the settings round grew the
// language stamp — one <html> tag, one rewrite, zero JS either way):
//
//	<html lang="en|fa" dir="ltr|rtl" data-desktop-lang="en|fa"
//	      data-desktop-authed="true|false"
//	      data-desktop-theme="light|claude-dark|system"
//	      data-theme="light|claude-dark">   <- explicit prefs ONLY
//
// The language is stamped from the LIVE session (a.me.language_pref,
// normalized): an FA session paints lang="fa" dir="rtl" at the FIRST frame —
// no EN/LTR flash while the async i18n.apply() resolves (the FA FOUC the
// desktop lived with since v0.1.0, killed the same way theme got its
// zero-JS first paint).
//
// Fail-open by design: if the marker drifted (an island re-pin), the bytes
// pass through untouched — the login JS then resolves visibility via the
// AuthState bridge call, js/desktop-theme.js reads a missing
// data-desktop-theme as 'system', and i18n.js's own async apply() resolves
// the language (a one-frame flash at worst, never a lockout, never a
// wrong-look lock, never a wrong-direction lock).
func InjectShellState(body []byte, authed bool, themePref, lang string) []byte {
	attr := "false"
	if authed {
		attr = "true"
	}
	if !bytes.Contains(body, []byte(htmlOpenTag)) {
		return body
	}
	pref := NormalizeTheme(themePref)
	l := NormalizeLanguage(lang)
	dir := "ltr"
	if l == LangFa {
		dir = "rtl"
	}
	replacement := `<html lang="` + l + `" dir="` + dir + `" data-desktop-lang="` + l + `" data-desktop-authed="` + attr + `" data-desktop-theme="` + pref + `">`
	if pref == ThemeLight || pref == ThemeDark {
		// Explicit look: paint it with ZERO JS (the token swap is a
		// data-theme attribute the CSS already branches on).
		replacement = `<html lang="` + l + `" dir="` + dir + `" data-desktop-lang="` + l + `" data-desktop-authed="` + attr + `" data-desktop-theme="` + pref + `" data-theme="` + pref + `">`
	}
	return bytes.Replace(body, []byte(htmlOpenTag), []byte(replacement), 1)
}

// InjectWailsRuntime splices the Wails runtime script tags in right after
// <head> — the same position (head's first children) the asset server puts
// them for "/" documents, so the aliased /kanban document parses in exactly
// the order Wails guarantees: ipc.js → runtime.js → the island's own tags.
// Fail-open by design; idempotent: an already-injected document (a future
// Wails release matching /kanban itself, or a double hop) passes through.
func InjectWailsRuntime(body []byte) []byte {
	if bytes.Contains(body, []byte("/wails/ipc.js")) {
		return body
	}
	i := bytes.Index(body, []byte("<head>"))
	if i < 0 {
		return body
	}
	at := i + len("<head>")
	out := make([]byte, 0, len(body)+len(wailsRuntimeScripts))
	out = append(out, body[:at]...)
	out = append(out, wailsRuntimeScripts...)
	out = append(out, body[at:]...)
	return out
}

// IndexMiddleware wraps the asset handler for the HTML root: every GET of /
// (or /index.html) is served with the CURRENT auth state injected into the
// <html> tag. Conditional-request headers (If-Modified-Since / If-None-Match
// / Range) are stripped for the root document so the WebView can never
// revalidate into a 304 whose cached copy would bypass the injection (the
// gate state would go stale across a sign-in); the rewritten response is
// explicitly no-store. The Wails runtime scripts are NOT injected here — the
// asset server's own top-level recorder handles "/" documents.
func (a *API) IndexMiddleware(next http.Handler) http.Handler {
	return a.indexMiddleware(next, false)
}

// KanbanIndexMiddleware serves the root document for the /kanban entry
// aliases (main.go rewrites /kanban, /kanban.html and /board.html to /): the
// same live-auth injection as IndexMiddleware PLUS the Wails runtime scripts,
// because the asset server's isRuntimeInjectionMatch() never fires for the
// aliased paths (see wailsRuntimeScripts) — without them the page the WebView
// actually boots on carries no window.go and every bridge call dies with
// "bridge not wired".
func (a *API) KanbanIndexMiddleware(next http.Handler) http.Handler {
	return a.indexMiddleware(next, true)
}

func (a *API) indexMiddleware(next http.Handler, injectWailsRuntime bool) http.Handler {
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
			// The language rides the same live rewrite (the settings round's
			// serve-time stamping): the injected <html lang dir> pair comes
			// from the session's language_pref, so an FA account paints
			// FA/RTL at first paint — the FOUC-free boot.
			body = InjectShellState(body, a.AuthState().Authenticated, a.ThemePref(), a.LanguagePref())
			if injectWailsRuntime {
				body = InjectWailsRuntime(body)
			}
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
