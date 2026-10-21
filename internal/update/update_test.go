package update

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseVersion(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want [3]int
		ok   bool
	}{
		{in: "0.1.14", want: [3]int{0, 1, 14}, ok: true},
		{in: "v0.1.14", want: [3]int{0, 1, 14}, ok: true},
		{in: "v0.1.14-desktop", want: [3]int{0, 1, 14}, ok: true},
		{in: "0.1.14-dev", want: [3]int{0, 1, 14}, ok: true},
		{in: "1.2.3+meta", want: [3]int{1, 2, 3}, ok: true},
		{in: "2.0", want: [3]int{2, 0, 0}, ok: true},
		{in: "10.20.30", want: [3]int{10, 20, 30}, ok: true},
		{in: "", ok: false},
		{in: "garbage", ok: false},
		{in: "0.x.1", ok: false},
		{in: "-1.2.3", ok: false},
		{in: "0.1.14.15.16.17", ok: false},
		{in: "v0.1.14-desktop", want: [3]int{0, 1, 14}, ok: true},
	} {
		got, ok := ParseVersion(tc.in)
		if ok != tc.ok {
			t.Errorf("ParseVersion(%q) ok = %v, want %v", tc.in, ok, tc.ok)
			continue
		}
		if ok && got != tc.want {
			t.Errorf("ParseVersion(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

func TestIsNewer(t *testing.T) {
	for _, tc := range []struct {
		latest, current string
		want            bool
	}{
		{"0.1.14", "0.1.13", true},
		{"0.2.0", "0.1.99", true},
		{"1.0.0", "0.9.9", true},
		{"0.1.13", "0.1.13", false}, // equal is never newer — dev builds don't self-update
		{"v0.1.14-desktop", "0.1.13", true},
		{"v0.1.13-desktop", "0.1.13-dev", false},
		{"0.1.12", "0.1.13", false},
		{"garbage", "0.1.13", false}, // fail closed both ways
		{"0.1.14", "garbage", false},
		{"", "0.1.13", false},
	} {
		if got := IsNewer(tc.latest, tc.current); got != tc.want {
			t.Errorf("IsNewer(%q, %q) = %v, want %v", tc.latest, tc.current, got, tc.want)
		}
	}
}

// ghFixture is a minimal GitHub release JSON served by the test's httptest
// server — the API response shape FetchLatest parses.
func ghFixture(tag string, assets []ghAsset) map[string]any {
	return map[string]any{
		"tag_name":     tag,
		"body":         "Desktop " + tag + " — auto-release: every update to main ships a release.",
		"published_at": "2026-10-21T00:00:00Z",
		"prerelease":   false,
		"draft":        false,
		"assets":       assets,
	}
}

func assetFixture(name string, size int64, url string) ghAsset {
	return ghAsset{Name: name, Size: size, BrowserDownloadURL: url}
}

func TestFetchLatestClassifiesAssets(t *testing.T) {
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/assadigit/hibana-desktop/releases/latest" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(ghFixture("v0.1.14-desktop", []ghAsset{
			assetFixture("hibana-amd64-installer.exe", 9200000, srv.URL+"/dl/hibana-amd64-installer.exe"),
			assetFixture("hibana.exe", 17600000, srv.URL+"/dl/hibana.exe"),
			assetFixture("hibana-portable-0.1.14.zip", 7560000, srv.URL+"/dl/hibana-portable-0.1.14.zip"),
			assetFixture("checksums.txt", 300, srv.URL+"/dl/checksums.txt"),
		}))
	}))
	defer srv.Close()
	old := apiBase
	apiBase = srv.URL
	defer func() { apiBase = old }()

	rel, err := FetchLatest(context.Background(), nil, "assadigit/hibana-desktop")
	if err != nil {
		t.Fatalf("FetchLatest: %v", err)
	}
	if rel.Version != "0.1.14" {
		t.Errorf("rel.Version = %q, want 0.1.14 (the -desktop suffix normalizes away)", rel.Version)
	}
	if rel.Installer == nil || rel.Installer.Name != "hibana-amd64-installer.exe" {
		t.Errorf("rel.Installer misclassified: %+v", rel.Installer)
	}
	if rel.Portable == nil || rel.Portable.Name != "hibana-portable-0.1.14.zip" {
		t.Errorf("rel.Portable misclassified: %+v", rel.Portable)
	}
	if rel.Checksums == nil || rel.Checksums.Name != "checksums.txt" {
		t.Errorf("rel.Checksums misclassified: %+v", rel.Checksums)
	}
	// The raw hibana.exe asset must not classify as ANY update kind: the
	// release page carries it as a convenience download only — a wrong
	// regex would make the updater try to "self-replace" with a bare exe
	// asset that carries no archive layout at all.
	if got, _, _ := PickAsset(rel); got != nil && got.Name == "hibana.exe" {
		t.Errorf("the raw hibana.exe asset must never be picked as an update asset")
	}
}

