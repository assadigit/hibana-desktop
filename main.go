// hibana-desktop — the Hibana Kanban Windows desktop port (ADR-001:
// Go + Wails v2 + WebView2 + modernc.org/sqlite; the decision record lives in
// hibana-source docs/project-kanban/GO-DESKTOP-IMPLEMENTATION-GUIDE.md §0).
//
// M1+M2-groundwork scope (this build): the Wails shell bootstrap, the
// embedded board island (frontend/dist — a checksum-pinned snapshot of
// hibana-source @ WebRef), the bridge (internal/ui — ONE Request method),
// the cloud client (internal/api), the SQLite mirror (internal/store), and
// the first sync-loop milestone (internal/sync: pull with the ETag
// cheap-poll on focus/5-minute cadence; the outbox drain runs when the queue
// is non-empty).
package main

import (
	"context"
	"embed"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"

	"hibana/desktop/internal/api"
	"hibana/desktop/internal/auth"
	"hibana/desktop/internal/store"
	"hibana/desktop/internal/sync"
	"hibana/desktop/internal/ui"
)

// The two version stamps (hard rule 9: both versions on every release —
// the tag, the -X stamps, and the Release notes never diverge; one CI step
// derives all three). Overridden at build time:
//
//	wails build -platform windows/amd64 -ldflags \
//	  "-s -w -X main.Version=0.1.0 -X main.WebRef=e6661c8"
var (
	Version = "0.1.0-dev"
	WebRef  = "unpinned"
)

// The island: a checksum-pinned snapshot of the web /kanban board surface,
// synced from hibana-source at WebRef by scripts/sync-island.mjs — NEVER
// hand-edited (the drift check fails CI on any byte).
//
//go:embed all:frontend/dist
var assets embed.FS

// canonical development constants (contract §6: both hosts serve the
// identical app; the desktop presents the canonical origin on writes).
const (
	defaultBaseURL = "https://hibana.ir"
	appDirName     = "hibana"
	pullEvery      = 5 * time.Minute // contract §10: on focus + every 5 min + manual
)

func main() {
	dataDir, err := resolveDataDir()
	if err != nil {
		log.Fatalf("hibana: data dir: %v", err)
	}
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		log.Fatalf("hibana: creating data dir %s: %v", dataDir, err)
	}
	logsDir := filepath.Join(dataDir, "logs")
	_ = os.MkdirAll(logsDir, 0o755)
	logFile, err := os.OpenFile(filepath.Join(logsDir, "hibana.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		log.Printf("hibana: log file unavailable (%v) — logging to stderr only", err)
	} else {
		log.SetOutput(logFile)
		defer logFile.Close()
	}
	log.Printf("hibana %s (island pin %s), data dir %s", Version, WebRef, dataDir)

	// The cloud client — cookie jar, Origin stamping on writes (the T6 gate),
	// the ETag store; credentials NEVER cross the bridge (internal/ui).
	client, err := api.New(defaultBaseURL)
	if err != nil {
		log.Fatalf("hibana: %v", err)
	}

	// The SQLite mirror (modernc.org/sqlite — pure Go, no cgo; WAL +
	// foreign_keys per the proven Node adapter, DATA-MODEL §6).
	mirror, err := store.Open(filepath.Join(dataDir, "mirror.db"))
	if err != nil {
		log.Fatalf("hibana: mirror: %v", err)
	}
	defer mirror.Close()

	// Session restore. The login window itself is M2's pick-one decision
	// (guide §5.5); until it exists, a missing/dead session leaves the island
	// on its own auth-expiry state — the pull loop simply surfaces the 401.
	sessStore := &auth.FileStore{Path: filepath.Join(dataDir, "session.bin")}
	ctx0 := context.Background()
	live, err := auth.Restore(ctx0, client, sessStore)
	if err != nil {
		log.Printf("hibana: session restore: %v", err)
	}
	log.Printf("hibana: session %s", map[bool]string{true: "restored", false: "absent — login lands at M2"}[live])

	engine := sync.New(client, mirror)
	engine.SetRelogin(func(ctx context.Context) error {
		// M2 wires the real login window here; a silent relogin without stored
		// credentials is impossible by design (no secrets at rest, hard rule 1).
		return fmt.Errorf("relogin: no login window yet (M2)")
	})

	// The first sync-loop milestone: pull on startup, then every 5 minutes
	// (the on-focus + manual triggers join with the M2 shell events). The
	// outbox drain rides the same tick — FIFO, one in-flight, §10.
	syncCtx, syncCancel := context.WithCancel(ctx0)
	defer syncCancel()
	go syncLoop(syncCtx, engine)

	bridge := ui.New(client, Version, WebRef)

	err = wails.Run(&options.App{
		Title:            "Hibana Kanban",
		Width:            1600,
		Height:           900,
		MinWidth:         1100, // the board's 5-column grid breakpoint (UI-UX §2)
		MinHeight:        720,
		BackgroundColour: &options.RGBA{R: 255, G: 255, B: 255, A: 255}, // .db-frame is a var(--card) white surface
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId: "hibana-kanban-desktop",
			OnSecondInstanceLaunch: func(secondInstanceData options.SecondInstanceData) {
				// Second launch focuses the first window instead of forking a
				// second data-dir writer (the never-mix rule, WPP §1).
				log.Printf("hibana: second instance launched (%v) — focusing this one", secondInstanceData.Args)
			},
		},
		AssetServer: &assetserver.Options{
			Assets: assets,
			// The canonical entry contract: the island IS /kanban (board-page.js
			// resolves the entry state from location.pathname — isKanbanEntry()
			// board-page.js:28 — so the asset server aliases the route exactly
			// like the Worker does (app.ts:370-385). A bare "/" boot bounces
			// once via the island's own guard (:29) — by design, so the deep
			// link state matches the web app byte-for-byte.
			Middleware: func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if p := r.URL.Path; p == "/kanban" || p == "/kanban.html" || p == "/board.html" {
						r.URL.Path = "/"
					}
					next.ServeHTTP(w, r)
				})
			},
		},
		Bind: []interface{}{bridge},
		Windows: &windows.Options{
			WebviewIsTransparent: false,
			WindowIsTranslucent:  false,
		},
	})
	if err != nil {
		log.Fatalf("hibana: wails: %v", err)
	}
}

