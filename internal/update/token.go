package update

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// THE GITHUB CREDENTIALS (v0.1.18 — the owner ask: "hibana desktop might be
// a private repo so in setting, add a github credentials so it can connect
// to the private repo").
//
// The repo is PUBLIC today and the anonymous round the v0.1.14 design shipped
// works (the check, the download, the checksums chain — all fine unauth'd;
// that is exactly how the dogfooded machine reached the apply step at all).
// But the owner wants the PRIVATE flip to keep the app updating, and an
// authenticated round also lifts the anonymous 60/hr shared-IP budget to
// 5000/hr. So the round gains an OPTIONAL token:
//
//   - USER-SUPPLIED at runtime through the settings sheet's GitHub-access row
//     (internal/ui settings.go: SetGithubToken / GithubTokenState) — never
//     embedded in the binary (a PAT baked into a public app's exe is still
//     the self-inflicted wound the v0.1.14 design refused), never committed,
//     never logged;
//   - STORED in the per-user DATA dir (github-token, 0600) — the same
//     never-mix rule session.bin rides: the file survives every self-replace,
//     so the relaunched exe keeps updating privately without re-entering it;
//   - USED by every GitHub request the round makes when present — the
//     releases/latest check, the checksums.txt fetch, and the asset download
//     (GitHub 302s the authorized browser_download_url to a signed objects
//     URL; Go strips the Authorization header on cross-host redirects, so the
//     follow-up needs nothing from us). Anonymous stays the DEFAULT: no
//     token, no header, the public-repo behavior byte-identical to v0.1.17.
//
// The token crosses the JS↔Go bridge exactly ONCE (the login password's
// discipline); only the HINT (ghp_…ABCD — TokenHint) ever crosses back.

// tokenFile is the stored token's name in the data dir (0600 — per-user
// secret, the session.bin precedent).
const tokenFile = "github-token"

// tokenRe is the shape allow-list (the hostile-input law): a GitHub PAT is
// classic ghp_…, fine-grained github_pat_…, or a raw deploy-style key — all
// [A-Za-z0-9_.-], 10..255 chars, no whitespace (an Authorization header value
// must be RFC-clean; anything else is refused before it ever reaches disk or
// the wire).
var tokenRe = regexp.MustCompile(`^[A-Za-z0-9_.\-]{10,255}$`)

// ValidTokenShape reports whether tok is a plausible GitHub token — the one
// validation gate the binding and the loader share.
func ValidTokenShape(tok string) bool { return tokenRe.MatchString(tok) }

// TokenHint renders the display form — "ghp_…ABCD": the first 4, an ellipsis,
// the last 4. The middle (the secret) never appears in a UI, a log line, or a
// probe screenshot. Short values mask entirely except the tail.
func TokenHint(tok string) string {
	if len(tok) < 12 {
		return "…" + tok[max(0, len(tok)-4):]
	}
	return tok[:4] + "…" + tok[len(tok)-4:]
}

// TokenPath is the stored token's location in the data dir.
func TokenPath(dataDir string) string {
	return filepath.Join(dataDir, tokenFile)
}

// SaveToken persists tok (already shape-validated by the caller) to the data
// dir, 0600, via the write-temp-then-rename atomicity so a torn write can
// never leave a half-token the next round reads.
func SaveToken(dataDir, token string) error {
	if dataDir == "" {
		return fmt.Errorf("update: token: no data dir wired")
	}
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return fmt.Errorf("update: token: %w", err)
	}
	p := TokenPath(dataDir)
	tmp := p + ".part"
	if err := os.WriteFile(tmp, []byte(token), 0o600); err != nil {
		return fmt.Errorf("update: token: %w", err)
	}
	if err := os.Rename(tmp, p); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("update: token: %w", err)
	}
	return nil
}

// LoadToken reads the stored token; missing, empty, or HAND-MANGLED (fails
// the shape gate) all resolve "" — the anonymous fallback. A garbage file
// must degrade to the proven public-repo round, never send a broken header
// that 401s every check until someone deletes it by hand.
func LoadToken(dataDir string) string {
	if dataDir == "" {
		return ""
	}
	b, err := os.ReadFile(TokenPath(dataDir))
	if err != nil {
		return ""
	}
	tok := strings.TrimSpace(string(b))
	if !ValidTokenShape(tok) {
		return ""
	}
	return tok
}