func TestPickAssetPrefersPortable(t *testing.T) {
	rel := &Release{Version: "0.1.14"}
	if _, _, ok := PickAsset(rel); ok {
		t.Errorf("PickAsset(empty) must offer nothing")
	}
	rel.Installer = &Asset{Name: "hibana-amd64-installer.exe", Size: 1}
	if a, k, ok := PickAsset(rel); !ok || k != KindInstaller || a.Name != rel.Installer.Name {
		t.Errorf("PickAsset(installer only) = %+v/%q/%v, want the installer", a, k, ok)
	}
	rel.Portable = &Asset{Name: "hibana-portable-0.1.14.zip", Size: 2}
	if a, k, ok := PickAsset(rel); !ok || k != KindPortable || a.Name != rel.Portable.Name {
		t.Errorf("PickAsset(both) = %+v/%q/%v, want the zip preferred over the wizard", a, k, ok)
	}
	if _, _, ok := PickAsset(nil); ok {
		t.Errorf("PickAsset(nil) must offer nothing")
	}
}

func TestParseChecksums(t *testing.T) {
	// exactly 64 hex chars per sum (the parser is length-strict on purpose:
	// a stray short token must never masquerade as a digest).
	const a = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111" // 64
	const b = "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222" // 64
	const c = "cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333" // 64
	if len(a) != 64 || len(b) != 64 || len(c) != 64 {
		t.Fatalf("fixture discipline: the sums must be 64 hex chars")
	}
	body := a + "\n" +
		b + "  hibana-portable-0.1.14.zip\n" +
		c + " *hibana.exe\n" +
		"\n# a comment line\n" +
		"garbage line with no hash\n"
	sums := ParseChecksums(body)
	// a 64-hex line with NO filename has 1 field — skipped, not fatal.
	if len(sums) != 2 {
		t.Errorf("expected exactly the 2 named sums to parse, got %d: %v", len(sums), sums)
	}
	if got := sums["hibana-portable-0.1.14.zip"]; got != b {
		t.Errorf("sha256sum form parsed wrong: %q", got)
	}
	if got := sums["hibana.exe"]; got != c {
		t.Errorf("Get-FileHash * form parsed wrong: %q", got)
	}
}

func shaHex(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func TestVerifyFileFailsClosed(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "hibana-portable-0.1.14.zip")
	content := []byte("the zip bytes")
	if err := os.WriteFile(p, content, 0o644); err != nil {
		t.Fatal(err)
	}
	sums := map[string]string{"hibana-portable-0.1.14.zip": shaHex(content)}
	if err := VerifyFile(p, "hibana-portable-0.1.14.zip", sums); err != nil {
		t.Errorf("VerifyFile(matching) failed: %v", err)
	}
	tampered := map[string]string{"hibana-portable-0.1.14.zip": strings.Repeat("f", 64)}
	if err := VerifyFile(p, "hibana-portable-0.1.14.zip", tampered); err == nil {
		t.Errorf("VerifyFile(mismatch) must fail closed")
	}
	if err := VerifyFile(p, "checksums-omitted.zip", sums); err == nil {
		t.Errorf("VerifyFile(missing line) must fail closed — a release whose checksums.txt omits its own asset is an anomaly")
	}
}

