package ui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"hibana/desktop/internal/api"
)

func newBridge(t *testing.T) (*API, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// A minimal API echo: 200 {ok} + the ETag contract.
		if r.Header.Get("Accept") != "application/json" {
			w.WriteHeader(400)
			return
		}
		w.Header().Set("ETag", `W/"bridge"`)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(srv.Close)
	c, err := api.New(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	return New(c, "0.1.0-test", "e6661c8"), srv
}

func TestBridgeAllowLists(t *testing.T) {
	a, _ := newBridge(t)

	// Method allow-list.
	if _, err := a.Request("TRACE", "/api/x", ""); err == nil {
		t.Fatal("TRACE must be rejected")
	}
	// Path allow-list: only /api/… (the media file route lives under it too).
	if _, err := a.Request("GET", "/etc/passwd", ""); err == nil {
		t.Fatal("non-API path must be rejected")
	}
	if _, err := a.Request("GET", "https://evil.example/api/x", ""); err == nil {
		t.Fatal("absolute URL must be rejected")
	}
	if _, err := a.Request("GET", "/api/../../secret", ""); err == nil {
		t.Fatal("traversal must be rejected")
	}
	if _, err := a.Request("GET", "/api/ping\r\nX-Injected: 1", ""); err == nil {
		t.Fatal("CRLF must be rejected")
	}
	// The size cap (7MB — the server's own 413 boundary).
	if _, err := a.Request("POST", "/api/x", strings.Repeat("a", maxBridgeBody+1)); err == nil {
		t.Fatal("oversized body must be rejected")
	}
	// A legit call passes through and carries the ETag.
	res, err := a.Request("GET", "/api/projects/p1/devboard", "")
	if err != nil {
		t.Fatalf("legit call: %v", err)
	}
	if res.Status != 200 || res.ETag != `W/"bridge"` {
		t.Fatalf("bridge response: %+v", res)
	}
	var wire map[string]any
	if json.Unmarshal([]byte(res.Body), &wire) != nil || wire["ok"] != true {
		t.Fatalf("body lost across the bridge: %q", res.Body)
	}
}

func TestBridgeStatusErrorFlowsAsStatus(t *testing.T) {
	// The island's err.status branching must survive: a 404 comes back as a
	// JS-visible {status:404}, not a rejected promise.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		_, _ = w.Write([]byte(`{"error":"not_found"}`))
	}))
	defer srv.Close()
	c, _ := api.New(srv.URL)
	a := New(c, "v", "r")
	res, err := a.Request("GET", "/api/projects/p1/devboard", "")
	if err != nil {
		t.Fatalf("404 must flow as a response, not an error: %v", err)
	}
	if res.Status != 404 {
		t.Fatalf("status lost: %+v", res)
	}
}

func TestAppInfoStamps(t *testing.T) {
	a, _ := newBridge(t)
	info := a.AppInfo()
	if info.Version != "0.1.0-test" || info.WebRef != "e6661c8" {
		t.Fatalf("stamps lost: %+v", info)
	}
}
