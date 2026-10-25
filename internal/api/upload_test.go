package api

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

// TestWriteStreamContract pins the streaming upload's wire shape: the KNOWN
// Content-Length (never chunked — the server's 413 boundary reads it), the
// Origin stamp (the T6 write gate), the JSON content type, real byte
// progress as the socket accepts the body, and no ETag-store pollution.
func TestWriteStreamContract(t *testing.T) {
	var progressCalls int32
	var lastSent, lastTotal int64
	body := []byte(`{"fileName":"shot.png","dataBase64":"` + makeString(64*1024) + `"}`)
	var gotCL, gotOrigin string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotCL = r.Header.Get("Content-Length")
		gotOrigin = r.Header.Get("Origin")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"ok":true,"id":"s1"}`))
	}))
	defer srv.Close()
	c, err := New(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	res, err := c.WriteStream(context.Background(), http.MethodPost, "/api/projects/p1/screenshots", body, func(sent, total int64) {
		atomic.AddInt32(&progressCalls, 1)
		atomic.StoreInt64(&lastSent, sent)
		atomic.StoreInt64(&lastTotal, total)
	})
	if err != nil {
		t.Fatalf("WriteStream: %v", err)
	}
	if res.Status != http.StatusCreated {
		t.Fatalf("status = %d", res.Status)
	}
	if gotCL != strconv.Itoa(len(body)) {
		t.Fatalf("Content-Length = %q, want the KNOWN length %d (never chunked)", gotCL, len(body))
	}
	if gotOrigin != srv.URL {
		t.Fatalf("Origin = %q, want %q (the T6 write gate)", gotOrigin, srv.URL)
	}
	if n := atomic.LoadInt32(&progressCalls); n == 0 {
		t.Fatal("the progress callback never fired")
	}
	if s, tot := atomic.LoadInt64(&lastSent), atomic.LoadInt64(&lastTotal); s != tot || tot != int64(len(body)) {
		t.Fatalf("final progress = %d/%d, want %d/%d", s, tot, int64(len(body)), int64(len(body)))
	}
	// The upload response carries no validator: the ETag store must stay clean.
	if c.ETag("/api/projects/p1/screenshots") != "" {
		t.Fatal("WriteStream polluted the ETag store")
	}
}

// TestWriteStreamMethodGate — only writes ride the streaming path.
func TestWriteStreamMethodGate(t *testing.T) {
	c, _ := New("https://hibana.example")
	if _, err := c.WriteStream(context.Background(), http.MethodGet, "/api/x", nil, nil); err == nil {
		t.Fatal("GET must be refused")
	}
	if _, err := c.WriteStream(context.Background(), "relative", "/api/x", nil, nil); err != nil {
		_ = err
	}
	if _, err := c.WriteStream(context.Background(), http.MethodPost, "api/no-leading-slash", nil, nil); err == nil {
		t.Fatal("a non-root-relative path must be refused")
	}
}

// TestWriteStreamTransportError — a dead server surfaces as an error (the
// uploader's ✕ row), never a zero-status success.
func TestWriteStreamTransportError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	srv.Close() // already dead
	c, _ := New(srv.URL)
	if _, err := c.WriteStream(context.Background(), http.MethodPost, "/api/x", []byte("{}"), nil); err == nil {
		t.Fatal("a dead server must error, not resolve")
	}
}

// TestMediaFetchContract — the media GET rides the cookie jar, forwards the
// response's Content-Type + Cache-Control, and carries the media deadline
// (a few MB must not die on the 3s interactive GET window).
func TestMediaFetchContract(t *testing.T) {
	sawCookie := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ck, err := r.Cookie(SessionCookie); err == nil {
			sawCookie = ck.Value
		}
		w.Header().Set("Content-Type", "image/webp")
		w.Header().Set("Cache-Control", "private, max-age=3600")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("fake-webp-bytes"))
	}))
	defer srv.Close()
	c, _ := New(srv.URL)
	c.SetSessionToken("media-token")
	res, err := c.Media(context.Background(), "/api/media/screenshots/s1/file?variant=thumb")
	if err != nil {
		t.Fatalf("Media: %v", err)
	}
	if res.Status != http.StatusOK || string(res.Body) != "fake-webp-bytes" {
		t.Fatalf("media result: %+v", res)
	}
	if res.ContentType != "image/webp" || res.CacheControl != "private, max-age=3600" {
		t.Fatalf("forwarded headers: %q / %q", res.ContentType, res.CacheControl)
	}
	if sawCookie != "media-token" {
		t.Fatalf("the media GET did not ride the session jar (cookie %q)", sawCookie)
	}
	if _, err := c.Media(context.Background(), "no-leading-slash"); err == nil {
		t.Fatal("a non-root-relative path must be refused")
	}
}

// TestProgressReaderThrottle — one tick per 120ms plus the final call: a
// 256-read stream must fire a handful of events, not 256.
func TestProgressReaderThrottle(t *testing.T) {
	total := int64(8 << 20)
	var calls int
	pr := &progressReader{r: newChunkReader(total), total: total, lastTick: time.Now().Add(-time.Hour), fn: func(sent, tot int64) { calls++ }}
	buf := make([]byte, 32*1024)
	for {
		if _, err := pr.Read(buf); err != nil {
			break
		}
	}
	if calls > 80 { // 8MB / 32KB = 256 reads; the throttle must keep this tiny
		t.Fatalf("progress fired %d times for a 256-read stream (the 120ms throttle failed)", calls)
	}
	if calls == 0 {
		t.Fatal("the throttle suppressed the FINAL call too — the last event must always fire")
	}
}

// --- helpers -----------------------------------------------------------------

func makeString(n int) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = 'a'
	}
	return string(b)
}

// chunkReader yields size bytes in whatever chunks it is asked for, then EOF
// (the transport drains it through the progress wrapper).
type chunkReader struct {
	remaining int64
}

func newChunkReader(size int64) *chunkReader { return &chunkReader{remaining: size} }

func (cr *chunkReader) Read(p []byte) (int, error) {
	if cr.remaining <= 0 {
		return 0, io.EOF
	}
	n := int64(len(p))
	if n > cr.remaining {
		n = cr.remaining
	}
	cr.remaining -= n
	return int(n), nil
}