// buildTestZip assembles a real portable zip (hibana.exe + PORTABLE.md —
// make-portable.ps1's own layout) and returns the archive bytes + the exe
// entry bytes.
func buildTestZip(t *testing.T) (zipBytes, exeBytes []byte) {
	exeBytes = bytes.Repeat([]byte("MZ\x90\x00hibana-binary"), 40000)
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create("hibana.exe")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(exeBytes); err != nil {
		t.Fatal(err)
	}
	w2, err := zw.Create("PORTABLE.md")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w2.Write([]byte("# Portable Hibana")); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes(), exeBytes
}

func TestVerifyZipEntry(t *testing.T) {
	zipBytes, exeBytes := buildTestZip(t)
	dir := t.TempDir()
	p := filepath.Join(dir, "hibana-portable-0.1.14.zip")
	if err := os.WriteFile(p, zipBytes, 0o644); err != nil {
		t.Fatal(err)
	}
	sums := map[string]string{"hibana.exe": shaHex(exeBytes)}
	if err := VerifyZipEntry(p, "hibana.exe", sums); err != nil {
		t.Errorf("VerifyZipEntry(matching) failed: %v", err)
	}
	wrong := map[string]string{"hibana.exe": strings.Repeat("0", 64)}
	if err := VerifyZipEntry(p, "hibana.exe", wrong); err == nil {
		t.Errorf("VerifyZipEntry(tampered payload) must fail closed")
	}
	if err := VerifyZipEntry(p, "hibana.exe", map[string]string{}); err == nil {
		t.Errorf("VerifyZipEntry(no checksums line) must fail closed")
	}
	// An archive that carries no hibana.exe at all: fail closed too.
	var nb bytes.Buffer
	zw := zip.NewWriter(&nb)
	if _, err := zw.Create("PORTABLE.md"); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	p2 := filepath.Join(dir, "hibana-portable-empty.zip")
	if err := os.WriteFile(p2, nb.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := VerifyZipEntry(p2, "hibana.exe", sums); err == nil {
		t.Errorf("VerifyZipEntry(no entry) must fail closed")
	}
}

func TestDownloadRelaysProgressAndNeverLeavesAPart(t *testing.T) {
	payload := bytes.Repeat([]byte("z"), 700<<10) // 700KB → ≥2 progress ticks
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", fmt.Sprint(len(payload)))
		_, _ = w.Write(payload)
	}))
	defer srv.Close()
	dest := filepath.Join(t.TempDir(), "asset.zip")
	var ticks []Progress
	n, err := Download(context.Background(), srv.Client(), srv.URL+"/asset.zip", dest, int64(len(payload)),
		func(p Progress) { ticks = append(ticks, p) })
	if err != nil {
		t.Fatalf("Download: %v", err)
	}
	if n != int64(len(payload)) {
		t.Errorf("Download received %d, want %d", n, len(payload))
	}
	got, err := os.ReadFile(dest)
	if err != nil || !bytes.Equal(got, payload) {
		t.Fatalf("the downloaded bytes diverge: %v", err)
	}
	if len(ticks) < 2 {
		t.Errorf("expected ≥2 progress ticks, got %d", len(ticks))
	}
	if last := ticks[len(ticks)-1]; last.Pct != 100 || last.Received != int64(len(payload)) {
		t.Errorf("the final tick must land 100%%: %+v", last)
	}
	for i := 1; i < len(ticks); i++ {
		if ticks[i].Received < ticks[i-1].Received {
			t.Errorf("progress went backwards: %+v then %+v", ticks[i-1], ticks[i])
		}
	}
	if _, err := os.Stat(dest + ".part"); !os.IsNotExist(err) {
		t.Errorf("a .part must never survive a finished download")
	}

	// A mid-stream death must leave NO partial masquerading as the asset.
	srv2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(payload[:100])
		panic(http.ErrAbortHandler) // hard-close mid-body
	}))
	defer srv2.Close()
	dest2 := filepath.Join(filepath.Dir(dest), "died.zip")
	if _, err := Download(context.Background(), srv2.Client(), srv2.URL+"/asset.zip", dest2, int64(len(payload)), nil); err == nil {
		t.Errorf("a severed download must error")
	}
	if _, err := os.Stat(dest2); !os.IsNotExist(err) {
		t.Errorf("a severed download must leave no finished asset")
	}
	if _, err := os.Stat(dest2 + ".part"); !os.IsNotExist(err) {
		t.Errorf("a severed download must clean its .part")
	}
}

