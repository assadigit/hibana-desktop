package ui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"hibana/desktop/internal/api"
)

// newClientAt builds an api.Client against a test server URL.
func newClientAt(t *testing.T, url string) (*api.Client, error) {
	t.Helper()
	return api.New(url)
}

// newUploadBridge builds a bridge against an upload-aware test server, with
// the progress relay captured for the assertions.
func newUploadBridge(t *testing.T, handler http.HandlerFunc) (*API, *[]map[string]any) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	c, err := newClientAt(t, srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	a := New(c, "0.1.0-test", "e6661c8")
	var mu sync.Mutex
	var seen []map[string]any
	a.SetUploadEmit(func(name string, payload map[string]any) {
		mu.Lock()
		seen = append(seen, payload)
		mu.Unlock()
	})
	return a, &seen
}

// TestUploadBridgeHappyPath pins the M4 contract (guide §5.4): the callID
// rides first, the Origin stamp + the KNOWN Content-Length ride the write
// (never chunked — the server's 413 boundary reads it), the progress relay
// fires addressed by the callID, and a 2xx answer flows back as {status,
// body} so the uploader's done path runs.
func TestUploadBridgeHappyPath(t *testing.T) {
	var mu sync.Mutex
	var gotPath, gotOrigin, gotCT, gotCL string
	var gotBodyLen int
	body := `{"fileName":"shot.png","mimeType":"image/png","dataBase64":"aGk="}`
	a, seen := newUploadBridge(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		gotPath = r.URL.Path
		gotOrigin = r.Header.Get("Origin")
		gotCT = r.Header.Get("Content-Type")
		gotCL = r.Header.Get("Content-Length")
		gotBodyLen = int(r.ContentLength)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"ok":true,"id":"shot-1","mimeType":"image/png"}`))
	})

	res, err := a.Upload("up1", "POST", "/api/projects/p1/screenshots", body, map[string]string{"Content-Type": "application/json"})
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	if res.Status != http.StatusCreated {
		t.Fatalf("status = %d, want 201", res.Status)
	}
	var wire map[string]any
	if json.Unmarshal([]byte(res.Body), &wire) != nil || wire["id"] != "shot-1" {
		t.Fatalf("body lost across the bridge: %q", res.Body)
	}
	mu.Lock()
	defer mu.Unlock()
	if gotPath != "/api/projects/p1/screenshots" {
		t.Fatalf("server saw path %q", gotPath)
	}
	if gotOrigin == "" {
		t.Fatal("the Origin stamp (the T6 write gate) never rode the upload")
	}
	if !strings.Contains(gotCT, "application/json") {
		t.Fatalf("Content-Type = %q", gotCT)
	}
	if gotCL == "" || gotBodyLen != len(body) {
		t.Fatalf("Content-Length = %q / %d, want the KNOWN length %d (never chunked)", gotCL, gotBodyLen, len(body))
	}
	// The progress relay: at least the final event, addressed by the callID.
	hasFinal := false
	for _, p := range *seen {
		if p["id"] == "up1" && p["loaded"] == int64(len(body)) && p["total"] == int64(len(body)) {
			hasFinal = true
		}
	}
	if !hasFinal {
		t.Fatalf("the progress relay never reported the final bytes for the callID (saw %v)", *seen)
	}
}

// TestUploadBridgeValidation — the SAME rejections as Request (the bridge is
// an API surface; the island renders hostile input).
func TestUploadBridgeValidation(t *testing.T) {
	a, _ := newBridge(t)
	if _, err := a.Upload("up1", "TRACE", "/api/x", "{}", nil); err == nil {
		t.Fatal("TRACE must be rejected")
	}
	if _, err := a.Upload("up1", "POST", "/media/x", "{}", nil); err == nil {
		t.Fatal("non-API path must be rejected")
	}
	if _, err := a.Upload("up1", "POST", "https://evil.example/api/x", "{}", nil); err == nil {
		t.Fatal("absolute URL must be rejected")
	}
	if _, err := a.Upload("up1", "POST", "/api/../../secret", "{}", nil); err == nil {
		t.Fatal("traversal must be rejected")
	}
	if _, err := a.Upload("up1", "POST", "/api/x\r\nX-Injected: 1", "{}", nil); err == nil {
		t.Fatal("CRLF must be rejected")
	}
	if _, err := a.Upload("up1", "POST", "/api/x", makeBody(maxBridgeBody+1), nil); err == nil {
		t.Fatal("oversized body must be rejected")
	}
	if _, err := a.Upload(makeBody(200), "POST", "/api/x", "{}", nil); err == nil {
		t.Fatal("an oversized call id must be rejected")
	}
}

// TestUploadBridgeStatusFlowsAsStatus — a 413/429/404 answers as a
// JS-visible {status}, never a rejected promise (the uploader's row keeps
// its error path).
func TestUploadBridgeStatusFlowsAsStatus(t *testing.T) {
	a, _ := newUploadBridge(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":"rate_limited"}`))
	})
	res, err := a.Upload("up9", "POST", "/api/projects/p1/screenshots", "{}", nil)
	if err != nil {
		t.Fatalf("a 429 must resolve, not reject: %v", err)
	}
	if res.Status != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", res.Status)
	}
}

