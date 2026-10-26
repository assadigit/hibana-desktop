// Package update — the auto-update round (v0.1.14).
//
// THE OWNER ASK: "Add an auto update for the app. when the new version
// releases in the github, app syncs with the internet and github, and if new
// version, whether portable or installer released, show a button for update.
// it must update from github and replace without losing data or needing user
// to re login."
//
// THE DESIGN (honest about every boundary it can control):
//
//  1. THE CHECK — GET /repos/<owner>/<repo>/releases/latest against the
//     public GitHub API. Anonymous by DEFAULT (the repo is public, and a PAT
//     embedded in a public app's exe would be a self-inflicted wound); since
//     v0.1.18 an OPTIONAL user-supplied token (the settings sheet's
//     GitHub-access row, stored in the DATA dir — token.go) rides every
//     request as a Bearer header, so a private flip keeps the app updating
//     and an authenticated check lifts the anonymous 60/hr shared-IP budget
//     to 5000/hr. No token, no header: the public round is byte-identical
//     to the v0.1.14 behavior.
//     The tag "v0.1.14-desktop" normalizes to "0.1.14" and is compared with
//     the -X stamped main.Version ("0.1.14"; a dev build "0.1.14-dev" counts
//     as 0.1.14 — dev builds never self-update to their own tag, only to a
//     strictly newer one). Garbage never updates: an unparsable version on
//     either side is NOT newer, by contract.
//
//  2. THE ASSET PICK — "whether portable or installer released": the release
//     may carry hibana-portable-<ver>.zip (preferred — a plain zip the
//     updater replaces its own exe with, per-user, no UAC, no wizard) and/or
//     hibana-*-installer.exe (the NSIS wizard — the fallback when a release
//     ships no zip). A release carrying NEITHER offers nothing (no button).
//
//  3. THE VERIFICATION CHAIN — the release's own checksums.txt (uploaded by
//     the same lane that built the assets) is fetched and BOTH halves are
//     checked before anything runs: the downloaded archive/installer matches
//     its sha256 line, AND (for the zip) the hibana.exe ENTRY inside the
//     archive matches the checksums.txt hibana.exe line — a tampered release
//     fails closed, the app never replaces itself with bytes the lane did
//     not sign off.
//
//  4. THE REPLACE, WITHOUT LOSING DATA — the WPP §1 never-mix rule is the
//     load-bearing fact: the session (session.bin), the mirror (mirror.db)
//     and the logs live in the DATA dir (%LOCALAPPDATA%\hibana installed /
//     <exeDir>\data portable) — NEVER next to the exe the update replaces.
//     The zip flow swaps exactly ONE file (the exe at os.Executable()) and
//     restarts it; the next boot's auth.Restore finds the live session and
//     boots straight into the board. No re-login, nothing lost.
//
//  5. THE RESTART — Windows cannot replace a running exe, so the replace
//     rides a DETACHED PowerShell helper spawned right before the app quits
//     (apply_windows.go — the interpreter RESOLVED BY ABSOLUTE PATH through
//     internal/winshell, because a stripped PATH must never kill the swap;
//     the v0.1.17 dogfood: a machine with a healthy PowerShell failed with
//     exec: "powershell.exe": executable file not found in %PATH%): it waits
//     for the parent PID to exit, swaps the file, relaunches the SAME path
//     (the new version), and stages nothing in the data dir but the
//     downloads themselves. The installer flow runs the wizard VISIBLE (no
//     /S — a silent NSIS on a machine where it needs elevation would hang
//     invisibly on a UAC prompt no one can see) and relaunches the exe after
//     it finishes.
package update

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// apiBase is the GitHub API host — a var so tests point it at an
// httptest server; the shipped default is the real public API.
var apiBase = "https://api.github.com"

// checkTimeout bounds one releases/latest call (a slow GitHub must never
// wedge the toolbar or the 2-hour loop's goroutine).
const checkTimeout = 15 * time.Second

// downloadTimeout bounds the whole asset download (a 5-8MB zip on a slow link
// can take minutes; half an hour of nothing means the round failed — Try
// again never loses anything).
const downloadTimeout = 30 * time.Minute