// newUpdateServer serves a complete fake GitHub: the API fixture at
// /repos/.../releases/latest, the asset bytes, and checksums.txt — the
// exact topography of the real lane's release. The _current param documents
// which version the fake lane "cut"; every release here is 0.1.14.
func newUpdateServer(t *testing.T, current string) (url string, zipBytes []byte) {
	t.Helper()
	zipBytes, exeBytes := buildTestZip(t)
	checksumsBody := shaHex(zipBytes) + "  hibana-amd64-installer.exe\n" +
		shaHex(exeBytes) + "  hibana.exe\n" +
		shaHex(zipBytes) + "  hibana-portable-0.1.14.zip\n"
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/repos/assadigit/hibana-desktop/releases/latest":
			_ = json.NewEncoder(w).Encode(ghFixture("v0.1.14-desktop", []ghAsset{
				assetFixture("hibana-amd64-installer.exe", int64(len(zipBytes)), srv.URL+"/dl/hibana-amd64-installer.exe"),
				assetFixture("hibana-portable-0.1.14.zip", int64(len(zipBytes)), srv.URL+"/dl/hibana-portable-0.1.14.zip"),
				assetFixture("checksums.txt", int64(len(checksumsBody)), srv.URL+"/dl/checksums.txt"),
			}))
		case r.URL.Path == "/dl/hibana-portable-0.1.14.zip" || r.URL.Path == "/dl/hibana-amd64-installer.exe":
			w.Header().Set("Content-Length", fmt.Sprint(len(zipBytes)))
			_, _ = w.Write(zipBytes)
		case r.URL.Path == "/dl/checksums.txt":
			_, _ = w.Write([]byte(checksumsBody))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv.URL, zipBytes
}

func TestUpdaterCheck(t *testing.T) {
	url, _ := newUpdateServer(t, "0.1.13")
	old := apiBase
	apiBase = url
	defer func() { apiBase = old }()

	u := &Updater{Repo: "assadigit/hibana-desktop", Current: "0.1.13", DataDir: t.TempDir()}
	res, err := u.Check(context.Background())
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if !res.Available {
		t.Fatalf("Check must report available for 0.1.14 over 0.1.13: %+v", res)
	}
	if res.Latest != "0.1.14" || res.Current != "0.1.13" {
		t.Errorf("Check versions: %+v", res)
	}
	if res.Kind != KindPortable {
		t.Errorf("Check kind = %q, want portable (the zip is preferred)", res.Kind)
	}
	if res.Size <= 0 || res.URL == "" {
		t.Errorf("Check must carry the asset size + the release page url: %+v", res)
	}

	// The running version is the latest → not available, no error.
	u2 := &Updater{Repo: "assadigit/hibana-desktop", Current: "0.1.14", DataDir: t.TempDir()}
	res2, err := u2.Check(context.Background())
	if err != nil || res2.Available {
		t.Errorf("Check(0.1.14 running) = %+v, %v — must be not-available, nil error", res2, err)
	}

	// GitHub unreachable → an ERROR (the caller logs; the island stays quiet).
	u3 := &Updater{Repo: "assadigit/hibana-desktop", Current: "0.1.13", DataDir: t.TempDir()}
	apiBase = "http://127.0.0.1:1"
	if _, err := u3.Check(context.Background()); err == nil {
		t.Errorf("Check against an unreachable api must error, never claim no-update")
	}
}

