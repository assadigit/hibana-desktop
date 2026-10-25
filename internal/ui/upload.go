package ui

import (
	"context"
	"fmt"
	"net/http"
	"strings"
)

// THE UPLOAD BINDING (guide §5.4 — the M4 round; the owner's dogfood ask:
// "upload file button exists and it shows a loading as well, but after the
// loading ends, it doesn't show whether it was successful or not, because it
// doesn't show the thumbnail of the uploaded picture"). The island's uploader
// (devboard.js's uploadShotXHR) speaks XMLHttpRequest through the shim's
// window.hibanaXHR proxy; the proxy resolves THIS bound method at send time:
//
//      Upload(callID, method, path, body, headers) → {status, body}
//
//      SetUploadEmit → EventsEmit "hibana:upload-progress" {id, loaded, total}
//
// The callID is the shim's per-request correlation key (the uploader can run
// several files in parallel against the SAME path, so the progress events
// cannot be addressed by path); the shim's EventsOn listener routes each
// event to the right XHR's upload.onprogress. Everything else mirrors Request
// exactly: the method allow-list, the /api/ path allow-list, the malformed-
// path rejections, the 7MB body cap (the server's own 413 boundary), the
// Origin stamp + cookie jar Go-side, and the rolling-session persist on 2xx.
// The one difference is the WIRE: WriteStream streams the body with a KNOWN
// Content-Length and reports real bytes-in-flight, so the uploader's progress
// rows fill with the truth, and the upload rides the api bucket's pacing
// (contract §3.6: upload 30/60s — the same ceiling the web uploader lives
// under; a 429 still answers as {status:429} so the row's error path shows).
//
// The success feedback the owner asked for is then complete: the row's ✓ +
// the green "Screenshot uploaded" toast + the tile WITH ITS THUMBNAIL (the
// media proxy below serves /api/media/… with the same cookie jar) — the
// same three facts the web app shows.

// uploadEventProgress is the Wails event the shim's XHR proxy subscribes to
// (its name is its contract, like hibana:sync-progress).
const uploadEventProgress = "hibana:upload-progress"

// uploadConcurrency caps the in-flight uploads through the bridge (the web
// uploader queues files SEQUENTIALLY per input, but a dropped folder can
// open several strip rows; the server's own ceiling is 30/min anyway).
const uploadConcurrency = 4

// uploadSem bounds concurrent uploads (a stuck uplink must not pile 50
// IPC payloads of ~7MB each into memory).
var uploadSem = make(chan struct{}, uploadConcurrency)

// SetUploadEmit wires the progress relay (main.go: EventsEmit — the only
// way the bridge's transport goroutine reaches the WebView). Without it the
// uploads still run; the rows just fill at the end (a degraded but honest
// bar, the same failure shape the web survives).
func (a *API) SetUploadEmit(fn func(name string, payload map[string]any)) {
	a.uploadMu.Lock()
	a.uploadEmit = fn
	a.uploadMu.Unlock()
}

// Upload is the streamed upload transport the shim's XHR proxy calls. The
// headers map is accepted for XHR-shape parity (the uploader sets
// Content-Type: application/json) but read only for that one documented
// value — the Go side owns every header (Origin, the session cookie), so a
// hostile page could never smuggle its own.
func (a *API) Upload(callID, method, path, body string, headers map[string]string) (BridgeResponse, error) {
	callID = strings.TrimSpace(callID)
	if len(callID) > 128 {
		return BridgeResponse{}, fmt.Errorf("bridge: upload: call id exceeds the size limit")
	}
	method = strings.ToUpper(strings.TrimSpace(method))
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
	default:
		return BridgeResponse{}, fmt.Errorf("bridge: upload: method not allowed: %q", method)
	}
	path = strings.TrimSpace(path)
	if !strings.HasPrefix(path, "/api/") {
		return BridgeResponse{}, fmt.Errorf("bridge: upload: path outside the API allow-list: %q", path)
	}
	if strings.Contains(path, "..") || strings.Contains(path, "://") || strings.ContainsAny(path, "\x00\r\n") {
		return BridgeResponse{}, fmt.Errorf("bridge: upload: malformed path: %q", path)
	}
	if len(body) > maxBridgeBody {
		return BridgeResponse{}, fmt.Errorf("bridge: upload: body exceeds the %d-byte cap", maxBridgeBody)
	}
	var bodyBytes []byte
	if body != "" {
		bodyBytes = []byte(body)
	}

	// The api bucket (contract §3.6) — never a blind retry: a paced-out
	// upload answers {status:429} through the normal path below.
	_ = a.client.Pace(context.Background(), "upload")

	uploadSem <- struct{}{} // acquire
	resp, err := a.client.WriteStream(context.Background(), method, path, bodyBytes, func(sent, total int64) {
		a.uploadMu.Lock()
		emit := a.uploadEmit
		a.uploadMu.Unlock()
		if emit != nil && callID != "" {
			emit(uploadEventProgress, map[string]any{
				"id":     callID,
				"loaded": sent,
				"total":  total,
			})
		}
	})
	<-uploadSem // release
	if err != nil {
		return BridgeResponse{}, fmt.Errorf("bridge: upload: transport: %w", err)
	}
	if resp.Status >= 200 && resp.Status < 300 {
		a.noteSessionRefresh()
	}
	return BridgeResponse{Status: resp.Status, Body: string(resp.Body), ETag: ""}, nil
}

// MediaMiddleware serves the island's AUTHED media (screenshots and their
// ?variant=thumb tiles, avatars) through the Go-side cookie jar. The
// desktop's WebView loads tiles as <img src="/api/media/…"> — those requests
// land on the EMBEDDED asset server, not hibana.ir, so without this proxy
// every tile 404s (the owner's report: "it doesn't show the thumbnail of the
// uploaded picture" even when the row said ✓). GET/HEAD only, the same
// malformed-path rejections as the bridge, the response's Content-Type +
// Cache-Control forwarded verbatim, non-200s passed through as-is (the
// island's SHOT_RETRY_ATTR tile self-heals transient failures).
func (a *API) MediaMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			next.ServeHTTP(w, r)
			return
		}
		if !strings.HasPrefix(r.URL.Path, "/api/media/") {
			next.ServeHTTP(w, r)
			return
		}
		if strings.Contains(r.URL.Path, "..") || strings.Contains(r.URL.Path, "://") || strings.ContainsAny(r.URL.Path, "\x00\r\n") {
			http.Error(w, "malformed media path", http.StatusBadRequest)
			return
		}
		path := r.URL.Path
		if r.URL.RawQuery != "" {
			path += "?" + r.URL.RawQuery
		}
		res, err := a.client.Media(r.Context(), path)
		if err != nil {
			http.Error(w, "media proxy unavailable", http.StatusBadGateway)
			return
		}
		h := w.Header()
		if ct := res.ContentType; ct != "" {
			h.Set("Content-Type", ct)
		}
		if cc := res.CacheControl; cc != "" {
			h.Set("Cache-Control", cc)
		} else {
			h.Set("Cache-Control", "private, max-age=3600")
		}
		h.Set("Content-Length", fmt.Sprint(len(res.Body)))
		w.WriteHeader(res.Status)
		if r.Method != http.MethodHead {
			_, _ = w.Write(res.Body)
		}
	})
}
