# hibana-desktop

The **Hibana Kanban Windows desktop port** — a Go + [Wails v2](https://wails.io) + WebView2 +
`modernc.org/sqlite` application that replicates the web kanban at
[`hibana.ir/kanban`](https://hibana.ir/kanban) (or `projects.hibana.ir/kanban`) with
offline support, sharing the same cloud data over the same API.

The full specification pack lives in the web repo:
[`assadigit/hibana-source` → `docs/project-kanban/`](https://github.com/assadigit/hibana-source/tree/main/docs/project-kanban)
(ten documents; the operator's manual is `GO-DESKTOP-IMPLEMENTATION-GUIDE.md`).
This repo is the **build** — the decision record is ADR-001 in that guide.

## Status (M1 + M2, sessions S211–S227)

| Milestone (port plan §8) | State |
|---|---|
| **M0** — Worker contract hardening (`API-AND-SYNC-CONTRACT.md` §7a-7e) | **NOT STARTED — awaiting the owner's go** (it is hibana-source work, not this repo; this build targets the already-deployed contract) |
| **M1** — Go API client + auth, no UI | **DONE + live-accepted** (`cmd/acceptance`: login → pull 2 boards → create/move/archive → verified via the web client's API, against prod, self-cleaning) |
| **M2** — the Wails shell + read-only board | **groundwork done + the login-first boot landed (v0.1.1) + the v0.1.2 dogfood fixes + the v0.1.3 tray + the v0.1.5 dark mode + the v0.1.6 sync button**: a live stored session boots straight to the board; otherwise the island-rendered sign-in card opens first — the WEB LOGIN PAGE'S OWN SPLIT LAYOUT (the Login.webp photo panel) (guide §5.5's pick) — sign in against hibana.ir, the kanban loads; a mid-session 401 reopens the card and a re-login wakes the outbox's retry-once. The S214 minimize-to-tray option (notification-area icon, ✕-hides-to-tray with a persisted toggle, second-launch restore) landed in v0.1.3; the S216 dark-mode round (the web's own claude-dark look + light, a persisted ui.theme preference, toggle surfaces on the board toolbar, the sign-in card, and the tray's Theme submenu, zero-JS first paint, follows-the-OS 'system' default) landed in v0.1.5; the S217 manual-sync round (a physical, visible Sync button in the board toolbar whose modal proves the round live — connecting to the Cloudflare server > upload > sync > the 'Everything synced — will not vanish' success panel, honest outcome codes, EN/FA + RTL-native) landed in v0.1.6; the S220 visibility round (the owner: "There is still No Sync button" — the v0.1.6 ghost icon did not read as one) landed in v0.1.8: the Sync button is now a LABELED, FILL-COLORED CTA pill right after Labels (the bare-button solid-primary grammar, theme-native teal/terracotta, EN/FA label), and Sprints + Labels are twin-sized (the <a> vs <button> box divergence normalized — all three 41px). The S221 sign-out round (the owner: "It must also have option of logout and enter with a new account") landed in v0.1.9: a LABELED ghost **Sign out** button closes the toolbar row (the pin's own nav.signout label, twin-sized with its neighbors), a native confirm dialog (S186 bare-button CTA) guards the click, and ui.API.Logout — the §5.5 login surface's counterpart — kills the server session best-effort, then the cookie + the ETag cache + the session file + the mirror's account-scoped rows together (the theme + close-to-tray device prefs survive); the reload opens the login card at first paint, where signing in with a NEW account boots its kanban. The S228 SETTINGS PAGE (the owner ask: "Plan for a settings page for hibana's desktop" — docs/SETTINGS-PAGE-PLAN.md) landed in v0.1.17: a ghost gear in the toolbar's account zone (between the theme toggle and Sign out) opens ONE wide native sheet with the owner's four sections in order — **1. Sync** (the cadence copy + a Sync-now CTA that delegates to the proven sync modal), **2. Update app** (the AppInfo version line `Hibana 0.1.16 · island e6661c8 (v0.4.1.35)`, the manual Check-for-updates verdict paint over the untouched boot+2h loop — none/available/busy/unreachable each honest, the revealed Update-now delegating to the proven update modal), **3. Account** (the AuthState identity line + the Sign-out delegation to the existing confirm), and **4. Appearance** (the Language segmented control `English | فارسی` through the round's ONE new Go binding — **SetLanguage** (internal/ui/settings.go): a `{en,fa}` allow-list, PATCH /api/settings Go-side through the same session/Origin machinery, the a.me snapshot un-staled under the same mutex AuthState reads, the `hibana:lang` emit; the live chrome flip (html[lang]/dir + hibanaI18n.apply()) then a ~700ms reload so the BOARD re-renders in the new language, offline resolving `{ok:false}` honestly — plus the Theme segmented control `Light | Dark | System` through the existing SetTheme with the tray's full 3-state vocabulary). Serve-time lang/dir stamping (InjectShellState's new lang param — `<html lang dir data-desktop-lang>` from the live session) kills the EN/LTR first-paint flash every FA boot had since v0.1.0. The v0.1.18 update-dogfood round (the owner: "got this error: Update failed — update: apply: spawning the helper: exec: \"powershell.exe\": executable file not found in %PATH% — update button appeared but didn't work" + "hibana desktop might be a private repo so in setting, add a github credentials so it can connect to the private repo") closed BOTH halves: (1) THE HELPER RESOLUTION — the new internal/winshell package resolves PowerShell by its CANONICAL ABSOLUTE PATH first (%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe, the C:\Windows hardcode, PowerShell 7's pwsh.exe — the PATH lookup LAST), shared by the update apply AND the quick-access .lnk writer, because the dogfooded machine's stripped PATH killed a swap its healthy PowerShell could have finished; a machine with no interpreter at all now gets the honest error naming the staged zip AND the release page for a manual finish; (2) THE GITHUB-ACCESS ROW — the settings sheet's Update-app section gains a PASSWORD field + Save/Remove over two new Go bindings (SetGithubToken / GithubTokenState over internal/update.TokenStore — the SAME data dir + repo the shell's Updater reads, one token file, one truth): the user's PAT is stored in the DATA dir (github-token, 0600 — the session.bin never-mix rule, survives every self-replace), rides EVERY release request as a Bearer header through one shared ghRequest (the check + the asset download + the checksums fetch — anonymous stays the byte-identical default, the repo being public; the token covers the private flip and lifts the anonymous 60/hr shared-IP budget to 5000/hr), is VERIFIED on save (200 → saved+verified · 401 → nothing saved · 404 → nothing saved · unreachable/403/5xx → saved with the honest saved-unverified note), crosses the JS↔Go bridge exactly ONCE (only the ghp_…ABCD hint ever crosses back), and a SAVED token immediately re-checks through the manual-check flow's own handler — the owner's connect-now ask; the field never keeps the secret (cleared on every resolve, Enter saves instead of submitting the dialog form). The v0.1.19 follow-up (the owner: "Yes add a test connection. also auto-open release page when an apply fails") closed both asks: (1) THE TEST BUTTON — the GitHub-access row gains a third control over one new Go binding (**TestGithubConnection** — a PURE READ: one cheap `GET /repos/<repo>` riding the same Bearer header the update rounds send, with the field's typed value when one is present, else the STORED token, else the honest anonymous round — the exact credential mix the next release check would ride; NOTHING is ever written and no re-check fires): the verdict matrix resolves `{ok, code, using, hint}` — verified/typed ("GitHub accepted the token — the repository is visible."), verified/saved ("The saved token works…"), verified/anonymous ("the repository is public — no token needed."), 401/typed, 401/saved (the SAVED token was revoked — remove or replace it), 404-with-token, and the owner's exact private-repo signal: the ANONYMOUS 404 ("GitHub can't see the repository without credentials — if it's private, save a token with access."), all EN/FA; the field KEEPS its value through a test (only Save clears — the value stays for the Save click the verdict invites); (2) THE RELEASE-PAGE REFLEX — every FAILED apply verdict (a download that died, a checksum refusal, the no-interpreter error, the honest timeout) now opens the release's human page in the SYSTEM BROWSER through the bridge's new SetUpdateOpenURL hook (main.go: wailsruntime.BrowserOpenURL — busy and no-update are NOT failures and open nothing), and the resolve carries `{pageOpened:true}` so the modal's new `#db-update-fallback` line ("The release page opened in your browser — you can download and install this version by hand." / the FA twin) paints ONLY when the open actually happened — a machine where it could not never hears that it did.  The v0.1.21 SYNC-BADGE round (the owner: the same kanban on both — the web's hibana-sync-status-spec.md, mirrored): the island moved to hibana-source 7a3198b (web v0.4.1.37), carrying the PER-CARD SYNC BADGE onto the desktop board — every card's meta row ends with the state symbol at the inline-end (RTL-native: pending = cloud-up teal, syncing = the Sync glyph rotating past 500ms, synced = cloud-check muted, failed = a danger Retry pill whose click re-sends ONLY that card; hover/focus labels + aria names; no taller cards; reduced-motion stills every animation), and the toolbar's SYNC BUTTON wears the COUNT badge (pending + failed, from the SAME island tracker the cards paint from — one source, hidden at zero; the icon rotates while the round runs or any card is mid-sync). HONEST DEVIATION, recorded in desktop-sync.js's header: the spec's “pressing Sync moves all pending/failed cards to Syncing” is deliberately NOT done — this round pulls boards + drains the outbox and does NOT re-send a failed live board edit (only the card's own Retry pill does), so claiming “syncing” for those cards would promise an ack the round never seeks. PROOF: island --check green 66 files at the new pin; ALL EIGHT probes green on the new island bytes (login, logout, newproject, settings — its version-line pin made DYNAMIC off web-ref.json + wails.json, closing the stale-stub class — soundfx, update, completefacts, refresh) — ZERO regressions; no Go file touched (the Windows lane's Go suite is unchanged; CI runs it on push). The windowed side-by-side pixel acceptance still needs the owner's dogfooding on a real Windows host |
| M3-M5 | not started (outbox drain engine exists + is table-tested; the offline mutation UI, media pipeline, installer + auto-update follow) |

## Layout

```
main.go                     bootstrap: window (1600×900, min 1100×720), single-instance,
                            portable-mode data dir + mode.lock (the never-mix rule),
                            embed.FS island, /kanban asset alias, the 5-minute pull loop,
                            the close-to-tray contract (OnBeforeClose + the tray goroutine
                            + the persisted ui.hide_on_close preference, S214), the theme
                            wiring (the ui.theme meta row, the hibana:theme emit, the
                            boot-frame background, S216), the manual-sync wiring (the
                            hibana:sync-progress relay + the session-outcome card reopen, S217),
                            the sign-out wiring (the onLogout mirror wipe with the
                            device-pref keep-list — ui.theme + ui.hide_on_close survive a
                            sign-out, S221)
theme_windows.go            the boot background: AppsUseLightTheme via pure advapi32
                            syscalls — 'system' paints the frame before the WebView
theme_other.go              the non-Windows stub (vet/test/cross-build from Linux)
trayicon.go                 the embedded build/windows/icon.ico bytes the tray tile wears
internal/tray/              the notification-area icon: pure user32/shell32 syscalls —
                            + the Theme submenu (Light/Dark/Follow system, radio-checked, S216) —
internal/ui/sync.go         the SyncNow binding: single-flight busy guard, the 10-minute
                            deadline (the relogin cap), the transition relay (S217)
                            Shell_NotifyIcon + a hidden window, CreateIconFromResourceEx
                            on the embedded ICO, TPM_RETURNCMD menu (Open / toggle / Quit),
                            TaskbarCreated re-add; pure logic split out + tested
internal/api/               the cloud client: cookie jar, Origin stamping on writes (T6),
                            ETag cheap-poll (If-None-Match), 3s+1-retry GET contract,
                            rate-bucket pacing, typed board/task/project calls
internal/auth/              login + session restore (FileStore now; DPAPI at rest is M5)
internal/store/             the SQLite mirror (modernc.org/sqlite — pure Go): DDL verbatim
                            from DATA-MODEL.md §6, WAL + foreign_keys, outbox + meta +
                            7-day deletion-shadow tables, migration bookkeeping,
                            ResetAccount — the logout wipe (account rows + pull cursors,
                            caller-kept device prefs, S221)
internal/sync/              the engine: projects/board pulls → mirror; the outbox drain
                            with the §10 status-code table (401-relogin-once, 404/409
                            drop, 429 window, 5xx ≤5 dead-letter, transport = hold)
internal/ui/                the JS↔Go bridge: ONE bound Request method + the §5.5 login
                            surface (Login/AuthState — the card's credentials cross
                            ONCE for the login POST; the cookie never returns to JS) +
                            its Logout counterpart (best-effort server kill → cookie +
                            ETag cache + session file + mirror wipe together → silent
                            state flip; the island reloads into the gate, S221) + the
                            SetLanguage binding (the settings round's one new
                            capability: {en,fa} allow-list, PATCH /api/settings
                            Go-side, the a.me un-stale, the hibana:lang emit, S228),
                            method/path allow-lists, 7MB body cap, and the
                            IndexMiddleware that serves index.html with the live
                            auth state + theme + language on the <html> tag
                            (first-paint card visibility, zero-JS look, FOUC-free
                            lang/dir — S216 + S228)
frontend/dist/              THE ISLAND — a checksum-pinned snapshot of the web /kanban
                            board surface + the desktop-owned login layer (js/desktop-login.js,
                            css/desktop-login.css, the gate markup) + the theme/sync/
                            sign-out/new-project/refresh/sound/update/settings layers
                            (js/desktop-theme.js, js/desktop-sync.js + css/desktop-sync.css,
                            js/desktop-logout.js + css/desktop-logout.css, js/desktop-newproject.js,
                            js/desktop-refresh.js, js/desktop-audio.js, js/desktop-update.js,
                            js/desktop-settings.js + css/desktop-settings.css — the wide
                            four-section settings sheet + its controller, S228)
                            — all generated by scripts/sync-island.mjs. NEVER hand-edit; re-sync instead.
scripts/sync-island.mjs     the island sync: content-addressed reads from hibana-source
                            at the pinned ref, the strip list, the 12 seam patches,
                            checksums + --check drift mode
cmd/acceptance/             THE M1 acceptance round-trip (live, env-only credentials,
                            self-cleaning throwaway project)
build/windows/              versioninfo + icon (wails build consumes these)
installer/hibana.nsi        the NSIS installer spec (M5 — per-user, leaves-no-residue)
scripts/make-portable.ps1   hibana.exe + docs/PORTABLE.md → hibana-portable-<ver>.zip
.github/workflows/desktop.yml  the CI: island drift check, vet+test, dual artifact build
```

## The island pin (the parity contract)

`frontend/web-ref.json` records the sealed web ref this island was synced from —
**`e6661c8` / `v0.4.1.35`**. The CI's `sync-island.mjs --check` FAILS if the island
drifts from the pin; moving the island = bump the pin consts in the script, re-sync,
release. Both versions (desktop semver + web ref) are stamped into the binary:

```bash
wails build -platform windows/amd64 \
  -ldflags "-s -w -X main.Version=0.1.2 -X main.WebRef=e6661c8"
```

A plain-Go cross-build from Linux works too (the Windows target is cgo-free):

```bash
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath \
  -ldflags "-s -w -X main.Version=0.1.0 -X main.WebRef=e6661c8" -o hibana.exe .
```

The canonical build host is Windows (or the CI's `windows-latest`) — `wails build`
adds the icon/VERSIONINFO resources and can emit the NSIS installer (`-nsis`).

## Tests

```bash
go vet ./internal/... && go test ./internal/...     # the pure-Go core (runs anywhere)
GOOS=windows go vet ./...                            # the full app, windows target
node scripts/sync-island.mjs --ref e6661c8 --check   # the island drift gate

# THE island probes (Chromium via the hibana-source checkout's playwright —
# the mock bridge sits at the exact Wails boundary; every round has its own):
node scripts/probe-login.mjs --src ../hibana-source        # the gate + the reload
node scripts/probe-logout.mjs --src ../hibana-source       # the sign-out + the new account
node scripts/probe-newproject.mjs --src ../hibana-source   # the live cloud create
node scripts/probe-refresh.mjs --src ../hibana-source      # the pulled-truth reflex
node scripts/probe-soundfx.mjs --src ../hibana-source      # the five synthesized cues
node scripts/probe-completefacts.mjs --src ../hibana-source # the sync modal's full facts
node scripts/probe-update.mjs --src ../hibana-source       # the auto-update round + the apply-failure release-page reflex (v0.1.19)
node scripts/probe-settings.mjs --src ../hibana-source     # the settings page + the GitHub-access row + its test-connection round (S228, v0.1.18 + v0.1.19)

# THE M1 acceptance (live round-trip; env-only credentials, self-cleaning):
HIBANA_LOGIN=… HIBANA_PASSWORD=… HIBANA_BASE=https://hibana.ir go run ./cmd/acceptance
```

## Hard rules (the builder's ten commandments — guide §11)

1. **No secrets in the binary. Ever.** (Session cookie via DPAPI at rest — M5.)
2. **The cloud stays the single source of truth**; the mirror is a cache + offline workspace.
3. **Don't "fix" the deliberate web-surface exceptions** (FEATURE-INVENTORY §13) without owner input.
4. **Keep the seam thin** — 12 call sites through one adapter; a 13th means re-run the sync, not a hand-patch.
5. **Origin on every write** — the Go client owns it, the island never knows.
6. **Never mix data dirs** — installed vs portable locks at first launch.
7. **M0 before desktop mutations** — the outbox's offline creates depend on §7a-7c being deployed.
8. **The web suite stays green** through anything shared.
9. **Both versions on every release** — desktop semver + embedded web ref.
10. **The bridge is an API surface** — one Request method, allow-lists, validated inputs.