// syncLoop is the pull cadence (§10): startup + every 5 minutes; each round
// refreshes the projects list, pulls every mirrored board (304s are one
// header), and drains the outbox when it has entries.
func syncLoop(ctx context.Context, engine *sync.Engine) {
	round := func() {
		pulled, errs := engine.SyncOnce(ctx)
		if len(errs) > 0 {
			for _, err := range errs {
				log.Printf("hibana sync: %v", err)
			}
		}
		res, err := engine.Drain(ctx)
		if err != nil {
			log.Printf("hibana sync: drain: %v", err)
		}
		if res.Done > 0 || res.Dropped > 0 || res.Held > 0 {
			log.Printf("hibana sync: round done (boards pulled: %d, outbox done/dropped/held: %d/%d/%d)", pulled, res.Done, res.Dropped, res.Held)
		}
	}
	round() // startup pull
	t := time.NewTicker(pullEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			round()
		}
	}
}

// resolveDataDir implements the never-mix data rule (WPP §1): portable mode
// is chosen by --portable OR a zero-byte portable.marker next to the exe →
// .\data\; otherwise the OS data dir (%LOCALAPPDATA%\hibana\ on Windows).
// The choice locks into mode.lock on first launch and the lock WINS on every
// later launch — the app never silently migrates between profiles.
func resolveDataDir() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	exeDir := filepath.Dir(exe)
	portableFlag := false
	for _, a := range os.Args[1:] {
		if a == "--portable" {
			portableFlag = true
		}
	}
	_, markerErr := os.Stat(filepath.Join(exeDir, "portable.marker"))
	portableNow := portableFlag || markerErr == nil

	osDir := os.UserConfigDir // %LOCALAPPDATA% on Windows, ~/.config elsewhere
	if runtime.GOOS == "windows" {
		// WPP §8: %LOCALAPPDATA%\hibana\ (the plan's canonical installed path).
		if la := os.Getenv("LOCALAPPDATA"); la != "" {
			osDir = func() (string, error) { return filepath.Join(la, appDirName), nil }
		}
	}

	installedDir := func() (string, error) {
		base, err := osDir()
		if err != nil {
			return "", err
		}
		if runtime.GOOS == "windows" {
			return filepath.Join(base, appDirName), nil
		}
		return filepath.Join(base, appDirName), nil
	}

	lockPath := ""
	candidate := ""
	if portableNow {
		candidate = filepath.Join(exeDir, "data")
		lockPath = filepath.Join(candidate, "mode.lock")
	} else {
		d, err := installedDir()
		if err != nil {
			return "", err
		}
		candidate = d
		lockPath = filepath.Join(candidate, "mode.lock")
	}
	if err := os.MkdirAll(candidate, 0o755); err != nil {
		return "", err
	}

	// The lock wins: a recorded choice is never silently overridden.
	if b, err := os.ReadFile(lockPath); err == nil {
		switch strings.TrimSpace(string(b)) {
		case "portable":
			return filepath.Join(exeDir, "data"), nil
		case "installed":
			return installedDir()
		}
	}
	mode := "installed"
	if portableNow {
		mode = "portable"
	}
	if err := os.WriteFile(lockPath, []byte(mode), 0o600); err != nil {
		return "", err
	}
	return candidate, nil
}