// ClearToken removes the stored token (the settings sheet's Remove row).
// A missing file is already the wanted end state — not an error.
func ClearToken(dataDir string) error {
	if dataDir == "" {
		return fmt.Errorf("update: token: no data dir wired")
	}
	if err := os.Remove(TokenPath(dataDir)); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("update: token: %w", err)
	}
	return nil
}

// TokenStatus is what the verify round learned about a candidate token.
type TokenStatus int

const (
	// TokenVerified: GET /repos/<repo> answered 200 — the token is valid AND
	// can read the repository (public or private-with-access).
	TokenVerified TokenStatus = iota
	// TokenInvalid: 401 — GitHub rejected the credentials themselves.
	TokenInvalid
	// TokenNoAccess: 404 — the token is valid but cannot see the repo (a
	// private repo it has no grant for, or a wrong repo string).
	TokenNoAccess
	// TokenUnreachable: transport error, 403 (rate-limited/suspended — the
	// honest reading is "could not ask"), or 5xx. Never a verdict on the
	// token itself.
	TokenUnreachable
)

func (s TokenStatus) String() string {
	switch s {
	case TokenVerified:
		return "verified"
	case TokenInvalid:
		return "invalid"
	case TokenNoAccess:
		return "no-access"
	default:
		return "unreachable"
	}
}

// VerifyToken asks GitHub whether tok can read repo — one cheap GET
// /repos/<repo> (the same apiRoot the release check reads, so tests point it
// at their httptest server through TokenStore.APIBase). The token rides the
// Authorization header exactly the way the update rounds will send it.
func VerifyToken(ctx context.Context, client *http.Client, apiRoot, repo, token string) TokenStatus {
	if client == nil {
		client = &http.Client{Timeout: checkTimeout}
	}
	cctx, cancel := context.WithTimeout(ctx, checkTimeout)
	defer cancel()
	url := strings.TrimRight(apiRoot, "/") + "/repos/" + repo
	req, err := ghRequest(cctx, http.MethodGet, url, token)
	if err != nil {
		return TokenUnreachable
	}
	resp, err := client.Do(req)
	if err != nil {
		return TokenUnreachable
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
		return TokenVerified
	case http.StatusUnauthorized:
		return TokenInvalid
	case http.StatusNotFound:
		return TokenNoAccess
	default:
		// 403 (rate limit / forbidden) and 5xx — GitHub was asked but did not
		// answer a question about the TOKEN; honest "could not verify".
		return TokenUnreachable
	}
}

// TokenStore is the settings binding's handle on the stored token: the SAME
// data dir + repo the shell's own Updater reads, so there is exactly ONE
// token file and ONE truth. main.go wires it (bridge.SetGithubTokenStore);
// the update rounds read the file directly (Updater.authToken), so a token
// saved mid-session is picked up by the very next check — no restart, no
// extra plumbing.
type TokenStore struct {
	DataDir string       // the resolved data dir (github-token lives beside session.bin)
	Repo    string       // "assadigit/hibana-desktop" — the verify round's subject
	Client  *http.Client // optional (tests); nil = a default client
	APIBase string       // optional (tests); "" = the package apiBase var
}

// Load reports the stored token ("" when absent or mangled).
func (s *TokenStore) Load() string {
	if s == nil || s.DataDir == "" {
		return ""
	}
	return LoadToken(s.DataDir)
}

// Hint reports the stored token's display form ("" when none is stored —
// an unset row must never paint a bare ellipsis).
func (s *TokenStore) Hint() string {
	tok := s.Load()
	if tok == "" {
		return ""
	}
	return TokenHint(tok)
}

// Save persists a shape-valid token.
func (s *TokenStore) Save(token string) error {
	if s == nil || s.DataDir == "" {
		return fmt.Errorf("update: token: no data dir wired")
	}
	return SaveToken(s.DataDir, token)
}

// Clear removes the stored token.
func (s *TokenStore) Clear() error {
	if s == nil || s.DataDir == "" {
		return fmt.Errorf("update: token: no data dir wired")
	}
	return ClearToken(s.DataDir)
}

// Verify runs the verify round for a candidate token against the store's
// repo.
func (s *TokenStore) Verify(ctx context.Context, token string) TokenStatus {
	if s == nil {
		return TokenUnreachable
	}
	root := s.APIBase
	if root == "" {
		root = apiBase
	}
	return VerifyToken(ctx, s.Client, root, s.Repo, token)
}
