package update

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// The v0.1.18 GitHub-credentials layer (token.go): the shape allow-list, the
// hint masking (the secret never re-crosses), the data-dir roundtrip, the
// hand-mangled-file anonymous fallback, the verify verdicts, and the token
// riding EVERY request the rounds make (check + asset + checksums).

func TestValidTokenShape(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want bool
	}{
		{"ghp_0123456789abcdefghijklmnopqrstuv", true},                                            // classic PAT
		{"github_pat_11AAAAAAA0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", true}, // fine-grained
		{"0123456789abcdef", true},                                                                // raw hex key
		{"gho_0123456789abcdef", true},                                                            // other prefixes ride the same alphabet
		{"short12", false},                                                                        // < 10 chars
		{"", false},
		{"has space in it", false}, // header value must be RFC-clean
		{"line\nbreak", false},
		{strings.Repeat("x", 256), false}, // > 255
		{"bad chars!", false},
		{"colon:here", false},
	} {
		if got := ValidTokenShape(tc.in); got != tc.want {
			t.Errorf("ValidTokenShape(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

func TestTokenHintNeverShowsTheMiddle(t *testing.T) {
	tok := "ghp_" + strings.Repeat("s", 32) + "ABCD"
	hint := TokenHint(tok)
	if strings.Contains(hint, "ssss") {
		t.Errorf("TokenHint leaked the secret middle: %q", hint)
	}
	if !strings.HasPrefix(hint, "ghp_") || !strings.HasSuffix(hint, "ABCD") {
		t.Errorf("TokenHint = %q, want ghp_…ABCD", hint)
	}
	if hint != "ghp_…ABCD" {
		t.Errorf("TokenHint = %q, want the exact ghp_…ABCD form", hint)
	}
	if TokenHint("") != "…" {
		t.Errorf("TokenHint(\"\") = %q, want …", TokenHint(""))
	}
}

func TestTokenSaveLoadClearRoundtrip(t *testing.T) {
	dir := t.TempDir()
	if got := LoadToken(dir); got != "" {
		t.Errorf("no token stored yet, LoadToken = %q", got)
	}
	tok := "ghp_0123456789abcdefghijklmnopqrstuv"
	if err := SaveToken(dir, tok); err != nil {
		t.Fatalf("SaveToken: %v", err)
	}
	if got := LoadToken(dir); got != tok {
		t.Errorf("LoadToken = %q, want %q", got, tok)
	}
	if _, err := os.Stat(TokenPath(dir) + ".part"); !os.IsNotExist(err) {
		t.Errorf("a .part must never survive the atomic save")
	}
	if err := ClearToken(dir); err != nil {
		t.Fatalf("ClearToken: %v", err)
	}
	if got := LoadToken(dir); got != "" {
		t.Errorf("after ClearToken, LoadToken = %q", got)
	}
	// Clearing again is already the wanted end state — not an error.
	if err := ClearToken(dir); err != nil {
		t.Errorf("ClearToken on a missing file must be a no-op, got %v", err)
	}
}

func TestLoadTokenHandMangledFallsBackAnonymous(t *testing.T) {
	dir := t.TempDir()
	for _, garbage := range []string{"", "not a token", "with\nnewline", strings.Repeat("x", 300)} {
		if err := os.WriteFile(TokenPath(dir), []byte(garbage), 0o600); err != nil {
			t.Fatal(err)
		}
		if got := LoadToken(dir); got != "" {
			t.Errorf("a hand-mangled token file (%q) must degrade to anonymous, got %q", garbage, got)
		}
	}
	// Trimmed-then-valid still loads (a stray trailing newline from a manual
	// edit must not lock the user out of their own token).
	tok := "ghp_0123456789abcdefghijklmnopqrstuv"
	if err := os.WriteFile(TokenPath(dir), []byte(tok+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := LoadToken(dir); got != tok {
		t.Errorf("trailing-newline file = %q, want the trimmed token", got)
	}
}

func TestVerifyTokenVerdicts(t *testing.T) {
	for _, tc := range []struct {
		status int // 0 = transport failure
		want   TokenStatus
	}{
		{http.StatusOK, TokenVerified},
		{http.StatusUnauthorized, TokenInvalid},
		{http.StatusNotFound, TokenNoAccess},
		{http.StatusForbidden, TokenUnreachable}, // rate-limited / forbidden — not a token verdict
		{http.StatusInternalServerError, TokenUnreachable},
		{0, TokenUnreachable},
	} {
		var srv *httptest.Server
		sawAuth := ""
		sawPath := ""
		if tc.status != 0 {
			srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				sawPath = r.URL.Path
				sawAuth = r.Header.Get("Authorization")
				if tc.status == http.StatusOK {
					_, _ = w.Write([]byte(`{"private":false}`))
					return
				}
				w.WriteHeader(tc.status)
			}))
			defer srv.Close()
		} else {
			srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
			srv.Close() // a dead server → transport failure
		}
		got := VerifyToken(context.Background(), srv.Client(), srv.URL, "assadigit/hibana-desktop", "ghp_0123456789abcdefghijklmnopqrstuv")
		if got != tc.want {
			t.Errorf("VerifyToken(status %d) = %v, want %v", tc.status, got, tc.want)
			continue
		}
		if tc.status != 0 && tc.status != http.StatusInternalServerError {
			if sawPath != "/repos/assadigit/hibana-desktop" {
				t.Errorf("verify asked %q, want /repos/assadigit/hibana-desktop", sawPath)
			}
			if sawAuth != "Bearer ghp_0123456789abcdefghijklmnopqrstuv" {
				t.Errorf("the token must ride the Bearer header the update rounds send, saw %q", sawAuth)
			}
		}
		if got.String() == "" {
			t.Errorf("TokenStatus(%v).String() must never be empty", got)
		}
	}
}

// tokenCapturingServer records the Authorization header per path — the gate
// that proves the stored token rides EVERY request the rounds make, and that
// NO header rides when none is stored (the anonymous default).
func tokenCapturingServer(t *testing.T, captures *map[string]string, mu *sync.Mutex) *httptest.Server {
	t.Helper()
	zipBytes, exeBytes := buildTestZip(t)
	checksumsBody := shaHex(zipBytes) + "  hibana-portable-0.1.14.zip\n" +
		shaHex(exeBytes) + "  hibana.exe\n"
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		(*captures)[r.URL.Path] = r.Header.Get("Authorization")
		mu.Unlock()
		switch {
		case r.URL.Path == "/repos/assadigit/hibana-desktop/releases/latest":
			_, _ = fmt.Fprintf(w, `{"tag_name":"v0.1.14-desktop","body":"x","assets":[`+
				`{"name":"hibana-portable-0.1.14.zip","size":%d,"browser_download_url":"%s/dl/hibana-portable-0.1.14.zip"},`+
				`{"name":"checksums.txt","size":%d,"browser_download_url":"%s/dl/checksums.txt"}]}`,
				len(zipBytes), srv.URL, len(checksumsBody), srv.URL)
		case r.URL.Path == "/dl/hibana-portable-0.1.14.zip":
			w.Header().Set("Content-Length", fmt.Sprint(len(zipBytes)))
			_, _ = w.Write(zipBytes)
		case r.URL.Path == "/dl/checksums.txt":
			_, _ = w.Write([]byte(checksumsBody))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestUpdaterRidesStoredTokenOnEveryRequest(t *testing.T) {
	var mu sync.Mutex
	captures := map[string]string{}
	srv := tokenCapturingServer(t, &captures, &mu)
	old := apiBase
	apiBase = srv.URL
	defer func() { apiBase = old }()

	tok := "ghp_0123456789abcdefghijklmnopqrstuv"
	data := t.TempDir()
	if err := SaveToken(data, tok); err != nil {
		t.Fatal(err)
	}
	u := &Updater{Repo: "assadigit/hibana-desktop", Current: "0.1.13", DataDir: data}
	if _, err := u.Check(context.Background()); err != nil {
		t.Fatalf("Check: %v", err)
	}
	assetPath, kind, err := u.Prepare(context.Background(), nil)
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if kind != KindPortable || assetPath == "" {
		t.Fatalf("Prepare = %q/%q", assetPath, kind)
	}
	mu.Lock()
	defer mu.Unlock()
	want := "Bearer " + tok
	for _, path := range []string{
		"/repos/assadigit/hibana-desktop/releases/latest",
		"/dl/hibana-portable-0.1.14.zip",
		"/dl/checksums.txt",
	} {
		if captures[path] != want {
			t.Errorf("Authorization on %s = %q, want %q (the stored token must ride EVERY round request)", path, captures[path], want)
		}
	}
	// The check re-read the token fresh from disk (a mid-session save is live
	// on the next round): drop the file and the same round goes anonymous.
	if err := ClearToken(data); err != nil {
		t.Fatal(err)
	}
	captures2 := map[string]string{}
	var mu2 sync.Mutex
	srv2 := tokenCapturingServer(t, &captures2, &mu2)
	apiBase = srv2.URL
	u2 := &Updater{Repo: "assadigit/hibana-desktop", Current: "0.1.13", DataDir: data}
	if _, err := u2.Check(context.Background()); err != nil {
		t.Fatalf("Check after clear: %v", err)
	}
	if got := captures2["/repos/assadigit/hibana-desktop/releases/latest"]; got != "" {
		t.Errorf("with no stored token the check must send NO Authorization header, saw %q", got)
	}
}

func TestTokenStoreFacade(t *testing.T) {
	// The nil store is honest everywhere (the not-wired belt).
	var s *TokenStore
	if s.Load() != "" || s.Hint() != "" {
		t.Errorf("nil store must load nothing")
	}
	if err := s.Save("ghp_0123456789abcdefghijklmnopqrstuv"); err == nil {
		t.Errorf("nil store must refuse to save")
	}
	if s.Verify(context.Background(), "ghp_0123456789abcdefghijklmnopqrstuv") != TokenUnreachable {
		t.Errorf("nil store verify must be unreachable, got %v", s.Verify(context.Background(), "x"))
	}

	dir := t.TempDir()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/repos/assadigit/hibana-desktop" {
			_, _ = w.Write([]byte(`{"private":false}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()
	live := &TokenStore{DataDir: dir, Repo: "assadigit/hibana-desktop", APIBase: srv.URL}
	tok := "ghp_0123456789abcdefghijklmnopqrstuv"
	if live.Verify(context.Background(), tok) != TokenVerified {
		t.Errorf("Verify against the 200 server must be TokenVerified")
	}
	if err := live.Save(tok); err != nil {
		t.Fatal(err)
	}
	if live.Load() != tok {
		t.Errorf("Load = %q", live.Load())
	}
	if live.Hint() != "ghp_…stuv" {
		t.Errorf("Hint = %q, want ghp_…stuv", live.Hint())
	}
	if err := live.Clear(); err != nil {
		t.Fatal(err)
	}
	if live.Load() != "" || live.Hint() != "" {
		t.Errorf("after Clear, Load/Hint must be empty")
	}
	// APIBase empty → the package apiBase (the shipped default).
	if (&TokenStore{Repo: "x"}).Verify(context.Background(), tok) == TokenVerified {
		t.Errorf("the package default apiBase must not answer 200 for repo x")
	}
}

func TestReleasePageURL(t *testing.T) {
	if got := ReleasePageURL("assadigit/hibana-desktop"); got != "https://github.com/assadigit/hibana-desktop/releases/latest" {
		t.Errorf("ReleasePageURL = %q", got)
	}
	if p := TokenPath("dir"); !strings.HasSuffix(p, "github-token") || filepath.Base(p) != tokenFile {
		t.Errorf("TokenPath = %q, want <dir>/github-token", p)
	}
}