// TestMediaMiddlewareServesAuthedMedia — the thumbnail half of the round: the
// island's <img src="/api/media/…"> requests land on the embedded asset
// server; the middleware must proxy them through the Go cookie jar with the
// response's Content-Type + Cache-Control forwarded verbatim, and pass
// everything else through untouched.
func TestMediaMiddlewareServesAuthedMedia(t *testing.T) {
	const pngBytes = "\x89PNG-fake-bytes"
	var sawCookie bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/media/") {
			t.Errorf("the media client asked for a non-media path: %s", r.URL.Path)
		}
		if r.URL.Path == "/api/media/screenshots/shot-1/file" && r.URL.RawQuery == "variant=thumb" {
			sawCookie = r.Header.Get("Cookie") != ""
			w.Header().Set("Content-Type", "image/webp")
			w.Header().Set("Cache-Control", "private, max-age=3600")
			_, _ = w.Write([]byte(pngBytes))
			return
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"not_found"}`))
	}))
	defer srv.Close()
	c, err := newClientAt(t, srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	// An authed jar (the media routes are authed — the tile only renders with
	// the session riding the request).
	c.SetSessionToken("media-session-token")
	a := New(c, "0.1.0-test", "e6661c8")

	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The pass-through: a non-media path must reach the wrapped handler.
		if r.URL.Path == "/js/island.css" {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("island"))
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
	})
	h := a.MediaMiddleware(next)

	// The media GET (thumb variant rides the query string verbatim).
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/media/screenshots/shot-1/file?variant=thumb", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("media proxy status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "image/webp" {
		t.Fatalf("Content-Type forwarded as %q, want image/webp", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "private, max-age=3600" {
		t.Fatalf("Cache-Control forwarded as %q", cc)
	}
	if rec.Body.String() != pngBytes {
		t.Fatal("the media bytes were lost across the proxy")
	}
	if !sawCookie {
		t.Fatal("the media proxy did not ride the session cookie jar (the route is authed)")
	}

	// The pass-through: the island's own assets never touch the proxy.
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, "/js/island.css", nil))
	if rec2.Code != http.StatusOK || rec2.Body.String() != "island" {
		t.Fatalf("the pass-through broke: %d %q", rec2.Code, rec2.Body.String())
	}

	// A malformed path is refused, never proxied.
	rec3 := httptest.NewRecorder()
	h.ServeHTTP(rec3, httptest.NewRequest(http.MethodGet, "/api/media/../../etc/passwd", nil))
	if rec3.Code != http.StatusBadRequest {
		t.Fatalf("malformed media path status = %d, want 400", rec3.Code)
	}

	// Writes fall through to the wrapped handler (the proxy is read-only).
	rec4 := httptest.NewRecorder()
	h.ServeHTTP(rec4, httptest.NewRequest(http.MethodPost, "/api/media/screenshots/shot-1/file", nil))
	if rec4.Code != http.StatusInternalServerError {
		t.Fatalf("a POST must fall through to the wrapped handler (got %d)", rec4.Code)
	}
}