// progressStep is the download progress granularity (bytes between emitted
// progress callbacks — every chunk would flood the Wails IPC; ~40 events for
// a 10MB asset is live enough for a smooth bar).
const progressStep = 256 << 10

// The two asset kinds the check reports to the island (the modal names what
// it will install).
const (
	KindInstaller = "installer"
	KindPortable  = "portable"
)

// portablesRe matches the lane's portable zip name (hibana-portable-<ver>.zip
// — scripts/make-portable.ps1's own output name).
var portablesRe = regexp.MustCompile(`^hibana-portable-[0-9][^/]*\.zip$`)

// Asset is one downloadable release artifact.
type Asset struct {
	Name string `json:"name"`
	URL  string `json:"url"`
	Size int64  `json:"size"`
}

// Release is the parsed latest release — exactly the fields the update flow
// needs, nothing else (the API's JSON is far wider; we never carry it).
type Release struct {
	Tag       string // "v0.1.14-desktop"
	Version   string // "0.1.14"
	Notes     string // the release body (markdown)
	Published string
	Installer *Asset // the NSIS installer, when the release carries one
	Portable  *Asset // the portable zip, when the release carries one
	Checksums *Asset // the release's own checksums.txt
}

// CheckResult is the wire shape the bridge reports to JS: the button's birth
// certificate. Available=false carries no asset facts (the island hides the
// button and claims nothing).
type CheckResult struct {
	Available bool   `json:"available"`
	Current   string `json:"current"`
	Latest    string `json:"latest"`
	Kind      string `json:"kind"` // "portable" | "installer"
	Size      int64  `json:"size"` // the asset's byte size (the modal shows it)
	Notes     string `json:"notes"`
	URL       string `json:"url"` // the GitHub release page (deep link, not the asset)
}

// Progress is one download/verify progress tick relayed to the modal's bar.
type Progress struct {
	Stage    string  `json:"stage"` // "download" | "verify" | "apply"
	Received int64   `json:"received"`
	Total    int64   `json:"total"`
	Pct      float64 `json:"pct"`
}

// ApplyResult is the apply round's wire outcome: {ok:true} means the helper
// is spawned and the app is about to quit — the modal paints "restarting…".
// Since v0.1.19 a FAILED round carries PageOpened:true when the bridge's
// fallback reflex opened the release page in the system browser (the owner
// ask: "auto-open release page when an apply fails") — the island paints its
// "the release page opened in your browser" line ONLY on this flag, so a
// machine where the open could not happen never claims it did.
type ApplyResult struct {
	OK         bool   `json:"ok"`
	Message    string `json:"message,omitempty"`
	PageOpened bool   `json:"pageOpened,omitempty"`
}

// ErrNoUpdate is the honest no-op: the release carries no usable asset, or
// it stopped being newer between the check and the click.
var ErrNoUpdate = errors.New("update: no downloadable update asset")

// ParseVersion reads "0.1.14", "v0.1.14", "0.1.14-desktop" or "0.1.14-dev"
// into a 3-tuple. The suffix after the first '-' or '+' is ignored (a dev
// build of 0.1.14 IS 0.1.14); a missing or non-numeric part fails with
// false — the caller decides, and IsNewer fails closed on it.
func ParseVersion(s string) ([3]int, bool) {
	var out [3]int
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "v")
	if i := strings.IndexByte(s, '-'); i >= 0 {
		s = s[:i]
	}
	if i := strings.IndexByte(s, '+'); i >= 0 {
		s = s[:i]
	}
	if s == "" {
		return out, false
	}
	parts := strings.Split(s, ".")
	if len(parts) < 1 || len(parts) > 4 {
		return out, false
	}
	seen := false
	for i := 0; i < 3; i++ {
		if i >= len(parts) {
			out[i] = 0
			continue
		}
		p := strings.TrimSpace(parts[i])
		if p == "" {
			out[i] = 0
			continue
		}
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return [3]int{}, false
		}
		out[i] = n
		seen = true
	}
	if !seen {
		return out, false
	}
	return out, true
}

