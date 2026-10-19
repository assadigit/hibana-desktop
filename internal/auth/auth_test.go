package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"hibana/desktop/internal/api"
)

func TestFileStoreRoundTrip(t *testing.T) {
	dir := t.TempDir()
	fs := &FileStore{Path: filepath.Join(dir, "session.bin")}
	if tok, err := fs.LoadSession(); err != nil || tok != "" {
		t.Fatalf("empty store should read ('',nil): %q %v", tok, err)
	}
	if err := fs.SaveSession("tok-123"); err != nil {
		t.Fatal(err)
	}
	// The file must exist with 0600 perms on POSIX (sensitive local state).
	// Windows ignores POSIX write bits (the real protection there is the
	// per-user ACL on %LOCALAPPDATA% — hardened for real by the M5 DPAPI
	// wiring per WINDOWS-PACKAGING-PLAN §8), so only existence is asserted.
	info, err := os.Stat(fs.Path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("session file perms = %v, want 0600", info.Mode().Perm())
	}
	if tok, err := fs.LoadSession(); err != nil || tok != "tok-123" {
		t.Fatalf("round-trip: %q %v", tok, err)
	}
	if err := fs.Clear(); err != nil {
		t.Fatal(err)
	}
	if tok, err := fs.LoadSession(); err != nil || tok != "" {
		t.Fatalf("clear: %q %v", tok, err)
	}
}

func TestRestoreValidatesAndClearsDeadSessions(t *testing.T) {
	// A server that 401s every /me: the stored token is dead → Restore clears
	// it and reports false (the login path runs).
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
	}))
	defer srv.Close()
	c, _ := api.New(srv.URL)
	fs := &FileStore{Path: filepath.Join(t.TempDir(), "session.bin")}
	if err := fs.SaveSession("dead-token"); err != nil {
		t.Fatal(err)
	}
	me, live, err := Restore(context.Background(), c, fs)
	if err != nil || live {
		t.Fatalf("dead session: live=%v err=%v", live, err)
	}
	if me != nil {
		t.Fatal("dead session must return a nil identity")
	}
	if tok, _ := fs.LoadSession(); tok != "" {
		t.Fatal("Restore must Clear a dead session")
	}
}

func TestRestoreReturnsTheIdentityOnALiveSession(t *testing.T) {
	// A live stored token validates against /me and comes back WITH the
	// identity — the bridge's boot snapshot (AuthState) needs the
	// email/language_pref so the login card's visibility and the island's
	// language hook resolve before any island code runs.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ck, err := r.Cookie(api.SessionCookie)
		if err != nil || ck.Value == "" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
			return
		}
		_, _ = w.Write([]byte(`{"user":{"id":"u1","username":"user","email":"user@example.com","role":"member","language_pref":"fa","calendar_pref":"gregorian"}}`))
	}))
	defer srv.Close()
	c, _ := api.New(srv.URL)
	fs := &FileStore{Path: filepath.Join(t.TempDir(), "session.bin")}
	if err := fs.SaveSession("live-token"); err != nil {
		t.Fatal(err)
	}
	me, live, err := Restore(context.Background(), c, fs)
	if err != nil || !live {
		t.Fatalf("live session: live=%v err=%v", live, err)
	}
	if me == nil || me.User.Email != "user@example.com" || me.User.LanguagePref != "fa" {
		t.Fatalf("identity lost: %+v", me)
	}
	// The token rode into the jar (the client is session-live immediately).
	if c.SessionToken() != "live-token" {
		t.Fatalf("jar token: %q", c.SessionToken())
	}
}

func TestRestoreWithoutStoredSessionIsQuiet(t *testing.T) {
	c, _ := api.New("https://hibana.example")
	fs := &FileStore{Path: filepath.Join(t.TempDir(), "session.bin")}
	me, live, err := Restore(context.Background(), c, fs)
	if err != nil || live || me != nil {
		t.Fatalf("empty store: me=%v live=%v err=%v", me, live, err)
	}
}
