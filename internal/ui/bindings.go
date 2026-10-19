// Package ui — the JS↔Go bridge (the Wails binding surface).
//
// THE BRIDGE IS AN API SURFACE (GO-DESKTOP-IMPLEMENTATION-GUIDE.md §4.4, hard
// rule 10). Every bound method is callable from the island's JS — and the
// island renders user-authored task titles, so the bridge must assume
// hostile input at the JS boundary even though the renderer is our own code:
//
//  1. The bound surface is exactly ONE transport method —
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
package ui

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"hibana/desktop/internal/api"
)

// maxBridgeBody mirrors the server's own rejection boundary: uploads are
// ≤5MB base64 and Content-Length >7MB is 413'd before parsing (core.ts:468).
// A body bigger than this never crosses the bridge.
const maxBridgeBody = 7 << 20

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

// API is the struct Wails binds into the WebView (window.go.<pkg>.API).
type API struct {
	client  *api.Client
	version string
	webRef  string
}

// New wires the bridge. The client is the cloud client (cookie jar, Origin
// stamping, ETag store — all Go-side; the island has no access to them).
func New(c *api.Client, version, webRef string) *API {
	return &API{client: c, version: version, webRef: webRef}
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
		return BridgeResponse{Status: resp.Status, Body: string(resp.Body), ETag: resp.ETag}, nil
	}
	// Status errors flow to JS as {status, body} so the island's err.status
	// branching (404-gone vs transient, devboard.js:56-61) keeps working —
	// the shim builds the fetch-shaped response from it.
	if se, ok := err.(*api.StatusError); ok {
		return BridgeResponse{Status: se.Status, Body: se.Body, ETag: ""}, nil
	}
	if err == api.ErrNotModified {
		// A cheap-poll 304 through the bridge: status 304 + the stored ETag
		// (the shim's headers.get('etag') contract, guide §4.3).
		return BridgeResponse{Status: http.StatusNotModified, Body: "", ETag: a.client.ETag(path)}, nil
	}
	return BridgeResponse{}, fmt.Errorf("bridge: transport: %w", err)
}