// IsNewer reports whether latest is STRICTLY newer than current (equal is
// false — a release equal to the running version is not an update; garbage
// on either side is never newer, fail closed).
func IsNewer(latest, current string) bool {
	l, ok := ParseVersion(latest)
	if !ok {
		return false
	}
	c, ok := ParseVersion(current)
	if !ok {
		return false
	}
	for i := 0; i < 3; i++ {
		if l[i] != c[i] {
			return l[i] > c[i]
		}
	}
	return false
}

// tagNameVersion normalizes the release tag into the comparable version
// ("v0.1.14-desktop" → "0.1.14"; a tag without the -desktop suffix parses too).
func tagNameVersion(tag string) string {
	v := strings.TrimPrefix(strings.TrimSpace(tag), "v")
	if i := strings.IndexByte(v, '-'); i >= 0 {
		v = v[:i]
	}
	return v
}

// ghAsset / ghRelease are the API response shapes (only the fields used).
type ghAsset struct {
	Name               string `json:"name"`
	Size               int64  `json:"size"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

type ghRelease struct {
	TagName     string    `json:"tag_name"`
	Body        string    `json:"body"`
	PublishedAt string    `json:"published_at"`
	Prerelease  bool      `json:"prerelease"`
	Draft       bool      `json:"draft"`
	Assets      []ghAsset `json:"assets"`
}

// ghRequest builds one GitHub request with the shared headers: the API's
// own versioned media type, the descriptive User-Agent GitHub requires, and
// — since v0.1.18 — the optional stored token's Bearer header (an empty
// token sends nothing; the anonymous round stays anonymous). Every request
// the update package makes goes through here, so the authenticated path and
// the anonymous path can never drift apart.
func ghRequest(ctx context.Context, method, url, token string) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "Hibana-Kanban-Desktop-Updater")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return req, nil
}

// FetchLatest reads the repo's latest published release and classifies its
// assets. The Accept header is the API's own versioned media type + a
// descriptive User-Agent (GitHub requires one); token ("") rides as a Bearer
// header when set (token.go — the private-repo / rate-budget path).
func FetchLatest(ctx context.Context, client *http.Client, repo, token string) (*Release, error) {
	if client == nil {
		client = &http.Client{Timeout: checkTimeout}
	}
	cctx, cancel := context.WithTimeout(ctx, checkTimeout)
	defer cancel()
	url := strings.TrimRight(apiBase, "/") + "/repos/" + repo + "/releases/latest"
	req, err := ghRequest(cctx, http.MethodGet, url, token)
	if err != nil {
		return nil, fmt.Errorf("update: latest release: %w", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("update: latest release: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("update: latest release: github answered %d", resp.StatusCode)
	}
	var gh ghRelease
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&gh); err != nil {
		return nil, fmt.Errorf("update: latest release: parsing json: %w", err)
	}
	if gh.Draft || gh.Prerelease {
		return nil, fmt.Errorf("update: latest release: /latest returned a %s", map[bool]string{true: "prerelease", false: "draft"}[gh.Prerelease])
	}
	rel := &Release{
		Tag:       gh.TagName,
		Version:   tagNameVersion(gh.TagName),
		Notes:     gh.Body,
		Published: gh.PublishedAt,
	}
	for _, a := range gh.Assets {
		asset := &Asset{Name: a.Name, URL: a.BrowserDownloadURL, Size: a.Size}
		switch {
		case a.Name == "checksums.txt":
			rel.Checksums = asset
		case strings.Contains(a.Name, "installer") && strings.HasSuffix(a.Name, ".exe"):
			rel.Installer = asset
		case portablesRe.MatchString(a.Name):
			rel.Portable = asset
		}
	}
	return rel, nil
}

// PickAsset chooses the update asset — the portable zip when the release
// carries one (self-replace: per-user, no wizard), the installer otherwise
// ("whether portable or installer released" — either one lights the button).
// The kind rides out with the asset so the modal can name the flow.
func PickAsset(rel *Release) (*Asset, string, bool) {
	if rel == nil {
		return nil, "", false
	}
	if rel.Portable != nil {
		return rel.Portable, KindPortable, true
	}
	if rel.Installer != nil {
		return rel.Installer, KindInstaller, true
	}
	return nil, "", false
}

// ParseChecksums reads the lane's checksums.txt ("<sha256>  <filename>" per
// line — Get-FileHash's sha256sum-style output) into a name→hex map. Lines
// that don't parse are skipped (never fatal to the map — the LOOKUP failing
// closed is what matters, a stray line must not void the whole file).
func ParseChecksums(body string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		// two forms seen in the wild: "<hex>  <name>" (sha256sum) and
		// "<hex> *<name>" (Get-FileHash's binary marker) — Fields eats the
		// whitespace; the marker itself is trimmed off the name.
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		hexSum := strings.ToLower(strings.TrimPrefix(fields[0], "\\"))
		if len(hexSum) != 64 {
			continue
		}
		out[strings.TrimPrefix(fields[1], "*")] = hexSum
	}
	return out
}

// sha256File hashes a file in one streaming pass.
func sha256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// VerifyFile checks a downloaded file against its checksums.txt line. A
// missing line FAILS CLOSED — a release whose checksums.txt omits the asset
// it shipped is exactly the kind of anomaly the updater must not survive.
func VerifyFile(path, name string, sums map[string]string) error {
	want, ok := sums[name]
	if !ok || want == "" {
		return fmt.Errorf("update: checksums.txt carries no line for %q", name)
	}
	got, err := sha256File(path)
	if err != nil {
		return fmt.Errorf("update: hashing %s: %w", name, err)
	}
	if got != want {
		return fmt.Errorf("update: %s failed verification (want %s…, got %s…)", name, want[:12], got[:12])
	}
	return nil
}

// VerifyZipEntry checks one named file INSIDE a zip archive against its
// checksums.txt line — the second half of the chain: not only must the
// archive hash match, the hibana.exe it carries must be the one the lane
// hashed. A mismatch fails closed before anything is ever spawned.
func VerifyZipEntry(zipPath, entryName string, sums map[string]string) error {
	want, ok := sums[entryName]
	if !ok || want == "" {
		return fmt.Errorf("update: checksums.txt carries no line for %q", entryName)
	}
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return fmt.Errorf("update: opening archive: %w", err)
	}
	defer zr.Close()
	for _, f := range zr.File {
		if f.Name != entryName {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return fmt.Errorf("update: reading %s from the archive: %w", entryName, err)
		}
		h := sha256.New()
		_, copyErr := io.Copy(h, rc)
		rc.Close()
		if copyErr != nil {
			return fmt.Errorf("update: hashing %s from the archive: %w", entryName, copyErr)
		}
		got := hex.EncodeToString(h.Sum(nil))
		if got != want {
			return fmt.Errorf("update: the archive's %s failed verification (want %s…, got %s…)", entryName, want[:12], got[:12])
		}
		return nil
	}
	return fmt.Errorf("update: the archive carries no %s", entryName)
}

// Download streams url to dest+".part" (a partial never masquerades as the
// asset — the atomic rename happens only on a complete copy) and relays
// progress every progressStep bytes plus one final tick. total<=0 means the
// caller lacked Content-Length; the relay still counts bytes (the modal's
// bar goes indeterminate then). The optional token rides as a Bearer header
// (private-repo asset downloads: GitHub 302s the authorized URL to a signed
// objects URL, and Go strips Authorization on cross-host redirects, so the
// signed follow-up needs nothing from us).
func Download(ctx context.Context, client *http.Client, url, dest string, total int64, progress func(Progress), token string) (int64, error) {
	if client == nil {
		client = &http.Client{Timeout: downloadTimeout}
	}
	dctx, cancel := context.WithTimeout(ctx, downloadTimeout)
	defer cancel()
	req, err := ghRequest(dctx, http.MethodGet, url, token)
	if err != nil {
		return 0, fmt.Errorf("update: download: %w", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, fmt.Errorf("update: download: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("update: download: github answered %d", resp.StatusCode)
	}
	if total <= 0 {
		total = resp.ContentLength
	}
	partPath := dest + ".part"
	part, err := os.OpenFile(partPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return 0, fmt.Errorf("update: download: staging %s: %w", filepath.Base(partPath), err)
	}
	var received int64
	emit := func() {
		if progress != nil {
			pct := 0.0
			if total > 0 {
				pct = float64(received) / float64(total) * 100
				if pct > 100 {
					pct = 100
				}
			}
			progress(Progress{Stage: "download", Received: received, Total: total, Pct: pct})
		}
	}
	// The counting copy: flush a progress tick every progressStep bytes.
	buf := make([]byte, 64<<10)
	var sinceTick int64
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := part.Write(buf[:n]); werr != nil {
				part.Close()
				os.Remove(partPath)
				return 0, fmt.Errorf("update: download: writing %s: %w", filepath.Base(partPath), werr)
			}
			received += int64(n)
			sinceTick += int64(n)
			if sinceTick >= progressStep {
				sinceTick = 0
				emit()
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			part.Close()
			os.Remove(partPath)
			return 0, fmt.Errorf("update: download: %w", rerr)
		}
	}
	if err := part.Close(); err != nil {
		os.Remove(partPath)
		return 0, fmt.Errorf("update: download: closing %s: %w", filepath.Base(partPath), err)
	}
	if err := os.Rename(partPath, dest); err != nil {
		os.Remove(partPath)
		return 0, fmt.Errorf("update: download: finishing %s: %w", filepath.Base(dest), err)
	}
	emit() // the final tick lands the bar at 100% whatever the chunk math did
	return received, nil
}

// fetchChecksums reads the release's own checksums.txt (a few hundred
// bytes; the token rides the same Bearer header as every other request).
func fetchChecksums(ctx context.Context, client *http.Client, c *Asset, token string) (map[string]string, error) {
	if client == nil {
		client = &http.Client{Timeout: checkTimeout}
	}
	if c == nil || c.URL == "" {
		return nil, fmt.Errorf("update: the release carries no checksums.txt")
	}
	cctx, cancel := context.WithTimeout(ctx, checkTimeout)
	defer cancel()
	req, err := ghRequest(cctx, http.MethodGet, c.URL, token)
	if err != nil {
		return nil, fmt.Errorf("update: checksums: %w", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("update: checksums: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("update: checksums: github answered %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("update: checksums: %w", err)
	}
	return ParseChecksums(string(body)), nil
}

// Updater is the shell-owned instance: one repo, one current version, one
// staging dir (<dataDir>/updates — the DATA dir, deliberately: the never-mix
// rule keeps data out of the replace path, and a staged download next to the
// exe would vanish under the installer flow's directory assumptions).
type Updater struct {
	Repo    string       // "assadigit/hibana-desktop"
	Current string       // main.Version ("0.1.13")
	DataDir string       // the resolved data dir (updates stage under it)
	Client  *http.Client // optional (tests); nil = a default client
	ExePath string       // optional override (tests); "" = os.Executable()

	// LastVersion is the release version the last successful Prepare staged
	// (read by the shell's restart log; written only under the bridge's
	// single-flight guard, so a plain field is the honest shape).
	LastVersion string
}

// updatesDir is the staging dir, created on demand.
func (u *Updater) updatesDir() (string, error) {
	if u.DataDir == "" {
		return "", fmt.Errorf("update: no data dir wired")
	}
	d := filepath.Join(u.DataDir, "updates")
	if err := os.MkdirAll(d, 0o755); err != nil {
		return "", fmt.Errorf("update: staging dir: %w", err)
	}
	return d, nil
}

// authToken is the round's optional stored token, read FRESH from the data
// dir on every check/prepare (a token saved through the settings sheet
// mid-session is picked up by the very next round — no restart); "" = the
// honest anonymous round. A hand-mangled file degrades to "" too (LoadToken's
// shape gate), never a broken header that 401s every check.
func (u *Updater) authToken() string {
	if u.DataDir == "" {
		return ""
	}
	return LoadToken(u.DataDir)
}

// exePath resolves the binary to replace (tests inject; the shell trusts
// os.Executable()).
func (u *Updater) exePath() (string, error) {
	if u.ExePath != "" {
		return u.ExePath, nil
	}
	return os.Executable()
}

// ReleasePageURL is the release's human page — the manual-install escape
// hatch the apply error names when a machine has no shell interpreter at
// all (the staged zip + this URL = a human can always finish the round).
func ReleasePageURL(repo string) string {
	return "https://github.com/" + repo + "/releases/latest"
}

// Check runs the whole check: fetch the latest release, decide, and report
// the wire result. An unreachable GitHub is an ERROR (the caller logs it and
// the island stays quiet — an offline check must never paint "no update";
// it simply didn't happen).
func (u *Updater) Check(ctx context.Context) (CheckResult, error) {
	rel, err := FetchLatest(ctx, u.Client, u.Repo, u.authToken())
	if err != nil {
		return CheckResult{Current: u.Current}, err
	}
	asset, kind, ok := PickAsset(rel)
	if !ok {
		// A release with no downloadable asset is a fact, not an error —
		// reported honestly as available:false. The lane always ships both
		// assets, so this is belt.
		return CheckResult{Current: u.Current, Latest: rel.Version, Available: false}, nil
	}
	if !IsNewer(rel.Version, u.Current) {
		return CheckResult{Current: u.Current, Latest: rel.Version, Available: false}, nil
	}
	return CheckResult{
		Available: true,
		Current:   u.Current,
		Latest:    rel.Version,
		Kind:      kind,
		Size:      asset.Size,
		Notes:     rel.Notes,
		URL:       ReleasePageURL(u.Repo),
	}, nil
}

// Prepare downloads + verifies the update: the asset lands in the staging
// dir, the archive (or installer) is verified against the release's own
// checksums.txt, and — for the zip flow — the embedded hibana.exe entry is
// verified against the exe's own line too. The returned path + kind feed
// Apply. progress relays the modal's bar (download ticks + the verify stage).
// The verdict is RE-EARNED here: the release may have moved between the
// check and the click (a re-cut tag, a yanked asset).
func (u *Updater) Prepare(ctx context.Context, progress func(Progress)) (string, string, error) {
	rel, err := FetchLatest(ctx, u.Client, u.Repo, u.authToken())
	if err != nil {
		return "", "", err
	}
	asset, kind, ok := PickAsset(rel)
	if !ok || !IsNewer(rel.Version, u.Current) {
		return "", "", ErrNoUpdate
	}
	dir, err := u.updatesDir()
	if err != nil {
		return "", "", err
	}
	dest := filepath.Join(dir, asset.Name)
	if _, err := Download(ctx, u.Client, asset.URL, dest, asset.Size, progress, u.authToken()); err != nil {
		return "", "", err
	}
	if progress != nil {
		progress(Progress{Stage: "verify", Received: asset.Size, Total: asset.Size, Pct: 100})
	}
	sums, err := fetchChecksums(ctx, u.Client, rel.Checksums, u.authToken())
	if err != nil {
		os.Remove(dest)
		return "", "", err
	}
	if err := VerifyFile(dest, asset.Name, sums); err != nil {
		os.Remove(dest)
		return "", "", err
	}
	if kind == KindPortable {
		// The second half of the chain: the exe INSIDE the zip must be the
		// lane's own — the zip hash alone proves the container, this proves
		// the payload the helper will actually run.
		if err := VerifyZipEntry(dest, "hibana.exe", sums); err != nil {
			os.Remove(dest)
			return "", "", err
		}
	}
	// Housekeeping: the staging dir keeps exactly this asset (older staged
	// versions from prior rounds are stale the moment this one verifies).
	u.pruneStage(dir, asset.Name)
	u.LastVersion = rel.Version
	return dest, kind, nil
}

// pruneStage removes every other file in the staging dir (a failed prior
// download, an older version's zip — never the just-verified asset).
func (u *Updater) pruneStage(dir, keep string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() || e.Name() == keep || e.Name() == keep+".part" {
			continue
		}
		_ = os.Remove(filepath.Join(dir, e.Name()))
	}
}

// Apply spawns the detached helper that replaces the app AFTER it exits and
// relaunches it (apply_windows.go; apply_other.go keeps the non-Windows
// build/test lane honest with a plain error).
func (u *Updater) Apply(assetPath, kind string) error {
	exe, err := u.exePath()
	if err != nil {
		return err
	}
	return apply(assetPath, kind, exe, ReleasePageURL(u.Repo), os.Getpid())
}