func TestUpdaterPrepareVerifiesAndStages(t *testing.T) {
	url, zipBytes := newUpdateServer(t, "0.1.13")
	old := apiBase
	apiBase = url
	defer func() { apiBase = old }()

	data := t.TempDir()
	u := &Updater{Repo: "assadigit/hibana-desktop", Current: "0.1.13", DataDir: data}
	var ticks []Progress
	assetPath, kind, err := u.Prepare(context.Background(), func(p Progress) { ticks = append(ticks, p) })
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if kind != KindPortable {
		t.Errorf("Prepare kind = %q, want portable", kind)
	}
	if filepath.Dir(assetPath) != filepath.Join(data, "updates") {
		t.Errorf("Prepare staged at %q — the DATA dir owns the staging", assetPath)
	}
	got, err := os.ReadFile(assetPath)
	if err != nil || !bytes.Equal(got, zipBytes) {
		t.Fatalf("the staged asset diverges: %v", err)
	}
	var sawVerify bool
	for _, p := range ticks {
		if p.Stage == "verify" {
			sawVerify = true
		}
	}
	if !sawVerify {
		t.Errorf("Prepare must relay a verify stage tick (the modal names the step)")
	}

	// A tampered checksums.txt (the zip line falsified) must fail closed and
	// leave no staged asset.
	var srv2 *httptest.Server
	srv2 = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/repos/assadigit/hibana-desktop/releases/latest":
			_ = json.NewEncoder(w).Encode(ghFixture("v0.1.14-desktop", []ghAsset{
				assetFixture("hibana-portable-0.1.14.zip", int64(len(zipBytes)), srv2.URL+"/dl/hibana-portable-0.1.14.zip"),
				assetFixture("checksums.txt", 10, srv2.URL+"/dl/checksums.txt"),
			}))
		case r.URL.Path == "/dl/hibana-portable-0.1.14.zip":
			_, _ = w.Write(zipBytes)
		case r.URL.Path == "/dl/checksums.txt":
			_, _ = w.Write([]byte(strings.Repeat("0", 64) + "  hibana-portable-0.1.14.zip\n" +
				strings.Repeat("0", 64) + "  hibana.exe\n"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv2.Close()
	apiBase = srv2.URL
	data2 := t.TempDir()
	u2 := &Updater{Repo: "assadigit/hibana-desktop", Current: "0.1.13", DataDir: data2}
	if _, _, err := u2.Prepare(context.Background(), nil); err == nil {
		t.Fatalf("Prepare must fail closed on a tampered checksum")
	}
	entries, _ := os.ReadDir(filepath.Join(data2, "updates"))
	if len(entries) != 0 {
		t.Errorf("a failed Prepare must clean its staged asset (found %d files)", len(entries))
	}
}

func TestUpdaterPrepareNoUpdateFails(t *testing.T) {
	url, zipBytes := newUpdateServer(t, "0.1.14")
	old := apiBase
	apiBase = url
	defer func() { apiBase = old }()
	// The running version IS the latest — Prepare must refuse to stage.
	u := &Updater{Repo: "assadigit/hibana-desktop", Current: "0.1.14", DataDir: t.TempDir()}
	if _, _, err := u.Prepare(context.Background(), nil); err != ErrNoUpdate {
		t.Errorf("Prepare(0.1.14 running) err = %v, want ErrNoUpdate", err)
	}
	_ = zipBytes // the fixture ships the asset anyway; the refusal happens before the download
}

func TestApplyStubFailsLoudlyOffWindows(t *testing.T) {
	// On the Linux test ladder the stub must error (never a fake success);
	// on Windows this test is vacuous — the real apply's surface is probed
	// by the vet/build lane, and the PE needles by the release verification.
	if err := apply("/tmp/asset.zip", KindPortable, "/tmp/hibana.exe", 42); err == nil {
		t.Errorf("the non-Windows apply stub must error, never pretend it applied")
	}
}

func TestProgressTickPacing(t *testing.T) {
	// progressStep sized so a 5-8MB asset produces ~20-30 ticks — smooth bar,
	// no IPC flood. A contract pin, not a runtime test.
	if progressStep != 256<<10 {
		t.Errorf("progressStep = %d, want %d", progressStep, 256<<10)
	}
	if checkTimeout <= 0 || downloadTimeout <= 0 {
		t.Errorf("the check/download deadlines must be positive")
	}
}
