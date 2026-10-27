#!/usr/bin/env node
// ============================================================================
// sync-island.mjs — the island sync ritual (GO-DESKTOP-IMPLEMENTATION-GUIDE.md §3 + §4)
//
// The island is a PINNED SNAPSHOT of the web app's /kanban board surface, synced by
// checksum — never a live subtree (guide §3). This script is its ONLY mutator:
// everything under frontend/dist is generated here, byte-for-byte reproducible, and
// NEVER hand-edited (guide §3.3.4: "Never hand-edit frontend/dist — change the patch
// script, so the patch is itself version-controlled and drift-detectable").
//
// WHAT IT DOES (per run):
//   1. Reads every island file CONTENT-ADDRESSED from the pinned git ref:
//      `git -C <src> show <ref>:public/<path>` — NOT the working tree, so the pin is
//      exact regardless of hibana-source's checkout state (guide §3.3.1).
//   2. Copies the verified manifest VERBATIM (guide §3.1 / UI-UX-REPLICATION-SPEC §7.3):
//      the 19 CSS sheets in board.html's EXACT <link> load order (rtl.css LAST — the
//      load order is a contract, guide §3.1), the font CSS graph (manrope linked by
//      board.html:29; general-sans + vazir @imported by variables.css:38/:45; vazir is
//      also injected at runtime by i18n.js:41 for FA) + every woff2 they reference, and
//      the JS set (devboard, chip-render, board-page, the i18n trio incl. LAZY
//      i18n-fa.js — the embedded asset server must serve the lazy paths, guide §3.1 —
//      vendor/jalaali.min.js, LAZY image-resize.js loaded by devboard.js:307-319).
//   3. Generates index.html from board.html@ref by the RECORDED strip/insert ops
//      (guide §3.2 — the web-chrome strip list; every op below is a named, exact
//      string match that FAILS LOUDLY if the pinned bytes drift).
//   4. Applies the transport-seam patches to the COPIES ONLY (guide §4.1/§4.2 — the
//      12 verified call sites: devboard.js api() choke point + 5 label fetches + 2 XHR
//      uploads; board-page.js 4 direct fetches). hibana-source is never touched.
//   5. Generates the desktop-owned island files: js/desktop-shim.js (guide §4.3),
//      js/desktop-login.js + css/desktop-login.css (guide §5.5 — the login gate),
//      js/desktop-theme.js (v0.1.5 — the S216 dark-mode round: the FIRST blocking
//      head script + the two toggle surfaces), js/desktop-sync.js +
//      css/desktop-sync.css (v0.1.6 — the S217 sync round: the toolbar button +
//      its proof modal), js/desktop-logout.js + css/desktop-logout.css (v0.1.9 —
//      the sign-out round: the toolbar's account zone + the confirm dialog),
//      js/desktop-newproject.js + css/desktop-newproject.css (v0.1.11 — the
//      new-project round: the switcher's New project row + the live cloud-create
//      dialog), and icon.svg.
//   6. Writes web-ref.json (the sealed pin) + island.checksums.json OUTSIDE dist
//      (frontend/island.checksums.json — dist stays purely servable; guide §3.3.2,
//      WINDOWS-PACKAGING-PLAN §7.4: CI re-runs --check to fail on web-island drift).
//
// CLI:
//   node scripts/sync-island.mjs --ref e6661c8 [--src /home/z/hibana-source]
//                                [--out frontend/dist] [--check]
//
//   --ref   must equal PIN_REF below (the sealed pin). To move the island to a new web
//           ref: bump PIN_REF/PIN_PACKAGE_VERSION + re-record any drifted op/patch
//           strings HERE, then re-run (guide §3.3.4). Syncing an unpinned ref is
//           refused by design.
//   --src   the hibana-source clone to read from (read-only; default /home/z/hibana-source).
//   --out   the dist dir (default frontend/dist, resolved against this repo's root).
//   --check recompute checksums over the EXISTING out dir and diff against
//           island.checksums.json. Exit 0 if identical; exit 1 + the differing file
//           list otherwise. NEVER re-copies (guide §3.3.2).
//
// Runtime: Node ≥ 20, stdlib only (node:fs, node:crypto, node:path, node:child_process).
// Deterministic + idempotent: the out dir is wiped and regenerated; running twice
// produces byte-identical output (checksums are content-addressed, sorted, stable).
// ============================================================================

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// The sealed pin (guide §3.3.1: "records the ref into frontend/dist/web-ref.json
// ({ref, packageVersion} — e.g. e6661c8, 0.4.1.35)"). S211 session: the S209 seal.
// ---------------------------------------------------------------------------
const PIN_REF = '7a3198b'
const PIN_PACKAGE_VERSION = '0.4.1.37'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// The verified copy manifest (guide §3.1 table / UI-UX-REPLICATION-SPEC §7.3).
// All paths are relative to hibana-source's public/.
// ---------------------------------------------------------------------------

// The 19 CSS sheets in board.html's EXACT <link> load order (board.html:10-28 at the
// pin). Load order is a contract: rtl.css LAST so the RTL overrides win (guide §3.1,
// rtl.css:6). The ?v= cache-bust query strings live in index.html (kept verbatim); the
// asset server ignores them.
const CSS_SHEETS = [
  'css/variables.css',      // ?v=27 — @imports vazir + general-sans font-face.css (:38/:45)
  'css/base.css',           // ?v=14
  'css/layout.css',         // ?v=67
  'css/dashboard.css',      // ?v=43
  'css/dashboard-todo.css', // ?v=25
  'css/components.css',     // ?v=9  — owns the .toast recipe's styles (:252-319)
  'css/canvas.css',         // ?v=11
  'css/quicknotes.css',     // ?v=50
  'css/to-do-list.css',     // ?v=13
  'css/polish-ui.css',      // ?v=39 — toast animations/positioning (:325, :582)
  'css/calendar.css',       // ?v=10
  'css/notifications.css',  // ?v=12
  'css/polish-batch.css',   // ?v=29 — .toast-msg unicode-bidi (:644)
  'css/project-header.css', // ?v=50 — the .pd-col column anatomy
  'css/devboard.css',       // ?v=34 — the .db-frame mother container (S207)
  'css/misc.css',           // ?v=24
  'css/themes.css',         // ?v=9  — the explicit LIGHT token block
  'css/claude-dark-theme.css', // ?v=31 — html[data-theme='claude-dark']
  'css/rtl.css',            // ?v=5  — LAST (the contract)
]

// Font CSS + every woff2 those files reference, so @font-face URLs resolve inside the
// embedded asset server (guide §3.1 Fonts row: board.html:7-9 preloads GeneralSans
// 400/500/600; variables.css @imports general-sans + vazir; manrope/font-face.css is
// <link>ed by board.html:29; vazir/font-face.css is ALSO injected at runtime by
// i18n.js:36-43 when the UI language is fa — so it must ship even for EN-first runs).
const FONT_CSS = [
  'vendor/manrope/font-face.css',      // board.html:29 — Manrope 400/500/600/700
  'vendor/general-sans/font-face.css', // variables.css:45 — General Sans 400/500/600
  'vendor/vazir/font-face.css',        // variables.css:38 + i18n.js:41 — Vazir ×6 weights
]
const FONT_FILES = [
  'vendor/manrope/Manrope-400.woff2',
  'vendor/manrope/Manrope-500.woff2',
  'vendor/manrope/Manrope-600.woff2',
  'vendor/manrope/Manrope-700.woff2',
  'vendor/general-sans/GeneralSans-400.woff2',
  'vendor/general-sans/GeneralSans-500.woff2',
  'vendor/general-sans/GeneralSans-600.woff2',
  'vendor/vazir/Vazir-Regular.woff2',
  'vendor/vazir/Vazir-Bold.woff2',
  'vendor/vazir/Vazir-Thin.woff2',
  'vendor/vazir/Vazir-Light.woff2',
  'vendor/vazir/Vazir-Medium.woff2',
  'vendor/vazir/Vazir-Black.woff2',
]

// The JS set (guide §3.1). devboard.js/board-page.js get the §4 seam patches; the rest
// are verbatim. i18n-fa.js + image-resize.js are LAZY (i18n.js:49-60 injects
// /js/i18n-fa.js?v=95 on FA; devboard.js:307-319 injects /js/image-resize.js?v=1 on
// first editor open) — the embedded asset server serves those exact paths.
const JS_FILES = [
  'js/sync-state.js',      // v2 (v0.4.1.37) — the per-card sync tracker (hibana-sync-status-spec §14: ONE source; devboard.js's task mutations report in, the badges + the Sync button count derive from it)
  'js/devboard.js',        // v29 (v0.4.1.37) — the data + editor modal; PATCHED (§4.2: 1 choke point + 5 labels + 2 XHR) — the sync-badge round wraps the task mutations with tracked()
  'js/chip-render.js',     // v13 (v0.4.1.37) — the markdown-lite title renderer (byte-parity target, UI-UX §3.3) + syncBadgeHtml/syncBadgeDetailHtml (the badge component, §4-§6)
  'js/board-page.js',      // v22 (v0.4.1.37) — the /kanban page; PATCHED (§4.2: 4 direct fetches) — renders the badge as the meta row's LAST child
  'js/i18n-en.js',         // v101 (v0.4.1.37) — the EN dictionary (loaded before i18n.js; defer order) + the sync.* labels
  'js/i18n.js',            // v155 (v0.4.1.37) — the i18n layer; NOTE: kept VERBATIM (see KNOWN-REMAINS below)
  'js/i18n-fa.js',         // v95 (v0.4.1.37) — the LAZY FA dictionary (i18n.js:49-60) + the sync.* FA labels
  'js/image-resize.js',    // v1 — the LAZY ≤1600px WebP prepare pass (devboard.js:307-319)
  'vendor/jalaali.min.js', // Jalali dates for FA (devboard.js calOf)
]

// The login gate's photo panel + corner brand (v0.1.2 — the owner ask: "Use the same
// login background of the hibana login in the app"): the gate replicates the web
// login page's own SPLIT layout (login.html @ pin), so the photo (Login.webp —
// quicknotes.css's .auth-visual background) and the corner wordmark (logo-dark.png —
// login.html's .auth-brand img) ship in the island too, copied from the PIN verbatim.
// The favicon (icon.svg) is NOT copied from the pin: the pin's icon.svg is the old
// H-tile art — the island's favicon is the traced Hibana logo mark, GENERATED below
// (ICON_SVG), matching the new web favicon byte-for-byte (hibana-source/public/icon.svg
// is regenerated by scripts/make-icons.py in this same change).
const LOGIN_ASSETS = ['Login.webp', 'logo-dark.png']

const COPY_MANIFEST = [...CSS_SHEETS, ...FONT_CSS, ...FONT_FILES, ...JS_FILES, ...LOGIN_ASSETS]

// ---------------------------------------------------------------------------
// KNOWN-REMAINS (documented, deliberate — each is a same-origin call the guide's §4.1
// seam list does NOT cover; all are guarded and degrade cleanly inside the island):
//
//  1. i18n.js:73 `fetch('/api/auth/me')` — the language bootstrap. Guide §4.1 lists
//     exactly 12 sites (devboard.js + board-page.js); i18n.js is copied verbatim.
//     In the island: window.__hibanaMe is absent (app.js stripped) → the direct fetch
//     hits the asset server → non-ok → me = null → the try/catch falls back to
//     navigator.language (i18n.js:81-82). M3's auth work takes language resolution
//     over Go-side WITHOUT touching the island: define window.__hibanaMe (the very
//     hook i18n.js:69 prefers) from a Go binding.
//  2. i18n.js:49-60 (dynamic <script> /js/i18n-fa.js?v=95) and devboard.js:307-319
//     (dynamic <script> /js/image-resize.js?v=1) — STATIC-ASSET loaders over HTTP to
//     same-origin paths. The Wails asset server serves them same-origin; left
//     untouched by design (they are not /api traffic).
//  3. devboard.js:511/:514/:622/:624/:713/:715 + board-page.js — <img>/<video>/href
//     pointing at /api/media/screenshots/:id/file (content URLs, NOT fetch()). Media
//     serving is M4's work (guide §5.4); the markup stays verbatim.
//  4. board-page.js:29 `location.replace('/kanban')` (bare-entry guard) and :953
//     `href = '/project.html?id='` — navigation, not network. The desktop shell owns
//     entry routing: either launch the WebView with ?project=<id>, or alias /kanban →
//     index.html in the Wails AssetServer handler (main.go, M2). Flagged for the M2
//     shell owner; NOT patched here (outside the guide's recorded patch list).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// git-show reader (content-addressed source — guide §3.3.1)
// ---------------------------------------------------------------------------
function fail(msg) {
  process.stderr.write('[sync-island] FAIL: ' + msg + '\n')
  process.exit(1)
}

function gitShow(src, ref, relPath) {
  // Read public/<relPath> as a raw blob at <ref>. Byte-for-byte, no working-tree
  // dependence, no CRLF smudge (git show emits the blob verbatim).
  try {
    return execFileSync('git', ['-C', src, 'show', ref + ':public/' + relPath], {
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (err) {
    const stderr = err && err.stderr ? String(err.stderr) : ''
    if (/does not exist|exists on disk, but not in|fatal: path/i.test(stderr)) {
      fail('manifest path public/' + relPath + ' does not exist at ref ' + ref +
        ' — the pinned manifest drifted from the tree; re-record the manifest in sync-island.mjs (guide §3.3.4).')
    }
    fail('git show failed for public/' + relPath + ' @ ' + ref + ': ' + (stderr || String(err && err.message)))
  }
}

function verifyRef(src, ref) {
  try {
    execFileSync('git', ['-C', src, 'rev-parse', '--verify', '--quiet', ref + '^{commit}'], { stdio: 'pipe' })
  } catch {
    fail('pinned ref ' + ref + ' is not a commit in ' + src + ' — fetch/clone hibana-source first.')
  }
}

// ---------------------------------------------------------------------------
// The HTML adaptation ops (guide §3.2 — each is RECORDED + fail-loudly; the output is
// never hand-edited). board.html@e6661c8 has NO inline scripts at all (verified: the
// theme/lang bootstrap lives in the STRIPPED boot.js/app.js — html[data-theme] is set
// by boot.js before first paint on the web). The "desktop shell owns theme natively"
// deferral (UI-UX-REPLICATION-SPEC §7.2 + guide §5.6) ended in v0.1.5: the generated
// js/desktop-theme.js (HTML_THEME_OPS below) runs as the FIRST blocking head script
// so the resolution beats the first render — a generated FILE, still no inline script.
// ---------------------------------------------------------------------------
const HTML_STRIP_LINES = [
  // The web-chrome <script> tags (board.html:30-42 at the pin) — exact strings incl.
  // the ?v= cache-bust tokens; a web-side bump makes these MISS and the sync fails
  // loudly (the drift tripwire — re-record here, then re-run).
  { name: 'strip vendor/htmx.min.js', cite: 'guide §3.2 (board.html:30; UI-UX §7.3)', line: '<script src="/vendor/htmx.min.js" defer></script>' },
  { name: 'strip vendor/idiomorph-ext.min.js', cite: 'guide §3.2 (board.html:31)', line: '<script src="/vendor/idiomorph-ext.min.js" defer></script>' },
  { name: 'strip js/boot.js (SW registration)', cite: 'guide §3.2 (board.html:32; UI-UX §7.3)', line: '<script src="/js/boot.js?v=7"></script>' },
  { name: 'strip vendor/alpine.min.js', cite: 'guide §3.2 (board.html:33)', line: '<script src="/vendor/alpine.min.js" defer></script>' },
  { name: 'strip js/app.js (the web shell — its toast contract moves to desktop-shim.js)', cite: 'guide §3.1+§3.2+§4.3 (board.html:34)', line: '<script src="/js/app.js?v=220" defer></script>' },
  { name: 'strip js/hib-init.js', cite: 'guide §3.2 (board.html:35)', line: '<script src="/js/hib-init.js?v=13" defer></script>' },
  { name: 'strip js/touch-drag.js (touch long-press — irrelevant on desktop)', cite: 'guide §3.2 (board.html:36; UI-UX §7.2)', line: '<script src="/js/touch-drag.js?v=1" defer></script>' },
  { name: 'strip js/nav.js (browser-history rail; its __hibanaPage mount consumer is re-owned by desktop-shim.js)', cite: 'guide §3.2 (board.html:37)', line: '<script src="/js/nav.js?v=45" defer></script>' },
  { name: 'strip js/command-palette.js', cite: 'guide §3.2 (board.html:38)', line: '<script src="/js/command-palette.js?v=19" defer></script>' },
  { name: 'strip js/mobile-nav.js', cite: 'guide §3.2 (board.html:39)', line: '<script src="/js/mobile-nav.js?v=17" defer></script>' },
  { name: 'strip js/zen-mode.js', cite: 'guide §3.2 (board.html:40)', line: '<script src="/js/zen-mode.js?v=1" defer></script>' },
  { name: 'strip js/micro-interactions.js', cite: 'guide §3.2 (board.html:41)', line: '<script src="/js/micro-interactions.js?v=1" defer></script>' },
  { name: 'strip js/go-to.js', cite: 'guide §3.2 (board.html:42)', line: '<script src="/js/go-to.js?v=3" defer></script>' },
  // The page-loader splash (board.html:52) — a boot.js/app.js-painted element.
  { name: 'strip the page loader div', cite: 'guide §3.2 (board.html:52; UI-UX §7.3)', line: '<div id="hibana-page-loader" aria-hidden="true"><div class="hibana-page-loader-inner"><div class="hibana-loader-mark" aria-hidden="true"><span class="hibana-loader-glyph">H</span><span class="hibana-loader-orbit"><span class="hibana-loader-spark"></span></span></div><span class="hibana-page-loader-brand">Hibana</span><div class="hibana-loader-track" aria-hidden="true"><span class="hibana-loader-fill"></span></div></div></div>' },
  // The nav rail mount point (board.html:53) — nav.js is stripped.
  { name: 'strip <div data-nav> block', cite: 'guide §3.2 (board.html:53)', line: '<div data-nav></div>' },
]

// The one BEFORE-anchor INSERT: the seam shim loads BEFORE devboard.js/board-page.js (guide §3.2
// "Add: the seam shim <script src=\"/js/desktop-shim.js\"> BEFORE devboard.js/
// board-page.js"). Emitted WITHOUT defer: a blocking head script is guaranteed to
// evaluate before every deferred island script, and it owns the contracts (bridge,
// toast, page lifecycle) those scripts consume at evaluation time. No ?v= — it is a
// desktop-owned file outside the web cache-bust graph.
const HTML_INSERT = {
  name: 'insert /js/desktop-shim.js before devboard.js',
  cite: 'guide §3.2 + §4.3',
  anchor: '<script src="/js/devboard.js?v=29" defer></script>',
  insert: '<script src="/js/desktop-shim.js"></script>',
}

// The login-first additions (guide §5.5 — the M2 pick LANDED: the island-rendered
// login card; the owner's dogfooding ask: "firstly a login modal opens, when user
// auths and connect to cloudflare kanban loads"). All AFTER-anchor inserts, all
// desktop-owned files generated by this script — the island's own 19-CSS order
// (rtl.css LAST) and script order (shim → devboard → board-page) are preserved
// verbatim around them.
const HTML_INSERTS_AFTER = [
  {
    name: 'insert the /icon.svg favicon link after the viewport meta (v0.1.2 — the Hibana logo as favicon)',
    cite: 'the owner ask; login.html:6 carries the same link at the pin',
    anchor: '<meta name="viewport" content="width=device-width, initial-scale=1">',
    insert: '  <link rel="icon" type="image/svg+xml" href="/icon.svg">',
  },
  {
    name: 'insert /js/desktop-login.js after desktop-shim.js (the login gate controller)',
    cite: 'guide §5.5 (the island-rendered login card)',
    anchor: '<script src="/js/desktop-shim.js"></script>',
    insert: '<script src="/js/desktop-login.js"></script>',
  },
  {
    name: 'insert /css/desktop-login.css after the manrope font sheet (rtl.css stays the last ISLAND /css/ sheet)',
    cite: 'guide §5.5 + §3.1 (the island CSS order is untouched; the gate sheet is desktop-owned)',
    anchor: '<link rel="stylesheet" href="/vendor/manrope/font-face.css">',
    insert: '  <link rel="stylesheet" href="/css/desktop-login.css?v=2">',
  },
]

// The login card markup: the WEB LOGIN PAGE'S OWN CLASSES (.auth-page /
// .auth-card / .error — base.css + components.css, theme-aware via vars) and the
// shared i18n keys (auth.welcomeBack / auth.emailOrUsername / auth.password /
// auth.signIn — present in BOTH island dictionaries), so the card is Hibana-native
// in light+dark and self-localizes (FA systems get the FA card + RTL via the
// navigator.language fallback; post-login the __hibanaMe hook carries
// language_pref). No /reset / signup links: those are web pages the island does
// not serve (the no-404 gate would fail them). The visibility rule lives in
// desktop-login.css: the Go shell injects data-desktop-authed on <html> at serve
// time (ui.IndexMiddleware) so first paint is correct with zero JS flash.
const HTML_LOGIN_GATE = [
  '  <!-- The desktop login gate (guide §5.5 — the M2 pick LANDED; v0.1.2: the WEB LOGIN',
  '       PAGE\'S OWN SPLIT LAYOUT — the owner ask: the same login background as the web login).',
  '       Generated by sync-island.mjs — never hand-edit. Hidden at first paint when the Go',
  '       shell serves this document with data-desktop-authed="true" (internal/ui.IndexMiddleware);',
  '       js/desktop-login.js wires the form to the Go Login binding (the cookie never crosses',
  '       back into JS — internal/ui/bindings.go §5.5). The gate replicates login.html @ pin',
  '       structurally: the 60/40 .auth-split (quicknotes.css\'s own rules — the same sheet',
  '       ships in the island), the Login.webp photo panel with the .auth-brand corner',
  '       wordmark (logo-dark.png — the photo panel\'s own img), and the .auth-form panel with',
  '       the shared i18n keys — theme-aware, RTL-native (FA flips the split), no island',
  '       network. No /reset / signup links: those are web pages the island does not serve',
  '       (the no-404 gate would fail them). The visibility rule lives in desktop-login.css. -->',
  '  <div class="login-gate auth-page auth-split-page" id="login-gate" role="dialog" aria-modal="true" aria-labelledby="login-gate-title">',
  '    <div class="auth-split">',
  '      <section class="auth-visual" aria-hidden="true">',
  '        <span class="auth-brand"><img class="auth-logo" src="/logo-dark.png" alt="Hibana"></span>',
  '      </section>',
  '      <section class="auth-form">',
  '        <div>',
  '          <h1 id="login-gate-title" data-i18n="auth.welcomeBack">Welcome back</h1>',
  '          <p class="small muted" id="login-gate-sub">Sign in to your Hibana account to load your boards.</p>',
  '        </div>',
  '        <form id="login-gate-form" novalidate>',
  '          <label><span data-i18n="auth.emailOrUsername">Email or username</span>',
  '            <input type="text" id="login-gate-login" name="login" autocomplete="username"></label>',
  '          <label><span data-i18n="auth.password">Password</span>',
  '            <input type="password" id="login-gate-password" name="password" autocomplete="current-password"></label>',
  '          <div class="row">',
  '            <button type="submit" id="login-gate-submit" data-i18n="auth.signIn">Sign in</button>',
  '            <span id="login-spinner" class="spinner" aria-hidden="true"></span>',
  '          </div>',
  '          <p id="login-error" class="error" role="alert" hidden></p>',
  '        </form>',
  '      </section>',
  '    </div>',
  '  </div>',
].join('\n')

const HTML_GATE_INSERT = {
  name: 'insert the login gate markup after <body>',
  cite: 'guide §5.5 (the card overlays the board; a live session never sees it)',
  anchor: '<body>',
  insert: HTML_LOGIN_GATE,
}

// ---------------------------------------------------------------------------
// The v0.1.5 additions — S216, the dark-mode round (the owner ask: "The app
// doesnt have darkmode, add dark mode and it's toggle"). Desktop-owned inserts
// around the PINNED bytes (the pin does not move), recorded per-round and in the
// order the head/body chain requires. The generated controller (DESKTOP_THEME_JS
// below) is the FIRST blocking head script: the pre-paint theme resolution must
// beat the first render. The floater is the WEB LOGIN PAGE'S OWN affordance
// (login.html:30 @ pin — present pre-login); the toolbar toggle rides the pin's
// own nav.themeHint key (FA-native).
//
// RECOVERY NOTE: the op bytes below are re-recorded from the byte-exact v0.1.6
// binary carve (go:embed) — the sync must reproduce that carve bit-for-bit.
// ---------------------------------------------------------------------------
const HTML_THEME_OPS = [
  {
    name: 'insert /js/desktop-theme.js after the chip-render.js tag — the FIRST blocking head script (immediately before desktop-shim.js)',
    cite: 'v0.1.5 (S216); desktop-theme.js: the pre-paint resolution must beat the first render',
    anchor: `    <script src="/js/chip-render.js?v=13" defer></script>`,
    insert: `<script src="/js/desktop-theme.js"></script>`,
  },
  {
    // An exact-string find→replace (the SEAM_PATCHES discipline) rather than a
    // line-anchored insert: HTML_GATE_INSERT splices the whole gate in as ONE
    // element, so no line anchor can reach inside it — and around the gate's
    // close a single line is ambiguous anyway ('    </div>' also closes the
    // board toolbar + .db-frame). The find pins the gate's last three lines
    // exactly; the replace splices the floater between the split close and the
    // gate close (the web login page's own corner affordance).
    name: 'insert the .theme-floater button into the login gate (the corner toggle, pre-login)',
    cite: "v0.1.5 (S216); login.html:30 @ pin — the web login page's own affordance",
    find: `      </section>
    </div>
  </div>`,
    replace: `      </section>
    </div>
    <button type="button" class="theme-floater" aria-label="Toggle theme" data-i18n-aria-label="auth.toggleTheme"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg></button>
  </div>`,
  },
  {
    name: 'insert the #db-theme-toggle toolbar button after the labels button',
    cite: "v0.1.5 (S216); the web rail's own affordance — the pin's nav.themeHint key, FA-native",
    anchor: `      <button type="button" class="btn ghost small" id="db-labels-btn"><span data-i18n="db.labelsTitle">Labels</span></button>`,
    insert: `      <!-- v0.1.5 (the owner ask: dark mode + its toggle): the board toolbar's theme toggle —
           the web rail's own affordance (the S87/S93 round) on the desktop's chrome-less board:
           a ghost icon button flipping light <-> claude-dark through the Go SetTheme binding
           (js/desktop-theme.js — the persisted mirror-meta pref is the one source of truth). -->
      <button type="button" class="btn ghost small" id="db-theme-toggle" data-theme-toggle aria-label="Toggle theme" data-i18n-aria-label="nav.themeHint"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg></button>`,
  },
]

// ---------------------------------------------------------------------------
// The v0.1.6 additions — S217, the sync-button round (the owner ask: the
// physical, visible sync button whose modal proves the round live: connecting to
// the Cloudflare server > upload > sync, then the success panel — the user is
// 100% sure the boards are synced and will not vanish). The dialog rides the
// WEB'S OWN native dialog system (dialog.dialog + .modal — components.css:
// theme-aware + RTL-native for free); js/desktop-sync.js (DESKTOP_SYNC_JS below)
// owns the flow through the Go SyncNow binding; the toolbar button's aria-label
// is desktop-localized (the pin dictionaries carry no sync key — verified @ pin).
//
// v0.1.8 — the owner's follow-up: "There is still No Sync button" — the ghost
// ICON at the toolbar's edge did not read as a sync button. The button is now a
// LABELED, FILL-COLORED pill right after Labels ("next to sprints and labels,
// but colored. (fill colored)"), and Sprints + Labels are twin-sized ("sprints
// and labels need to be same size" — the <a> vs <button> box divergence, below
// in DESKTOP_SYNC_CSS).
// ---------------------------------------------------------------------------
const HTML_SYNC_OPS = [
  {
    name: 'insert /css/desktop-sync.css after the gate sheet (rtl.css stays the last ISLAND /css/ sheet)',
    cite: 'v0.1.6 (S217); the modal\'s desktop-owned styles',
    anchor: `  <link rel="stylesheet" href="/css/desktop-login.css?v=2">`,
    insert: `  <link rel="stylesheet" href="/css/desktop-sync.css?v=1">`,
  },
  {
    name: 'insert /js/desktop-sync.js after desktop-login.js',
    cite: 'v0.1.6 (S217); the modal controller — blocking, after the login controller, before the deferred board scripts',
    anchor: `<script src="/js/desktop-login.js"></script>`,
    insert: `<script src="/js/desktop-sync.js"></script>`,
  },
  {
    name: 'insert the #db-sync-dialog markup after the skip-link',
    cite: "v0.1.6 (S217); the WEB'S OWN native dialog system (dialog.dialog + .modal — components.css)",
    anchor: `  <a class="skip-link" href="#main" data-i18n="a11y.skipToMain">Skip to content</a>`,
    insert: `  <!-- The manual sync modal (v0.1.6 — the owner ask: the physical, visible sync button's
       proof modal: connecting to the Cloudflare server > upload > sync, then the success
       panel — the user is 100% sure the boards are synced and will not vanish).
       GENERATED by sync-island.mjs — never hand-edit. The WEB'S OWN native dialog
       (dialog.dialog + .modal, components.css — theme-aware + RTL-native for free);
       js/desktop-sync.js wires the toolbar's #db-sync-button → the Go SyncNow binding
       (internal/sync round.go: connect /api/auth/me → outbox drain → full pull) and the
       hibana:sync-progress events light the step rows live. -->
  <dialog class="dialog" id="db-sync-dialog" aria-labelledby="db-sync-title">
    <form class="modal db-sync-modal" method="dialog">
      <!-- v0.1.13 (the owner ask: "also in modal i want syncing animation with
           icons and animation") — the HERO: the round's living emblem, an
           aria-hidden stage above the factual step rows. One 4.6rem emblem
           carries the whole choreography: the pulse ring reaches out on
           connect, three packets rise through upload, the h-spark orbits
           while the round is in flight, and the central glyph MORPHS per
           stage (cloud -> upload arrow -> orbit -> check/cross) with the
           ok pop settling the emblem into the green verdict. js/
           desktop-sync.js flips data-stage from the hibana:sync-progress
           events + data-kind from the outcome; desktop-sync.css owns every
           keyframe (prefers-reduced-motion respected). -->
      <div class="db-sync-hero" id="db-sync-hero" data-stage="connect" data-kind="" aria-hidden="true">
        <div class="db-sync-emblem" id="db-sync-emblem">
          <span class="db-sync-ring"></span>
          <span class="db-sync-orbit"><span class="db-sync-spark"></span></span>
          <span class="db-sync-packets" aria-hidden="true"><span></span><span></span><span></span></span>
          <svg class="icon db-sync-glyph db-sync-glyph-connect" viewBox="0 0 24 24"><path d="M17.5 18a4.5 4.5 0 0 0 .38-8.98A6 6 0 0 0 6.48 7.62 5 5 0 0 0 6.5 17.5"/></svg>
          <svg class="icon db-sync-glyph db-sync-glyph-upload" viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5M4 21h16"/></svg>
          <svg class="icon db-sync-glyph db-sync-glyph-orbit" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/></svg>
          <svg class="icon db-sync-glyph db-sync-glyph-ok" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>
          <svg class="icon db-sync-glyph db-sync-glyph-err" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </div>
      </div>
      <h2 id="db-sync-title">Sync with Hibana cloud</h2>
      <ol class="db-sync-steps" id="db-sync-steps">
        <li data-step="connect" data-state="pending"><span class="db-sync-mark" aria-hidden="true"></span><span class="db-sync-label">Connecting to Cloudflare server</span></li>
        <li data-step="upload" data-state="pending"><span class="db-sync-mark" aria-hidden="true"></span><span class="db-sync-label">Uploading changes</span></li>
        <li data-step="sync" data-state="pending"><span class="db-sync-mark" aria-hidden="true"></span><span class="db-sync-label">Syncing boards</span></li>
      </ol>
      <div class="db-sync-panel" id="db-sync-panel" data-kind="ok" hidden>
        <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>
        <div><strong id="db-sync-panel-title">Everything synced</strong><p class="small muted" id="db-sync-panel-body"></p></div>
      </div>
      <div class="db-sync-actions">
        <button type="button" class="btn ghost small" id="db-sync-close">Close</button>
        <button type="button" class="btn small" id="db-sync-retry" hidden>Try again</button>
        <button type="button" class="btn small" id="db-sync-done" hidden>Done</button>
      </div>
    </form>
  </dialog>`,
  },
  {
    // v0.1.8: the anchor moved from the theme-toggle line (v0.1.6 put the ghost
    // icon at the toolbar's EDGE) to the PINNED Labels line — the owner ask:
    // "next to sprints and labels". The theme round runs FIRST (its own anchor
    // is this same Labels line), so the theme toggle already sits right after
    // Labels when this op runs; inserting at the same anchor lands the sync
    // button BETWEEN them: Sprints | Labels | Sync | theme.
    name: 'insert the #db-sync-button toolbar button right after the Labels button (v0.1.8: next to Sprints and Labels)',
    cite: "v0.1.8 (the owner ask: 'a sync button on the header of app, next to sprints and labels, but colored. (fill colored)'); the v0.1.6 ghost icon read as NO sync button — now the bare-button CTA grammar (base.css S186: a plain <button> IS the app's solid primary) with the refresh glyph + the Sync label",
    anchor: `      <button type="button" class="btn ghost small" id="db-labels-btn"><span data-i18n="db.labelsTitle">Labels</span></button>`,
    insert: `      <!-- v0.1.8 (the owner ask: "a sync button on the header of app, next to
           sprints and labels, but colored. (fill colored)" — the v0.1.6 ghost
           icon at the toolbar's edge read as NO sync button): the manual sync
           trigger is now a LABELED, FILL-COLORED pill right after Labels — the
           bare-button CTA grammar (base.css S186: a plain <button> IS the
           app's solid primary — the --cta fill + the white --btn-text label,
           --cta-hover on hover, theme-native in light AND claude-dark), the
           refresh glyph + the Sync label at the same twin metrics as Sprints
           and Labels (desktop-sync.css sizes all three identically). Clicking
           it opens the sync modal, which proves the round live (connecting to
           the Cloudflare server > upload > sync, then the success panel) so
           the user is 100% sure the boards are synced and will not vanish.
           js/desktop-sync.js owns the flow through the Go SyncNow binding;
           the label + aria are desktop-localized (no pin i18n key exists). -->
      <button type="button" class="small db-sync-cta" id="db-sync-button" aria-label="Sync now" title="Sync now"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/></svg><span id="db-sync-btn-label">Sync</span></button>`,
  },
]

// ---------------------------------------------------------------------------
// The v0.1.9 additions — the sign-out round (the owner ask: "It must also have
// option of logout and enter with a new account"). The toolbar gains a LABELED
// ghost Log out button at the row's END (after the theme toggle — the account
// zone; the S220 lesson: an icon at the row's edge reads as nothing, so the
// button carries the pin's own nav.signout label), and the confirm dialog rides
// the WEB'S OWN native dialog system (dialog.dialog + .modal — components.css:
// theme-aware + RTL-native for free) exactly like the sync modal. The labels
// ride the PIN'S OWN dictionaries (nav.signout EN 'Sign out' / FA 'خروج' +
// common.cancel — i18n-en.js:11,92 / i18n-fa.js:11,92 @ pin), self-flipped by
// i18n.js; only the body copy + the failure lines are the controller's own
// EN/FA pair (desktop-logout.js below).
//
// The Go side (internal/ui.API.Logout — the §5.5 login surface's counterpart):
// POST /api/auth/logout best-effort → the cookie + the ETag cache together
// (api.ClearSession) → the persisted session file → the mirror's
// account-scoped rows + pull cursors (the shell's ResetAccount hook; the
// theme + close-to-tray device prefs survive) → the silent state flip. On the
// {ok:true} resolve desktop-logout.js location.reload()s: the shell serves
// the document with data-desktop-authed="false", the login card opens at
// first paint, and signing in with the new account boots its kanban.
// ---------------------------------------------------------------------------
const HTML_LOGOUT_OPS = [
  {
    name: 'insert /css/desktop-logout.css after the sync sheet (rtl.css stays the last ISLAND /css/ sheet)',
    cite: 'v0.1.9 (the sign-out round); the confirm dialog + the toolbar button\'s desktop-owned styles',
    anchor: `  <link rel="stylesheet" href="/css/desktop-sync.css?v=1">`,
    insert: `  <link rel="stylesheet" href="/css/desktop-logout.css?v=1">`,
  },
  {
    name: 'insert /js/desktop-logout.js after desktop-sync.js',
    cite: 'v0.1.9; the sign-out controller — blocking, after the sync controller, before the deferred board scripts',
    anchor: `<script src="/js/desktop-sync.js"></script>`,
    insert: `<script src="/js/desktop-logout.js"></script>`,
  },
  {
    // Generated-line anchor (the S217 pattern): the sync round's dialog op
    // emits this line above; at this op's turn in the chain exactly ONE
    // </dialog> line exists (the island ships no other dialog markup from
    // the pin), so the logout dialog lands right after the sync modal.
    name: 'insert the #db-logout-dialog markup after the sync dialog',
    cite: "v0.1.9; the WEB'S OWN native dialog system (dialog.dialog + .modal — components.css), the sync modal's own grammar",
    anchor: `  </dialog>`,
    insert: `  <!-- The sign-out confirm modal (v0.1.9 — the owner ask: "It must also
       have option of logout and enter with a new account"). GENERATED by
       sync-island.mjs — never hand-edit. The WEB'S OWN native dialog
       (dialog.dialog + .modal, components.css — theme-aware + RTL-native
       for free); js/desktop-logout.js wires the confirm → the Go Logout
       binding (internal/ui bindings.go: POST /api/auth/logout best-effort,
       then the cookie + the session file + the ETag cache + the mirror's
       account rows all die Go-side) → on ok a location.reload() so the
       shell serves the document with data-desktop-authed="false" — the
       login card opens, and signing in with the new account boots its
       kanban. The title/confirm/cancel labels ride the pin's own
       dictionaries (nav.signout / common.cancel); the body line is the
       controller's own EN/FA pair. The confirm is the BARE <button> — the
       S186 CTA grammar (base.css: the bare button IS the view's one solid
       primary, the login gate's own "Sign in" shape; Cancel is the neutral
       secondary ahead of it, trailing primary under RTL too). -->
  <dialog class="dialog" id="db-logout-dialog" aria-labelledby="db-logout-title">
    <form class="modal db-logout-modal" method="dialog">
      <h2 id="db-logout-title" data-i18n="nav.signout">Sign out</h2>
      <p class="small muted" id="db-logout-body">Your boards live safe on the Hibana cloud — sign in again any time to load them back.</p>
      <p id="db-logout-error" class="error" role="alert" hidden></p>
      <div class="db-logout-actions">
        <button type="button" class="btn ghost small" id="db-logout-cancel" data-i18n="common.cancel">Cancel</button>
        <button type="button" id="db-logout-confirm" data-i18n="nav.signout">Sign out</button>
      </div>
    </form>
  </dialog>`,
  },
  {
    // Generated-line anchor: the theme round emitted the toggle line above;
    // the sync round then inserted its CTA at the Labels line, so at this
    // op's turn the row reads Sprints | Labels | Sync | theme and this insert
    // appends the account zone at the END: Sprints | Labels | Sync | theme |
    // Log out (FA/RTL mirrors the whole row — Log out lands leftmost).
    name: 'insert the #db-logout-button toolbar button after the theme toggle (the row-end account zone)',
    cite: "v0.1.9 (the owner ask: 'option of logout and enter with a new account'); the pin's own nav.signout key — a VISIBLE LABELED ghost (the S220 lesson: a bare icon at the row's edge reads as nothing), twin metrics with Sprints/Labels/Sync",
    anchor: `<button type="button" class="btn ghost small" id="db-theme-toggle" data-theme-toggle aria-label="Toggle theme" data-i18n-aria-label="nav.themeHint"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg></button>`,
    insert: `      <!-- v0.1.9 (the owner ask: "It must also have option of logout and enter
           with a new account"): the toolbar's account zone — a LABELED ghost
           Log out button at the row's end (after the theme toggle), the
           pin's own nav.signout key (EN 'Sign out' / FA 'خروج'), the
           log-out glyph + the label at the same twin metrics as Sprints and
           Labels (desktop-logout.css). Ghost on purpose: account actions are
           not CTAs — Sync stays the ONE colored action in the row. Clicking
           opens the confirm dialog (#db-logout-dialog — a sign-out is never
           accidental); js/desktop-logout.js owns the flow through the Go
           Logout binding, and the reload lands the user on the login card,
           where entering a new account boots its kanban. -->
      <button type="button" class="btn ghost small" id="db-logout-button" aria-label="Sign out" data-i18n-aria-label="nav.signout" title="Sign out" data-i18n-title="nav.signout"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg><span id="db-logout-btn-label" data-i18n="nav.signout">Sign out</span></button>`,
  },
]

// ---------------------------------------------------------------------------
// The v0.1.11 additions — the new-project round (the owner ask: "Add ability to
// define a new project, and get a kanban for it as well. this project then will
// be updated in hibana's cloudflare as a new project."). The desktop could OPEN
// boards but never CREATE their projects — every project came from the web app.
// The round closes the gap with a LIVE cloud create, the web API's own
// idempotent POST /api/projects (routes/projects/index.ts:389 @ pin): the
// controller (DESKTOP_NEWPROJECT_JS below) mints a client UUID v4, POSTs
// {id, title, description?, status:'planning'} through window.hibanaFetch —
// the shim's fetch seam into the bridge's ONE Request transport (the Go
// client stamps the Origin + the session cookie; the T6 write gate passes) —
// and on the 201 {ok,id} / 200 {ok,duplicate} resolve deep-links the island's
// OWN /kanban?project=<id> boot, which loads the fresh board (B().load → GET
// /api/projects/:id/devboard → the empty columns render — the kanban for the
// new project) and records it as the last-used board (the island's OWN
// recordBoard; this round touches NO storage).
//
// status:'planning' — the FIRST ACTIVE stage, NOT the createProjectSchema's
// 'spark' default: the switcher's list (GET /api/projects?sort=recent, the
// seam's site 9) EXCLUDES sparks (routes/projects/index.ts:66), so a spark
// would never appear in the very switcher it was created from; 'planning'
// lands in the list AND owns its kanban. The stage stays editable on the web.
//
// THREE entry points, all in the controller: (1) the switcher popup's
// "New project" row — board-page.js builds the popup lazily at RUNTIME
// (openSwitch), so the row is injected via MutationObserver the moment the
// popup is born, riding the pin's own .db-switch-row grammar (devboard.css)
// + the pin's own cmdk.newProject label (EN 'New project' / FA 'پروژهٔ جدید');
// (2) the popup's dead "All projects →" link (/projects.html — board-page.js
// :371, a web page the embedded server does not serve) is HIDDEN by
// css/desktop-newproject.css — on the desktop the switcher list IS the
// projects page, and the New project row replaces the dead link; (3) the
// remaining /projects.html links (the no-projects empty state's "Go to
// projects" CTA, board-page.js:466; the fail state, :920) are click-
// intercepted into the dialog by the controller's document delegation.
//
// OFFLINE HONESTY: a transport failure surfaces the dialog's unreachable line
// — NO offline queue (the outbox's project.create entity stays M3's scope:
// offline mutations; a create that LOOKS queued but is not would be a lie).
// A 401 opens the login card (the bridge's own NotifyAuthLost fires Go-side)
// plus the session line here; the user re-signs in and retries.
//
// The dialog rides the WEB'S OWN native dialog system (dialog.dialog + .modal
// — components.css: theme-aware + RTL-native for free), the sync/logout
// modals' own grammar; every label rides the PIN'S OWN dictionaries
// (cmdk.newProject / sparks.title / sparks.description / cat.quickAdd /
// common.cancel — EN+FA @ pin) via data-i18n; only the body copy + the failure
// lines are the controller's own EN/FA pair.
// ---------------------------------------------------------------------------
const HTML_NEWPROJECT_OPS = [
  {
    name: 'insert /css/desktop-newproject.css after the logout sheet (rtl.css stays the last ISLAND /css/ sheet)',
    cite: 'v0.1.11 (the new-project round); the dialog + the switcher row + the dead-link hide — desktop-owned styles',
    anchor: `  <link rel="stylesheet" href="/css/desktop-logout.css?v=1">`,
    insert: `  <link rel="stylesheet" href="/css/desktop-newproject.css?v=1">`,
  },
  {
    name: 'insert /js/desktop-newproject.js after desktop-logout.js',
    cite: 'v0.1.11; the new-project controller — blocking, after the sign-out controller, before the deferred board scripts',
    anchor: `<script src="/js/desktop-logout.js"></script>`,
    insert: `<script src="/js/desktop-newproject.js"></script>`,
  },
  {
    // Generated-element anchor (the S217/S219 pattern): BOTH prior dialogs were
    // spliced in as SINGLE multi-line elements, so a bare '</dialog>' anchor now
    // matches TWO elements and must fail — the logout dialog's OWN confirm id
    // is unique, and inserting after ITS element lands the create dialog right
    // after the sign-out modal in the body chain.
    name: 'insert the #db-newproject-dialog markup after the logout dialog',
    cite: "v0.1.11; the WEB'S OWN native dialog system (dialog.dialog + .modal — components.css), the sync/logout modals' own grammar",
    anchor: `id="db-logout-confirm"`,
    insert: `  <!-- The new-project modal (v0.1.11 — the owner ask: "Add ability to
       define a new project, and get a kanban for it as well. this project then
       will be updated in hibana's cloudflare as a new project."). GENERATED by
       sync-island.mjs — never hand-edit. The WEB'S OWN native dialog
       (dialog.dialog + .modal, components.css — theme-aware + RTL-native for
       free); js/desktop-newproject.js wires the form to a LIVE cloud create:
       POST /api/projects {id: client UUID, title, description?, status:
       'planning'} through window.hibanaFetch — the shim's fetch seam into the
       bridge's ONE Request transport (the Go client stamps the Origin + the
       session cookie) — the web API's own idempotent-by-client-id contract
       (201 {ok,id} / 200 {ok,duplicate}), so the project EXISTS on the Hibana
       cloud the moment the dialog resolves; then the island's own
       /kanban?project=<id> deep-link boot loads the fresh board — the kanban
       for the new project, recorded as the last-used board by the island's own
       recordBoard. Every label rides the pin's own i18n keys (cmdk.newProject
       / sparks.title / sparks.description / cat.quickAdd / common.cancel); the
       body copy + the failure lines are the controller's own EN/FA pair.
       Create is the BARE <button> (the S186 CTA grammar); status:'planning'
       because the switcher's list excludes sparks (a spark would vanish from
       the very switcher it was created from). -->
  <dialog class="dialog" id="db-newproject-dialog" aria-labelledby="db-newproject-title">
    <form class="modal db-newproject-modal" id="db-newproject-form" method="dialog" novalidate>
      <h2 id="db-newproject-title" data-i18n="cmdk.newProject">New project</h2>
      <p class="small muted" id="db-newproject-body">Name the project — it is created on the Hibana cloud (hibana.ir) and its Kanban board opens right here.</p>
      <label><span data-i18n="sparks.title">Title</span>
        <input type="text" id="db-newproject-title-input" maxlength="200" autocomplete="off" spellcheck="false" dir="auto" required></label>
      <label><span data-i18n="sparks.description">Description</span>
        <textarea id="db-newproject-description" maxlength="2000" rows="3" dir="auto"></textarea></label>
      <p id="db-newproject-error" class="error" role="alert" hidden></p>
      <div class="db-newproject-actions">
        <button type="button" class="btn ghost small" id="db-newproject-cancel" data-i18n="common.cancel">Cancel</button>
        <button type="button" id="db-newproject-create" data-i18n="cat.quickAdd">Create</button>
      </div>
    </form>
  </dialog>`,
  },
]

// ---------------------------------------------------------------------------
// The v0.1.12 additions — the refresh round (the owner ask: "I tried
// something, deleted something from hibana, clicked sync on the app, but it
// didn't got deleted. it seems we need a refresh button"). The ROOT CAUSE the
// owner hit: the sync round DOES pull the boards (deletions included) into
// the Go MIRROR — but the island's own DOM kept the boot-time render, so the
// kanban on screen never re-fetched after a green sync: a task deleted on
// hibana.ir stayed visible until a manual restart. The round closes it on
// BOTH surfaces:
//
//   1. THE REFRESH BUTTON — a LABELED ghost pill right after the Sync CTA
//      (Sprints | Labels | Sync | Refresh | theme | Log out): clicking it
//      re-boots the island (location.reload — board-page.js pushState'd
//      ?project=, so a refresh re-enters the SAME board) and the boot
//      fetches ride the bridge's ALWAYS-FRESH interactive transport
//      (bindings.go RequestFresh — never the conditional poll), so the
//      cloud's truth — the deletion included — paints. The
//      always-there affordance the owner asked for.
//
//   2. THE SYNC ROUND'S OWN REFLEX — the round outcome now carries `pulled`
//      (the boards whose pull was a live 200 — the mirror rows that MOVED),
//      desktop-sync.js paints it in the ok panel ("2 board(s) updated from
//      the cloud — the board shows them when you close this."), and when
//      the modal closes (Done or Esc — both fire the native close event)
//      the island reloads, so the pulled deletions reach the VISIBLE board
//      — the exact gap "clicked sync, but it didn't got deleted". pulled=0
//      (all 304s — nothing changed server-side) reloads NOTHING: the screen
//      was already the truth.
//
// Go-side companions (this round's other half, main repo): SyncOnce now
// TOMBSTONES a mirror row whose board answered the web's gone state (404 —
// store.MarkProjectGone), so a project deleted on hibana.ir stops counting
// as live in the modal's own success line and stops being re-polled every
// round; the list pull owns resurrection (a fresh list row clears the
// tombstone via the upsert's excluded.deleted_at overwrite).
// ---------------------------------------------------------------------------
const HTML_REFRESH_OPS = [
  {
    name: 'insert /css/desktop-refresh.css after the newproject sheet (rtl.css stays the last ISLAND /css/ sheet)',
    cite: 'v0.1.12 (the refresh round); the toolbar Refresh button + the busy spin — desktop-owned styles',
    anchor: `  <link rel="stylesheet" href="/css/desktop-newproject.css?v=1">`,
    insert: `  <link rel="stylesheet" href="/css/desktop-refresh.css?v=1">`,
  },
  {
    name: 'insert /js/desktop-refresh.js after desktop-newproject.js',
    cite: 'v0.1.12; the refresh controller — blocking, after the new-project controller, before the deferred board scripts',
    anchor: `<script src="/js/desktop-newproject.js"></script>`,
    insert: `<script src="/js/desktop-refresh.js"></script>`,
  },
  {
    // Generated-line anchor: the sync round emitted the CTA line above; at
    // this op's turn exactly ONE line carries the sync button's own class+id
    // pair, so the Refresh pill lands right after it:
    // Sprints | Labels | Sync | Refresh | theme | Log out (FA/RTL mirrors
    // the whole row — Refresh lands between Sync and theme under RTL too).
    name: 'insert the #db-refresh-button toolbar button right after the Sync CTA (v0.1.12: the pull-to-screen affordance)',
    cite: "v0.1.12 (the owner ask: 'I tried something, deleted something from hibana, clicked sync on the app, but it didn't got deleted. it seems we need a refresh button'); a VISIBLE, LABELED ghost (the S220 lesson + the row's grammar: Sync stays the ONE colored action), twin metrics with Sprints/Labels/Sync/Log out",
    anchor: `class="small db-sync-cta" id="db-sync-button"`,
    insert: `      <!-- v0.1.12 (the owner ask: "I tried something, deleted something
           from hibana, clicked sync on the app, but it didn't got deleted.
           it seems we need a refresh button"): the toolbar's Refresh button —
           the pull-to-screen affordance right after the Sync CTA. The sync
           round pulls the boards into the Go MIRROR, but the island's own
           DOM kept the boot-time render, so a deletion made on hibana.ir
           stayed on screen even after a green sync; clicking Refresh
           re-boots the island (board-page.js pushState'd ?project= — the
           refresh re-enters the SAME board) and the boot fetches ride the
           bridge's always-fresh interactive transport, so the cloud's truth
           — the deletion included — paints. Ghost on purpose (Sync stays
           the ONE colored action in the row); js/desktop-refresh.js owns
           the click + the EN/FA label; desktop-sync.js grew the same reflex
           for the sync round itself (an ok round that pulled boards
           reloads the board when the modal closes). -->
      <button type="button" class="btn ghost small" id="db-refresh-button" aria-label="Refresh board" title="Refresh board"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/></svg><span id="db-refresh-btn-label">Refresh</span></button>`,
  },
]

// ---------------------------------------------------------------------------
// The v0.1.14 additions — THE AUTO-UPDATE ROUND (the owner ask: "Add an auto
// update for the app. when the new version releases in the github, app syncs
// with the internet and github, and if new version, whether portable or
// installer released, show a button for update. it must update from github
// and replace without losing data or needing user to re login."). The Go
// half (internal/update + internal/ui/update.go + main.go's updateLoop)
// checks github.com/assadigit/hibana-desktop/releases/latest every boot +
// every 2 hours against the -X stamped main.Version, downloads the release's
// own asset (the portable zip preferred — the self-replace; the NSIS
// installer the fallback — "whether portable or installer released"),
// verifies BOTH the asset hash AND (for the zip) the embedded hibana.exe
// hash against the release's own checksums.txt, and swaps the exe via a
// DETACHED PowerShell helper that waits for the app to exit — the data dir
// (session.bin + mirror.db — the never-mix rule) is never on the replace
// path, so the relaunched exe boots straight back into the board: no
// re-login, nothing lost.
//
// THE ISLAND HALF here: a LABELED Update pill that is HIDDEN until the
// hibana:update-available event says a newer release exists (right after
// Refresh — the row: Sprints | Labels | Sync | Refresh | Update | theme |
// Log out), the web's own native dialog grammar for the update modal
// (version line + kind/size + the progress bar + the restarting panel),
// js/desktop-update.js as the controller (EventsOn the two update events +
// the ApplyUpdate binding at click time), and css/desktop-update.css for
// the pill's solid --ok green (the ONE colored grammar distinct from Sync's
// teal CTA — an update is the row's "good news" action) + the bar + the
// reduced-motion discipline.
// ---------------------------------------------------------------------------
const HTML_UPDATE_OPS = [
  {
    name: 'insert /css/desktop-update.css after the refresh sheet (rtl.css stays the last ISLAND /css/ sheet)',
    cite: 'v0.1.14 (the auto-update round); the toolbar Update pill + the modal progress bar — desktop-owned styles',
    anchor: `  <link rel="stylesheet" href="/css/desktop-refresh.css?v=1">`,
    insert: `  <link rel="stylesheet" href="/css/desktop-update.css?v=1">`,
  },
  {
    name: 'insert /js/desktop-update.js after desktop-refresh.js',
    cite: 'v0.1.14; the update controller — blocking, after the refresh controller, before the deferred board scripts',
    anchor: `<script src="/js/desktop-refresh.js"></script>`,
    insert: `<script src="/js/desktop-update.js"></script>`,
  },
  {
    // Generated-element anchor (the S217/S219/S223 pattern): the newproject
    // dialog was spliced in as ONE multi-line element carrying its own
    // create-button id — unique, so inserting after that ELEMENT lands the
    // update dialog right after the newproject modal in the body chain.
    name: 'insert the #db-update-dialog markup after the newproject dialog',
    cite: "v0.1.14; the WEB'S OWN native dialog system (dialog.dialog + .modal — components.css) + the sync panel's own .db-sync-panel grammar (class-reused, kind-styled)",
    anchor: `id="db-newproject-create"`,
    insert: `  <!-- The auto-update modal (v0.1.14 — the owner ask: "Add an auto update
       for the app. when the new version releases in the github, app syncs
       with the internet and github, and if new version, whether portable or
       installer released, show a button for update. it must update from
       github and replace without losing data or needing user to re login.").
       GENERATED by sync-island.mjs — never hand-edit. The WEB'S OWN native
       dialog (dialog.dialog + .modal, components.css — theme-aware +
       RTL-native for free); js/desktop-update.js wires the toolbar's
       #db-update-button (HIDDEN until the Go shell's updateLoop finds a
       newer github release — hibana:update-available) and the modal's
       "Update now" to the Go ApplyUpdate binding (internal/ui update.go:
       updater.Prepare downloads + verifies the asset against the release's
       own checksums.txt — the zip's embedded hibana.exe too — then
       updater.Apply spawns the DETACHED helper that waits for this process
       to exit, swaps the exe, relaunches it; the app quits ~1.5s after the
       {ok:true} resolve so this restarting panel is on screen when the
       window goes). The DATA dir (session.bin + mirror.db) is never on the
       replace path — the relaunched exe boots straight back into the board,
       no re-login. The progress bar rides the live hibana:update-progress
       events {stage,received,total,pct}; the panel reuses the sync modal's
       own .db-sync-panel grammar. -->
  <dialog class="dialog" id="db-update-dialog" aria-labelledby="db-update-title">
    <form class="modal db-update-modal" method="dialog">
      <h2 id="db-update-title">A new version is available</h2>
      <p id="db-update-version">Hibana 0.1.13 → 0.1.14</p>
      <p class="small muted" id="db-update-kind">Portable update — 7.6 MB from GitHub</p>
      <p class="small muted" id="db-update-body">Your boards and your sign-in stay exactly as they are — Hibana just restarts into the new version.</p>
      <div class="db-update-progress" id="db-update-progress" data-stage="download" hidden>
        <div class="db-update-bar"><span class="db-update-fill" id="db-update-fill"></span></div>
        <span class="db-update-note" id="db-update-note">Downloading — 0%</span>
      </div>
      <div class="db-sync-panel" id="db-update-panel" data-kind="ok" hidden>
        <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>
        <div><strong id="db-update-panel-title">Update ready — restarting…</strong><p class="small muted" id="db-update-panel-body"></p></div>
      </div>
      <p id="db-update-error" class="error" role="alert" hidden></p>
      <!-- v0.1.19 (the owner ask: "auto-open release page when an apply
           fails"): the Go bridge opens the release's human page in the
           system browser on EVERY failed apply verdict and flags the
           resolve {pageOpened:true}; this line says so — and only shows
           when the flag is true, so a machine where the open could not
           happen never claims a page nobody saw. -->
      <p class="small muted" id="db-update-fallback" hidden></p>
      <div class="db-sync-actions">
        <button type="button" class="btn ghost small" id="db-update-later">Later</button>
        <button type="button" id="db-update-go">Update now</button>
      </div>
    </form>
  </dialog>`,
  },
  {
    // Generated-line anchor: the refresh round emitted the Refresh pill as
    // its own element carrying the unique class+id pair, so the Update pill
    // lands right after it: Sprints | Labels | Sync | Refresh | Update |
    // theme | Log out (FA/RTL mirrors the whole row — Update sits between
    // Refresh and theme under RTL too).
    name: 'insert the #db-update-button toolbar button right after the Refresh pill (v0.1.14: the auto-update affordance)',
    cite: "v0.1.14 (the owner ask: 'if new version, whether portable or installer released, show a button for update'); a VISIBLE, LABELED solid-green pill that is HIDDEN until a newer GitHub release exists (the hibana:update-available event removes the hidden attr), twin metrics with Sprints/Labels/Sync/Refresh",
    anchor: `class="btn ghost small" id="db-refresh-button"`,
    insert: `      <!-- v0.1.14 (the owner ask: "Add an auto update for the app. when
           the new version releases in the github, app syncs with the
           internet and github, and if new version, whether portable or
           installer released, show a button for update"): the toolbar's
           Update pill — HIDDEN at boot (no update = no button, the honest
           default), revealed by js/desktop-update.js the moment the Go
           shell's updateLoop finds a newer release (the hibana:update-
           available event). Solid GREEN (--ok — the island's own success
           grammar; light theme #1f7a34 with white ink, claude-dark olive
           #9BA77A with dark ink) so it reads as the row's good news, at the
           same twin metrics as Sprints/Labels/Sync/Refresh; the up-arrow
           glyph + the desktop-owned EN 'Update' / FA 'نسخهٔ جدید' label.
           Clicking opens #db-update-dialog, whose "Update now" rides the Go
           ApplyUpdate binding — the download is verified against the
           release's own checksums.txt, the exe swap waits for the app to
           quit (a detached helper), and the relaunched exe boots straight
           back into the board: the data dir (session + mirror) is never on
           the replace path — no re-login, nothing lost. -->
      <button type="button" class="small db-update-cta" id="db-update-button" hidden aria-label="Update Hibana now" title="Update Hibana now"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg><span id="db-update-btn-label">Update</span></button>`,
  },
]

// ---------------------------------------------------------------------------
// The v0.1.17 additions — THE SETTINGS PAGE (the owner ask 2026-10-26: "Plan
// for a settings page for hibana's desktop" with exactly four sections, in
// the owner's order: 1. Sync 2. Update app — "check the latest release of
// github, if there were newer version. update." 3. Login/logout 4. fa/en and
// dark mode/light mode; docs/SETTINGS-PAGE-PLAN.md). A COMPOSITION round:
// three of the four sections are surface work over LIVE, proven rounds (the
// sync modal, the auto-update modal, the logout confirm, SetTheme), and only
// language (fa/en) is a genuinely new capability — the Go SetLanguage
// binding (internal/ui/settings.go), which PATCHes /api/settings through
// the same session/Origin machinery, un-stales the a.me snapshot under the
// same mutex AuthState reads, and emits hibana:lang; the serve-time
// <html lang dir> stamping (InjectShellState's new lang param) kills the FA
// first-paint flash every FA boot had since v0.1.0.
//
// THE SURFACE: one native <dialog> (#db-settings-dialog, the dialog-wide
// grammar — the web's own settings page compressed into the app's modal
// vocabulary) opened from the toolbar's gear (#db-settings-button, a ghost
// icon button in the account zone after the theme toggle and before Sign
// out: Sprints | Labels | Sync | Refresh | Update | theme | ⚙ | Log out).
// The title rides the pin's own nav.settings key; Sign out rides
// nav.signout; everything else is the controller's own EN/FA pair (the
// desktop-update.js STR pattern). Sections delegate: Sync now / Update now /
// Sign out are programmatic clicks on the PROVEN toolbar buttons (zero new
// flows — the settings sheet closes itself first so the modals never
// stack); Check for updates is the bound CheckForUpdates verdict; the theme
// segmented control rides SetTheme (the tray's full 3-state vocabulary);
// the language segmented control rides SetLanguage → the live chrome flip →
// the ~700ms reload reflex (i18n.js's dynamic-markup law makes a live-only
// flip dishonest — the board would stay in the old language).
// ---------------------------------------------------------------------------
const HTML_SETTINGS_OPS = [
  {
    name: 'insert /css/desktop-settings.css after the update sheet (rtl.css stays the last ISLAND /css/ sheet)',
    cite: 'v0.1.17 (the settings round); the gear button + the four-section sheet — desktop-owned styles',
    anchor: `  <link rel="stylesheet" href="/css/desktop-update.css?v=1">`,
    insert: `  <link rel="stylesheet" href="/css/desktop-settings.css?v=1">`,
  },
  {
    name: 'insert /js/desktop-settings.js after desktop-update.js',
    cite: 'v0.1.17; the settings controller — blocking, after the update controller, before the deferred board scripts',
    anchor: `<script src="/js/desktop-update.js"></script>`,
    insert: `<script src="/js/desktop-settings.js"></script>`,
  },
  {
    // Generated-element anchor (the S217/S219/S223/S225 pattern): the update
    // dialog was spliced in as ONE multi-line element carrying its own
    // action-button id — unique, so inserting after that ELEMENT lands the
    // settings dialog right after the update modal in the body chain.
    name: 'insert the #db-settings-dialog markup after the update dialog',
    cite: "v0.1.17; the WEB'S OWN wide-dialog grammar (dialog.dialog dialog-wide + .modal — components.css), the owner's four sections in order",
    anchor: `id="db-update-go"`,
    insert: `  <!-- The settings page (v0.1.17 — the owner ask: "Plan for a settings
       page for hibana's desktop" with four sections: 1. Sync 2. Update app
       3. Login/logout 4. fa/en + dark mode/light mode). GENERATED by
       sync-island.mjs — never hand-edit. A COMPOSITION round: one WIDE
       native dialog (dialog.dialog dialog-wide + .modal, components.css —
       theme-aware + RTL-native for free) opened from the toolbar's gear
       (#db-settings-button — the account zone between the theme toggle and
       Sign out). Sync now / Update now / Sign out DELEGATE to the proven
       toolbar buttons' flows (js/desktop-settings.js closes this sheet
       first, then clicks #db-sync-button / #db-update-button /
       #db-logout-button — the modals never stack, zero new rounds);
       Check for updates rides the bound CheckForUpdates verdict (the
       auto-update loop keeps checking boot + 2h untouched — this row is
       the manual trigger + the idle-time surface the owner asked for);
       v0.1.18 adds the GitHub-access row (SetGithubToken /
       GithubTokenState — an optional PAT stored Go-side in the DATA dir
       riding every release request as a Bearer header: anonymous stays the
       default, a private flip keeps updating, and the shared-IP 60/hr
       budget lifts to 5000/hr);
       the theme segmented control rides SetTheme (the tray's full
       light | claude-dark | system vocabulary — an upgrade over the
       toolbar's binary flip, which stays as the quick flip); the language
       segmented control rides the ONE new Go binding, SetLanguage
       (internal/ui settings.go: PATCH /api/settings {language_pref} →
       the a.me snapshot un-stales → hibana:lang), then flips the chrome
       live (html[lang]/dir + hibanaI18n.apply()) and reloads after ~700ms
       so the BOARD re-renders in the new language. The title rides the
       pin's own nav.settings key; Sign out + the gear's aria ride
       nav.signout / nav.settings; the rest is the controller's own
       EN/FA pair. The Go shell serves this document with lang/dir/
       data-desktop-lang stamped from the live session (InjectShellState)
       — an FA account paints FA/RTL at the FIRST frame, and the
       post-flip reload is seamless. -->
  <dialog class="dialog dialog-wide" id="db-settings-dialog" aria-labelledby="db-settings-title">
    <form class="modal db-settings-modal" method="dialog">
      <h2 id="db-settings-title" data-i18n="nav.settings">Settings</h2>

      <!-- 1. SYNC (the owner's first section): the copy names the cadence,
           the CTA delegates to the proven round. -->
      <section class="db-settings-section">
        <h3 class="db-settings-heading" id="db-settings-sync-heading">Sync</h3>
        <p class="small muted" id="db-settings-sync-body">Boards sync on launch and every 5 minutes. A manual round uploads local changes first, then pulls the cloud's truth.</p>
        <div class="db-settings-actions">
          <button type="button" class="btn small" id="db-settings-sync-now"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/></svg><span id="db-settings-sync-now-label">Sync now</span></button>
        </div>
      </section>

      <!-- 2. UPDATE APP (the owner's second section — "check the latest
           release of github, if there were newer version. update."): the
           version line from AppInfo, the manual check verdict, the
           Update-now delegation to the proven update modal, and (v0.1.18)
           the GitHub-access row — the owner ask: "hibana desktop might be
           a private repo so in setting, add a github credentials so it can
           connect to the private repo". -->
      <section class="db-settings-section">
        <h3 class="db-settings-heading" id="db-settings-update-heading">Update app</h3>
        <p class="db-settings-version" id="db-settings-version">Hibana — island unpinned</p>
        <p class="small muted" id="db-settings-update-status"></p>
        <p id="db-settings-update-error" class="error" role="alert" hidden></p>
        <div class="db-settings-actions">
          <button type="button" class="btn ghost small" id="db-settings-check"><span id="db-settings-check-label">Check for updates</span></button>
          <button type="button" class="small db-update-cta" id="db-settings-update-now" hidden><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg><span id="db-settings-update-now-label">Update now</span></button>
        </div>
        <!-- v0.1.18: the GitHub-access row — a PAT the Go shell stores in
             the DATA dir (github-token, 0600) and attaches to every
             release check + asset download + checksums fetch as a Bearer
             header. Anonymous stays the DEFAULT (the repo is public); the
             token covers the private flip + the 60/hr → 5000/hr rate
             budget. The value crosses the bridge ONCE (SetGithubToken —
             the login password's discipline; Enter in the field saves,
             never submits the dialog form); only the ghp_…ABCD hint ever
             crosses back (GithubTokenState). A saved token immediately
             re-checks (js/desktop-settings.js clicks #db-settings-check)
             — the owner's connect-now ask. v0.1.19 adds the TEST button
             (the owner ask: "Yes add a test connection"): one cheap
             GET /repos/<repo> through the Go TestGithubConnection binding —
             with the field's value when one is typed, else the stored
             token, else the honest anonymous round — and NOTHING is
             written: the verdict tells the row whether the next check
             will see the repository before anything is saved or spent. -->
        <div class="db-settings-row db-settings-token-row">
          <span class="db-settings-row-label" id="db-settings-token-label">GitHub access</span>
          <div class="db-settings-token">
            <input type="password" id="db-settings-token-input" autocomplete="off" spellcheck="false" placeholder="ghp_… (optional)" aria-label="GitHub personal access token" />
            <button type="button" class="btn ghost small" id="db-settings-token-test"><span id="db-settings-token-test-label">Test</span></button>
            <button type="button" class="btn ghost small" id="db-settings-token-save"><span id="db-settings-token-save-label">Save</span></button>
            <button type="button" class="btn ghost small" id="db-settings-token-clear" hidden><span id="db-settings-token-clear-label">Remove</span></button>
          </div>
        </div>
        <p class="small muted" id="db-settings-token-status"></p>
        <p id="db-settings-token-error" class="error" role="alert" hidden></p>
      </section>

      <!-- 3. ACCOUNT (the owner's third section): the identity from
           AuthState, the sign-out delegation to the proven confirm. -->
      <section class="db-settings-section">
        <h3 class="db-settings-heading" id="db-settings-account-heading">Account</h3>
        <p class="db-settings-account" id="db-settings-account"></p>
        <p class="small muted" id="db-settings-account-body">Your boards live safe on the Hibana cloud — sign in again any time.</p>
        <div class="db-settings-actions">
          <button type="button" class="btn ghost small" id="db-settings-signout" data-i18n="nav.signout">Sign out</button>
        </div>
      </section>

      <!-- 4. APPEARANCE (the owner's fourth section — "fa/en and dark mode/
           light mode"): the two segmented controls, label column + control
           column. Language = the round's one NEW capability (SetLanguage);
           Theme = the tray's full 3-state vocabulary through SetTheme. -->
      <section class="db-settings-section">
        <h3 class="db-settings-heading" id="db-settings-appearance-heading">Appearance</h3>
        <div class="db-settings-row">
          <span class="db-settings-row-label" id="db-settings-lang-label">Language</span>
          <div class="db-settings-seg" id="db-settings-lang-seg" role="group" aria-labelledby="db-settings-lang-label">
            <button type="button" class="db-settings-seg-btn" id="db-settings-lang-en" data-seg-lang="en" aria-pressed="false">English</button>
            <button type="button" class="db-settings-seg-btn" id="db-settings-lang-fa" data-seg-lang="fa" aria-pressed="false">فارسی</button>
          </div>
        </div>
        <p id="db-settings-lang-error" class="error" role="alert" hidden></p>
        <div class="db-settings-row">
          <span class="db-settings-row-label" id="db-settings-theme-label">Theme</span>
          <div class="db-settings-seg" id="db-settings-theme-seg" role="group" aria-labelledby="db-settings-theme-label">
            <button type="button" class="db-settings-seg-btn" id="db-settings-theme-light" data-seg-theme="light" aria-pressed="false">Light</button>
            <button type="button" class="db-settings-seg-btn" id="db-settings-theme-claude-dark" data-seg-theme="claude-dark" aria-pressed="false">Dark</button>
            <button type="button" class="db-settings-seg-btn" id="db-settings-theme-system" data-seg-theme="system" aria-pressed="false">System</button>
          </div>
        </div>
      </section>

      <div class="db-settings-actions db-settings-footer">
        <button type="button" class="btn small" id="db-settings-done"><span id="db-settings-done-label">Done</span></button>
      </div>
    </form>
  </dialog>`,
  },
  {
    // Generated-element anchor: the theme round emitted the toggle as its
    // own comment+button element (the logout round's own anchor pattern),
    // and the logout button landed right after it. Anchoring at the theme
    // element's unique id inserts the gear AFTER the whole theme element and
    // BEFORE the logout element — the account zone the plan pins:
    // Sprints | Labels | Sync | Refresh | Update | theme | ⚙ Settings | Log out.
    name: 'insert the #db-settings-button toolbar button after the theme toggle (the account zone, before Sign out)',
    cite: "v0.1.17 (the settings page plan §1.2); the pin's own nav.settings key on aria+title — a ghost icon button (chrome, not a CTA: Sync stays the row's one colored action)",
    anchor: `id="db-theme-toggle"`,
    insert: `      <!-- v0.1.17 (the owner ask: "Plan for a settings page for hibana's
           desktop"): the toolbar's settings gear — a ghost icon button in
           the account zone (after the theme toggle, before Sign out). The
           feather settings glyph; the pin's own nav.settings key on
           aria-label + title (EN 'Settings' / FA 'تنظیمات'). Ghost on
           purpose: Settings is chrome, not a CTA — Sync stays the row's ONE
           colored action. Clicking opens #db-settings-dialog, the wide
           native sheet with the owner's four sections (Sync · Update app ·
           Account · Appearance); js/desktop-settings.js owns the flow. -->
      <button type="button" class="btn ghost small" id="db-settings-button" aria-label="Settings" data-i18n-aria-label="nav.settings" title="Settings" data-i18n-title="nav.settings"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>`,
  },
]

function adaptBoardHtml(html) {
  const lines = html.split('\n')
  const log = []
  for (const op of HTML_STRIP_LINES) {
    const hits = lines.filter((l) => l.trim() === op.line)
    if (hits.length !== 1) {
      fail('HTML op "' + op.name + '" (' + op.cite + ') matched ' + hits.length +
        ' lines (expected exactly 1) at ref ' + PIN_REF + ' — board.html drifted; re-record the op in sync-island.mjs (guide §3.3.4).')
    }
    const idx = lines.findIndex((l) => l.trim() === op.line)
    lines.splice(idx, 1)
    log.push('stripped : ' + op.name)
  }
  {
    const anchorIdx = lines.findIndex((l) => l.includes(HTML_INSERT.anchor))
    if (anchorIdx === -1 || lines.filter((l) => l.includes(HTML_INSERT.anchor)).length !== 1) {
      fail('HTML op "' + HTML_INSERT.name + '" (' + HTML_INSERT.cite + '): anchor tag not found (or not unique) at ref ' +
        PIN_REF + ' — devboard.js\'s <script> tag drifted; re-record the anchor in sync-island.mjs.')
    }
    lines.splice(anchorIdx, 0, HTML_INSERT.insert)
    log.push('inserted: ' + HTML_INSERT.name)
  }
  for (const op of HTML_INSERTS_AFTER) {
    const hits = lines.map((l, i) => (l.includes(op.anchor) ? i : -1)).filter((i) => i !== -1)
    if (hits.length !== 1) {
      fail('HTML op "' + op.name + '" (' + op.cite + '): anchor found ' + hits.length +
        ' times (expected exactly 1) — board.html or a prior insert drifted; re-record the op in sync-island.mjs.')
    }
    lines.splice(hits[0] + 1, 0, op.insert)
    log.push('inserted: ' + op.name)
  }
  {
    const gateIdx = lines.findIndex((l) => l.trim() === HTML_GATE_INSERT.anchor)
    const gateHits = lines.filter((l) => l.trim() === HTML_GATE_INSERT.anchor).length
    if (gateIdx === -1 || gateHits !== 1) {
      fail('HTML op "' + HTML_GATE_INSERT.name + '" (' + HTML_GATE_INSERT.cite + '): <body> tag found ' +
        gateHits + ' times (expected exactly 1) at ref ' + PIN_REF + ' — board.html drifted; re-record the anchor.')
    }
    lines.splice(gateIdx + 1, 0, HTML_GATE_INSERT.insert)
    log.push('inserted: ' + HTML_GATE_INSERT.name)
  }
  // The v0.1.5 theme round + the v0.1.6 sync round + the v0.1.9 sign-out round
  // + the v0.1.11 new-project round + the v0.1.12 refresh round + the v0.1.13
  // sound round + the v0.1.14 update round + the v0.1.17 settings round
  // (recorded above, per-round, in the order the head/body chain requires —
  // each op's anchor must already exist when the op runs: the theme script
  // rides the PINNED chip-render line, the floater rides the gate block
  // HTML_GATE_INSERT just emitted, the toolbar toggle rides the PINNED labels
  // line, the sync sheet/script ride the desktop login lines emitted above,
  // the dialog rides the PINNED skip-link, the sync button rides the toggle
  // line the theme round just inserted; the logout sheet/script ride the sync
  // round's own emitted lines, the logout dialog rides the sync dialog's
  // closing line, and the logout button rides the theme toggle line — the row
  // ends Sprints | Labels | Sync | theme | Log out; the newproject sheet/script
  // ride the logout round's own emitted lines, and the create dialog rides
  // the logout dialog's OWN confirm id — a bare '</dialog>' anchor now
  // matches BOTH spliced dialog elements and must never be used again; the
  // refresh sheet/script ride the newproject round's own emitted lines, and
  // the Refresh pill rides the sync CTA's own class+id pair — the row ends
  // Sprints | Labels | Sync | Refresh | theme | Log out; the audio script
  // rides the SHIM'S OWN tag — whichever order the rounds apply in, it lands
  // between the shim and the login controller (the login insert rides the
  // same anchor but emits a DIFFERENT line, so both stay unambiguous); the
  // update sheet/script ride the refresh round's own emitted lines, the
  // update dialog rides the newproject dialog's OWN create-button id, and
  // the Update pill rides the Refresh pill's own class+id pair; the settings
  // sheet/script ride the update round's own emitted lines, the settings
  // dialog rides the update dialog's OWN go-button id, and the gear button
  // rides the theme toggle's OWN id — inserting after the whole theme element
  // lands the gear BEFORE the logout element (the account zone: Sprints |
  // Labels | Sync | Refresh | Update | theme | ⚙ | Log out).
  for (const op of [...HTML_THEME_OPS, ...HTML_SYNC_OPS, ...HTML_LOGOUT_OPS, ...HTML_NEWPROJECT_OPS, ...HTML_REFRESH_OPS, ...HTML_AUDIO_OPS, ...HTML_UPDATE_OPS, ...HTML_SETTINGS_OPS]) {
    if (op.anchor !== undefined) {
      const hits = lines.map((l, i) => (l.includes(op.anchor) ? i : -1)).filter((i) => i !== -1)
      if (hits.length !== 1) {
        fail('HTML op "' + op.name + '" (' + op.cite + '): anchor found ' + hits.length +
          ' times (expected exactly 1) — board.html or a prior insert drifted; re-record the op in sync-island.mjs.')
      }
      lines.splice(hits[0] + 1, 0, op.insert)
      log.push('inserted: ' + op.name)
    } else {
      // op.find/op.replace — the SEAM_PATCHES discipline applied to the html: an
      // exact-string find→replace that must match EXACTLY ONCE or the sync fails
      // loudly (used where the anchor sits INSIDE a multi-line element this script
      // already spliced in — a line anchor cannot reach there).
      const occurrences = lines.reduce((n, l) => n + l.split(op.find).length - 1, 0)
      if (occurrences !== 1) {
        fail('HTML op "' + op.name + '" (' + op.cite + '): find string matched ' + occurrences +
          ' times (expected exactly 1) — board.html or a prior insert drifted; re-record the op in sync-island.mjs.')
      }
      const idx = lines.findIndex((l) => l.includes(op.find))
      lines[idx] = lines[idx].replace(op.find, op.replace)
      log.push('inserted: ' + op.name)
    }
  }
  return { html: lines.join('\n'), log }
}

// ---------------------------------------------------------------------------
// The seam patches (guide §4.1 the 12 verified sites / §4.2 the patch strategy).
// Each is an EXACT recorded string replace applied to the COPY in dist — hibana-source
// is never touched. A miss = web drift = the sync FAILS LOUDLY (the tripwire).
// The callers' opts objects (cache:'no-store', headers, signal) are kept INTACT in the
// copies — hibanaFetch ignores cache headers; the Go client owns real caching, the
// cookie jar, the Origin header on writes, the ETag store and the 3s+retry contract
// (guide §4.2.1: the web's workaround becomes the desktop's real contract, §5.1).
// ---------------------------------------------------------------------------
const SEAM_PATCHES = [
  // ---- devboard.js ----
  {
    file: 'js/devboard.js',
    name: 'api() choke point — devboard.js:33 (guide §4.1 site 1, §4.2.1)',
    find: "    const send = (signal) => fetch(path, { ...opts, cache: 'no-store', signal })",
    replace: "    const send = (signal) => window.hibanaFetch(path, { ...opts, cache: 'no-store', signal })",
  },
  {
    file: 'js/devboard.js',
    name: 'label manager: GET /api/tags — devboard.js:1288 (guide §4.1 site 2)',
    find: "const res = await fetch('/api/tags', { cache: 'no-store' })",
    replace: "const res = await window.hibanaFetch('/api/tags', { cache: 'no-store' })",
  },
  {
    file: 'js/devboard.js',
    name: 'label manager: PATCH rename (merge-on-collide) — devboard.js:1344 (guide §4.1 site 3)',
    find: "const res = await fetch('/api/tags/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name }) })",
    replace: "const res = await window.hibanaFetch('/api/tags/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name }) })",
  },
  {
    file: 'js/devboard.js',
    name: 'label manager: PATCH recolor — devboard.js:1360 (guide §4.1 site 4)',
    find: "const res = await fetch('/api/tags/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ color: sw.dataset.color }) })",
    replace: "const res = await window.hibanaFetch('/api/tags/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ color: sw.dataset.color }) })",
  },
  {
    file: 'js/devboard.js',
    name: 'label manager: POST merge — devboard.js:1380 (guide §4.1 site 5)',
    find: "const res = await fetch('/api/tags/' + id + '/merge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ into: into }) })",
    replace: "const res = await window.hibanaFetch('/api/tags/' + id + '/merge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ into: into }) })",
  },
  {
    file: 'js/devboard.js',
    name: 'label manager: DELETE unused tag — devboard.js:1390 (guide §4.1 site 6)',
    find: "const res = await fetch('/api/tags/' + id, { method: 'DELETE' })",
    replace: "const res = await window.hibanaFetch('/api/tags/' + id, { method: 'DELETE' })",
  },
  {
    // XHR site 1 of 2 — the raw-bytes upload path (S208 uploader). Unique context: the
    // FileReader onload that stages base64 bytes.
    file: 'js/devboard.js',
    name: 'uploader XHR (raw path) — devboard.js:337 (guide §4.1 site 7, §4.2.3)',
    find: "      reader.onload = () => {\n        const b64 = String(reader.result).split(',')[1]\n        const xhr = new XMLHttpRequest()",
    replace: "      reader.onload = () => {\n        const b64 = String(reader.result).split(',')[1]\n        const xhr = new window.hibanaXHR()",
  },
  {
    // XHR site 2 of 2 — the ≤1600px WebP-resized upload path. Unique context: the
    // small-file raw-continue branch above it.
    file: 'js/devboard.js',
    name: 'uploader XHR (resized path) — devboard.js:367 (guide §4.1 site 8, §4.2.3)',
    find: "          if (!main) { pendingThumb = thumb; reader.readAsDataURL(file); return } // small file — raw bytes + tile\n          if (prepareAborted) return reject(new Error('aborted'))\n          const xhr = new XMLHttpRequest()",
    replace: "          if (!main) { pendingThumb = thumb; reader.readAsDataURL(file); return } // small file — raw bytes + tile\n          if (prepareAborted) return reject(new Error('aborted'))\n          const xhr = new window.hibanaXHR()",
  },
  // ---- board-page.js ----
  {
    file: 'js/board-page.js',
    name: 'project switcher: GET /api/projects?sort=recent — board-page.js:287 (guide §4.1 site 9)',
    find: "const r = await fetch('/api/projects?sort=recent')",
    replace: "const r = await window.hibanaFetch('/api/projects?sort=recent')",
  },
  {
    file: 'js/board-page.js',
    name: 'delete confirm: DELETE /api/devtasks/:id — board-page.js:579 (guide §4.1 site 10)',
    find: "const r = await fetch('/api/devtasks/' + id, { method: 'DELETE' })",
    replace: "const r = await window.hibanaFetch('/api/devtasks/' + id, { method: 'DELETE' })",
  },
  {
    file: 'js/board-page.js',
    name: 'archive-done: POST /api/projects/:id/devtasks/archive-done — board-page.js:741 (guide §4.1 site 11)',
    find: "fetch('/api/projects/' + projectId + '/devtasks/archive-done', { method: 'POST' })",
    replace: "window.hibanaFetch('/api/projects/' + projectId + '/devtasks/archive-done', { method: 'POST' })",
  },
  {
    file: 'js/board-page.js',
    name: 'clear-done: DELETE fan-out — board-page.js:761 (guide §4.1 site 12)',
    find: "Promise.all(ids.map((id) => fetch('/api/devtasks/' + id, { method: 'DELETE' })))",
    replace: "Promise.all(ids.map((id) => window.hibanaFetch('/api/devtasks/' + id, { method: 'DELETE' })))",
  },
]

function applySeamPatches(fileMap) {
  const log = []
  for (const patch of SEAM_PATCHES) {
    const content = fileMap[patch.file]
    if (content == null) fail('seam patch "' + patch.name + '": file ' + patch.file + ' not in the copy map.')
    const occurrences = content.split(patch.find).length - 1
    if (occurrences === 0) {
      fail('seam patch "' + patch.name + '" — search string NOT FOUND at ref ' + PIN_REF +
        ' (web drift; guide §4.1 site list). Locate the moved site, re-record the exact find/replace in sync-island.mjs, re-run. Never hand-edit dist.')
    }
    if (occurrences > 1) {
      fail('seam patch "' + patch.name + '" — search string matched ' + occurrences +
        ' sites (expected 1); the recorded context is no longer unique at ' + PIN_REF + '. Re-record with more context.')
    }
    fileMap[patch.file] = content.replace(patch.find, patch.replace)
    log.push('patched : ' + patch.name)
  }
  return log
}

// ---------------------------------------------------------------------------
// desktop-shim.js — generated below into dist/js/ (guide §4.3: the M2-era NEW island
// file — v0.1.5/v0.1.6 added desktop-theme.js + desktop-sync.js + desktop-sync.css
// below). Written without template literals/backticks so it can nest in this literal.
// ---------------------------------------------------------------------------
const DESKTOP_SHIM_JS = `// desktop-shim.js — the transport + toast + page-lifecycle shim for the embedded island.
// GENERATED FILE — do not hand-edit (guide §3.3.4): emitted by scripts/sync-island.mjs
// into frontend/dist/js/ and checksummed in frontend/island.checksums.json.
//
// WHAT THIS FILE OWNS (GO-DESKTOP-IMPLEMENTATION-GUIDE.md §4.3 — the only NEW island
// file; loads BEFORE devboard.js/board-page.js):
//   1. window.hibanaFetch  — the fetch-compatible transport seam to the Go bridge.
//      The sync rebinds the 12 verified call sites to it (guide §4.1/§4.2):
//      devboard.js api() choke point (devboard.js:33) + 5 label-manager fetches
//      (:1288/:1344/:1360/:1380/:1390) + board-page.js's 4 direct fetches
//      (:287/:579/:741/:761). Response shape mirrors fetch so callers that check
//      err.status keep working (devboard.js:54-63).
//   2. window.hibanaXHR    — the XMLHttpRequest-compatible upload proxy for the S208
//      uploader (devboard.js:337/:367). The Go streaming upload is spec'd in guide
//      §5.4; v0.1.15 wires it LIVE — the bound Upload call rides the same session/
//      Origin machinery as the fetch seam, and real byte progress flows back through
//      the hibana:upload-progress events (a dev island without the binding still
//      fails fast and LOUD with a named not-wired error).
//   3. window.hibana.toast — the app.js toast component contract (app.js:243-323 @
//      e6661c8), reimplemented 1:1 as WEB TOASTS (identical in WebView2 —
//      UI-UX-REPLICATION-SPEC.md §7.2). ZERO network use.
//   4. window.__hibanaPage — the minimal page-lifecycle consumer (mount + ctx.on),
//      ported verbatim from nav.js:24-54 + boot.js:185-208, BECAUSE guide §3.2 strips
//      nav.js, boot.js AND vendor/alpine.min.js — the only three owners of that
//      contract in the web app. board-page.js registers its page def through
//      window.__hibanaPage (board-page.js:1-2 self-stubs a queue); without a consumer
//      here the def stays queued forever and the island NEVER BOOTS. This is the one
//      addition beyond the guide's §4.3 skeleton trio, forced by the §3.2 strip list.
//
// WHAT IT MUST NEVER OWN (guide §4.3: "Owns NOTHING else"):
//   - No theme bootstrap (boot.js's job on the web — the desktop shell owns theme
//     natively, UI-UX §7.2 + guide §5.6). No service worker, no soft navigation, no
//     link interception, no command palette, no quick-add, no i18n (the i18n trio
//     carries it unchanged).
//   - No credentials, no cookie jar, no Origin forging, no caching (guide §4.4: the
//     Go side owns all of it; the bound surface stays the ONE Request method + the
//     upload stream; Request validates method + path allow-lists + size caps Go-side).
//   - window.hibana.handle401 is deliberately NOT provided: board-page.js:288 guards
//     it, so a 401 degrades to the caller's error path; M3's login window owns 401
//     recovery (guide §5.5).
(function () {
  'use strict'

  // ------------------------------------------------------------------ bridge
  // Wails v2 generates window.go.<pkg>.<Struct>.<Method> for every bound Go method;
  // the pkg/Struct names belong to internal/ui/bindings.go (M2), so resolve
  // defensively, in this order:
  //   1. window.go.desktop.API.Request  (the primary candidate)
  //   2. window.gohibana.api.Request    (the guide §4.3 fallback name)
  //   3. any window.go.<pkg>.API/api.<Method> (scan — survives the real package name)
  //   4. else null → callers throw a clear "bridge not wired" error.
  function pick(root, keys) {
    let cur = root
    for (let i = 0; i < keys.length; i++) {
      if (cur == null || typeof cur !== 'object') return null
      cur = cur[keys[i]]
    }
    return typeof cur === 'function' ? cur : null
  }
  function resolveBoundMethod(name) {
    let fn = pick(window, ['go', 'desktop', 'API', name])
    if (fn) return fn
    fn = pick(window, ['gohibana', 'api', name])
    if (fn) return fn
    fn = pick(window, ['gohibana', 'API', name])
    if (fn) return fn
    const go = window.go
    if (go && typeof go === 'object') {
      for (const pkg of Object.keys(go)) {
        fn = pick(go[pkg], ['API', name]) || pick(go[pkg], ['api', name])
        if (fn) return fn
      }
    }
    return null
  }

  // ------------------------------------------------------- window.hibanaFetch
  // fetch-compatible async fn (guide §4.3 skeleton, mirrored exactly):
  //   - opts.method defaults to GET, uppercased;
  //   - opts.body: strings pass through (every island call site pre-stringifies via
  //     JSON.stringify); non-strings are stringified — never String()'d into
  //     '[object Object]';
  //   - the caller's AbortController semantics are preserved: an ALREADY-aborted
  //     opts.signal rejects with an AbortError BEFORE the bridge is called
  //     (devboard.js:42 keys its one-retry off e.name === 'AbortError'; devboard.js's
  //     own 3s+retry deadline rides its own controllers around this seam unchanged);
  //   - opts.cache ('no-store') and opts.headers are IGNORED: hibanaFetch is a
  //     function call, not an HTTP dispatch — no CORS, no cookie domain games; the Go
  //     client owns real caching, cookies, the Origin header on writes (the T6 gate
  //     403s headerless writers) and the ETag store (guide §4.5, §5.1);
  //   - returns { ok, status, headers.get('etag'), json(), text() } — the guide's
  //     exact shape, so err.status propagation survives the round-trip.
  window.hibanaFetch = async function (path, opts) {
    opts = opts || {}
    if (opts.signal && opts.signal.aborted) {
      const ab = new Error('The operation was aborted.')
      ab.name = 'AbortError'
      throw ab
    }
    const method = (opts.method || 'GET').toUpperCase()
    let body = null
    if (opts.body != null) body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
    const bridge = resolveBoundMethod('Request')
    if (!bridge) {
      const err = new Error('hibana desktop bridge not wired: window.go.desktop.API.Request / window.gohibana.api.Request are missing. The Go side must bind internal/ui API.Request(method, path, body) (guide §4.4).')
      err.name = 'HibanaBridgeNotWired'
      throw err
    }
    const res = await bridge(method, path, body)
    if (res == null || typeof res.status !== 'number') {
      const err = new Error('hibana desktop bridge returned a malformed response for ' + method + ' ' + path)
      err.name = 'HibanaBridgeMalformed'
      throw err
    }
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      headers: { get: (h) => (String(h).toLowerCase() === 'etag' ? (res.etag || null) : null) },
      json: async () => JSON.parse(res.body),
      text: async () => res.body,
    }
  }

  // --------------------------------------------------------- window.hibanaXHR
  // XMLHttpRequest-compatible upload proxy for devboard.js's uploader (the 2
  // 'new XMLHttpRequest()' sites, devboard.js:337/:367 at the pin). Implements
  // exactly the surface the uploader touches: open/send/setRequestHeader/abort,
  // upload.onprogress, onload/onerror/onabort/onreadystatechange, status,
  // responseText, readyState.
  //
  // v0.1.15 — THE M4 BRIDGE IS LIVE (guide §5.4; the owner's dogfood: "upload
  // file button exists and it shows a loading as well, but after the loading
  // ends, it doesn't show whether it was successful or not, because it doesn't
  // show the thumbnail of the uploaded picture"). send() calls the bound Go
  // Upload(callID, method, path, body, headers) → {status, body} — the SAME
  // session/Origin machinery the fetch seam rides — and the Go side STREAMS the
  // body with real byte progress: every 'hibana:upload-progress' Wails event
  // {id, loaded, total} is routed to the matching instance's upload.onprogress
  // (the per-request callID keys the registry — the uploader can run several
  // files in parallel against the SAME path, so the events cannot be addressed
  // by path). Without the bound method (a dev island, a stubbed runtime) send()
  // still fails fast and LOUD with the named not-wired error.
  var hibanaXHRSeq = 0
  var hibanaXHRLive = {} // callID → the in-flight instance (progress routing)
  if (window.runtime && typeof window.runtime.EventsOn === 'function') {
    window.runtime.EventsOn('hibana:upload-progress', function (p) {
      if (!p || typeof p !== 'object') return
      const x = hibanaXHRLive[p.id]
      if (!x || x._aborted) return
      if (typeof x.upload.onprogress === 'function') {
        try { x.upload.onprogress({ lengthComputable: true, loaded: p.loaded || 0, total: p.total || 0, type: 'progress' }) } catch (e) { /* a handler must never throw back into the uploader */ }
      }
    })
  }
  function HibanaXHR() {
    this.readyState = 0
    this.status = 0
    this.responseText = ''
    this.onreadystatechange = null
    this.onload = null
    this.onerror = null
    this.onabort = null
    this._id = 'up' + (++hibanaXHRSeq) + '-' + Date.now() // the progress event's correlation key
    this._method = null
    this._url = null
    this._headers = {}
    this._sent = false
    this._aborted = false
    this.upload = { onprogress: null } // devboard.js sets xhr.upload.onprogress
  }
  HibanaXHR.prototype.open = function (method, url) {
    this._method = method
    this._url = url
    this.readyState = 1
  }
  HibanaXHR.prototype.setRequestHeader = function (k, v) { this._headers[k] = v }
  HibanaXHR.prototype._drop = function () { delete hibanaXHRLive[this._id] }
  HibanaXHR.prototype.abort = function () {
    if (this._aborted) return
    this._aborted = true
    this._drop()
    this.readyState = 0
    if (typeof this.onabort === 'function') { try { this.onabort({ type: 'abort' }) } catch (e) { /* a handler must never throw back into the uploader */ } }
  }
  HibanaXHR.prototype.send = function (body) {
    if (this._sent) return
    this._sent = true
    const self = this
    if (this._aborted) return
    const bridge = resolveBoundMethod('Upload')
    if (!bridge) {
      // The bridge is not wired (a dev island outside the shell). Fire onerror
      // asynchronously, like a real XHR — devboard.js assigns its handlers BEFORE
      // send() but real XHR events are tasks.
      queueMicrotask(function () {
        self.readyState = 4
        self.status = 0
        const err = new Error('hibanaXHR: the streaming upload bridge (window.gohibana.api.Upload — guide §5.4) is not wired in this runtime; the desktop board cannot upload attachments here.')
        err.name = 'HibanaUploadBridgeNotWired'
        self._error = err
        if (typeof self.onerror === 'function') { try { self.onerror({ type: 'error', error: err }) } catch (e) { /* ditto */ } }
        if (typeof self.onreadystatechange === 'function') { try { self.onreadystatechange() } catch (e) { /* ditto */ } }
      })
      return
    }
    // The M4 contract (guide §5.4): Upload(callID, method, path, body, headers)
    // → { status, body } — the callID routes the Go-side progress events back
    // to THIS instance through the registry above.
    hibanaXHRLive[self._id] = self
    Promise.resolve()
      .then(function () { return bridge(self._id, self._method || 'POST', self._url, body, self._headers) })
      .then(function (res) {
        if (self._aborted) return
        self._drop()
        self.readyState = 4
        self.status = res && typeof res.status === 'number' ? res.status : 0
        self.responseText = res && res.body != null ? String(res.body) : ''
        const good = self.status >= 200 && self.status < 300
        if (good && typeof self.onload === 'function') { try { self.onload({ type: 'load' }) } catch (e) { /* ditto */ } }
        if (!good && typeof self.onerror === 'function') { try { self.onerror({ type: 'error' }) } catch (e) { /* ditto */ } }
        if (typeof self.onreadystatechange === 'function') { try { self.onreadystatechange() } catch (e) { /* ditto */ } }
      })
      .catch(function () {
        if (self._aborted) return
        self._drop()
        self.readyState = 4
        self.status = 0
        if (typeof self.onerror === 'function') { try { self.onerror({ type: 'error' }) } catch (e) { /* ditto */ } }
      })
  }
  window.hibanaXHR = HibanaXHR

  // -------------------------------------------------------- window.hibana.toast
  // The app.js toast recipe, ported 1:1 (app.js:243-323 @ e6661c8; guide §4.3 cites
  // app.js:253-317 + app.js:247 for the Undo-must-stay-a-button rule). Contract:
  //   toast(message, kind = 'info', ms, actions = null)
  //   - kind 'ok'   → the S105 pastel-green variant: .toast-msg-row (check glyph +
  //     message + action buttons) + a .toast-x dismiss anchored TOP-RIGHT;
  //   - kind 'err'  → PERSISTENT by default (ms = 0 — stays until dismissed);
  //     other kinds auto-dismiss at 4000ms;
  //   - actions: [{ label, onClick, kind }] — kind 'primary' keeps the solid button,
  //     else .ghost; an Undo stays a REAL BUTTON (UI-UX §7.2), and clicking an action
  //     dismisses the toast after invoking it;
  //   - message renders via innerHTML (app.js's H2 contract — links allowed), so
  //     callers own escaping; the island's call sites esc()/B().esc() their
  //     interpolations (devboard.js:67, board-page.js:581);
  //   - exactly ONE toast at a time (the previous #toast is removed first).
  // Styling ships in the island's CSS manifest (components.css:252-319, polish-ui.css,
  // polish-batch.css) — identical in WebView2. ZERO network use.
  function toast(message, kind, ms, actions) {
    if (kind === undefined || kind === null) kind = 'info'
    if (ms === undefined) ms = kind === 'err' ? 0 : 4000 // errors persist by default
    const old = document.getElementById('toast')
    if (old) old.remove()
    const el = document.createElement('div')
    el.id = 'toast'
    el.className = 'toast ' + kind
    el.setAttribute('role', 'status')
    const makeAction = function (a) {
      const btn = document.createElement('button')
      btn.className = a.kind === 'primary' ? '' : 'ghost'
      btn.textContent = a.label
      btn.addEventListener('click', () => { try { a.onClick?.() } catch (e) { /* the app.js contract: a broken action never blocks dismissal */ } el.remove() })
      return btn
    }
    const makeDismiss = function (className) {
      const d = document.createElement('button')
      d.className = className
      d.setAttribute('aria-label', 'Dismiss')
      d.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'
      d.addEventListener('click', () => el.remove())
      return d
    }
    if (kind === 'ok') {
      const row = document.createElement('div')
      row.className = 'toast-msg-row'
      const check = document.createElement('span')
      check.className = 'toast-check'
      check.setAttribute('aria-hidden', 'true')
      check.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12.5l5 5L19.5 7"/></svg>'
      row.appendChild(check)
      const msg = document.createElement('span')
      msg.className = 'toast-msg'
      msg.innerHTML = message
      row.appendChild(msg)
      if (Array.isArray(actions)) for (const a of actions) row.appendChild(makeAction(a))
      el.appendChild(row)
      el.appendChild(makeDismiss('toast-x'))
    } else {
      const msg = document.createElement('span')
      msg.className = 'toast-msg'
      msg.innerHTML = message
      el.appendChild(msg)
      if (Array.isArray(actions)) for (const a of actions) el.appendChild(makeAction(a))
      el.appendChild(makeDismiss('ghost danger'))
    }
    document.body.appendChild(el)
    if (ms > 0) setTimeout(() => { if (el.parentNode) el.remove() }, ms)
  }
  window.hibana = { toast }

  // ----------------------------------------------------- window.__hibanaPage
  // The minimal mount consumer (see the header WHY). The contract below is nav.js's
  // applyDef/ctx shape VERBATIM (nav.js:24-54) + boot.js's queue drain
  // (boot.js:185-208): ctx.on(type, fn, opts) is a document-level listener tracked
  // for unmount; a second applyDef unmounts the previous page first. It owns NOTHING
  // else — no link interception, no soft navigation (the desktop is single-surface).
  const pageQueue = Array.isArray(window.__hibanaPageQueue) ? window.__hibanaPageQueue : []
  let activePage = null
  const applyDef = function (def) {
    if (!def || typeof def.mount !== 'function') return
    if (window.__hibanaBoot && typeof window.__hibanaBoot.unmount === 'function') {
      window.__hibanaBoot.unmount()
      window.__hibanaBoot = null
    }
    if (activePage) activePage.unmount()
    const listeners = []
    const ctx = {
      on(type, fn, opts) {
        document.addEventListener(type, fn, opts)
        listeners.push([type, fn, opts])
      },
    }
    const customUnmount = def.mount(ctx)
    activePage = {
      name: def.name,
      unmount() {
        for (const item of listeners) document.removeEventListener(item[0], item[1], item[2])
        listeners.length = 0
        if (typeof customUnmount === 'function') customUnmount()
        if (typeof def.unmount === 'function') def.unmount()
      },
    }
  }
  window.__hibanaPage = applyDef
  for (const def of pageQueue) applyDef(def)
  window.__hibanaPageQueue = []
})()
`

// ---------------------------------------------------------------------------
// desktop-login.js — generated below into dist/js/ (guide §5.5 — the M2 pick
// LANDED: the island-rendered login card; the owner's dogfooding ask). Written
// without template literals/backticks so it can nest in this literal.
// ---------------------------------------------------------------------------
const DESKTOP_LOGIN_JS = `// desktop-login.js — the login gate controller (GO-DESKTOP-IMPLEMENTATION-GUIDE.md
// §5.5 — the M2 pick: the island-rendered login card).
// GENERATED FILE — do not hand-edit (guide §3.3.4): emitted by scripts/sync-island.mjs
// into frontend/dist/js/ and checksummed in frontend/island.checksums.json. Loads
// blocking, right after desktop-shim.js, BEFORE every deferred island script.
//
// WHAT THIS FILE OWNS:
//   1. The gate's form flow: submit → the Go Login binding (internal/ui.API.Login —
//      POST /api/auth/login happens Go-SIDE; the session cookie NEVER crosses back
//      into JS, it lands in the Go cookie jar + the DPAPI-at-M5 store) → on ok a
//      location.reload() so the island boots with a live session and the kanban
//      loads. Auth failures resolve {ok:false, code, message} so the card branches
//      wrong-password vs suspended vs rate-limited; transport trouble rejects and
//      the card reports it cannot reach hibana.ir.
//   2. window.__hibanaMe — the async identity hook i18n.js:69-77 ALREADY prefers:
//      the island's language resolution goes through the Go bridge (AuthState) —
//      FA users get the FA dictionary + RTL with ZERO island network (the M3 note
//      in desktop-shim.js's header, pulled forward because login now exists).
//   3. Session-expiry recovery (guide §5.5: "401 mid-session → the session-expiry
//      dialog → re-POST → the failing op retries once"): the Go side emits
//      hibana:auth-required (a 401 crossing the bridge, the pull loop, or the
//      outbox drain); the gate reopens with the expiry note; a successful sign-in
//      reloads, and Go wakes the outbox's retry-once.
//
// WHAT IT MUST NEVER OWN: no cookie/token handling, no storage of credentials, no
// Origin forging, no theme bootstrap, no caching — all Go-side or island-owned.
(function () {
  'use strict'

  // The bridge resolver — the same defensive chain desktop-shim.js uses (both files
  // are generated + drift-controlled; the duplication is by design so the login
  // gate keeps working even if the shim's internal shape ever evolves).
  function pick(root, keys) {
    let cur = root
    for (let i = 0; i < keys.length; i++) {
      if (cur == null || typeof cur !== 'object') return null
      cur = cur[keys[i]]
    }
    return typeof cur === 'function' ? cur : null
  }
  function resolveBoundMethod(name) {
    let fn = pick(window, ['go', 'desktop', 'API', name])
    if (fn) return fn
    fn = pick(window, ['gohibana', 'api', name])
    if (fn) return fn
    fn = pick(window, ['gohibana', 'API', name])
    if (fn) return fn
    const go = window.go
    if (go && typeof go === 'object') {
      for (const pkg of Object.keys(go)) {
        fn = pick(go[pkg], ['API', name]) || pick(go[pkg], ['api', name])
        if (fn) return fn
      }
    }
    return null
  }

  // ---- bridge resolution: LAZY, at USE time — never a parse-time snapshot (the
  // v0.1.1 dogfood lesson: "The desktop bridge is not wired — restart the app." fired
  // with a live bridge one script tag away, because the snapshot ran on a document
  // whose Wails runtime tags were missing; v0.1.2 both injects them on every lane
  // AND makes the gate resolve at submit time like the shim resolves per call). ----

  // ---- language resolution (i18n.js:69-77): the hook wins, no island network ----
  window.__hibanaMe = async function () {
    const authState = resolveBoundMethod('AuthState')
    if (!authState) return { ok: false, body: null }
    try {
      const st = await authState()
      if (st && st.authenticated && st.user) return { ok: true, body: { user: st.user } }
      return { ok: false, body: null }
    } catch (e) {
      return { ok: false, body: null }
    }
  }

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn)
    else fn()
  }

  ready(function () {
    var gate = document.getElementById('login-gate')
    var form = document.getElementById('login-gate-form')
    var loginInput = document.getElementById('login-gate-login')
    var passInput = document.getElementById('login-gate-password')
    var submit = document.getElementById('login-gate-submit')
    var spinner = document.getElementById('login-spinner')
    var errEl = document.getElementById('login-error')
    var sub = document.getElementById('login-gate-sub')
    if (!gate || !form) return

    var authedAtBoot = document.documentElement.getAttribute('data-desktop-authed') === 'true'

    function busy(on) {
      if (submit) submit.disabled = on
      if (spinner) spinner.classList.toggle('busy', on)
    }
    function fail(msg) {
      if (!errEl) return
      errEl.textContent = msg
      errEl.hidden = false
    }
    function openGate(reason) {
      document.documentElement.setAttribute('data-desktop-authed', 'false')
      if (reason === 'expired' && sub) sub.textContent = 'Your session expired — sign in again to reconnect and load your boards.'
      if (errEl) errEl.hidden = true
      if (loginInput) loginInput.value = ''
      if (passInput) passInput.value = ''
      if (loginInput) loginInput.focus()
    }

    // The form is wired even while the gate is hidden — the expiry event can
    // reopen it long after boot.
    form.addEventListener('submit', function (ev) {
      ev.preventDefault()
      if (errEl) errEl.hidden = true
      var login = loginInput ? String(loginInput.value || '').trim() : ''
      var password = passInput ? String(passInput.value || '') : ''
      if (!login || !password) {
        fail('Enter your email and password.')
        return
      }
      var bridgeLogin = resolveBoundMethod('Login')
      if (!bridgeLogin) {
        fail('The desktop bridge is not wired — restart the app.')
        return
      }
      busy(true)
      bridgeLogin(login, password).then(
        function (res) {
          if (res && res.ok) {
            // v0.1.13 — the login chime (the sound round's cue #1): the
            // welcome fifth plays on the ok resolve, and the reload WAITS
            // ~700ms so the chime lands before the document unloads (a
            // reload kills the AudioContext — an immediate one clips the
            // cue to silence). The submit stays busy through the chime so
            // a second click can never double-schedule; with no engine the
            // reload is immediate, exactly as before.
            if (window.hibanaAudio && typeof window.hibanaAudio.play === 'function') {
              window.hibanaAudio.play('login')
              setTimeout(function () { location.reload() }, 700)
            } else {
              // Reload with the live session: the Go shell now serves this
              // document with data-desktop-authed="true", the card never
              // appears, and the island boots straight into the boards.
              location.reload()
            }
            return
          }
          busy(false)
          fail((res && res.message) || 'Sign-in failed — try again.')
        },
        function () {
          busy(false)
          fail('Cannot reach hibana.ir — check your connection and try again.')
        }
      )
    })

    if (!authedAtBoot && loginInput) loginInput.focus()

    // Session expiry mid-session (guide §5.5) — emitted by the Go shell when a
    // 401 crosses the bridge, the pull loop, or the outbox drain.
    if (window.runtime && typeof window.runtime.EventsOn === 'function') {
      window.runtime.EventsOn('hibana:auth-required', function () {
        openGate('expired')
      })
    }
  })
})()
`

// ---------------------------------------------------------------------------
// desktop-login.css — generated below into dist/css/ (the gate's desktop-owned
// styles; everything else the card wears comes from the island's own sheets).
// ---------------------------------------------------------------------------
const DESKTOP_LOGIN_CSS = `/* desktop-login.css — the login gate's desktop-owned styles.
   GENERATED FILE — do not hand-edit (guide §3.3.4): emitted by scripts/sync-island.mjs
   into frontend/dist/css/ and checksummed in frontend/island.checksums.json.

   v0.1.2: the gate is the WEB LOGIN PAGE'S OWN SPLIT LAYOUT now (login.html @ pin —
   the owner ask: the same login background as the web login): .auth-page +
   .auth-split-page (base.css + quicknotes.css), .auth-split / .auth-visual (the
   Login.webp photo panel) / .auth-form / .auth-brand / .auth-logo — ALL quicknotes.css
   + base.css rules, and both sheets ship in the island VERBATIM, so the gate is
   theme-aware (light/claude-dark) and RTL-correct for free. This sheet only owns the
   gate wrapper, the first-paint visibility rule, and the busy spinner state. */

/* The gate: a full-viewport overlay above every island surface (the toast in
   components.css sits far below this z-index; the board beneath never shows
   its unauthenticated error state through the gate). var(--bg) backdrop so a
   sub-pixel split seam can never flash the board behind. */
.login-gate {
  position: fixed;
  inset: 0;
  z-index: 2147483646;
  overflow: auto;
  background: var(--bg);
}

/* First-paint visibility is a CSS-ONLY decision (never a JS flash): the Go shell
   serves index.html with the live auth state on the <html> tag
   (internal/ui.IndexMiddleware) — a live restored session hides the gate before
   the first paint; a fresh session shows it before the island's first fetch can
   401. A missing attribute (a drifted island) shows the gate: fail-visible. */
html[data-desktop-authed='true'] .login-gate {
  display: none;
}

.login-gate #login-error {
  margin: 0;
  white-space: pre-line;
}

#login-gate-sub {
  margin: 0.1rem 0 1.4rem;
}

/* components.css's .spinner is display:none until the STRIPPED htmx chrome tags it;
   the gate uses its own busy state instead (never the stripped-web class names). */
.login-gate .spinner.busy {
  display: inline-block;
}
`

// ---------------------------------------------------------------------------
// desktop-theme.js — generated below into dist/js/ (v0.1.5 — the S216 dark-mode
// round; the owner ask: "The app doesnt have darkmode, add dark mode and it's
// toggle"). The FIRST blocking head script (before desktop-shim.js): the pre-paint
// 'system' resolution (boot.js S87 byte-parity), live OS flips, the TWO toggle
// surfaces (the login gate's .theme-floater + the board toolbar's
// #db-theme-toggle), click-time SetTheme resolution (the v0.1.1 parse-time
// lesson), optimistic apply, the web's own SUN/MOON icons. NO storage: the Go
// mirror-meta pref is the one source of truth.
//
// desktop-sync.js + desktop-sync.css — generated below into dist/js/ + dist/css/
// (v0.1.6 — the S217 sync round; the owner ask: the physical, visible sync button
// whose modal proves the round live). The controller: click-time SyncNow
// resolution, openSync resets + showModal, the hibana:sync-progress listener
// painting the step rows live (spinner → check/cross + the server-minted fact
// lines), the success belt with the "will not vanish" copy (EN + FA), honest
// outcome panels (ok / busy / session / unreachable / pending / error) — closing
// never cancels, reopening mid-round shows the live steps, EN/FA localized live
// off html[lang]. The sheet owns the step marks (the .db-sync-spin ring) + the
// ok/warn/err panels — every color a var(), riding the island's OWN native dialog
// + .modal card (components.css: theme-aware + RTL-native for free). NO storage.
//
// RECOVERY NOTE (S216 + S217): the v0.1.5 + v0.1.6 commits were LOCAL-only and
// lost to a sandbox reset. These three files were carved byte-exact out of the
// surviving v0.1.6 exe (go:embed stores island files verbatim) and are embedded
// here verbatim — the sync must regenerate them identically:
//   js/desktop-theme.js  bdfccdf77656cc1bf9dab3f3ea61d3ecac92dc8da625e4aba9c5f8e08ba62bb3
//   js/desktop-sync.js   dfd2805fc18ab454b64f87c9cc066b743efa9b6641d5dea73bda9cf304ccaab2
//   css/desktop-sync.css 416c5ef5152ea71d82971ca1e6867a5e9e53e5a7416f2fee5f4886b4570928a4
// Written without backticks/${/backslashes so each nests in its literal.
// ---------------------------------------------------------------------------
const DESKTOP_THEME_JS = `// desktop-theme.js — the desktop theme bootstrap + toggle wiring (v0.1.5 — the
// owner ask: "The app doesnt have darkmode, add dark mode and it's toggle").
// GENERATED FILE — do not hand-edit (guide §3.3.4): emitted by scripts/sync-island.mjs
// into frontend/dist/js/ and checksummed in frontend/island.checksums.json. Loads
// blocking, FIRST in <head> (before desktop-shim.js), BEFORE every deferred island
// script — the pre-paint theme resolution must beat the first render.
//
// WHY THIS FILE EXISTS: the web sets html[data-theme] in boot.js + app.js (S87 —
// exactly two looks: light and claude-dark, a CSS TOKEN swap; claude-dark-theme.css
// + themes.css ship in the island VERBATIM). Both scripts are STRIPPED here (guide
// §3.2), so without this file the desktop rendered the light baseline forever —
// the root cause of "the app doesn't have dark mode". The desktop owns theme
// natively per UI-UX-REPLICATION-SPEC §7.2 + guide §5.6.
//
// THE ONE SOURCE OF TRUTH is Go-side: the mirror meta row ui.theme
// (internal/ui.ThemeMetaKey — 'light' | 'claude-dark' | 'system', default system —
// the web's own default, S87). The Go shell serves the document with
// data-desktop-theme="<pref>" on <html> (internal/ui.InjectShellState); explicit
// prefs ALSO carry data-theme directly (a zero-JS first paint). This file owns:
//   1. PRE-PAINT: resolve 'system' via the OS scheme (WebView2 follows the Windows
//      app mode) — exactly boot.js's S87 block, run synchronously before first render.
//   2. Live OS flips while the pref is 'system' (app.js:235-242 parity).
//   3. The TWO toggle surfaces: the login gate's .theme-floater (the web login
//      page's own affordance, login.html:30 — present pre-login) and the board
//      toolbar's #db-theme-toggle (post-login). Both flip light <-> claude-dark
//      through the Go SetTheme binding (resolved at CLICK time — the v0.1.1
//      parse-time lesson) and paint the web's own SUN/MOON icons (app.js:181-182).
//   4. The hibana:theme event — the Go shell emits it with the new pref (the tray
//      menu's Light / Dark / Follow system picker, internal/tray).
//
// NO localStorage: the desktop pref never forks from the Go meta row (the web's
// 'hibana-theme' key stays web-only; a dead bridge still flips the live document,
// the next boot re-reads the persisted pref).
(function () {
  'use strict'

  var html = document.documentElement
  var DARK = 'claude-dark'
  var LIGHT = 'light'
  // The web's own icons, byte-parity (app.js:181-182). The convention is
  // app.js:213's: the icon mirrors the CURRENT look — SUN in light, MOON in dark.
  var SUN = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
  var MOON = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>'

  function osDark() {
    try { return matchMedia('(prefers-color-scheme: dark)').matches } catch (e) { return false }
  }
  // pref(): the Go-served stored preference (data-desktop-theme on <html>);
  // anything else (a raw serve without the middleware) reads as 'system'.
  function pref() {
    var p = html.getAttribute('data-desktop-theme')
    return p === DARK || p === LIGHT || p === 'system' ? p : 'system'
  }
  function resolve(p) {
    if (p === DARK || p === LIGHT) return p
    return osDark() ? DARK : LIGHT
  }
  function apply(p) {
    html.dataset.theme = resolve(p)
  }
  // paintToggles(): app.js paintThemeButton parity (S93: no hover tooltip — the
  // icon is the label). Both desktop surfaces are icon-only, so only the .icon
  // child swaps; other children (if a future surface adds one) survive.
  function paintToggles() {
    var svg = html.dataset.theme === DARK ? MOON : SUN
    var els = document.querySelectorAll('[data-theme-toggle], .theme-floater')
    for (var i = 0; i < els.length; i++) {
      var b = els[i]
      b.removeAttribute('title')
      b.removeAttribute('data-tooltip')
      var old = b.querySelector('.icon')
      if (old) old.outerHTML = svg
      else b.insertAdjacentHTML('afterbegin', svg)
    }
  }

  // ---- 1. PRE-PAINT: synchronous in <head>, before first render (S87 parity). ----
  apply(pref())

  // ---- 2. live OS flips while 'system' (app.js:235-242 parity) ----
  try {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      if (pref() === 'system') {
        apply('system')
        paintToggles()
      }
    })
  } catch (e) { /* engines without the matchMedia listener resolve per-load only */ }

  // The bridge resolver — the same defensive chain desktop-login.js uses (both
  // files are generated + drift-controlled; the duplication is by design so the
  // theme keeps working even if the shim's internal shape ever evolves).
  function pick(root, keys) {
    let cur = root
    for (let i = 0; i < keys.length; i++) {
      if (cur == null || typeof cur !== 'object') return null
      cur = cur[keys[i]]
    }
    return typeof cur === 'function' ? cur : null
  }
  function resolveBoundMethod(name) {
    let fn = pick(window, ['go', 'desktop', 'API', name])
    if (fn) return fn
    fn = pick(window, ['gohibana', 'api', name])
    if (fn) return fn
    fn = pick(window, ['gohibana', 'API', name])
    if (fn) return fn
    const go = window.go
    if (go && typeof go === 'object') {
      for (const pkg of Object.keys(go)) {
        fn = pick(go[pkg], ['API', name]) || pick(go[pkg], ['api', name])
        if (fn) return fn
      }
    }
    return null
  }

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn)
    else fn()
  }

  ready(function () {
    // ---- 3. the toggle surfaces (the gate floater pre-login, the toolbar button
    //      post-login — the same flip lands on both). Optimistic apply FIRST: the
    //      Go persist can never make the toggle feel broken; a dead bridge keeps
    //      the live document in the chosen look until the next boot. ----
    function flip(ev) {
      if (ev) ev.preventDefault()
      var next = html.dataset.theme === DARK ? LIGHT : DARK
      html.setAttribute('data-desktop-theme', next) // an explicit flip leaves 'system'
      apply(next)
      paintToggles()
      var setTheme = resolveBoundMethod('SetTheme')
      if (setTheme) {
        try { setTheme(next).catch(function () {}) } catch (e) {}
      }
    }
    var buttons = document.querySelectorAll('[data-theme-toggle], .theme-floater')
    for (var i = 0; i < buttons.length; i++) buttons[i].addEventListener('click', flip)

    // ---- 4. tray-driven changes: Go emits hibana:theme with the new pref
    //      (Light / Dark / Follow system — internal/tray's submenu). ----
    if (window.runtime && typeof window.runtime.EventsOn === 'function') {
      window.runtime.EventsOn('hibana:theme', function (payload) {
        var p = payload
        if (p && typeof p === 'object') p = p.pref || ''
        if (p !== DARK && p !== LIGHT && p !== 'system') p = 'system'
        html.setAttribute('data-desktop-theme', p)
        apply(p)
        paintToggles()
      })
    }

    paintToggles()
  })
})()
`

// ---------------------------------------------------------------------------
// desktop-sync.js — see the recovery note above for what it owns.
// ---------------------------------------------------------------------------
const DESKTOP_SYNC_JS = `// desktop-sync.js — the manual sync button + its proof modal (v0.1.6 — the
// owner ask: the physical, visible sync button whose modal proves the round:
// connecting to the Cloudflare server > upload > sync > the success panel —
// the user is 100% sure the boards are synced and will not vanish).
// v0.1.8 — the owner ask: "next to sprints and labels, but colored (fill
// colored)": the button is now the LABELED fill-colored CTA pill after Labels
// (this file also paints its visible label per language, like the aria).
// v0.1.12 — the refresh-round reflex (the owner ask: "deleted something from
// hibana, clicked sync on the app, but it didn't got deleted"): the round
// outcome now carries \`pulled\` (the boards whose pull was a live 200 — the
// mirror rows that MOVED), the ok panel names it, and closing the modal
// reloads the island so the pulled cloud truth — the deletion included —
// reaches the VISIBLE board. pulled=0 reloads NOTHING (the screen was already
// the truth); the toolbar's own Refresh button (desktop-refresh.js) is the
// same reflex as an always-there affordance.
// GENERATED FILE — do not hand-edit (guide §3.3.4): emitted by scripts/sync-island.mjs
// into frontend/dist/js/ and checksummed in frontend/island.checksums.json.
(function () {
  'use strict'

  // The desktop-owned strings. The island's dictionaries are pin-verbatim copies
  // (they carry no sync keys — verified @ the pin), so this EN/FA pair is the
  // modal's own; i18n.js owns html[lang], and localize() reads it live.
  var STR = {
    en: {
      btn: 'Sync now',
      btnLabel: 'Sync',
      title: 'Sync with Hibana cloud',
      connect: 'Connecting to Cloudflare server',
      upload: 'Uploading changes',
      sync: 'Syncing boards',
      okTitle: 'Everything synced',
      okBody: 'Your boards are saved on the Hibana cloud — they will not vanish.',
      uploaded: '{u} change(s) uploaded',
      noneWaiting: 'no changes were waiting — every edit saves live',
      updated: '{n} board(s) updated from the cloud — the board shows them when you close this.',
      projectsNote: '{p} project(s) · {b} board(s) checked',
      okTime: 'last synced {t}',
      warnTitle: 'Synced — some changes still uploading',
      busyTitle: 'A sync is already running.',
      sessionTitle: 'Your session expired — sign in again.',
      unreachableTitle: 'Cannot reach hibana.ir — check your connection.',
      errTitle: 'Sync failed',
      notWired: 'The desktop bridge is not wired — restart the app.',
      retry: 'Try again',
      done: 'Done',
      close: 'Close'
    },
    fa: {
      btn: 'همگام‌سازی',
      btnLabel: 'همگام‌سازی',
      title: 'همگام‌سازی با ابر هیبانا',
      connect: 'اتصال به سرور Cloudflare',
      upload: 'بارگذاری تغییرات',
      sync: 'همگام‌سازی تخته‌ها',
      okTitle: 'همه‌چیز همگام شد',
      okBody: 'تخته‌های شما در ابر هیبانا ذخیره شده‌اند — از بین نمی‌روند.',
      uploaded: '{u} تغییر بارگذاری شد',
      noneWaiting: 'تغییر منتظری نبود — هر ویرایش زنده ذخیره می‌شود',
      updated: '{n} تخته از ابر هیبانا به‌روزرسانی شد — با بستن این پنجره نمایش به‌روز می‌شود.',
      projectsNote: '{p} پروژه · {b} تخته بررسی شد',
      okTime: 'آخرین همگام‌سازی {t}',
      warnTitle: 'همگام شد — چند تغییر هنوز در حال بارگذاری است',
      busyTitle: 'یک همگام‌سازی دیگر در جریان است.',
      sessionTitle: 'نشست شما منقضی شد — دوباره وارد شوید.',
      unreachableTitle: 'اتصال به hibana.ir ممکن نیست — اتصال خود را بررسی کنید.',
      errTitle: 'همگام‌سازی ناموفق بود',
      notWired: 'پل دسکتاپ وصل نیست — برنامه را دوباره باز کنید.',
      retry: 'تلاش دوباره',
      done: 'انجام شد',
      close: 'بستن'
    }
  }

  function lang() { return document.documentElement.lang === 'fa' ? 'fa' : 'en' }
  function t(key) { return (STR[lang()] && STR[lang()][key]) || STR.en[key] || key }
  function fmt(key, map) {
    var s = t(key)
    for (var k in map) s = s.split('{' + k + '}').join(String(map[k]))
    return s
  }

  // The step marks: the small ring while active, check/cross at the ends.
  var SPIN = '<span class="db-sync-spin" aria-hidden="true"></span>'
  var CHECK = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>'
  var CROSS = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>'
  var REFRESH = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/></svg>'

  // The bridge resolver — the same defensive chain desktop-login.js/-theme.js
  // use (all generated + drift-controlled; the duplication is by design).
  function pick(root, keys) {
    let cur = root
    for (let i = 0; i < keys.length; i++) {
      if (cur == null || typeof cur !== 'object') return null
      cur = cur[keys[i]]
    }
    return typeof cur === 'function' ? cur : null
  }
  function resolveBoundMethod(name) {
    let fn = pick(window, ['go', 'desktop', 'API', name])
    if (fn) return fn
    fn = pick(window, ['gohibana', 'api', name])
    if (fn) return fn
    fn = pick(window, ['gohibana', 'API', name])
    if (fn) return fn
    const go = window.go
    if (go && typeof go === 'object') {
      for (const pkg of Object.keys(go)) {
        fn = pick(go[pkg], ['API', name]) || pick(go[pkg], ['api', name])
        if (fn) return fn
      }
    }
    return null
  }

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn)
    else fn()
  }

  ready(function () {
    var btn = document.getElementById('db-sync-button')
    var dlg = document.getElementById('db-sync-dialog')
    if (!btn || !dlg || typeof dlg.showModal !== 'function') return

    var stepsEl = document.getElementById('db-sync-steps')
    var btnLabel = document.getElementById('db-sync-btn-label')
    var panel = document.getElementById('db-sync-panel')
    var panelIcon = panel ? panel.querySelector('.icon') : null
    var panelTitle = document.getElementById('db-sync-panel-title')
    var panelBody = document.getElementById('db-sync-panel-body')
    var closeBtn = document.getElementById('db-sync-close')
    var retryBtn = document.getElementById('db-sync-retry')
    var doneBtn = document.getElementById('db-sync-done')
    var syncing = false
    // v0.1.21 — THE COUNT BADGE (hibana-sync-status-spec §9): the toolbar Sync
    // button wears pending + failed cards, from the SAME tracker the cards'
    // badges paint from (the island's sync-state.js — ONE source: the button
    // and the cards can never disagree). Hidden at zero; the icon rotates while
    // the round runs OR any card is mid-sync. HONEST DEVIATION, recorded: the
    // spec's "pressing Sync moves all Pending and Failed cards to Syncing
    // together" is deliberately NOT done — this round pulls boards + drains the
    // outbox, and a FAILED live board edit is NOT re-sent by it (only the card's
    // own Retry pill re-sends that write), so claiming "syncing" for those cards
    // would promise an ack this round never seeks (spec §2: synced only after
    // the server confirmed THE write).
    var countEl = null
    var roundRunning = false
    var anyCardSyncing = false
    function paintCount(n) {
      if (!n && !countEl) return
      if (!countEl) {
        countEl = document.createElement('span')
        countEl.className = 'db-sync-count'
        countEl.setAttribute('aria-hidden', 'true')
        btn.appendChild(countEl)
      }
      countEl.textContent = String(n)
      countEl.hidden = !n
    }
    function paintSpin() {
      btn.classList.toggle('db-sync-running', roundRunning || anyCardSyncing)
    }
    var syncTracker = window.HibanaSyncState
    if (syncTracker && typeof syncTracker.subscribe === 'function') {
      paintCount(syncTracker.count())
      anyCardSyncing = !!(syncTracker.hasSyncing && syncTracker.hasSyncing())
      paintSpin()
      syncTracker.subscribe(function (n) {
        paintCount(n)
        anyCardSyncing = !!(syncTracker.hasSyncing && syncTracker.hasSyncing())
        paintSpin()
      })
    }
    // v0.1.13 — the sound round's hero (the owner ask: "also in modal i want
    // syncing animation with icons and animation"): the living emblem above
    // the step rows. data-stage follows the round's ACTIVE step (connect /
    // upload / sync — morphing the central glyph + the choreography), and
    // data-kind settles it on the outcome (ok / warn / err — the ok pop, the
    // danger tint). setStage/setKind below own every flip; the CSS owns every
    // keyframe (prefers-reduced-motion respected).
    var hero = document.getElementById('db-sync-hero')
    function setStage(name) { if (hero) hero.setAttribute('data-stage', name) }
    function setKind(kind) { if (hero) hero.setAttribute('data-kind', kind) }
    // v0.1.12 — the pulled-boards reflex: set when an ok round MOVED mirror
    // rows (out.pulled > 0 — the cloud changed under the island's boot-time
    // render), consumed by the modal's close listener (Done or Esc) so the
    // reload lands AFTER the user reads the success panel, never under it.
    var needsReload = false

    function setText(id, text) { var el = document.getElementById(id); if (el) el.textContent = text }

    function localize() {
      btn.setAttribute('aria-label', t('btn'))
      btn.setAttribute('title', t('btn'))
      if (btnLabel) btnLabel.textContent = t('btnLabel')
      setText('db-sync-title', t('title'))
      var rows = stepsEl ? stepsEl.querySelectorAll('li[data-step]') : []
      for (var i = 0; i < rows.length; i++) {
        var label = rows[i].querySelector('.db-sync-label')
        var key = rows[i].getAttribute('data-step')
        if (label && key) label.textContent = t(key)
      }
      if (closeBtn) closeBtn.textContent = t('close')
      if (retryBtn) retryBtn.textContent = t('retry')
      if (doneBtn) doneBtn.textContent = t('done')
    }

    function setStep(name, state, note) {
      if (!stepsEl) return
      var li = stepsEl.querySelector('li[data-step="' + name + '"]')
      if (!li) return
      li.setAttribute('data-state', state)
      var mark = li.querySelector('.db-sync-mark')
      if (mark) {
        if (state === 'active') mark.innerHTML = SPIN
        else if (state === 'done') mark.innerHTML = CHECK
        else if (state === 'failed') mark.innerHTML = CROSS
        else mark.innerHTML = ''
      }
      // The server-minted detail lines ride under the step row (English by
      // nature — they are live facts, not UI chrome). An UNDEFINED note keeps
      // the existing one (the success belt only refreshes the states — it must
      // never wipe the details the events painted); an EMPTY string hides it
      // (an active step carries no fact yet).
      var noteEl = li.querySelector('.db-sync-note')
      if (!noteEl) {
        noteEl = document.createElement('span')
        noteEl.className = 'db-sync-note'
        li.appendChild(noteEl)
      }
      if (typeof note === 'undefined') {
        // keep the painted note (state-only refresh)
      } else if (note) { noteEl.textContent = note; noteEl.hidden = false }
      else noteEl.hidden = true
    }

    function showPanel(kind, title, body, retryable) {
      if (!panel) return
      if (kind === 'ok' && panelIcon) panelIcon.outerHTML = CHECK
      else if (kind === 'warn' && panelIcon) panelIcon.outerHTML = REFRESH
      else if (kind === 'err' && panelIcon) panelIcon.outerHTML = CROSS
      panelIcon = panel ? panel.querySelector('.icon') : null
      panel.setAttribute('data-kind', kind)
      if (panelTitle) panelTitle.textContent = title
      if (panelBody) panelBody.textContent = body || ''
      panel.hidden = false
      if (retryBtn) retryBtn.hidden = !retryable
      if (doneBtn) doneBtn.hidden = kind !== 'ok'
      if (closeBtn) closeBtn.hidden = kind === 'ok'
    }

    function timeStr(iso) {
      var d = iso ? new Date(iso) : new Date()
      if (isNaN(d.getTime())) d = new Date()
      try { return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) } catch (e) { return d.toString() }
    }

    function onDone(out) {
      syncing = false
      roundRunning = false
      paintSpin()
      if (!out || typeof out !== 'object') out = {}
      if (out.ok) {
        // Belt: the events may lag the promise (the same IPC, different lanes) —
        // a success verdict paints ALL steps done.
        setStep('connect', 'done')
        setStep('upload', 'done')
        setStep('sync', 'done')
        var note = out.uploaded > 0 ? fmt('uploaded', { u: out.uploaded }) : t('noneWaiting')
        var counts = fmt('projectsNote', { p: out.projects, b: out.boards })
        var when = fmt('okTime', { t: timeStr(out.at) })
        // v0.1.12 — the boards the round PULLED (live 200s — the mirror rows
        // that moved, deletions included) are named in the ok body, and the
        // close listener re-renders the board so they reach the SCREEN
        // (pulled=0 means nothing changed server-side — no reload, no claim).
        var refreshed = out.pulled > 0 ? fmt('updated', { n: out.pulled }) : ''
        if (refreshed) refreshed = ' · ' + refreshed
        needsReload = out.pulled > 0
        // v0.1.13 — the hero settles into the green verdict (the ok pop) and
        // the all-clear chime plays (cue #5: "when syncing complete" — the
        // sonic twin of this very panel; desktop-audio.js owns the synth).
        setKind('ok')
        if (window.hibanaAudio && typeof window.hibanaAudio.play === 'function') {
          window.hibanaAudio.play('sync')
        }
        showPanel('ok', t('okTitle'), t('okBody') + ' ' + note + refreshed + ' · ' + counts + ' · ' + when, false)
        return
      }
      if (out.code === 'busy') { setKind('err'); showPanel('err', t('busyTitle'), '', false); return }
      if (out.code === 'session') { setKind('err'); showPanel('err', t('sessionTitle'), '', false); return }
      if (out.code === 'unreachable') { setKind('err'); showPanel('err', t('unreachableTitle'), '', true); return }
      if (out.code === 'pending') { setKind('warn'); showPanel('warn', t('warnTitle'), out.message || '', true); return }
      setKind('err')
      showPanel('err', t('errTitle'), out.message || '', true)
    }

    function onReject() {
      syncing = false
      roundRunning = false
      paintSpin()
      setKind('err')
      showPanel('err', t('errTitle'), t('notWired'), false)
    }

    function run() {
      syncing = true
      roundRunning = true
      paintSpin()
      var syncNow = resolveBoundMethod('SyncNow')
      if (!syncNow) { onReject(); return }
      try {
        Promise.resolve(syncNow()).then(onDone, onReject)
      } catch (e) { onReject() }
    }

    function openSync() {
      localize()
      if (syncing) { dlg.showModal(); return } // reopen mid-round: the steps are live
      syncing = true
      needsReload = false // every fresh round re-earns its own reload verdict
      // v0.1.13 — every fresh round re-boots the hero too: connect stage, no
      // verdict yet (the ok pop/err tint from the previous round must never
      // leak into a new one).
      setStage('connect')
      setKind('')
      if (panel) panel.hidden = true
      if (retryBtn) retryBtn.hidden = true
      if (doneBtn) doneBtn.hidden = true
      if (closeBtn) closeBtn.hidden = false
      setStep('connect', 'pending')
      setStep('upload', 'pending')
      setStep('sync', 'pending')
      dlg.showModal()
      run()
    }

    btn.addEventListener('click', openSync)
    if (closeBtn) closeBtn.addEventListener('click', function () { dlg.close() })
    if (doneBtn) doneBtn.addEventListener('click', function () { dlg.close() })
    if (retryBtn) retryBtn.addEventListener('click', function () {
      if (panel) panel.hidden = true
      if (retryBtn) retryBtn.hidden = true
      if (doneBtn) doneBtn.hidden = true
      if (closeBtn) closeBtn.hidden = false
      setStage('connect')
      setKind('')
      setStep('connect', 'pending')
      setStep('upload', 'pending')
      setStep('sync', 'pending')
      run()
    })

    // The Go shell's live step relay (main.go SetSyncEmit → EventsEmit
    // hibana:sync-progress {step, state, detail} — round.go's choreography).
    if (window.runtime && typeof window.runtime.EventsOn === 'function') {
      window.runtime.EventsOn('hibana:sync-progress', function (payload) {
        if (!payload || typeof payload !== 'object') return
        if (!dlg.open) return // a stale event after the modal closed — the round still finishes Go-side
        setStep(payload.step, payload.state, payload.detail || '')
        // v0.1.13 — the hero follows the round's ACTIVE step (the glyph morph
        // + the choreography); a done/failed step leaves the stage where the
        // round stands until the next active step or the outcome takes it.
        if (payload.state === 'active' && payload.step) setStage(payload.step)
      })
    }

    // v0.1.12 — the pulled-boards reflex's trigger: the native close event
    // fires on EVERY exit (the Done button, the Esc cancel) — exactly when
    // the user has finished reading the success panel. An ok round that
    // moved mirror rows (needsReload — the ok body said so) reloads the
    // island, so the cloud's truth — the deletion made on hibana.ir —
    // reaches the VISIBLE board. The same re-boot the toolbar's Refresh
    // button owns, earned by the round's own pulled count; nothing reloads
    // when nothing changed server-side.
    dlg.addEventListener('close', function () {
      if (!needsReload) return
      needsReload = false
      location.reload()
    })

    // Live language flips (i18n.js owns html[lang]) — relabel the surfaces.
    localize()
    try {
      new MutationObserver(localize).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
    } catch (e) { /* no observer — the labels stay at the open-time language */ }
  })
})()
`

// ---------------------------------------------------------------------------
// desktop-sync.css — see the recovery note above for what it owns.
// ---------------------------------------------------------------------------
const DESKTOP_SYNC_CSS = `/* desktop-sync.css — the manual sync modal's step rows + result panels (v0.1.6;
   v0.1.8 grew it: the toolbar's fill-colored Sync pill + the Sprints/Labels
   twin sizing — the owner ask: "a sync button on the header of app, next to
   sprints and labels, but colored. (fill colored)" + "sprints and labels need
   to be same size").
   v0.1.15 grew it again — the COMPLETE-facts fix (the owner ask: "when you
   sync using Hibana Desktop, the modal is not complete and needs fix"): the
   step notes are the round's LIVE FACTS ("signed in as aliassadi@live.com",
   "every board already current · 7 project(s) · 7 board(s)") and the old
   side-by-side 60%-cap ellipsis cut them mid-word — the modal looked done
   but PROVED nothing readable. The rows are now a mark + (label, note)
   grid: the note owns its own full-width line UNDER the label and WRAPS.
   GENERATED FILE — do not hand-edit (guide §3.3.4): emitted by scripts/sync-island.mjs
   into frontend/dist/css/ and checksummed in frontend/island.checksums.json.
   The dialog + .modal card are the island's own (components.css) — this sheet
   starts INSIDE the card. */

/* The three step rows: pending (muted ring) → active (the accent ring spins)
   → done (the green check) / failed (the red cross). v0.1.15: the row is a
   GRID — the mark in column one, the label + its live fact stacked in
   column two — so the note can take the FULL card width and wrap instead
   of ellipsizing at 60%. */
.db-sync-steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.8rem;
}
.db-sync-steps li {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: start;
  column-gap: 0.65rem;
  row-gap: 0.15rem;
  color: var(--muted);
  font-size: var(--fs-md);
  transition: color 0.18s ease;
}
.db-sync-steps li .db-sync-label { grid-column: 2; }
.db-sync-steps li[data-state='active'] { color: var(--fg); }
.db-sync-steps li[data-state='done'] { color: var(--fg); }
.db-sync-steps li[data-state='failed'] { color: var(--err); }

.db-sync-mark {
  grid-column: 1;
  margin-block-start: 0.05rem; /* optical: the ring centers on the label's cap height, not the taller note */
  inline-size: 1.4rem;
  block-size: 1.4rem;
  border-radius: 50%;
  border: 1.5px solid var(--line-strong);
  display: grid;
  place-items: center;
  color: inherit;
  background: transparent;
  transition: border-color 0.18s ease, background-color 0.18s ease;
}
.db-sync-mark .icon { width: 0.95rem; height: 0.95rem; stroke-width: 2.6; }
.db-sync-steps li[data-state='active'] .db-sync-mark { border-color: var(--accent); }
.db-sync-steps li[data-state='done'] .db-sync-mark {
  border-color: var(--ok);
  color: var(--ok);
  background: color-mix(in srgb, var(--ok) 10%, transparent);
}
.db-sync-steps li[data-state='failed'] .db-sync-mark {
  border-color: var(--err);
  color: var(--err);
  background: color-mix(in srgb, var(--err) 10%, transparent);
}

/* The small activity ring (NOT .hibana-spinner — that one is the big pulsing
   loading ring, layout.css:1143; the modal needs the mark-sized one). */
.db-sync-spin {
  display: block;
  inline-size: 0.85rem;
  block-size: 0.85rem;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--accent) 25%, transparent);
  border-block-start-color: var(--accent);
  animation: db-sync-rotate 0.7s linear infinite;
}
@keyframes db-sync-rotate { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .db-sync-spin { animation-duration: 1.6s; }
}

/* The live fact under its step ("hibana.ir reached", "signed in as …", "7
   project(s) · 7 board(s)") — v0.1.15: the note is the REASON the modal
   exists (the round's proof), so it takes the row's full second column on
   its own line, wraps to as many lines as the truth needs, and never
   ellipsizes. overflow-wrap:anywhere keeps a long email or a no-break
   token inside the card instead of stretching it. */
.db-sync-note {
  grid-column: 2;
  font-size: 0.82em;
  color: var(--muted);
  white-space: normal;
  overflow-wrap: anywhere;
  min-inline-size: 0;
}

/* The result panel (one element, three kinds): ok = the green "Everything
   synced — will not vanish" verdict; warn = held outbox ops named honestly;
   err = the failure with the in-place retry. */
.db-sync-panel {
  display: flex;
  align-items: flex-start;
  gap: 0.7rem;
  padding: 0.85rem 0.95rem;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--bg);
}
.db-sync-panel .icon { width: 1.5rem; height: 1.5rem; flex: none; margin-top: 0.1rem; stroke-width: 2.2; }
.db-sync-panel strong { display: block; font-size: var(--fs-md); color: var(--fg); }
.db-sync-panel p { margin: 0.15rem 0 0; white-space: pre-line; }
.db-sync-panel[data-kind='ok'] {
  border-color: color-mix(in srgb, var(--ok) 38%, transparent);
  background: color-mix(in srgb, var(--ok) 8%, transparent);
}
.db-sync-panel[data-kind='ok'] .icon { color: var(--ok); }
.db-sync-panel[data-kind='warn'] {
  border-color: color-mix(in srgb, var(--accent) 38%, transparent);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}
.db-sync-panel[data-kind='warn'] .icon { color: var(--accent); }
.db-sync-panel[data-kind='err'] {
  border-color: color-mix(in srgb, var(--err) 38%, transparent);
  background: color-mix(in srgb, var(--err) 7%, transparent);
}
.db-sync-panel[data-kind='err'] .icon { color: var(--err); }

.db-sync-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
[dir='rtl'] .db-sync-actions { justify-content: flex-start; }

/* The modal card is a compact result dialog — the base .modal padding breathes
   a little tighter. */
.db-sync-modal h2 { margin: 0; }

/* v0.1.8 — the board toolbar row (the owner ask: "sprints and labels need to
   be same size"): Sprints is an <a class="btn ghost small"> — a.ghost's own
   explicit box (base.css: padding 0.55rem 0.75rem, weight 400) diverges from
   its sibling Labels <button class="btn ghost small"> (the global button box:
   0.55rem 1rem + the 500 label weight) — one read visibly WIDER and BOLDER
   than the other. ONE #id rule pins BOTH to the button's own twin metrics:
   identical padding, font, weight, and height. */
#db-sprint-link,
#db-labels-btn {
  padding: 0.55rem 1rem;
  font-size: var(--fs-md);
  font-weight: var(--text-label-weight, 500);
  white-space: nowrap;
}

/* v0.1.8 — the toolbar's Sync button (the owner ask: VISIBLE + FILL-COLORED,
   next to Sprints and Labels): the bare-<button> CTA grammar (base.css S186 —
   a plain <button> IS the app's solid primary: the --cta fill, the white
   --btn-text label, --cta-hover on hover/active — theme-native in light AND
   claude-dark), laid out as an icon + label pill at the SAME twin metrics as
   its neighbors. Sprints/Labels stay neutral ghosts so the ONE colored action
   in the toolbar row is Sync. */
#db-sync-button {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.55rem 1rem;
  border: 1px solid transparent; /* the ghost twins carry a 1px hairline — a transparent border keeps all three boxes the exact same height */
  font-size: var(--fs-md);
  font-weight: var(--text-label-weight, 500);
  white-space: nowrap;
}
#db-sync-button .icon { flex: none; }
#db-sync-button { position: relative; } /* v0.1.21: the count badge's corner anchor */
/* v0.1.21 — THE COUNT BADGE (hibana-sync-status-spec §9): pending + failed cards,
   from the SAME tracker the cards' badges paint from (the island's sync-state.js);
   hidden at zero. Danger fill + the CTA's own --btn-text ink — no new hex; the
   --card ring separates it from the toolbar surface. The rotation reuses this
   sheet's own db-sync-rotate keyframes, reduced-motion guarded. */
.db-sync-count {
  position: absolute;
  top: -0.42rem;
  inset-inline-end: -0.42rem;
  min-inline-size: 1.02rem;
  block-size: 1.02rem;
  padding-inline: 0.28rem;
  border-radius: 999px;
  background: var(--danger);
  color: var(--btn-text);
  font-size: 0.66rem;
  font-weight: 700;
  line-height: 1.02rem;
  text-align: center;
  box-shadow: 0 0 0 2px var(--card);
}
.db-sync-count[hidden] { display: none; }
#db-sync-button.db-sync-running .icon { animation: db-sync-rotate 1.2s linear infinite; }
@media (prefers-reduced-motion: reduce) {
  #db-sync-button.db-sync-running .icon { animation: none; }
}

/* v0.1.13 — THE HERO (the owner ask: "also in modal i want syncing animation
   with icons and animation"): the round's living emblem, a compact stage
   above the factual step rows. One 4.6rem emblem carries the whole
   choreography — the pulse ring reaches out on connect, three packets rise
   through upload, the h-spark orbits while the round is in flight, and the
   central glyph MORPHS per stage (cloud -> upload arrow -> orbit ->
   check/cross) with the ok pop settling the emblem into the green verdict.
   js/desktop-sync.js flips data-stage (the live hibana:sync-progress
   events) + data-kind (the outcome); every keyframe lives here. */
.db-sync-hero {
  display: flex;
  justify-content: center;
  margin-block-end: -0.35rem; /* the emblem breathes tight under the title's grid gap */
}
.db-sync-emblem {
  position: relative;
  inline-size: 4.6rem;
  block-size: 4.6rem;
  border-radius: 50%;
  border: 1px solid var(--line-strong);
  background: color-mix(in srgb, var(--accent) 5%, var(--card));
  transition: border-color 0.25s ease, background-color 0.25s ease;
}

/* The glyphs: only the matching one shows; the rest rest at scale(0.6) +
   transparent, so every stage flip is a morph (a 280ms cubic pop), never
   a swap. The kind rules sit AFTER the stage rules — a settled verdict
   (ok/warn/err) overrides whatever stage the round last stood at. */
.db-sync-glyph {
  position: absolute;
  inset: 0;
  margin: auto;
  inline-size: 1.8rem;
  block-size: 1.8rem;
  stroke-width: 1.9;
  color: var(--accent);
  opacity: 0;
  transform: scale(0.6);
  transition: opacity 0.28s ease, transform 0.28s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.db-sync-hero[data-stage='connect'] .db-sync-glyph-connect,
.db-sync-hero[data-stage='upload'] .db-sync-glyph-upload,
.db-sync-hero[data-stage='sync'] .db-sync-glyph-orbit { opacity: 1; transform: scale(1); }
.db-sync-hero[data-kind='ok'] .db-sync-glyph-ok,
.db-sync-hero[data-kind='warn'] .db-sync-glyph-orbit,
.db-sync-hero[data-kind='err'] .db-sync-glyph-err { opacity: 1; transform: scale(1); }
.db-sync-hero[data-kind='ok'] .db-sync-glyph-ok { color: var(--ok); }
.db-sync-hero[data-kind='err'] .db-sync-glyph-err { color: var(--err); }

/* The verdict settle: the emblem itself tints with the outcome — the green
   ring for ok (the step marks' own --ok grammar), the danger ring for err. */
.db-sync-hero[data-kind='ok'] .db-sync-emblem {
  border-color: color-mix(in srgb, var(--ok) 45%, transparent);
  background: color-mix(in srgb, var(--ok) 9%, transparent);
}
.db-sync-hero[data-kind='err'] .db-sync-emblem {
  border-color: color-mix(in srgb, var(--err) 45%, transparent);
  background: color-mix(in srgb, var(--err) 8%, transparent);
}
.db-sync-hero[data-kind='warn'] .db-sync-emblem {
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
}

/* The connect pulse: the ring reaches OUT (scale + fade, an outgoing
   handshake) exactly while the connect step is ACTIVE and no verdict sits. */
.db-sync-ring {
  position: absolute;
  inset: -1px;
  border-radius: 50%;
  border: 1.5px solid color-mix(in srgb, var(--accent) 55%, transparent);
  opacity: 0;
  pointer-events: none;
}
.db-sync-hero[data-stage='connect'][data-kind=''] .db-sync-ring {
  animation: db-sync-pulse 1.15s ease-out infinite;
}
@keyframes db-sync-pulse {
  0% { opacity: 0.65; transform: scale(1); }
  100% { opacity: 0; transform: scale(1.45); }
}

/* The orbit: the h-spark circles the emblem while a round is in flight
   (kind='') — faster through the sync stage — and stops dead on every
   verdict. The spark is the accent dot with a soft glow, the loader-mark
   grammar's own tiny descendant. */
.db-sync-orbit {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.db-sync-spark {
  position: absolute;
  top: -2.5px;
  left: 50%;
  margin-left: -2.5px;
  inline-size: 5px;
  block-size: 5px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 60%, transparent);
}
.db-sync-hero[data-kind=''] .db-sync-orbit { animation: db-sync-orbit 1.6s linear infinite; }
.db-sync-hero[data-stage='sync'][data-kind=''] .db-sync-orbit { animation-duration: 1.1s; }
@keyframes db-sync-orbit { to { transform: rotate(360deg); } }

/* The upload packets: three dots rise through the emblem exactly while the
   upload step is ACTIVE — changes visibly ON THE WAY UP, staggered. */
.db-sync-packets {
  position: absolute;
  inset: 0;
  opacity: 0;
  pointer-events: none;
}
.db-sync-packets span {
  position: absolute;
  bottom: 0.55rem;
  left: 50%;
  inline-size: 3px;
  block-size: 3px;
  margin-left: -1.5px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--accent) 75%, transparent);
  opacity: 0;
}
.db-sync-hero[data-stage='upload'][data-kind=''] .db-sync-packets { opacity: 1; }
.db-sync-hero[data-stage='upload'][data-kind=''] .db-sync-packets span { animation: db-sync-rise 0.9s ease-in infinite; }
.db-sync-hero[data-stage='upload'][data-kind=''] .db-sync-packets span:nth-child(2) { animation-delay: 0.3s; margin-left: 0.35rem; }
.db-sync-hero[data-stage='upload'][data-kind=''] .db-sync-packets span:nth-child(3) { animation-delay: 0.6s; margin-left: -1rem; }
@keyframes db-sync-rise {
  0% { opacity: 0; transform: translateY(0); }
  25% { opacity: 0.9; }
  100% { opacity: 0; transform: translateY(-1.5rem); }
}

/* The ok pop: the check lands with the same overshoot the glyph morph uses
   — the settle IS the satisfaction beat, paired with the all-clear chime. */
.db-sync-hero[data-kind='ok'] .db-sync-glyph-ok {
  animation: db-sync-pop 0.45s cubic-bezier(0.34, 1.56, 0.64, 1);
}
@keyframes db-sync-pop {
  0% { transform: scale(0.35); }
  60% { transform: scale(1.18); }
  100% { transform: scale(1); }
}

/* The step rows' own life: a step turning done pops its check in (the same
   overshoot grammar), and the result panel slides up into place instead of
   snapping — the whole modal moves with the round now. */
.db-sync-steps li[data-state='done'] .db-sync-mark .icon {
  animation: db-sync-pop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.db-sync-panel:not([hidden]) {
  animation: db-sync-panel-in 0.3s ease;
}
@keyframes db-sync-panel-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

/* The motion budget: reduced motion keeps the STATE legible (the glyph
   morph + the verdict tints are information, not ornament) but spends no
   loops — the pulse/orbit/packets/rise animations go still, the pops and
   the slide vanish (the glyph morph relaxes to a plain 180ms linear fade),
   and the activity ring spins at the modal's own reduced tempo. */
@media (prefers-reduced-motion: reduce) {
  .db-sync-hero[data-stage='connect'][data-kind=''] .db-sync-ring { animation: none; }
  .db-sync-hero[data-stage='upload'][data-kind=''] .db-sync-packets span { animation: none; }
  .db-sync-hero[data-kind=''] .db-sync-orbit { animation-duration: 1.6s; }
  .db-sync-glyph { transition-duration: 0.18s; transition-timing-function: linear; }
  .db-sync-hero[data-kind='ok'] .db-sync-glyph-ok,
  .db-sync-steps li[data-state='done'] .db-sync-mark .icon { animation: none; }
  .db-sync-panel:not([hidden]) { animation: none; }
}
`

// desktop-logout.js — the sign-out controller (v0.1.9 — the owner ask: "It
// must also have option of logout and enter with a new account"). The
// toolbar's #db-logout-button opens the #db-logout-dialog confirm; the
// confirm resolves the Go Logout binding at CLICK time (the v0.1.1 lesson) —
// the round-trip is Go-side and best-effort, and the {ok:true} resolve
// location.reload()s into the login card, where the user enters the new
// account (desktop-login.js → Go Login → reload → the kanban). The button /
// title / cancel / confirm labels ride the pin's own dictionaries via
// data-i18n (nav.signout + common.cancel — present in BOTH island
// dictionaries, verified @ the pin); only the body copy + the failure lines
// are this file's own EN/FA pair, live-flipped off html[lang].
const DESKTOP_LOGOUT_JS = `// desktop-logout.js — the sign-out option + its confirm dialog (v0.1.9 — the
// owner ask: "It must also have option of logout and enter with a new account").
// GENERATED FILE — do not hand-edit (guide §3.3.4): emitted by scripts/sync-island.mjs
// into frontend/dist/js/ and checksummed in frontend/island.checksums.json. Loads
// blocking, right after desktop-sync.js, BEFORE every deferred island script.
//
// WHAT THIS FILE OWNS: the toolbar's #db-logout-button → the #db-logout-dialog
// confirm → the Go Logout binding (internal/ui.API.Logout — POST /api/auth/logout
// happens Go-SIDE, best-effort; then the cookie, the persisted session file, the
// ETag cache and the mirror's account-scoped rows all die Go-side) → on ok a
// location.reload(): the shell serves the document with data-desktop-authed="false",
// the login card opens at first paint, and signing in with the new account boots its
// kanban. The title/confirm/cancel labels ride the pin's own i18n keys
// (nav.signout / common.cancel — data-i18n on the markup, live-flipped by i18n.js);
// only the body copy + the failure lines are this file's own EN/FA pair.
//
// WHAT IT MUST NEVER OWN: no cookie/token handling, no credential storage, no
// storage of any kind — all Go-side.
(function () {
  'use strict'

  var STR = {
    en: {
      body: 'Your boards live safe on the Hibana cloud — sign in again any time to load them back.',
      notWired: 'The desktop bridge is not wired — restart the app.',
      unreachable: 'Cannot reach hibana.ir — check your connection and try again.'
    },
    fa: {
      body: 'تخته‌های شما در ابر هیبانا امن هستند — هر وقت خواستید دوباره وارد شوید و آن‌ها را بارگذاری کنید.',
      notWired: 'پل دسکتاپ وصل نیست — برنامه را دوباره باز کنید.',
      unreachable: 'اتصال به hibana.ir ممکن نیست — اتصال خود را بررسی کنید.'
    }
  }

  function lang() { return document.documentElement.lang === 'fa' ? 'fa' : 'en' }
  function t(key) { return (STR[lang()] && STR[lang()][key]) || STR.en[key] || key }

  // The bridge resolver — the same defensive chain desktop-login.js/-sync.js
  // use (all generated + drift-controlled; the duplication is by design so
  // the sign-out keeps working even if the shim's internal shape ever evolves).
  function pick(root, keys) {
    let cur = root
    for (let i = 0; i < keys.length; i++) {
      if (cur == null || typeof cur !== 'object') return null
      cur = cur[keys[i]]
    }
    return typeof cur === 'function' ? cur : null
  }
  function resolveBoundMethod(name) {
    let fn = pick(window, ['go', 'desktop', 'API', name])
    if (fn) return fn
    fn = pick(window, ['gohibana', 'api', name])
    if (fn) return fn
    fn = pick(window, ['gohibana', 'API', name])
    if (fn) return fn
    const go = window.go
    if (go && typeof go === 'object') {
      for (const pkg of Object.keys(go)) {
        fn = pick(go[pkg], ['API', name]) || pick(go[pkg], ['api', name])
        if (fn) return fn
      }
    }
    return null
  }

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn)
    else fn()
  }

  ready(function () {
    var btn = document.getElementById('db-logout-button')
    var dlg = document.getElementById('db-logout-dialog')
    if (!btn || !dlg || typeof dlg.showModal !== 'function') return

    var body = document.getElementById('db-logout-body')
    var errEl = document.getElementById('db-logout-error')
    var confirmBtn = document.getElementById('db-logout-confirm')
    var cancelBtn = document.getElementById('db-logout-cancel')
    var busy = false

    function localize() {
      // The button/title/cancel/confirm labels ride data-i18n (i18n.js owns
      // them, live-flipped); only the body line is this file's pair.
      if (body) body.textContent = t('body')
    }

    function fail(msg) {
      if (!errEl) return
      errEl.textContent = msg
      errEl.hidden = false
    }

    function reset() {
      busy = false
      if (confirmBtn) confirmBtn.disabled = false
      if (cancelBtn) cancelBtn.disabled = false
      if (errEl) errEl.hidden = true
    }

    confirmBtn.addEventListener('click', function () {
      if (busy) return
      busy = true
      if (confirmBtn) confirmBtn.disabled = true
      if (cancelBtn) cancelBtn.disabled = true
      if (errEl) errEl.hidden = true
      var bridgeLogout = resolveBoundMethod('Logout')
      if (!bridgeLogout) { reset(); fail(t('notWired')); return }
      try {
        Promise.resolve(bridgeLogout()).then(function (res) {
          if (res && res.ok) {
            // The LOCAL account state is gone — reload: the shell serves the
            // document with data-desktop-authed="false", the login card
            // paints at the first frame, and the user signs in with the new
            // account (desktop-login.js → Go Login → reload → the kanban).
            location.reload()
            return
          }
          reset()
          fail(t('unreachable'))
        }, function () {
          reset()
          fail(t('unreachable'))
        })
      } catch (e) { reset(); fail(t('notWired')) }
    })

    if (cancelBtn) cancelBtn.addEventListener('click', function () { if (!busy) dlg.close() })
    btn.addEventListener('click', function () {
      if (busy) return
      localize()
      dlg.showModal()
    })

    // Live language flips (i18n.js owns html[lang]) — relabel the body line.
    localize()
    try {
      new MutationObserver(localize).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
    } catch (e) { /* no observer — the label stays at the open-time language */ }
  })
})()
`

// desktop-logout.css — the sign-out round's desktop-owned styles (v0.1.9 — the
// owner ask: "It must also have option of logout and enter with a new account").
// The dialog + .modal card are the island's own (components.css — the .modal
// grid's 1rem gap already spaces the title/body/error/actions stack); this
// sheet only pins the toolbar button's icon+label box (the twin metrics) and
// the confirm row.
const DESKTOP_LOGOUT_CSS = `/* desktop-logout.css — the sign-out round (v0.1.9 — the owner ask: "It must
   also have option of logout and enter with a new account").
   GENERATED FILE — do not hand-edit (guide §3.3.4): emitted by scripts/sync-island.mjs
   into frontend/dist/css/ and checksummed in frontend/island.checksums.json.
   The dialog + .modal card are the island's own (components.css) — this sheet
   starts INSIDE the card. */

/* The toolbar's Log out button — the account zone at the row's END (after the
   theme toggle). Ghost on purpose (account actions are not CTAs — Sync stays
   the ONE colored action in the row), the log-out glyph + the pin's own
   nav.signout label, laid out as an icon+label pill at the same twin metrics
   as Sprints/Labels/Sync (the S220 "same size" grammar). */
#db-logout-button {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  white-space: nowrap;
}
#db-logout-button .icon { flex: none; }

/* The confirm dialog's action row — the .db-sync-actions grammar (the pair
   right-aligned, start-aligned under RTL). The .modal grid's own gap spaces
   the title / body / error stack above it. */
.db-logout-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
[dir='rtl'] .db-logout-actions { justify-content: flex-start; }
.db-logout-modal h2 { margin: 0; }
`

// ---------------------------------------------------------------------------
// desktop-newproject.js — generated below into dist/js/ (the v0.1.11
// new-project round). Written without template literals/backticks so it can
// nest in this literal.
// ---------------------------------------------------------------------------
const DESKTOP_NEWPROJECT_JS = `// desktop-newproject.js — the new-project round (v0.1.11 — the owner ask:
// "Add ability to define a new project, and get a kanban for it as well. this
// project then will be updated in hibana's cloudflare as a new project.").
// GENERATED FILE — do not hand-edit (guide §3.3.4): emitted by scripts/sync-island.mjs
// into frontend/dist/js/ and checksummed in frontend/island.checksums.json. Loads
// blocking, right after desktop-logout.js, BEFORE every deferred island script.
//
// WHAT THIS FILE OWNS: the ability to DEFINE a project on the desktop and get
// its kanban — a LIVE cloud create, not a local stub:
//   1. THREE entry points: the switcher popup's "New project" row (injected by
//      the MutationObserver the moment board-page.js's openSwitch builds the
//      popup at runtime), and EVERY dead /projects.html link on the board
//      surface (the no-projects empty-state CTA, board-page.js:466; the fail
//      state, :920) — intercepted into the dialog because the embedded server
//      serves no projects page; the switcher list IS it. The popup's own
//      "All projects →" link (:371) is css-hidden (desktop-newproject.css).
//   2. THE CREATE: mint a client UUID v4 -> POST /api/projects {id, title,
//      description?, status:'planning'} through window.hibanaFetch — the
//      shim's fetch-compatible seam into the bridge's ONE Request transport
//      (the Go client stamps the Origin + the session cookie; the T6 write
//      gate passes) — the web API's own idempotent-by-client-id contract
//      (201 {ok,id} / 200 {ok,duplicate}: both mean the project EXISTS on
//      the Hibana cloud; routes/projects/index.ts:389).
//   3. THE KANBAN: on the ok resolve, location.assign the island's OWN
//      /kanban?project=<id> deep link — the boot loads the fresh board (GET
//      /api/projects/:id/devboard: the project + its empty columns), and the
//      island's own boot->recordBoard() writes hibana-kanban-last; THIS FILE
//      never touches storage (the island's code does, exactly as on the web).
//   4. status:'planning' — NOT the createProjectSchema's 'spark' default: the
//      switcher's list (GET /api/projects?sort=recent) EXCLUDES sparks
//      (routes/projects/index.ts:66), so a spark would never appear in the
//      very switcher it was created from; 'planning' is the first ACTIVE
//      stage — it lands in the list AND owns its kanban.
//
// WHAT IT MUST NEVER OWN: no cookie/token handling, no storage of any kind,
// no offline queueing (the outbox's project.create entity is M3's scope — a
// create that LOOKS queued but is not would be a lie; offline surfaces the
// unreachable line honestly).
(function () {
  'use strict'

  var STR = {
    en: {
      body: 'Name the project — it is created on the Hibana cloud (hibana.ir) and its Kanban board opens right here.',
      busy: 'Creating on hibana.ir…',
      notWired: 'The desktop bridge is not wired — restart the app.',
      unreachable: 'Cannot reach hibana.ir — check your connection and try again.',
      session: 'Your session expired — sign in again, then retry.',
      rate: 'Too many attempts — wait a minute and try again.',
      refused: 'hibana.ir refused the create — check the name and try again.',
      conflict: 'That project id already exists — try again.',
      emptyTitle: 'Give the project a name first.'
    },
    fa: {
      body: 'نام پروژه را وارد کنید — روی ابر هیبانا (hibana.ir) ساخته می‌شود و برد کانبانش همین‌جا باز می‌شود.',
      busy: 'در حال ساخت روی hibana.ir…',
      notWired: 'پل دسکتاپ وصل نیست — برنامه را دوباره باز کنید.',
      unreachable: 'اتصال به hibana.ir ممکن نیست — اتصال خود را بررسی کنید.',
      session: 'نشست شما منقضی شده — دوباره وارد شوید و تلاش کنید.',
      rate: 'تلاش‌های شما زیاد بوده — کمی صبر کنید و دوباره تلاش کنید.',
      refused: 'hibana.ir ساخت پروژه را نپذیرفت — نام را بررسی کنید و دوباره تلاش کنید.',
      conflict: 'پروژه‌ای با این شناسه موجود است — دوباره تلاش کنید.',
      emptyTitle: 'اول یک نام برای پروژه وارد کنید.'
    }
  }

  function lang() { return document.documentElement.lang === 'fa' ? 'fa' : 'en' }
  function t(key) { return (STR[lang()] && STR[lang()][key]) || STR.en[key] || key }

  // The pin's own dictionaries carry every dialog label (cmdk.newProject /
  // sparks.title / sparks.description / cat.quickAdd / common.cancel — EN + FA
  // @ pin). Resolve at CALL time, never a parse-time snapshot (the v0.1.1
  // lesson) — the switcher row is runtime-injected, so data-i18n cannot own it.
  function pin(key, fallback) {
    var s = window.hibanaI18n ? window.hibanaI18n.t(key) : null
    return s && s !== key ? s : fallback
  }

  // The client-minted id — the create's idempotency key (the server re-validates
  // the uuid shape; a replay of the same id answers {ok,duplicate} 200 — the
  // offline-replay-safety contract the web quick-add itself rides).
  function uuid() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID()
    } catch (e) { /* fall through to the v4 shim */ }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0
      var v = c === 'x' ? r : (r & 0x3) | 0x8
      return v.toString(16)
    })
  }

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn)
    else fn()
  }

  ready(function () {
    var dlg = document.getElementById('db-newproject-dialog')
    if (!dlg || typeof dlg.showModal !== 'function') return

    var titleInput = document.getElementById('db-newproject-title-input')
    var descInput = document.getElementById('db-newproject-description')
    var body = document.getElementById('db-newproject-body')
    var errEl = document.getElementById('db-newproject-error')
    var createBtn = document.getElementById('db-newproject-create')
    var cancelBtn = document.getElementById('db-newproject-cancel')
    var busy = false

    function authed() {
      // The login gate owns an unauthenticated surface (the shell serves
      // data-desktop-authed on <html> at every paint — the first-paint rule).
      return document.documentElement.getAttribute('data-desktop-authed') !== 'false'
    }

    function fail(msg) {
      if (!errEl) return
      errEl.textContent = msg
      errEl.hidden = false
    }

    function reset() {
      busy = false
      if (createBtn) { createBtn.disabled = false; createBtn.textContent = pin('cat.quickAdd', 'Create') }
      if (cancelBtn) cancelBtn.disabled = false
    }

    function localize() {
      if (body) body.textContent = t('body')
      // The runtime-injected switcher row's label — the pin's own
      // cmdk.newProject (EN 'New project' / FA 'پروژهٔ جدید').
      var rowLabel = document.getElementById('db-switch-new-label')
      if (rowLabel) rowLabel.textContent = pin('cmdk.newProject', 'New project')
      var row = document.getElementById('db-switch-new')
      if (row) {
        var lbl = pin('cmdk.newProject', 'New project')
        row.setAttribute('title', lbl)
        row.setAttribute('aria-label', lbl)
      }
    }

    function open() {
      if (busy || !authed()) return
      if (titleInput) titleInput.value = ''
      if (descInput) descInput.value = ''
      if (errEl) errEl.hidden = true
      if (createBtn) { createBtn.disabled = false; createBtn.textContent = pin('cat.quickAdd', 'Create') }
      if (cancelBtn) cancelBtn.disabled = false
      localize()
      dlg.showModal()
      if (titleInput) titleInput.focus()
    }

    function create() {
      if (busy) return
      var title = titleInput ? String(titleInput.value || '').trim() : ''
      if (!title) { fail(t('emptyTitle')); if (titleInput) titleInput.focus(); return }
      if (typeof window.hibanaFetch !== 'function') { fail(t('notWired')); return }
      var id = uuid()
      var payload = { id: id, title: title, status: 'planning' }
      var desc = descInput ? String(descInput.value || '').trim() : ''
      if (desc) payload.description = desc
      busy = true
      if (createBtn) { createBtn.disabled = true; createBtn.textContent = t('busy') }
      if (cancelBtn) cancelBtn.disabled = true
      if (errEl) errEl.hidden = true
      // POST /api/projects — the LIVE Hibana-cloud create through the shim's
      // fetch seam (the bridge's ONE Request transport: Origin + cookie are
      // stamped Go-side). 201 {ok,id} / 200 {ok,duplicate} both mean the
      // project EXISTS on the cloud — navigate the island's own deep link.
      window.hibanaFetch('/api/projects', { method: 'POST', body: JSON.stringify(payload) })
        .then(function (r) {
          if (r.ok) {
            return r.json().catch(function () { return {} }).then(function (b) {
              var pid = (b && b.id) || id
              // The project is on the Hibana cloud — boot its kanban via the
              // island's own deep-link path (recordBoard runs island-side).
              location.assign('/kanban?project=' + encodeURIComponent(pid))
            })
          }
          reset()
          // 401: the bridge already reopened the login card Go-side
          // (NotifyAuthLost); the session line explains the retry.
          if (r.status === 401) { fail(t('session')); return }
          if (r.status === 429) { fail(t('rate')); return }
          if (r.status === 409) { fail(t('conflict')); return }
          fail(t('refused'))
        })
        .catch(function () { reset(); fail(t('unreachable')) })
    }

    if (createBtn) createBtn.addEventListener('click', function (e) { e.preventDefault(); create() })
    if (cancelBtn) cancelBtn.addEventListener('click', function () { if (!busy) dlg.close() })
    var form = document.getElementById('db-newproject-form')
    if (form) form.addEventListener('submit', function (e) { e.preventDefault(); create() })
    // Esc cannot drop an in-flight create — the POST's outcome is unknown until
    // it resolves (the honest-transport rule; the dialog re-opens on reset).
    dlg.addEventListener('cancel', function (e) { if (busy) e.preventDefault() })
    dlg.addEventListener('close', reset)

    // The dead /projects.html links — the embedded server serves no projects
    // page; the empty state's "Go to projects" CTA (board-page.js:466) and the
    // fail state's link (:920) both become the create dialog, the desktop's
    // honest affordance (the empty state's own copy says "Create your first
    // project" — now the desktop actually can).
    document.addEventListener('click', function (e) {
      if (!e.target || !e.target.closest) return
      var a = e.target.closest('a[href="/projects.html"]')
      if (!a) return
      e.preventDefault()
      open()
    })

    // The switcher popup's New project row — board-page.js builds the popup
    // lazily at RUNTIME (openSwitch appends it to <body>), so the row joins via
    // MutationObserver the moment the popup is born. Appended as a POPUP
    // SIBLING after the list div: renderSwitchRows rewrites #db-switch-list's
    // innerHTML on every list update, but this row survives every re-render —
    // and the popup stays OPEN under the modal's backdrop, so board-page.js's
    // own switchOpen state is never desynced (closeSwitch stays consistent).
    function injectRow() {
      var pop = document.getElementById('db-switch-pop')
      if (!pop || document.getElementById('db-switch-new')) return
      var row = document.createElement('button')
      row.type = 'button'
      row.id = 'db-switch-new'
      row.className = 'db-switch-row db-switch-new'
      row.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span class="db-switch-name" id="db-switch-new-label"></span>'
      row.addEventListener('click', function (e) { e.preventDefault(); open() })
      pop.appendChild(row)
      localize()
    }
    injectRow()
    try {
      new MutationObserver(injectRow).observe(document.body, { childList: true, subtree: true })
    } catch (e) { /* no observer — the row injects on the ready pass only */ }

    // Live language flips (i18n.js owns html[lang]) — relabel the body line +
    // the runtime-injected row.
    localize()
    try {
      new MutationObserver(localize).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
    } catch (e) { /* no observer — the labels stay at the open-time language */ }
  })
})()
`

// ---------------------------------------------------------------------------
// desktop-newproject.css — generated below into dist/css/. The dialog +
// .modal card + the .modal label grid + the .error line are the island's own
// (components.css / base.css) — this sheet starts INSIDE the card.
// ---------------------------------------------------------------------------
const DESKTOP_NEWPROJECT_CSS = `/* desktop-newproject.css — the new-project round (v0.1.11 — the owner ask:
   "Add ability to define a new project, and get a kanban for it as well. this
   project then will be updated in hibana's cloudflare as a new project.").
   GENERATED FILE — do not hand-edit (guide §3.3.4): emitted by scripts/sync-island.mjs
   into frontend/dist/css/ and checksummed in frontend/island.checksums.json.
   The dialog + .modal card + the .modal label grid + the .error line are the
   island's own (components.css / base.css) — this sheet starts INSIDE the card. */

/* The switcher popup's New project row — injected at RUNTIME by
   js/desktop-newproject.js (board-page.js builds the popup lazily on first
   open), riding the pin's own .db-switch-row grammar (devboard.css) with the
   + glyph where a project row carries its status badge; accent-as-TEXT —
   the S204 doctrine (the 5.74:1 --accent-ink), never a filled accent. */
.db-switch-new { color: var(--accent-ink); }

/* The desktop serves NO projects page — the switcher list IS it — so the
   popup's dead "All projects →" link (/projects.html, board-page.js:371; a
   web page the embedded asset server does not carry) is hidden and the New
   project row replaces it at the popup's foot. The OTHER /projects.html
   links (the no-projects CTA :466, the fail state :920) are click-intercepted
   into the dialog by the controller instead. */
.db-switch-all { display: none; }

/* The dialog's description textarea — rows=3 renders it; the min-block-size
   belt keeps the box readable if the UA sheet ever disagrees. */
.db-newproject-modal textarea { min-block-size: 5rem; }

/* The actions row — the .db-logout-actions grammar (the pair right-aligned,
   start-aligned under RTL). The Create button is the BARE <button> (the S186
   CTA grammar — the view's one solid primary, the sign-out confirm's shape);
   Cancel the neutral secondary ahead of it. */
.db-newproject-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
[dir='rtl'] .db-newproject-actions { justify-content: flex-start; }
.db-newproject-modal h2 { margin: 0; }
`

// ---------------------------------------------------------------------------
// desktop-refresh.js — generated below into dist/js/ (the v0.1.12
// refresh round). Written without template literals/backticks so it can nest
// in this literal.
// ---------------------------------------------------------------------------
const DESKTOP_REFRESH_JS = `// desktop-refresh.js — the refresh round (v0.1.12 — the owner ask: "I tried
// something, deleted something from hibana, clicked sync on the app, but it
// didn't got deleted. it seems we need a refresh button"). The sync round
// PULLS the boards into the Go mirror, but the island's own DOM keeps the
// boot-time render — a deletion made on hibana.ir stayed on screen even after
// a green sync. This button is the explicit pull-to-screen: one click re-boots
// the island (location.reload — board-page.js pushState'd ?project= so a
// refresh re-enters the SAME board), and the boot fetches ride the bridge's
// always-fresh interactive transport (never the conditional poll), so the
// cloud's truth — the deletion included — paints. The sync modal grew the
// same reflex for its own round (desktop-sync.js v0.1.12: an ok outcome with
// pulled boards reloads on close); this button is the always-there affordance.
// GENERATED FILE — do not hand-edit (guide §3.3.4): emitted by scripts/sync-island.mjs
// into frontend/dist/js/ and checksummed in frontend/island.checksums.json. Loads
// blocking, right after desktop-newproject.js, BEFORE every deferred island script.
(function () {
  'use strict'

  // The desktop-owned strings. The pin's dictionaries carry no refresh key
  // (verified @ the pin), so this EN/FA pair is the button's own; i18n.js
  // owns html[lang], and localize() reads it live.
  var STR = {
    en: { btn: 'Refresh board', label: 'Refresh' },
    fa: { btn: 'به‌روزرسانی تخته', label: 'به‌روزرسانی' }
  }

  function lang() { return document.documentElement.lang === 'fa' ? 'fa' : 'en' }
  function t(key) { return (STR[lang()] && STR[lang()][key]) || STR.en[key] || key }

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn)
    else fn()
  }

  ready(function () {
    var btn = document.getElementById('db-refresh-button')
    if (!btn) return
    var label = document.getElementById('db-refresh-btn-label')
    var busy = false

    function localize() {
      btn.setAttribute('aria-label', t('btn'))
      btn.setAttribute('title', t('btn'))
      if (label) label.textContent = t('label')
    }

    // One guard: a second click while the reload is pending must not
    // double-schedule — the first reload already owns the document. The
    // data-busy attribute spins the glyph (desktop-refresh.css) for the
    // frame(s) before the unload; a re-boot always follows on a live click.
    btn.addEventListener('click', function () {
      if (busy) return
      busy = true
      btn.setAttribute('data-busy', 'true')
      btn.setAttribute('aria-busy', 'true')
      location.reload()
    })

    // Live language flips (i18n.js owns html[lang]) — relabel the surfaces.
    localize()
    try {
      new MutationObserver(localize).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
    } catch (e) { /* no observer — the label stays at the boot language */ }
  })
})()
`

// ---------------------------------------------------------------------------
// desktop-refresh.css — generated below into dist/css/. The toolbar row's own
// grammar owns the button; this sheet only pins the twin metrics + the spin.
// ---------------------------------------------------------------------------
const DESKTOP_REFRESH_CSS = `/* desktop-refresh.css — the refresh round (v0.1.12 — the owner ask: "I tried
   something, deleted something from hibana, clicked sync on the app, but it
   didn't got deleted. it seems we need a refresh button").
   GENERATED FILE — do not hand-edit (guide §3.3.4): emitted by scripts/sync-island.mjs
   into frontend/dist/css/ and checksummed in frontend/island.checksums.json. */

/* The toolbar's Refresh button — the pull-to-screen affordance right after
   the Sync CTA (Sprints | Labels | Sync | Refresh | theme | Log out). Ghost
   on purpose (the row's grammar: Sync stays the ONE colored action), the
   refresh glyph + the desktop-owned label at the same twin metrics as
   Sprints/Labels/Sync/Log out (the S220 "same size" grammar — the icon +
   label pill inline-flex so the glyph centers against the text). */
#db-refresh-button {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  white-space: nowrap;
}
#db-refresh-button .icon { flex: none; }

/* The between-clicks frame: the glyph spins while the reload is pending (the
   unload usually beats the first turn — the spin is the belt for a slow one,
   never a fake progress bar). The prefers-reduced-motion respect mirrors the
   sync modal's own spin discipline. */
#db-refresh-button[data-busy] .icon {
  animation: db-refresh-rotate 0.7s linear infinite;
}
@keyframes db-refresh-rotate { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  #db-refresh-button[data-busy] .icon { animation-duration: 1.6s; }
}
`

// ---------------------------------------------------------------------------
// desktop-update.js — generated below into dist/js/ (the v0.1.14 auto-update
// round — the owner ask: "Add an auto update for the app. when the new
// version releases in the github, app syncs with the internet and github,
// and if new version, whether portable or installer released, show a button
// for update. it must update from github and replace without losing data or
// needing user to re login."). The island's half of the round: the HIDDEN
// toolbar pill that the hibana:update-available event reveals (no update =
// no button, the honest default), and the modal whose "Update now" rides the
// Go ApplyUpdate binding (the download verifies against the release's own
// checksums.txt Go-side; the swap waits for the app to quit; the relaunched
// exe boots straight back into the board — the data dir is never on the
// replace path). Written without template literals/backticks so it can nest
// in this literal.
// ---------------------------------------------------------------------------
const DESKTOP_UPDATE_JS = `// desktop-update.js — the auto-update round (v0.1.14 — the owner ask: "Add an
// auto update for the app. when the new version releases in the github, app
// syncs with the internet and github, and if new version, whether portable
// or installer released, show a button for update. it must update from
// github and replace without losing data or needing user to re login.").
// The Go shell checks github.com/assadigit/hibana-desktop/releases/latest at
// boot + every 2h (main.go updateLoop); THIS controller is the island half:
// the toolbar Update pill (HIDDEN until a newer release exists — the
// hibana:update-available event) + the update modal (version line, the
// asset kind + size, the live progress bar on hibana:update-progress, and
// the restarting panel on {ok:true} — the app quits ~1.5s after that resolve,
// so NO reload here: the Go process restarts the whole island instead).
// GENERATED FILE — do not hand-edit (guide §3.3.4): emitted by scripts/sync-island.mjs
// into frontend/dist/js/ and checksummed in frontend/island.checksums.json. Loads
// blocking, right after desktop-refresh.js, BEFORE every deferred island script.
(function () {
  'use strict'

  // The desktop-owned strings. The pin's dictionaries carry no update key
  // (verified @ the pin), so this EN/FA pair is the round's own; i18n.js
  // owns html[lang], and localize() reads it live.
  var STR = {
    en: {
      btn: 'Update Hibana now',
      label: 'Update',
      title: 'A new version is available',
      version: 'Hibana {cur} → {new}',
      kindPortable: 'Portable update — {size} from GitHub',
      kindInstaller: 'Installer update — {size} from GitHub',
      dataNote: 'Your boards and your sign-in stay exactly as they are — Hibana just restarts into the new version.',
      download: 'Downloading — {pct}%',
      verify: 'Verifying the download…',
      restartingTitle: 'Update ready — restarting…',
      restartingBody: 'Hibana {v} is installed. The app restarts in a moment — your boards and your sign-in stay as they are.',
      later: 'Later',
      go: 'Update now',
      errTitle: 'Update failed',
      notWired: 'The desktop bridge is not wired — restart the app.',
      busy: 'An update is already in progress.',
      noUpdate: 'No update is available right now.',
      // v0.1.19 — the manual-fallback note (the owner ask: "auto-open
      // release page when an apply fails"): the Go bridge opened the
      // release's human page in the system browser and flagged the resolve
      // {pageOpened:true}; this line says so, and paints ONLY on that flag.
      pageOpened: 'The release page opened in your browser — you can download and install this version by hand.'
    },
    fa: {
      btn: 'بروزرسانی هیبانا',
      label: 'نسخهٔ جدید',
      title: 'نسخهٔ جدید در دسترس است',
      version: 'هیبانا {cur} → {new}',
      kindPortable: 'بروزرسانی پرتابل — {size} از گیت‌هاب',
      kindInstaller: 'بروزرسانی نصبی — {size} از گیت‌هاب',
      dataNote: 'تخته‌ها و نشست شما دقیقاً همان‌طور می‌مانند — هیبانا فقط به نسخهٔ جدید بازراه‌اندازی می‌شود.',
      download: 'در حال دانلود — {pct}٪',
      verify: 'در حال بررسی دانلود…',
      restartingTitle: 'بروزرسانی آماده است — در حال بازراه‌اندازی…',
      restartingBody: 'هیبانا {v} نصب شد. برنامه یک لحظه دیگر دوباره باز می‌شود — تخته‌ها و نشست شما همان‌طور می‌مانند.',
      later: 'بعداً',
      go: 'بروزرسانی کن',
      errTitle: 'بروزرسانی ناموفق بود',
      notWired: 'پل دسکتاپ وصل نیست — برنامه را دوباره باز کنید.',
      busy: 'یک بروزرسانی دیگر در جریان است.',
      noUpdate: 'در حال حاضر بروزرسانی‌ای در دسترس نیست.',
      // v0.1.19 — the manual-fallback note's FA twin.
      pageOpened: 'صفحهٔ انتشار در مرورگر شما باز شد — می‌توانید این نسخه را دستی دانلود و نصب کنید.'
    }
  }

  function lang() { return document.documentElement.lang === 'fa' ? 'fa' : 'en' }
  function t(key) { return (STR[lang()] && STR[lang()][key]) || STR.en[key] || key }
  function fmt(key, map) {
    var s = t(key)
    for (var k in map) s = s.split('{' + k + '}').join(String(map[k]))
    return s
  }

  // The bridge resolver — the same defensive chain desktop-sync.js/-theme.js
  // use (all generated + drift-controlled; the duplication is by design).
  function pick(root, keys) {
    let cur = root
    for (let i = 0; i < keys.length; i++) {
      if (cur == null || typeof cur !== 'object') return null
      cur = cur[keys[i]]
    }
    return typeof cur === 'function' ? cur : null
  }
  function resolveBoundMethod(name) {
    let fn = pick(window, ['go', 'desktop', 'API', name])
    if (fn) return fn
    fn = pick(window, ['gohibana', 'api', name])
    if (fn) return fn
    fn = pick(window, ['gohibana', 'API', name])
    if (fn) return fn
    const go = window.go
    if (go && typeof go === 'object') {
      for (const pkg of Object.keys(go)) {
        fn = pick(go[pkg], ['API', name]) || pick(go[pkg], ['api', name])
        if (fn) return fn
      }
    }
    return null
  }

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn)
    else fn()
  }

  // fmtSize paints the release asset size the way the island paints counts —
  // honest MB with one decimal under 10.
  function fmtSize(bytes) {
    var n = Number(bytes)
    if (!(n > 0)) return ''
    var mb = n / (1024 * 1024)
    return (mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10) + ' MB'
  }

  ready(function () {
    var btn = document.getElementById('db-update-button')
    var dlg = document.getElementById('db-update-dialog')
    if (!btn || !dlg || typeof dlg.showModal !== 'function') return

    var btnLabel = document.getElementById('db-update-btn-label')
    var versionEl = document.getElementById('db-update-version')
    var kindEl = document.getElementById('db-update-kind')
    var bodyEl = document.getElementById('db-update-body')
    var progress = document.getElementById('db-update-progress')
    var fill = document.getElementById('db-update-fill')
    var note = document.getElementById('db-update-note')
    var panel = document.getElementById('db-update-panel')
    var panelTitle = document.getElementById('db-update-panel-title')
    var panelBody = document.getElementById('db-update-panel-body')
    var errEl = document.getElementById('db-update-error')
    // v0.1.19 — the manual-fallback line under the error (the release page
    // the Go bridge opened in the browser on a failed apply).
    var fallEl = document.getElementById('db-update-fallback')
    var laterBtn = document.getElementById('db-update-later')
    var goBtn = document.getElementById('db-update-go')

    // The Go shell's last check verdict — set by hibana:update-available,
    // consumed by the modal intro. null = no update exists yet (the pill
    // stays hidden; the modal is unreachable — there is nothing to offer).
    var info = null
    var applying = false

    function localize() {
      btn.setAttribute('aria-label', t('btn'))
      btn.setAttribute('title', t('btn'))
      if (btnLabel) btnLabel.textContent = t('label')
      setText('db-update-title', t('title'))
      if (laterBtn) laterBtn.textContent = t('later')
      if (goBtn) goBtn.textContent = t('go')
      if (info) paintIntro()
    }

    function setText(id, text) { var el = document.getElementById(id); if (el) el.textContent = text }

    function paintIntro() {
      if (!info) return
      if (versionEl) versionEl.textContent = fmt('version', { cur: info.current, new: info.latest })
      if (kindEl) {
        var size = fmtSize(info.size)
        kindEl.textContent = info.kind === 'installer'
          ? fmt('kindInstaller', { size: size })
          : fmt('kindPortable', { size: size })
      }
      if (bodyEl) bodyEl.textContent = t('dataNote')
      if (progress) progress.hidden = true
      if (panel) panel.hidden = true
      if (errEl) errEl.hidden = true
      if (fallEl) fallEl.hidden = true // a fresh intro never carries a stale fallback note
      if (laterBtn) laterBtn.hidden = false
      if (goBtn) { goBtn.hidden = false; goBtn.disabled = false }
    }

    function showPill() { btn.hidden = false }

    function openModal() {
      localize() // the FA/RTL flip lands before the intro paints
      paintIntro()
      dlg.showModal()
    }

    // The live bar: stage download paints the fill + the honest percent;
    // verify pins 100% + the verifying note. The fill sizes via the PHYSICAL
    // width (the probe's own lesson: a Chromium fill driven through the
    // logical inline-size never renders — width does); the LOGICAL anchor
    // keeps the RTL mirror correct. An indeterminate server (no
    // Content-Length) sends pct 0 — the note stays honest at 0% while the
    // bytes count Go-side.
    function setStage(stage, pct) {
      if (!progress || !fill || !note) return
      progress.hidden = false
      progress.setAttribute('data-stage', stage)
      if (stage === 'verify') {
        fill.style.width = '100%'
        note.textContent = t('verify')
      } else {
        var p = Math.max(0, Math.min(100, pct))
        fill.style.width = p + '%'
        note.textContent = fmt('download', { pct: p })
      }
    }

    function showError(msg, pageOpened) {
      if (progress) progress.hidden = true
      if (errEl) { errEl.textContent = t('errTitle') + ' — ' + msg; errEl.hidden = false }
      // The fallback note paints ONLY on the resolve's own pageOpened flag —
      // a machine where the open could not happen never hears that it did.
      if (fallEl) {
        if (pageOpened) { fallEl.textContent = t('pageOpened'); fallEl.hidden = false }
        else fallEl.hidden = true
      }
      if (laterBtn) laterBtn.hidden = false
      if (goBtn) { goBtn.hidden = false; goBtn.disabled = false }
    }

    function onDone(out) {
      applying = false
      if (!out || typeof out !== 'object') out = {}
      if (out.ok) {
        // The helper is spawned Go-side; the app quits ~1.5s after this
        // resolve. The panel is the last thing on screen — and NO reload
        // here: the whole island restarts with the new exe, and the data
        // dir (session + mirror) rides through untouched.
        if (progress) progress.hidden = true
        if (errEl) errEl.hidden = true
        if (fallEl) fallEl.hidden = true
        if (laterBtn) laterBtn.hidden = true
        if (goBtn) goBtn.hidden = true
        if (panel) {
          panel.setAttribute('data-kind', 'ok')
          if (panelTitle) panelTitle.textContent = t('restartingTitle')
          if (panelBody) panelBody.textContent = fmt('restartingBody', { v: info ? info.latest : '' })
          panel.hidden = false
        }
        return
      }
      // The honest verdicts: busy / no-update / a real Go error message.
      // A FAILURE carries the Go resolve's own pageOpened flag (v0.1.19 —
      // the bridge opened the release page in the browser; the note says
      // so), while busy and no-update resolve Go-side without the flag and
      // never paint it.
      var msg = out.message || ''
      if (msg === 'busy') msg = t('busy')
      else if (msg.indexOf('no update') === 0) msg = t('noUpdate')
      else if (!msg) msg = t('notWired')
      showError(msg, !!(out && out.pageOpened))
    }

    function onReject() {
      applying = false
      showError(t('notWired'), false)
    }

    function run() {
      if (applying) return
      applying = true
      if (errEl) errEl.hidden = true
      if (fallEl) fallEl.hidden = true // every fresh round starts with a clean slate
      if (laterBtn) laterBtn.hidden = false
      if (goBtn) goBtn.disabled = true
      setStage('download', 0) // visible from the first frame of the round
      var apply = resolveBoundMethod('ApplyUpdate')
      if (!apply) { onReject(); return }
      try {
        Promise.resolve(apply()).then(onDone, onReject)
      } catch (e) { onReject() }
    }

    btn.addEventListener('click', openModal)
    if (goBtn) goBtn.addEventListener('click', run)
    if (laterBtn) laterBtn.addEventListener('click', function () { dlg.close() })

    // THE GO SHELL'S RELAYS (main.go SetUpdateEmit → EventsEmit):
    // hibana:update-available reveals the pill (and repaints an open modal's
    // intro with the fresh facts); hibana:update-progress paints the bar —
    // only while the modal is open (a stale tick after Later closes is a
    // no-op; the round finishes Go-side and the staged bytes clean
    // themselves on the next round).
    if (window.runtime && typeof window.runtime.EventsOn === 'function') {
      window.runtime.EventsOn('hibana:update-available', function (payload) {
        if (!payload || typeof payload !== 'object') return
        info = {
          current: String(payload.current || ''),
          latest: String(payload.latest || ''),
          kind: String(payload.kind || 'portable'),
          size: Number(payload.size) || 0,
          notes: String(payload.notes || ''),
          url: String(payload.url || '')
        }
        showPill()
        if (dlg.open) paintIntro()
      })
      window.runtime.EventsOn('hibana:update-progress', function (payload) {
        if (!payload || typeof payload !== 'object' || !dlg.open) return
        var stage = String(payload.stage || 'download')
        var pct = Math.max(0, Math.min(100, Number(payload.pct) || 0))
        setStage(stage, pct)
      })
    }

    // Live language flips (i18n.js owns html[lang]) — relabel the surfaces.
    localize()
    try {
      new MutationObserver(localize).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
    } catch (e) { /* no observer — the labels stay at the boot language */ }
  })
})()
`

// ---------------------------------------------------------------------------
// desktop-update.css — generated below into dist/css/. The modal rides the
// island's own dialog + .modal + .db-sync-panel grammars (components.css +
// desktop-sync.css); this sheet owns ONLY the round's own surfaces: the
// toolbar pill's solid-green CTA + the progress bar + the intro line.
// ---------------------------------------------------------------------------
const DESKTOP_UPDATE_CSS = `/* desktop-update.css — the auto-update round (v0.1.14 — the owner ask: "Add
   an auto update for the app. when the new version releases in the github,
   app syncs with the internet and github, and if new version, whether
   portable or installer released, show a button for update. it must update
   from github and replace without losing data or needing user to re login.").
   GENERATED FILE — do not hand-edit (guide §3.3.4): emitted by scripts/sync-island.mjs
   into frontend/dist/css/ and checksummed in frontend/island.checksums.json. */

/* The toolbar's Update pill — HIDDEN until a newer GitHub release exists
   (the hibana:update-available event removes the hidden attr), then a
   VISIBLE, LABELED, fill-colored pill right after Refresh: the solid --ok
   green (the island's own success grammar — distinct from Sync's teal CTA on
   purpose: an update is the row's "good news" action) at the SAME twin
   metrics as Sprints/Labels/Sync/Refresh (the S220 "same size" grammar).
   Light theme: #1f7a34 with white ink (the token's own AA pair). Dark
   theme: the olive --ok (#9BA77A) is too light for white ink, so the pill
   flips to dark ink over the same olive fill. */
#db-update-button {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.55rem 1rem;
  border: 1px solid transparent; /* the ghost twins carry a 1px hairline — a transparent border keeps every pill box the exact same height */
  font-size: var(--fs-md);
  font-weight: var(--text-label-weight, 500);
  white-space: nowrap;
  background: var(--ok);
  color: #fff;
}
#db-update-button[hidden] { display: none; }
#db-update-button .icon { flex: none; }
#db-update-button:hover,
#db-update-button:focus-visible {
  background: color-mix(in srgb, var(--ok) 86%, #000);
  color: #fff;
}
#db-update-button:active { background: color-mix(in srgb, var(--ok) 76%, #000); }
html[data-theme='claude-dark'] #db-update-button { color: #141413; }
html[data-theme='claude-dark'] #db-update-button:hover,
html[data-theme='claude-dark'] #db-update-button:focus-visible {
  background: color-mix(in srgb, var(--ok) 88%, #fff);
  color: #141413;
}

/* The modal's version line — the one fact the round is about, so it carries
   the body weight, not the muted smalls under it. */
#db-update-version {
  margin: 0.1rem 0 0.15rem;
  font-size: var(--fs-md);
  font-weight: var(--text-label-weight, 500);
  color: var(--fg);
}
.db-update-modal h2 { margin: 0; }

/* The live progress bar — a hairline track with the solid --ok fill, the
   note under it in the muted small. The fill anchors at the inline-start
   edge via the LOGICAL inset (RTL anchors it right automatically) but
   SIZES + TWEENS via the physical width — the probe's first lesson: a
   Chromium fill whose size rode the logical inline-size never left 0
   (the logical transition never renders), so the size is physical on
   purpose. Reduced-motion stills the tween (the bar still fills — the
   STATE stays, the tween goes). */
.db-update-progress {
  display: grid;
  gap: 0.45rem;
  margin: 0.55rem 0 0.35rem;
}
.db-update-bar {
  position: relative;
  block-size: 0.5rem;
  border-radius: 999px;
  background: color-mix(in srgb, var(--fg) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--fg) 12%, transparent);
  overflow: hidden;
}
.db-update-fill {
  position: absolute;
  inset-block: 0;
  inset-inline-start: 0;
  width: 0%;
  border-radius: inherit;
  background: var(--ok);
  transition: width 0.25s ease;
}
.db-update-note {
  font-size: 0.82rem;
  color: var(--muted);
}

@media (prefers-reduced-motion: reduce) {
  .db-update-fill { transition: none; }
}
`


// ---------------------------------------------------------------------------
// desktop-settings.js — generated below into dist/js/ (the v0.1.17 settings
// round — the owner ask: "Plan for a settings page for hibana's desktop"
// with four sections: 1. Sync 2. Update app 3. Login/logout 4. fa/en + dark
// mode/light mode; v0.1.18 grows section 2 with the GitHub-access row — the
// owner ask: "hibana desktop might be a private repo so in setting, add a
// github credentials so it can connect to the private repo"; v0.1.19 adds
// the row's TEST button — the owner ask: "Yes add a test connection"). A
// COMPOSITION controller: three of the four sections delegate to the PROVEN
// toolbar flows (Sync now / Update now / Sign out are programmatic clicks on
// the existing buttons — this sheet closes itself first so the modals never
// stack), the update row adds the manual CheckForUpdates trigger over the
// untouched boot+2h loop AND the credentials row (SetGithubToken /
// GithubTokenState — the token crosses the bridge once, the hint crosses
// back, a save immediately re-checks) AND the test-connection round
// (TestGithubConnection — verify the typed candidate / the stored token /
// the anonymous round WITHOUT writing anything), the theme segmented control
// rides SetTheme (the tray's full 3-state vocabulary), and the language
// segmented control rides the SetLanguage binding — whose 2xx resolve flips
// the chrome LIVE (html[lang]/dir + hibanaI18n.apply(), which re-reads the
// Go-side un-staled __hibanaMe) and schedules the ~700ms reload reflex
// (i18n.js's dynamic-markup law: a live-only flip would leave the BOARD's
// rendered titles in the old language). The PIN_PACKAGE_VERSION constant is
// the ONE interpolation in this template — the sync script knows the sealed
// pin's package version at emit time, so the version line never needs a
// fetch or a binding change.
// Written without template literals/backticks so it nests in this literal.
// ---------------------------------------------------------------------------
const DESKTOP_SETTINGS_JS = `// desktop-settings.js — the settings page controller (v0.1.17 + the
// v0.1.18 GitHub-access row + the v0.1.19 test-connection round — the owner
// asks: "Plan for a settings page for hibana's desktop" with four sections:
// 1. Sync 2. Update app ("check the latest release of github, if there were
// newer version. update.") 3. Login/logout 4. fa/en + dark mode/light mode).
// The settings page is a COMPOSITION: one wide native dialog opened from the
// toolbar's gear, whose sections delegate to the live, proven rounds. This
// controller owns: the gear → showModal wiring, the live facts (AppInfo's
// version line, AuthState's account line, GithubTokenState's hint line), the
// manual Check-for-updates verdict paint, the GitHub-access row (v0.1.18 —
// Save/Remove over SetGithubToken, Enter-to-save, the connect-now re-check;
// v0.1.19 — the Test button over TestGithubConnection: verify the typed
// candidate / the stored token / the anonymous round, nothing written),
// the two segmented controls (Language through the Go SetLanguage binding;
// Theme through the existing SetTheme with the tray's full 3-state
// vocabulary), the delegation clicks (Sync now / Update now / Sign out → the
// toolbar buttons' own flows, this sheet closing FIRST so the modals never
// stack), and the hibana:lang / hibana:theme / hibana:update-available event
// listeners so the tray, the toolbar, and this sheet always agree.
// GENERATED FILE — do not hand-edit (guide §3.3.4): emitted by scripts/sync-island.mjs
// into frontend/dist/js/ and checksummed in frontend/island.checksums.json.
// Loads blocking, right after desktop-update.js, BEFORE every deferred island
// script.
(function () {
  'use strict'

  // The sealed pin's package version (the sync script interpolates it at emit
  // time — the AppInfo binding carries version + webRef, and the island's own
  // package version rides the web-ref.json the script already knows).
  var PIN_PACKAGE_VERSION = '${PIN_PACKAGE_VERSION}'

  // The desktop-owned strings. The title rides the pin's own nav.settings key
  // and Sign out rides nav.signout (both in the markup via data-i18n); every
  // other label is this round's own EN/FA pair (the desktop-update.js STR
  // pattern — the pin's dictionaries carry no desktop-settings keys beyond
  // nav.settings, verified @ the pin).
  var STR = {
    en: {
      btn: 'Settings',
      syncHeading: 'Sync',
      syncBody: "Boards sync on launch and every 5 minutes. A manual round uploads local changes first, then pulls the cloud's truth.",
      syncNow: 'Sync now',
      updateHeading: 'Update app',
      versionLine: 'Hibana {version} · island {ref} (v{pin})',
      statusLatest: "You're on the latest version.",
      statusAvailable: 'Hibana {cur} → {new} is available ({size}).',
      checkBtn: 'Check for updates',
      checkBusy: 'Checking…',
      updateNow: 'Update now',
      statusBusy: 'An update is already in progress.',
      statusUnreachable: "Couldn't reach GitHub — check your connection.",
      notWired: 'The desktop bridge is not wired — restart the app.',
      // v0.1.18 — the GitHub-access row (the owner ask: "hibana desktop
      // might be a private repo so in setting, add a github credentials
      // so it can connect to the private repo").
      tokenLabel: 'GitHub access',
      tokenPlaceholder: 'ghp_… (optional)',
      tokenSave: 'Save',
      tokenRemove: 'Remove',
      tokenSaving: 'Verifying…',
      tokenNone: 'No token — anonymous GitHub access (fine for public repos).',
      tokenSaved: 'Token saved ({hint}) — release checks use it.',
      tokenSavedUnverified: 'Saved ({hint}) — GitHub was unreachable to verify; the next check uses it.',
      tokenRejected: 'GitHub rejected the token — nothing was saved.',
      tokenNoAccess: 'The token cannot see this repository — nothing was saved.',
      tokenCleared: 'Token removed — release checks are anonymous again.',
      tokenInvalid: 'That does not look like a GitHub token (ghp_…).',
      tokenSaveFailed: "Couldn't save the token — try again.",
      // v0.1.19 — the TEST-CONNECTION row (the owner ask: "Yes add a test
      // connection"): one cheap GET /repos/<repo> through the Go
      // TestGithubConnection binding — the typed candidate, the stored
      // token, or the honest anonymous round — with NOTHING written. The
      // using field on the resolve picks the line.
      tokenTest: 'Test',
      tokenTesting: 'Testing…',
      testOkTyped: 'GitHub accepted the token — the repository is visible.',
      testOkSaved: 'The saved token works — GitHub sees the repository.',
      testOkAnon: 'GitHub is reachable and the repository is public — no token needed.',
      testInvalidTyped: 'GitHub rejected this token.',
      testInvalidSaved: 'GitHub rejected the saved token — remove it or paste a new one.',
      testNoAccessToken: 'The token cannot see this repository — check its repository access.',
      testNoAccessAnon: "GitHub can't see the repository without credentials — if it's private, save a token with access.",
      testUnreachable: "Couldn't reach GitHub — check your connection and try again.",
      accountHeading: 'Account',
      accountBody: 'Your boards live safe on the Hibana cloud — sign in again any time.',
      appearanceHeading: 'Appearance',
      langLabel: 'Language',
      langEn: 'English',
      langFa: 'فارسی',
      themeLabel: 'Theme',
      themeLight: 'Light',
      themeDark: 'Dark',
      themeSystem: 'System',
      langUnreachable: "Couldn't reach hibana.ir — the language is unchanged.",
      langSession: 'Your session expired — sign in again.',
      done: 'Done'
    },
    fa: {
      btn: 'تنظیمات',
      syncHeading: 'همگام‌سازی',
      syncBody: 'تخته‌ها هنگام اجرا و هر ۵ دقیقه همگام می‌شوند. یک دور دستی ابتدا تغییرات محلی را بارگذاری می‌کند و سپس حقیقت ابر را می‌گیرد.',
      syncNow: 'همگام‌سازی کن',
      updateHeading: 'بروزرسانی برنامه',
      versionLine: 'هیبانا {version} · جزیره {ref} (v{pin})',
      statusLatest: 'شما روی آخرین نسخه هستید.',
      statusAvailable: 'هیبانا {cur} → {new} در دسترس است ({size}).',
      checkBtn: 'بررسی بروزرسانی',
      checkBusy: 'در حال بررسی…',
      updateNow: 'بروزرسانی کن',
      statusBusy: 'یک بروزرسانی دیگر در جریان است.',
      statusUnreachable: 'اتصال به گیت‌هاب برقرار نشد — اینترنت خود را بررسی کنید.',
      notWired: 'پل دسکتاپ وصل نیست — برنامه را دوباره باز کنید.',
      // v0.1.18 — the GitHub-access row's FA twins.
      tokenLabel: 'دسترسی گیت‌هاب',
      tokenPlaceholder: 'ghp_… (اختیاری)',
      tokenSave: 'ذخیره',
      tokenRemove: 'حذف',
      tokenSaving: 'در حال بررسی…',
      tokenNone: 'توکنی ذخیره نشده — دسترسی ناشناس به گیت‌هاب (برای مخازن عمومی کافی است).',
      tokenSaved: 'توکن ذخیره شد ({hint}) — بررسی بروزرسانی از آن استفاده می‌کند.',
      tokenSavedUnverified: 'ذخیره شد ({hint}) — گیت‌هاب برای تأیید در دسترس نبود؛ بررسی بعدی از آن استفاده می‌کند.',
      tokenRejected: 'گیت‌هاب این توکن را نپذیرفت — چیزی ذخیره نشد.',
      tokenNoAccess: 'این توکن به این مخزن دسترسی ندارد — چیزی ذخیره نشد.',
      tokenCleared: 'توکن حذف شد — بررسی بروزرسانی دوباره ناشناس است.',
      tokenInvalid: 'این شبیه توکن گیت‌هاب نیست (ghp_…).',
      tokenSaveFailed: 'ذخیره توکن ممکن نشد — دوباره تلاش کنید.',
      // v0.1.19 — the TEST-CONNECTION row's FA twins.
      tokenTest: 'تست',
      tokenTesting: 'در حال تست…',
      testOkTyped: 'گیت‌هاب این توکن را پذیرفت — مخزن قابل مشاهده است.',
      testOkSaved: 'توکن ذخیره‌شده کار می‌کند — گیت‌هاب مخزن را می‌بیند.',
      testOkAnon: 'گیت‌هاب در دسترس است و مخزن عمومی است — نیازی به توکن نیست.',
      testInvalidTyped: 'گیت‌هاب این توکن را نپذیرفت.',
      testInvalidSaved: 'گیت‌هاب توکن ذخیره‌شده را نپذیرفت — حذفش کنید یا توکن جدیدی جای آن بگذارید.',
      testNoAccessToken: 'این توکن به این مخزن دسترسی ندارد — دسترسی مخزن آن را بررسی کنید.',
      testNoAccessAnon: 'گیت‌هاب بدون اعتبارنامه مخزن را نمی‌بیند — اگر خصوصی است، توکنی با دسترسی ذخیره کنید.',
      testUnreachable: 'اتصال به گیت‌هاب برقرار نشد — اینترنت خود را بررسی کنید و دوباره تلاش کنید.',
      accountHeading: 'حساب',
      accountBody: 'تخته‌های شما در ابر هیبانا امن هستند — هر وقت خواستید دوباره وارد شوید.',
      appearanceHeading: 'ظاهر',
      langLabel: 'زبان',
      langEn: 'English',
      langFa: 'فارسی',
      themeLabel: 'پوسته',
      themeLight: 'روشن',
      themeDark: 'تیره',
      themeSystem: 'سیستم',
      langUnreachable: 'اتصال به hibana.ir برقرار نشد — زبان تغییر نکرد.',
      langSession: 'نشست شما منقضی شده — دوباره وارد شوید.',
      done: 'انجام شد'
    }
  }

  function lang() { return document.documentElement.lang === 'fa' ? 'fa' : 'en' }
  function t(key) { return (STR[lang()] && STR[lang()][key]) || STR.en[key] || key }
  function fmt(key, map) {
    var s = t(key)
    for (var k in map) s = s.split('{' + k + '}').join(String(map[k]))
    return s
  }

  // The bridge resolver — the same defensive chain desktop-update.js /
  // desktop-sync.js / desktop-theme.js use (all generated + drift-controlled;
  // the duplication is by design).
  function pick(root, keys) {
    let cur = root
    for (let i = 0; i < keys.length; i++) {
      if (cur == null || typeof cur !== 'object') return null
      cur = cur[keys[i]]
    }
    return typeof cur === 'function' ? cur : null
  }
  function resolveBoundMethod(name) {
    let fn = pick(window, ['go', 'desktop', 'API', name])
    if (fn) return fn
    fn = pick(window, ['gohibana', 'api', name])
    if (fn) return fn
    fn = pick(window, ['gohibana', 'API', name])
    if (fn) return fn
    const go = window.go
    if (go && typeof go === 'object') {
      for (const pkg of Object.keys(go)) {
        fn = pick(go[pkg], ['API', name]) || pick(go[pkg], ['api', name])
        if (fn) return fn
      }
    }
    return null
  }

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn)
    else fn()
  }

  // fmtSize — the update modal's own honest MB round (under 10: one decimal).
  function fmtSize(bytes) {
    var n = Number(bytes)
    if (!(n > 0)) return ''
    var mb = n / (1024 * 1024)
    return (mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10) + ' MB'
  }

  ready(function () {
    var gear = document.getElementById('db-settings-button')
    var dlg = document.getElementById('db-settings-dialog')
    if (!gear || !dlg || typeof dlg.showModal !== 'function') return

    var els = {
      version: document.getElementById('db-settings-version'),
      updateStatus: document.getElementById('db-settings-update-status'),
      updateError: document.getElementById('db-settings-update-error'),
      updateNow: document.getElementById('db-settings-update-now'),
      check: document.getElementById('db-settings-check'),
      tokenInput: document.getElementById('db-settings-token-input'),
      tokenTest: document.getElementById('db-settings-token-test'),
      tokenSave: document.getElementById('db-settings-token-save'),
      tokenRemove: document.getElementById('db-settings-token-clear'),
      tokenStatus: document.getElementById('db-settings-token-status'),
      tokenError: document.getElementById('db-settings-token-error'),
      account: document.getElementById('db-settings-account'),
      langError: document.getElementById('db-settings-lang-error'),
      langEn: document.getElementById('db-settings-lang-en'),
      langFa: document.getElementById('db-settings-lang-fa'),
      themeLight: document.getElementById('db-settings-theme-light'),
      themeDark: document.getElementById('db-settings-theme-claude-dark'),
      themeSystem: document.getElementById('db-settings-theme-system')
    }

    // The Go shell's last check verdict (display state — the Update-now
    // delegation re-earns everything in the proven modal). null = no check
    // has landed this boot: the status line claims NOTHING (an unchecked app
    // is not "latest" — the auto-update honesty rule).
    var updateVerdict = null
    var checking = false
    var langFlipping = false

    // v0.1.18 — the GitHub-access row's own state: null = the GithubTokenState
    // round has not landed (the same claim-nothing honesty); {set, hint}
    // after it does. The token VALUE never lives here — it crosses the
    // bridge inside the Save click and dies with it.
    var tokenState = null
    var tokenBusy = false

    function setText(id, text) { var el = document.getElementById(id); if (el) el.textContent = text }

    // ---- localization (every label this controller owns; the title, the
    //      gear's aria/title, and Sign out ride the pin's own keys) ----
    function localize() {
      gear.setAttribute('aria-label', t('btn'))
      gear.setAttribute('title', t('btn'))
      setText('db-settings-sync-heading', t('syncHeading'))
      setText('db-settings-sync-body', t('syncBody'))
      setText('db-settings-sync-now-label', t('syncNow'))
      setText('db-settings-update-heading', t('updateHeading'))
      setText('db-settings-check-label', t('checkBtn'))
      setText('db-settings-update-now-label', t('updateNow'))
      setText('db-settings-token-label', t('tokenLabel'))
      setText('db-settings-token-save-label', t('tokenSave'))
      setText('db-settings-token-test-label', t('tokenTest'))
      setText('db-settings-token-clear-label', t('tokenRemove'))
      if (els.tokenInput) {
        els.tokenInput.setAttribute('placeholder', t('tokenPlaceholder'))
        els.tokenInput.setAttribute('aria-label', t('tokenLabel'))
      }
      setText('db-settings-account-heading', t('accountHeading'))
      setText('db-settings-account-body', t('accountBody'))
      setText('db-settings-appearance-heading', t('appearanceHeading'))
      setText('db-settings-lang-label', t('langLabel'))
      setText('db-settings-theme-label', t('themeLabel'))
      if (els.langEn) els.langEn.textContent = t('langEn')
      if (els.langFa) els.langFa.textContent = t('langFa')
      if (els.themeLight) els.themeLight.textContent = t('themeLight')
      if (els.themeDark) els.themeDark.textContent = t('themeDark')
      if (els.themeSystem) els.themeSystem.textContent = t('themeSystem')
      setText('db-settings-done-label', t('done'))
      if (versionInfo) paintVersion()
      if (accountInfo) paintAccount()
    }

    // ---- the live facts (resolved at OPEN time — the v0.1.1 parse-time
    //      snapshot lesson) ----
    var versionInfo = null
    var accountInfo = null

    function paintVersion() {
      if (!versionInfo || !els.version) return
      els.version.textContent = fmt('versionLine', {
        version: String(versionInfo.version || ''),
        ref: String(versionInfo.webRef || ''),
        pin: PIN_PACKAGE_VERSION
      })
    }

    function paintAccount() {
      if (!els.account || !accountInfo) return
      var name = String(accountInfo.username || '')
      var email = String(accountInfo.email || '')
      els.account.textContent = name && name !== email ? name + ' · ' + email : email
    }

    function resolveLive() {
      var appInfo = resolveBoundMethod('AppInfo')
      if (appInfo) {
        try {
          Promise.resolve(appInfo()).then(function (info) {
            versionInfo = info && typeof info === 'object' ? info : null
            paintVersion()
          }, function () {})
        } catch (e) {}
      }
      var authState = resolveBoundMethod('AuthState')
      if (authState) {
        try {
          Promise.resolve(authState()).then(function (st) {
            accountInfo = st && st.authenticated && st.user ? st.user : null
            paintAccount()
          }, function () {})
        } catch (e) {}
      }
      // v0.1.18 — the GitHub-access row's display state ({set, hint}); the
      // verdict's own copy rides the Save resolve.
      resolveTokenState()
    }

    // ---- SECTION 2's status line + the Update-now reveal ----
    function paintUpdateStatus() {
      if (els.updateStatus) {
        if (updateVerdict && updateVerdict.available) {
          els.updateStatus.textContent = fmt('statusAvailable', {
            cur: String(updateVerdict.current || ''),
            new: String(updateVerdict.latest || ''),
            size: fmtSize(updateVerdict.size)
          })
        } else if (updateVerdict) {
          els.updateStatus.textContent = t('statusLatest')
        } else {
          els.updateStatus.textContent = ''
        }
      }
      if (els.updateNow) els.updateNow.hidden = !(updateVerdict && updateVerdict.available)
    }

    function showUpdateError(msg) {
      if (els.updateError) { els.updateError.textContent = msg; els.updateError.hidden = false }
    }
    function hideUpdateError() { if (els.updateError) els.updateError.hidden = true }
    function showLangError(msg) {
      if (els.langError) { els.langError.textContent = msg; els.langError.hidden = false }
    }
    function hideLangError() { if (els.langError) els.langError.hidden = true }

    // ---- THE DELEGATION (the plan §1.3): this sheet closes FIRST, then the
    //      proven toolbar button's own click handler opens its modal — the
    //      modals never stack, zero new flows. ----
    function delegate(id) {
      if (dlg.open) dlg.close()
      var el = document.getElementById(id)
      if (el) el.click()
    }

    var syncNowBtn = document.getElementById('db-settings-sync-now')
    if (syncNowBtn) syncNowBtn.addEventListener('click', function () { delegate('db-sync-button') })
    if (els.updateNow) els.updateNow.addEventListener('click', function () { delegate('db-update-button') })
    var signoutBtn = document.getElementById('db-settings-signout')
    if (signoutBtn) signoutBtn.addEventListener('click', function () { delegate('db-logout-button') })
    var doneBtn = document.getElementById('db-settings-done')
    if (doneBtn) doneBtn.addEventListener('click', function () { dlg.close() })

    // ---- SECTION 2's manual check (the auto-update loop keeps its boot+2h
    //      cadence untouched; this row is the manual trigger + the idle-time
    //      surface the owner asked for). The honest verdicts: available /
    //      latest / busy / unreachable — never a claim that was not earned. ----
    function onCheckDone(res) {
      checking = false
      if (els.check) els.check.disabled = false
      if (!res || typeof res !== 'object') res = {}
      updateVerdict = res
      hideUpdateError()
      paintUpdateStatus()
    }

    function onCheckFail(err) {
      checking = false
      if (els.check) els.check.disabled = false
      updateVerdict = null
      if (els.updateStatus) els.updateStatus.textContent = ''
      var msg = (err && (err.message || String(err))) || ''
      // The busy guard rejects with "already running" — the honest busy line,
      // never the can't-reach line (a check DID happen; it was refused).
      if (/already running|already in progress/i.test(msg)) showUpdateError(t('statusBusy'))
      else showUpdateError(t('statusUnreachable'))
    }

    if (els.check) els.check.addEventListener('click', function () {
      if (checking) return
      var check = resolveBoundMethod('CheckForUpdates')
      hideUpdateError()
      if (!check) { showUpdateError(t('notWired')); return }
      checking = true
      els.check.disabled = true
      if (els.updateStatus) els.updateStatus.textContent = t('checkBusy')
      try {
        Promise.resolve(check()).then(onCheckDone, onCheckFail)
      } catch (e) { onCheckFail(e) }
    })

    // ---- SECTION 2's GitHub-access row (v0.1.18 — the owner ask: "hibana
    //      desktop might be a private repo so in setting, add a github
    //      credentials so it can connect to the private repo"). The row is
    //      a PASSWORD input + Save/Remove over the Go SetGithubToken /
    //      GithubTokenState bindings: the token crosses the bridge ONCE
    //      (the login password's discipline — never stored JS-side, never
    //      in localStorage, the field cleared on every resolve); only the
    //      ghp_…ABCD hint ever crosses back. A SAVED token immediately
    //      re-checks (the row's whole point — connect now), riding the
    //      manual-check flow above through its own click handler. ----
    function showTokenError(msg) {
      if (els.tokenError) { els.tokenError.textContent = msg; els.tokenError.hidden = false }
    }
    function hideTokenError() { if (els.tokenError) els.tokenError.hidden = true }

    function paintToken() {
      if (els.tokenStatus) {
        if (tokenState == null) els.tokenStatus.textContent = ''
        else if (tokenState.set) els.tokenStatus.textContent = fmt('tokenSaved', { hint: String(tokenState.hint || '') })
        else els.tokenStatus.textContent = t('tokenNone')
      }
      if (els.tokenRemove) els.tokenRemove.hidden = !(tokenState && tokenState.set)
    }

    function resolveTokenState(after) {
      var state = resolveBoundMethod('GithubTokenState')
      if (!state) { if (after) after(); return }
      try {
        Promise.resolve(state()).then(function (s) {
          tokenState = s && typeof s === 'object' && s.set
            ? { set: true, hint: String(s.hint || '') }
            : { set: false, hint: '' }
          paintToken()
          if (after) after()
        }, function () { if (after) after() })
      } catch (e) { if (after) after() }
    }

    function setTokenBusy(on) {
      tokenBusy = on
      if (els.tokenTest) els.tokenTest.disabled = on
      if (els.tokenSave) els.tokenSave.disabled = on
      if (els.tokenRemove) els.tokenRemove.disabled = on
    }

    function onTokenSaveDone(res) {
      setTokenBusy(false)
      hideTokenError()
      if (!res || typeof res !== 'object') res = {}
      if (res.cleared) {
        if (els.tokenInput) els.tokenInput.value = ''
        tokenState = { set: false, hint: '' }
        paintToken()
        if (els.tokenStatus) els.tokenStatus.textContent = t('tokenCleared')
        return
      }
      if (res.ok && res.saved) {
        // The field never keeps the secret — the value lives Go-side only.
        if (els.tokenInput) els.tokenInput.value = ''
        var unverified = !res.verified
        resolveTokenState(function () {
          if (unverified && tokenState && tokenState.set && els.tokenStatus) {
            els.tokenStatus.textContent = fmt('tokenSavedUnverified', { hint: String(tokenState.hint || '') })
          } else {
            paintToken()
          }
        })
        // THE CONNECT-NOW REFLEX — the row's whole point: a saved token is
        // used by the very next check, so fire one immediately through the
        // manual-check flow's own handler (busy/disable/verdict paint all
        // reused; a check already in flight is simply left alone).
        if (els.check && !checking) { try { els.check.click() } catch (e) {} }
        return
      }
      var code = String(res.code || '')
      // The verdict's failure paths RESTORE the status line to the stored
      // state's truth (the probe caught the stuck "Verifying…" — a refused
      // save must never leave the busy line on screen).
      paintToken()
      if (code === 'invalid') showTokenError(t('tokenRejected'))
      else if (code === 'no_access') showTokenError(t('tokenNoAccess'))
      else if (code === 'not_wired') showTokenError(t('notWired'))
      else showTokenError(t('tokenSaveFailed'))
    }

    // The ONLY rejected promise this binding returns is the malformed-shape
    // refusal (errBadGithubToken) — the catch paints the shape line. The
    // status line restores the stored truth (nothing was saved).
    function onTokenSaveFail() {
      setTokenBusy(false)
      hideTokenError()
      paintToken()
      showTokenError(t('tokenInvalid'))
    }

    if (els.tokenSave) els.tokenSave.addEventListener('click', function () {
      if (tokenBusy) return
      var value = els.tokenInput ? String(els.tokenInput.value || '') : ''
      hideTokenError()
      if (!value) return // nothing to save — Remove is the clear path
      var save = resolveBoundMethod('SetGithubToken')
      if (!save) { showTokenError(t('notWired')); return }
      setTokenBusy(true)
      if (els.tokenStatus) els.tokenStatus.textContent = t('tokenSaving')
      try {
        Promise.resolve(save(value)).then(onTokenSaveDone, onTokenSaveFail)
      } catch (e) { onTokenSaveFail() }
    })

    if (els.tokenRemove) els.tokenRemove.addEventListener('click', function () {
      if (tokenBusy) return
      var save = resolveBoundMethod('SetGithubToken')
      if (!save) { showTokenError(t('notWired')); return }
      hideTokenError()
      if (els.tokenInput) els.tokenInput.value = ''
      setTokenBusy(true)
      if (els.tokenStatus) els.tokenStatus.textContent = t('tokenSaving')
      try {
        Promise.resolve(save('')).then(onTokenSaveDone, onTokenSaveFail) // "" = the Go clear contract
      } catch (e) { onTokenSaveFail() }
    })

    // ---- THE TEST-CONNECTION ROUND (v0.1.19 — the owner ask: "Yes add a
    //      test connection"). One cheap GET /repos/<repo> through the Go
    //      TestGithubConnection binding: the FIELD's value when one is
    //      typed (verify-before-save — nothing is written), else the
    //      STORED token, else the honest anonymous round — the exact
    //      credential mix the next release check would ride. The field is
    //      NEVER cleared by a test (only Save clears it — the value stays
    //      for the Save click the verdict invites); no connect-now re-check
    //      either (a test changes no state). The resolve's using field
    //      picks the line: typed / saved / anonymous. ----
    function onTestDone(res) {
      setTokenBusy(false)
      hideTokenError()
      if (!res || typeof res !== 'object') res = {}
      var using = String(res.using || (tokenState && tokenState.set ? 'saved' : 'anonymous'))
      if (res.ok) {
        if (els.tokenStatus) {
          els.tokenStatus.textContent = using === 'typed' ? t('testOkTyped')
            : using === 'saved' ? t('testOkSaved')
            : t('testOkAnon')
        }
        return
      }
      // The failure verdicts: the stored truth restores on the status line
      // (a test never changed it) and the error line carries the verdict.
      paintToken()
      var code = String(res.code || '')
      if (code === 'invalid') showTokenError(using === 'saved' ? t('testInvalidSaved') : t('testInvalidTyped'))
      else if (code === 'no_access') showTokenError(using === 'anonymous' ? t('testNoAccessAnon') : t('testNoAccessToken'))
      else if (code === 'not_wired') showTokenError(t('notWired'))
      else showTokenError(t('testUnreachable'))
    }

    // The only rejected promise is the malformed-shape refusal — the catch
    // paints the shape line (the SetGithubToken discipline).
    function onTestFail() {
      setTokenBusy(false)
      hideTokenError()
      paintToken()
      showTokenError(t('tokenInvalid'))
    }

    if (els.tokenTest) els.tokenTest.addEventListener('click', function () {
      if (tokenBusy) return
      var test = resolveBoundMethod('TestGithubConnection')
      if (!test) { showTokenError(t('notWired')); return }
      hideTokenError()
      var value = els.tokenInput ? String(els.tokenInput.value || '') : ''
      setTokenBusy(true)
      if (els.tokenStatus) els.tokenStatus.textContent = t('tokenTesting')
      try {
        Promise.resolve(test(value)).then(onTestDone, onTestFail)
      } catch (e) { onTestFail() }
    })

    // Enter in the field SAVES — a method="dialog" form would otherwise
    // swallow the keypress as a submit (closing the sheet mid-save).
    if (els.tokenInput) els.tokenInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault()
        if (els.tokenSave && !tokenBusy) els.tokenSave.click()
      }
    })

    // ---- SECTION 4's segmented controls ----
    function currentLang() {
      var l = document.documentElement.getAttribute('data-desktop-lang')
      if (l !== 'en' && l !== 'fa') l = document.documentElement.lang === 'fa' ? 'fa' : 'en'
      return l
    }

    function currentTheme() {
      var p = document.documentElement.getAttribute('data-desktop-theme')
      return p === 'light' || p === 'claude-dark' || p === 'system' ? p : 'system'
    }

    // The tray-radio grammar: the active state IS aria-pressed (css/
    // desktop-settings.css branches on it).
    function setSeg(btn, active) {
      if (!btn) return
      btn.setAttribute('aria-pressed', active ? 'true' : 'false')
    }

    function paintLangSeg() {
      var cur = currentLang()
      setSeg(els.langEn, cur === 'en')
      setSeg(els.langFa, cur === 'fa')
    }

    function paintThemeSeg() {
      var cur = currentTheme()
      setSeg(els.themeLight, cur === 'light')
      setSeg(els.themeDark, cur === 'claude-dark')
      setSeg(els.themeSystem, cur === 'system')
    }

    // THE LANGUAGE FLIP (the plan §2.3 — the round's one new capability):
    // on {ok:true} the chrome flips LIVE for immediate feedback (html[lang]/
    // [dir], then hibanaI18n.apply() re-reads the Go-side un-staled
    // __hibanaMe, lazy-loads the FA dict, injects Vazir, and sweeps
    // [data-i18n]), the sheet closes, and the ~700ms reload re-renders the
    // BOARD in the new language (i18n.js's dynamic-markup law — a live-only
    // flip would leave the rendered board behind). On failure the control
    // STAYS PUT (the server never moved) and the line says why.
    function onLangDone(res, next) {
      langFlipping = false
      if (res && res.ok) {
        document.documentElement.setAttribute('data-desktop-lang', next)
        document.documentElement.setAttribute('lang', next)
        document.documentElement.setAttribute('dir', next === 'fa' ? 'rtl' : 'ltr')
        if (window.hibanaI18n && typeof window.hibanaI18n.apply === 'function') {
          try { window.hibanaI18n.apply() } catch (e) {}
        }
        paintLangSeg()
        if (dlg.open) dlg.close() // the reload lands on the board, not a modal
        setTimeout(function () { location.reload() }, 700)
        return
      }
      var msg = res && res.message ? String(res.message) : ''
      if (msg.indexOf('session expired') !== -1) showLangError(t('langSession'))
      else showLangError(t('langUnreachable'))
      paintLangSeg()
    }

    function onLangPick(ev) {
      var btn = ev.currentTarget
      var next = btn.getAttribute('data-seg-lang')
      if (!next || (next !== 'en' && next !== 'fa') || next === currentLang() || langFlipping) return
      hideLangError()
      var setLanguage = resolveBoundMethod('SetLanguage')
      if (!setLanguage) { showLangError(t('notWired')); return }
      langFlipping = true
      try {
        Promise.resolve(setLanguage(next)).then(function (res) { onLangDone(res, next) }, function () { onLangDone(null, next) })
      } catch (e) { onLangDone(null, next) }
    }

    if (els.langEn) els.langEn.addEventListener('click', onLangPick)
    if (els.langFa) els.langFa.addEventListener('click', onLangPick)

    // The theme flip — desktop-theme.js's own optimistic discipline: the live
    // document flips FIRST (the Go persist can never make the toggle feel
    // broken), the segmented state follows, and the SetTheme resolve is
    // belt-only. 'system' resolves the OS scheme exactly the way the boot
    // bootstrap does.
    function resolveTheme(p) {
      if (p === 'light' || p === 'claude-dark') return p
      try { return matchMedia('(prefers-color-scheme: dark)').matches ? 'claude-dark' : 'light' } catch (e) { return 'light' }
    }

    function onThemePick(ev) {
      var btn = ev.currentTarget
      var next = btn.getAttribute('data-seg-theme')
      if (!next || (next !== 'light' && next !== 'claude-dark' && next !== 'system') || next === currentTheme()) return
      document.documentElement.setAttribute('data-desktop-theme', next)
      document.documentElement.dataset.theme = resolveTheme(next)
      paintThemeSeg()
      var setTheme = resolveBoundMethod('SetTheme')
      if (setTheme) {
        try { setTheme(next).catch(function () {}) } catch (e) {}
      }
    }

    if (els.themeLight) els.themeLight.addEventListener('click', onThemePick)
    if (els.themeDark) els.themeDark.addEventListener('click', onThemePick)
    if (els.themeSystem) els.themeSystem.addEventListener('click', onThemePick)

    // ---- THE GO SHELL'S RELAYS (main.go's emit wiring): the tray and this
    //      sheet must agree on both segmented controls, and the update loop's
    //      verdict reaches the status line the same way the pill does. ----
    if (window.runtime && typeof window.runtime.EventsOn === 'function') {
      window.runtime.EventsOn('hibana:theme', function (payload) {
        var p = payload
        if (p && typeof p === 'object') p = p.pref || ''
        if (p !== 'light' && p !== 'claude-dark' && p !== 'system') p = 'system'
        document.documentElement.setAttribute('data-desktop-theme', p)
        paintThemeSeg()
      })
      window.runtime.EventsOn('hibana:lang', function (payload) {
        var l = payload
        if (l && typeof l === 'object') l = l.lang || ''
        if (l !== 'en' && l !== 'fa') return
        document.documentElement.setAttribute('data-desktop-lang', l)
        paintLangSeg()
      })
      window.runtime.EventsOn('hibana:update-available', function (payload) {
        if (!payload || typeof payload !== 'object') return
        updateVerdict = payload
        paintUpdateStatus()
      })
    }

    // ---- the gear ----
    function openSheet() {
      localize()
      paintUpdateStatus()
      paintLangSeg()
      paintThemeSeg()
      resolveLive()
      dlg.showModal()
    }
    gear.addEventListener('click', openSheet)

    // Live language flips (i18n.js owns html[lang]) — relabel the surfaces.
    localize()
    paintLangSeg()
    paintThemeSeg()
    try {
      new MutationObserver(localize).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
    } catch (e) { /* no observer — the labels stay at the boot language */ }
  })
})()
`

// ---------------------------------------------------------------------------
// desktop-settings.css — generated below into dist/css/ (the v0.1.17
// settings round). The dialog + .modal card are the island's own
// (components.css — the wide variant's grammar); this sheet starts INSIDE
// the card: the four sections, the label/control rows, the segmented
// control, and the toolbar gear. RTL rides logical properties throughout.
// ---------------------------------------------------------------------------
const DESKTOP_SETTINGS_CSS = `/* desktop-settings.css — the settings page (v0.1.17 — the owner ask: "Plan
   for a settings page for hibana's desktop" with four sections: 1. Sync
   2. Update app 3. Login/logout 4. fa/en + dark mode/light mode).
   GENERATED FILE — do not hand-edit (guide §3.3.4): emitted by scripts/sync-island.mjs
   into frontend/dist/css/ and checksummed in frontend/island.checksums.json.
   The dialog + .modal card are the island's own (components.css — including
   the dialog-wide variant's roomier padding); this sheet starts INSIDE the
   card. */

/* The toolbar's gear — the theme toggle's OWN icon-only grammar (base.css's
   [data-theme-toggle] rule: the 1.75rem square, the centered glyph, and the
   ≥40px hit ring via the inset pseudo), replicated here because the pin's
   sheet is untouchable — the gear and the toggle read as one family of
   chrome controls. Ghost on purpose: Settings is chrome, not a CTA — Sync
   stays the row's ONE colored action. */
#db-settings-button {
  position: relative;
  display: inline-grid;
  place-items: center;
  inline-size: 1.75rem;
  block-size: 1.75rem;
  padding: 0;
  line-height: 1;
}
#db-settings-button::after {
  content: "";
  position: absolute;
  inset: -0.55rem;
}
#db-settings-button .icon { flex: none; }

/* The sheet — a touch narrower than the capture dialogs' 46rem: the four
   sections read best at a page-like measure, still comfortably wide. */
#db-settings-dialog {
  inline-size: min(36rem, 94vw);
  max-inline-size: min(36rem, 94vw);
}
.db-settings-modal h2 { margin: 0; }

/* The four sections: hairline-separated, each carrying its own heading +
   copy + action. The LAST section (Appearance) carries the label/control
   rows instead of a trailing action, so its padding-end is trimmed by the
   footer's own border. */
.db-settings-section {
  padding-block: 0.85rem 0.2rem;
  border-block-start: 1px solid var(--line);
  display: grid;
  gap: 0.45rem;
}
.db-settings-section:first-of-type { border-block-start: 0; padding-block-start: 0.35rem; }
.db-settings-heading {
  margin: 0;
  font-size: 0.78rem;
  font-weight: var(--text-label-weight, 600);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}

/* The version line + the account line — the section's ONE fact each, so they
   carry the body weight, not the muted smalls under them. */
.db-settings-version,
.db-settings-account {
  margin: 0;
  font-size: var(--fs-md);
  font-weight: var(--text-label-weight, 500);
  color: var(--fg);
  overflow-wrap: anywhere;
}

/* The action rows — the .db-sync-actions grammar (right-aligned, mirrored
   under RTL). */
.db-settings-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
[dir='rtl'] .db-settings-actions { justify-content: flex-start; }
.db-settings-actions .btn,
.db-settings-actions .db-update-cta { display: inline-flex; align-items: center; gap: 0.4rem; }
.db-settings-actions .icon { flex: none; }

/* The footer — the sheet's own exit, set off from the sections. */
.db-settings-footer {
  margin-block-start: 0.35rem;
  padding-block-start: 0.85rem;
  border-block-start: 1px solid var(--line);
}

/* The Appearance rows: label column + control column (the web's own
   settings-page grammar — a fixed label rail, the control at the inline
   end; RTL mirrors the whole row for free through the logical template). */
.db-settings-row {
  display: grid;
  grid-template-columns: minmax(6.5rem, auto) 1fr;
  align-items: center;
  column-gap: 1rem;
}
.db-settings-row-label {
  font-size: var(--fs-md);
  color: var(--muted);
}

/* The segmented control — the tray-radio grammar as a pill group: a
   hairline pill holding the options, the ACTIVE option painted with the
   soft accent fill (the active rail item's own recipe — a soft FILLED tint,
   one rung under the CTA). aria-pressed is the state (the controller keeps
   it truthful); hover/focus ride the ghost grammar's own affordances. */
.db-settings-seg {
  display: inline-flex;
  align-items: stretch;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  padding: 0.2rem;
  gap: 0.2rem;
  justify-self: start;
  background: color-mix(in srgb, var(--fg) 3%, transparent);
}
.db-settings-seg-btn {
  appearance: none;
  border: 0;
  border-radius: 999px;
  padding: 0.35rem 0.95rem;
  font: inherit;
  font-size: var(--fs-md);
  font-weight: var(--text-label-weight, 500);
  color: var(--muted);
  background: transparent;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 0.18s ease, color 0.18s ease;
}
.db-settings-seg-btn:hover { color: var(--fg); }
.db-settings-seg-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.db-settings-seg-btn[aria-pressed='true'] {
  color: var(--fg);
  background: color-mix(in srgb, var(--accent) 16%, var(--card));
  font-weight: var(--text-label-weight, 600);
}

/* The update-now CTA in the sheet reuses the Update pill's own solid --ok
   grammar (class db-update-cta, desktop-update.css) — the twin fill so both
   surfaces of the same action read as one. */
#db-settings-update-now[hidden] { display: none; }

/* The GitHub-access row (v0.1.18 — the owner ask: "hibana desktop might be
   a private repo so in setting, add a github credentials so it can connect
   to the private repo"): the Appearance rows' own label-rail grammar with a
   PASSWORD input + Save/Remove at the control column. The input is
   type=password on purpose — the token never renders in clear; the
   controller clears the field on every resolve, so the value lives
   Go-side only. RTL mirrors through the logical properties, as everywhere
   in this sheet. */
.db-settings-token-row { align-items: center; }
.db-settings-token {
  display: flex;
  align-items: center;
  flex-wrap: wrap; /* v0.1.19: the row grew a third button (Test) — a narrow sheet wraps the buttons instead of crushing the field */
  gap: 0.5rem;
  min-inline-size: 0;
}
#db-settings-token-input {
  flex: 1 1 auto;
  min-inline-size: 0;
  font: inherit;
  font-size: var(--fs-md);
  color: var(--fg);
  background: color-mix(in srgb, var(--fg) 3%, transparent);
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  padding: 0.35rem 0.65rem;
}
#db-settings-token-input::placeholder { color: var(--muted); }
#db-settings-token-input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
#db-settings-token-clear[hidden] { display: none; }
#db-settings-token-error { margin: 0; }

@media (prefers-reduced-motion: reduce) {
  .db-settings-seg-btn { transition: none; }
}
`

// ---------------------------------------------------------------------------
// desktop-audio.js — generated below into dist/js/ (the v0.1.13 sound round —
// the owner ask: "I want some sound engineering, some modern, futurist and
// low-key sounds. for this: 1. when you login. 2. when you delete a task
// 3. when you fulfill a tasks 4. when you move a task to another state
// 5. when syncing complete"). The engine is PROCEDURAL — Web Audio API
// oscillators synthesized in-page, ZERO audio files (no binary assets, no
// licensing, byte-countable, theme-free) — in a deliberately futurist
// grammar: pure sine/triangle partials, perfect-fifth intervals, exponential
// pluck envelopes, master-gain headroom at ~-20dBFS so every cue sits UNDER
// the work, never over it. Written without template literals/backticks so it
// can nest in this literal.
// ---------------------------------------------------------------------------
const DESKTOP_AUDIO_JS = `// desktop-audio.js — the sound round (v0.1.13 — the owner ask: "I want some
// sound engineering, some modern, futurist and low-key sounds. for this:
// 1. when you login. 2. when you delete a task 3. when you fulfill a tasks
// 4. when you move a task to another state 5. when syncing complete").
// GENERATED FILE — do not hand-edit (guide §3.3.4): emitted by scripts/sync-island.mjs
// into frontend/dist/js/ and checksummed in frontend/island.checksums.json.
// Loads blocking, right AFTER desktop-shim.js (it wraps the seam the shim
// just defined) and BEFORE every deferred island script.
//
// WHAT THIS FILE OWNS (the desktop-owned sound layer):
//   1. window.hibanaAudio.play(name) — the five cues, synthesized live via
//      the Web Audio API (WebView2 = Chromium; window.AudioContext always
//      exists there). NO audio files ship: every sound is a few oscillator
//      voices + envelopes, so the whole engine is ~5KB of text and nothing
//      binary ever enters dist. The palette is FUTURIST + LOW-KEY by design:
//      sine/triangle partials only (glassy, synthetic — no acoustic
//      emulations), perfect-fifth intervals (the open, weightless sonority),
//      short exponential pluck envelopes (attack 8-16ms so nothing clicks,
//      decay settles under the next paint), per-voice lowpass shaping, and a
//      master gain of 0.5 with per-voice peaks of 0.02-0.1 — every cue lands
//      around -20dBFS, audible as a whisper of confirmation, never an alarm.
//        login   — the welcome fifth: E5 rising to B5 over a soft E4 bed
//                  with a faint E6 shimmer (~0.75s; desktop-login.js plays
//                  it on the ok resolve and delays the reload so it lands).
//        delete  — the dissolve thock: a 320->165Hz triangle body + a 98Hz
//                  sub weight + a band-passed noise puff (~0.3s; the sound
//                  of something dissolving — never a trash-can crash).
//        fulfill — the completion ding: G5 + D6 plucks over a G3 bed with a
//                  high sparkle tail (~0.8s; the "task done" satisfaction).
//        move    — the micro tick: a 540->660Hz sine glide, 75ms — the
//                  quietest of the five, tactile like a precision switch.
//        sync    — the all-clear: a stacked-fifth arpeggio A4 -> E5 -> B5
//                  with a glassy E6 tail over an A3 bed (~1.1s; the sonic
//                  twin of the green "Everything synced" panel).
//   2. The task-action OBSERVER on the transport seam: it wraps
//      window.hibanaFetch (the shim's ONE seam — every task mutation the
//      island makes crosses it) and classifies BEFORE the call (the island
//      state still holds the PREVIOUS status while the request is in
//      flight — window.HibanaBoard.findTask reads it live), then plays the
//      matching cue ONLY on a 2xx resolve — a failed delete/move/fulfill is
//      silent, because nothing happened:
//        DELETE /api/devtasks/:id (exactly one path segment — the tag/
//        screenshot deleters never match)      -> 'delete'
//        PATCH  /api/devtasks/:id with a status the task did NOT already
//        carry:  -> 'done' = 'fulfill', any other change = 'move'
//        (a PATCH whose status equals the current status — the editor's
//        every-save resend — is a plain edit and stays silent; same-name
//        cues within 150ms coalesce, so "Clear done" sounds ONCE).
//   3. The gesture unlock: Chromium gates audio behind a user activation —
//      the first pointerdown/keydown warms the context (resume()), and
//      every play() re-checks it; all five call sites inherently follow a
//      real gesture (submit, confirm, drag, the Sync click).
//
// WHAT IT MUST NEVER OWN: no island bytes (the wrapper touches nothing the
// island ships — it observes the seam the shim already owns), no storage
// (the Go mirror owns persistence), no network of its own, no volume UI
// (the ask is the five cues; nothing else).
(function () {
  'use strict'

  var ctx = null
  var master = null
  var lastPlay = {}

  function ensureCtx() {
    if (ctx) return ctx
    var AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return null
    try {
      ctx = new AC()
      master = ctx.createGain()
      master.gain.value = 0.5
      master.connect(ctx.destination)
    } catch (e) { ctx = null; master = null }
    return ctx
  }

  function unlock() {
    var c = ensureCtx()
    if (c && c.state === 'suspended') { try { c.resume() } catch (e) { /* a locked context stays silent, never broken */ } }
  }

  // The warm-up: the FIRST gesture unlocks the context for the document's
  // life, so a drag's drop (a gesture chain) and every click-driven cue
  // schedule against an already-running context.
  document.addEventListener('pointerdown', unlock, { once: true, capture: true })
  document.addEventListener('keydown', unlock, { once: true, capture: true })

  // One synth voice: osc -> (optional lowpass) -> envelope -> master.
  function tone(o) {
    var osc = ctx.createOscillator()
    osc.type = o.type || 'sine'
    osc.frequency.setValueAtTime(o.f0, o.t)
    if (o.f1 && o.f1 !== o.f0) osc.frequency.exponentialRampToValueAtTime(o.f1, o.t + o.dur * 0.85)
    var g = ctx.createGain()
    var atk = o.attack || 0.012
    g.gain.setValueAtTime(0.0001, o.t)
    g.gain.linearRampToValueAtTime(o.peak, o.t + atk)
    g.gain.exponentialRampToValueAtTime(0.0001, o.t + o.dur)
    var head = osc
    if (o.lp) {
      var f = ctx.createBiquadFilter()
      f.type = 'lowpass'
      f.frequency.value = o.lp
      f.Q.value = 0.7
      osc.connect(f)
      head = f
    }
    head.connect(g)
    g.connect(master)
    osc.start(o.t)
    osc.stop(o.t + o.dur + 0.05)
  }

  // The noise breath (the delete cue's puff): a decaying white-noise buffer
  // through a band-pass — the "dissolving" tail, barely there.
  function puff(o) {
    var len = Math.max(256, Math.floor(ctx.sampleRate * o.dur))
    var buf = ctx.createBuffer(1, len, ctx.sampleRate)
    var d = buf.getChannelData(0)
    for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len)
    var src = ctx.createBufferSource()
    src.buffer = buf
    var bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = o.freq
    bp.Q.value = 0.9
    var g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, o.t)
    g.gain.linearRampToValueAtTime(o.peak, o.t + 0.008)
    g.gain.exponentialRampToValueAtTime(0.0001, o.t + o.dur)
    src.connect(bp)
    bp.connect(g)
    g.connect(master)
    src.start(o.t)
    src.stop(o.t + o.dur + 0.02)
  }

  // The five cues (frequencies in Hz, A4=440 — the intervals are perfect
  // fifths by design: the futurist, weightless sonority).
  var SOUNDS = {
    login: function (t) {
      tone({ f0: 329.63, type: 'triangle', t: t, dur: 0.55, peak: 0.03, lp: 1600 })
      tone({ f0: 659.25, type: 'sine', t: t, dur: 0.5, peak: 0.1, lp: 2800 })
      tone({ f0: 987.77, type: 'sine', t: t + 0.16, dur: 0.62, peak: 0.08, lp: 3200 })
      tone({ f0: 1318.51, type: 'sine', t: t + 0.34, dur: 0.4, peak: 0.022, lp: 6000 })
    },
    delete: function (t) {
      tone({ f0: 320, f1: 165, type: 'triangle', t: t, dur: 0.17, peak: 0.09, lp: 750 })
      tone({ f0: 98, type: 'sine', t: t, dur: 0.12, peak: 0.05 })
      puff({ t: t + 0.01, dur: 0.13, freq: 700, peak: 0.032 })
    },
    fulfill: function (t) {
      tone({ f0: 196, type: 'triangle', t: t, dur: 0.5, peak: 0.028, lp: 900 })
      tone({ f0: 783.99, type: 'sine', t: t, dur: 0.38, peak: 0.085, lp: 3400 })
      tone({ f0: 1174.66, type: 'sine', t: t + 0.09, dur: 0.5, peak: 0.07, lp: 4000 })
      tone({ f0: 2349.32, type: 'sine', t: t + 0.2, dur: 0.28, peak: 0.016, lp: 7000 })
    },
    move: function (t) {
      tone({ f0: 540, f1: 660, type: 'sine', t: t, dur: 0.075, peak: 0.05, lp: 1900 })
    },
    sync: function (t) {
      tone({ f0: 220, type: 'triangle', t: t, dur: 0.9, peak: 0.03, lp: 1000 })
      tone({ f0: 440, type: 'sine', t: t, dur: 0.5, peak: 0.085, lp: 2400 })
      tone({ f0: 659.25, type: 'sine', t: t + 0.13, dur: 0.6, peak: 0.075, lp: 2800 })
      tone({ f0: 987.77, type: 'sine', t: t + 0.26, dur: 0.8, peak: 0.065, lp: 3400 })
      tone({ f0: 1318.51, type: 'sine', t: t + 0.42, dur: 0.7, peak: 0.02, lp: 6000 })
    },
  }

  function play(name) {
    var fn = SOUNDS[name]
    if (!fn) return false
    if (!ensureCtx()) return false
    unlock()
    var now = Date.now()
    if (lastPlay[name] && now - lastPlay[name] < 150) return false // coalesce: "Clear done" sounds ONCE
    lastPlay[name] = now
    try { fn(ctx.currentTime + 0.02) } catch (e) { return false }
    return true
  }

  window.hibanaAudio = { play: play }

  // ------------------------------------------------------ the seam observer
  // Classify BEFORE the call (the island's live state still holds the
  // PREVIOUS status while the request is in flight) and play ONLY on a 2xx
  // resolve — a failed mutation is silent. The wrapper returns the ORIGINAL
  // promise untouched, so the callers' error/abort semantics are byte-ident.
  function classify(path, opts) {
    if (!path || typeof path !== 'string') return null
    var method = ((opts && opts.method) || 'GET').toUpperCase()
    var m = /^\\/api\\/devtasks\\/([^\\/?]+)$/.exec(path)
    if (!m) return null
    if (method === 'DELETE') return 'delete'
    if (method === 'PATCH') {
      var body = opts && opts.body
      var parsed = null
      if (typeof body === 'string') { try { parsed = JSON.parse(body) } catch (e) { return null } }
      else if (body && typeof body === 'object') parsed = body
      if (!parsed || typeof parsed.status !== 'string') return null
      var prior = null
      try {
        var HB = window.HibanaBoard
        var task = HB && typeof HB.findTask === 'function' ? HB.findTask(m[1]) : null
        if (task && typeof task.status === 'string') prior = task.status
      } catch (e) { /* a missing board never blocks the cue */ }
      if (parsed.status === prior) return null // the editor's same-status resend: a plain edit
      return parsed.status === 'done' ? 'fulfill' : 'move'
    }
    return null
  }

  var seam = window.hibanaFetch
  if (typeof seam === 'function') {
    window.hibanaFetch = function (path, opts) {
      var verdict = classify(path, opts)
      var p = seam.call(window, path, opts)
      if (verdict) {
        p.then(function (res) { if (res && res.ok) play(verdict) }, function () { /* a rejected call is silent */ })
      }
      return p
    }
  }
})()
`

// ---------------------------------------------------------------------------
// The v0.1.13 HTML ops — the sound round's script tag. The engine wraps
// window.hibanaFetch, so it must load AFTER desktop-shim.js defines it and
// BEFORE every deferred island script consumes it. The anchor is the shim's
// OWN tag (unique in the head — the login insert rides the same anchor but
// emits a DIFFERENT line, so both ops stay unambiguous; whichever order the
// rounds apply in, this op lands between the shim and the login controller).
// ---------------------------------------------------------------------------
const HTML_AUDIO_OPS = [
  {
    name: 'insert /js/desktop-audio.js after desktop-shim.js (the sound engine wraps the seam the shim just defined)',
    cite: "v0.1.13 (the sound round — the owner ask: 'some modern, futurist and low-key sounds'); the observer must wrap the shim's seam and the login/sync controllers call window.hibanaAudio at runtime",
    anchor: `<script src="/js/desktop-shim.js"></script>`,
    insert: `<script src="/js/desktop-audio.js"></script>`,
  },
]

// ---------------------------------------------------------------------------
// icon.svg — the ISLAND'S FAVICON (v0.1.2 — the owner ask: "use the Hibana logo as
// fav icon. and app icon"). GENERATED, not copied: the pin's own icon.svg is the old
// H-tile art; these bytes are the traced Hibana logo mark (the h-spark squircle,
// dark tile + white glyph) produced by scripts/make-icons.py — byte-identical to the
// regenerated hibana-source/public/icon.svg so the desktop tab icon and the web
// favicon are the same logo. index.html's <link rel="icon"> (a recorded insert)
// points at it.
// ---------------------------------------------------------------------------
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <!-- Hibana — the h-spark logo mark (traced from logo-square-light.png by scripts/make-icons.py) -->
  <rect width="512" height="512" rx="101" fill="#191e22"/>
  <path fill-rule="evenodd" d="M391.2 97.9 L392.8 88.8 L387.4 94.1 L382.1 99.4 L372.2 109.3 L366.9 109.3 L366.1 110.1 L360.8 115.4 L355.4 120.8 L345.6 130.7 L340.2 130.7 L339.4 131.4 L329.6 141.3 L324.2 141.3 L323.4 142.1 L313.6 152.0 L308.2 152.0 L302.9 157.3 L304.0 157.3 L298.7 157.3 L286.9 157.3 L281.6 162.7 L282.7 162.7 L277.3 162.7 L272.0 162.7 L254.9 162.7 L264.0 171.8 L264.0 177.1 L269.3 182.4 L269.3 181.3 L269.3 186.7 L269.3 192.0 L269.3 197.3 L269.3 202.7 L269.3 212.2 L270.1 211.4 L264.8 216.8 L259.4 222.1 L249.6 232.0 L250.7 232.0 L245.3 232.0 L240.0 232.0 L234.7 232.0 L229.3 232.0 L217.6 232.0 L212.2 237.3 L213.3 237.3 L201.6 237.3 L200.8 238.1 L190.9 248.0 L187.8 248.0 L184.0 244.2 L184.0 245.3 L184.0 240.0 L184.0 234.7 L184.0 229.3 L184.0 224.0 L184.0 218.7 L184.0 213.3 L184.0 208.0 L184.0 202.7 L184.0 197.3 L184.0 192.0 L184.0 186.7 L184.0 181.3 L184.0 176.0 L184.0 170.7 L184.0 165.3 L184.0 160.0 L184.0 154.7 L184.0 149.3 L184.0 137.6 L177.1 130.7 L176.0 130.7 L170.7 130.7 L165.3 130.7 L160.0 130.7 L154.7 130.7 L149.3 130.7 L144.0 130.7 L138.7 130.7 L126.9 130.7 L120.0 137.6 L120.0 138.7 L120.0 144.0 L120.0 149.3 L120.0 154.7 L120.0 160.0 L120.0 165.3 L120.0 170.7 L120.0 176.0 L120.0 181.3 L120.0 186.7 L120.0 192.0 L120.0 197.3 L120.0 202.7 L120.0 208.0 L120.0 213.3 L120.0 218.7 L120.0 224.0 L120.0 229.3 L120.0 234.7 L120.0 240.0 L120.0 245.3 L120.0 250.7 L120.0 256.0 L120.0 261.3 L120.0 266.7 L120.0 272.0 L120.0 277.3 L120.0 282.7 L120.0 288.0 L120.0 293.3 L120.0 298.7 L120.0 304.0 L120.0 309.3 L120.0 314.7 L120.0 320.0 L120.0 325.3 L120.0 330.7 L120.0 342.4 L125.3 347.8 L125.3 346.7 L125.3 352.0 L125.3 363.8 L130.7 369.1 L130.7 368.0 L130.7 379.8 L131.4 380.6 L136.8 385.9 L142.1 391.2 L147.4 396.6 L158.9 408.0 L164.2 408.0 L169.6 413.3 L170.7 413.3 L184.0 413.3 L184.0 410.7 L184.0 405.3 L184.0 400.0 L184.0 394.7 L184.0 389.3 L184.0 384.0 L184.0 378.7 L184.0 373.3 L184.0 368.0 L184.0 362.7 L184.0 357.3 L184.0 352.0 L184.0 346.7 L184.0 341.3 L184.0 336.0 L184.0 330.7 L184.0 325.3 L184.0 315.8 L189.3 310.4 L189.3 305.1 L188.6 305.9 L198.4 296.0 L203.8 296.0 L204.6 295.2 L214.4 285.3 L213.3 285.3 L218.7 285.3 L224.0 285.3 L229.3 285.3 L234.7 285.3 L240.0 285.3 L245.3 285.3 L254.9 285.3 L260.2 290.7 L265.6 290.7 L264.8 289.9 L270.1 295.2 L275.4 300.6 L285.3 310.4 L285.3 315.8 L290.7 321.1 L290.7 320.0 L290.7 325.3 L290.7 330.7 L290.7 336.0 L290.7 341.3 L290.7 346.7 L290.7 352.0 L290.7 357.3 L290.7 362.7 L290.7 368.0 L290.7 373.3 L290.7 378.7 L290.7 384.0 L290.7 389.3 L290.7 394.7 L290.7 400.0 L290.7 405.3 L290.7 418.7 L293.3 418.7 L298.7 418.7 L304.0 418.7 L309.3 418.7 L314.7 418.7 L320.0 418.7 L325.3 418.7 L330.7 418.7 L336.0 418.7 L341.3 418.7 L353.1 418.7 L360.0 411.8 L360.0 410.7 L360.0 405.3 L360.0 400.0 L360.0 394.7 L360.0 389.3 L360.0 384.0 L360.0 378.7 L360.0 373.3 L360.0 368.0 L360.0 362.7 L360.0 357.3 L360.0 352.0 L360.0 346.7 L360.0 341.3 L360.0 329.6 L354.7 324.2 L354.7 325.3 L354.7 320.0 L354.7 314.7 L354.7 302.9 L349.3 297.6 L349.3 298.7 L349.3 286.9 L348.6 286.1 L338.7 276.2 L338.7 270.9 L337.9 270.1 L332.6 264.8 L327.2 259.4 L315.8 248.0 L310.4 248.0 L305.1 242.7 L299.8 242.7 L294.4 237.3 L289.1 237.3 L283.8 232.0 L278.4 232.0 L275.8 229.3 L278.4 226.7 L283.8 226.7 L289.1 221.3 L288.0 221.3 L293.3 221.3 L298.7 221.3 L304.0 221.3 L309.3 221.3 L318.9 221.3 L324.2 226.7 L325.3 226.7 L334.9 226.7 L340.2 232.0 L345.6 232.0 L344.8 231.2 L349.3 228.2 L349.3 222.9 L348.6 222.1 L338.7 212.2 L338.7 213.3 L338.7 208.0 L338.7 202.7 L338.7 197.3 L338.7 192.0 L338.7 186.7 L338.7 181.3 L338.7 171.8 L344.0 166.4 L344.0 161.1 L343.2 161.9 L354.7 150.4 L354.7 145.1 L353.9 145.9 L365.3 134.4 L365.3 129.1 L364.6 129.9 L369.9 124.6 L381.3 113.1 L381.3 107.8 L380.6 108.6 L385.9 103.2 Z" fill="#f1f2f4"/>
</svg>
`

// ---------------------------------------------------------------------------
// Checksums (guide §3.3.2; WINDOWS-PACKAGING-PLAN §7.4). sha256 of every file under
// dist, relative POSIX paths as keys, sorted, stable formatting — written OUTSIDE dist
// (frontend/island.checksums.json) so dist is purely servable.
// ---------------------------------------------------------------------------
function walkFiles(dir, baseDir) {
  const out = []
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  for (const e of entries) {
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walkFiles(abs, baseDir))
    else if (e.isFile()) out.push(path.relative(baseDir, abs).split(path.sep).join('/'))
  }
  return out
}

function hashDist(outDir) {
  const hashes = {}
  for (const rel of walkFiles(outDir, outDir)) {
    hashes[rel] = createHash('sha256').update(fs.readFileSync(path.join(outDir, rel))).digest('hex')
  }
  const sorted = {}
  for (const key of Object.keys(hashes).sort()) sorted[key] = hashes[key]
  return sorted
}

// ---------------------------------------------------------------------------
// Post-sync self-verification (the sync gate — everything must pass or the run fails)
// ---------------------------------------------------------------------------
function verifyDist(outDir, fileMap) {
  const problems = []
  const devboard = fileMap['js/devboard.js']
  const boardPage = fileMap['js/board-page.js']
  const indexHtml = fileMap['index.html']

  // (1) the seam took, exactly (guide §4.1: 6 fetch sites + 2 XHR in devboard; 4 in board-page)
  const count = (s, needle) => s.split(needle).length - 1
  if (count(devboard, 'window.hibanaFetch(') !== 6) problems.push('devboard.js: expected 6 window.hibanaFetch( sites, found ' + count(devboard, 'window.hibanaFetch('))
  if (count(devboard, 'window.hibanaXHR(') !== 2) problems.push('devboard.js: expected 2 window.hibanaXHR( sites, found ' + count(devboard, 'window.hibanaXHR('))
  if (count(devboard, 'new XMLHttpRequest(') !== 0) problems.push('devboard.js: ' + count(devboard, 'new XMLHttpRequest(') + ' bare new XMLHttpRequest( remain')
  if (count(boardPage, 'window.hibanaFetch(') !== 4) problems.push('board-page.js: expected 4 window.hibanaFetch( sites, found ' + count(boardPage, 'window.hibanaFetch('))
  const bareFetchRe = /\bfetch\(/g
  if ((devboard.match(bareFetchRe) || []).length !== 0) problems.push('devboard.js: bare fetch( calls remain')
  if ((boardPage.match(bareFetchRe) || []).length !== 0) problems.push('board-page.js: bare fetch( calls remain')

  // (1b) THE v0.1.15 UPLOAD BRIDGE (the owner's dogfood: "it doesn't show
  // whether it was successful or not"): the XHR proxy must call the bound
  // Upload with the callID FIRST (the progress events are addressed by id —
  // parallel uploads share one path), register in the live map, and route the
  // hibana:upload-progress events to upload.onprogress with the standard
  // ProgressEvent shape (lengthComputable + loaded/total).
  const shimJs = fileMap['js/desktop-shim.js'] || ''
  if (!shimJs.includes("resolveBoundMethod('Upload')")) problems.push('js/desktop-shim.js: the XHR upload proxy must resolve the Go Upload binding at SEND time')
  if (!shimJs.includes('bridge(self._id, self._method')) problems.push('js/desktop-shim.js: the Upload call must carry the callID (progress correlation key) first')
  if (!shimJs.includes("EventsOn('hibana:upload-progress'")) problems.push('js/desktop-shim.js: the hibana:upload-progress listener is missing')
  if (!shimJs.includes('lengthComputable: true')) problems.push('js/desktop-shim.js: the synthetic progress event must be lengthComputable (the uploader gates on it)')

  // (2) the HTML adaptation (guide §3.2)
  for (const banned of ['htmx', 'idiomorph', 'boot.js', 'app.js', 'hib-init', 'touch-drag', 'nav.js', 'command-palette',
    'mobile-nav', 'zen-mode', 'micro-interactions', 'go-to.js', 'alpine', 'hibana-page-loader', 'data-nav']) {
    if (indexHtml.includes(banned)) problems.push('index.html still references stripped chrome: "' + banned + '"')
  }
  const linkRe = /<link rel="stylesheet" href="([^"]+)"/g
  const links = []
  let m
  while ((m = linkRe.exec(indexHtml)) !== null) links.push(m[1].replace(/\?.*$/, ''))
  // The desktop-owned sheets ride AFTER the manrope font sheet at the END of the
  // head link block — the gate sheet (guide §5.5), then the sync modal's sheet
  // (v0.1.6), then the sign-out round's sheet (v0.1.9); the island's 19-sheet
  // order + rtl-last are untouched around them.
  const expectedLinks = [...CSS_SHEETS.map((p) => '/' + p), '/vendor/manrope/font-face.css', '/css/desktop-login.css', '/css/desktop-sync.css', '/css/desktop-logout.css', '/css/desktop-newproject.css', '/css/desktop-refresh.css', '/css/desktop-update.css', '/css/desktop-settings.css']
  if (JSON.stringify(links) !== JSON.stringify(expectedLinks)) {
    problems.push('index.html CSS manifest mismatch:\n    expected: ' + JSON.stringify(expectedLinks) + '\n    actual:   ' + JSON.stringify(links))
  }
  if (links[CSS_SHEETS.length - 1] !== '/css/rtl.css') problems.push('index.html: rtl.css is not the last ISLAND /css/ sheet (the desktop-owned sheets follow it)')
  // The blocking head chain (v0.1.5 + v0.1.6 + v0.1.9 + v0.1.11 + v0.1.12 + v0.1.13 + v0.1.17 grew it): the pre-paint theme
  // bootstrap FIRST, then the transport shim, the sound engine (it wraps the
  // seam the shim just defined), the login controller, the sync
  // controller, the sign-out controller, the new-project controller, the
  // refresh controller, the update controller, the settings controller —
  // all blocking, so they own their contracts before every deferred island
  // script.
  const themeIdx = indexHtml.indexOf('/js/desktop-theme.js')
  const shimIdx = indexHtml.indexOf('/js/desktop-shim.js')
  const audioIdx = indexHtml.indexOf('/js/desktop-audio.js')
  const loginIdx = indexHtml.indexOf('/js/desktop-login.js')
  const syncIdx = indexHtml.indexOf('/js/desktop-sync.js')
  const logoutIdx = indexHtml.indexOf('/js/desktop-logout.js')
  const newProjIdx = indexHtml.indexOf('/js/desktop-newproject.js')
  const refreshIdx = indexHtml.indexOf('/js/desktop-refresh.js')
  const updateIdx = indexHtml.indexOf('/js/desktop-update.js')
  const settingsIdx = indexHtml.indexOf('/js/desktop-settings.js')
  const devIdx = indexHtml.indexOf('/js/devboard.js')
  const bpIdx = indexHtml.indexOf('/js/board-page.js')
  if (!(themeIdx !== -1 && shimIdx !== -1 && audioIdx !== -1 && loginIdx !== -1 && syncIdx !== -1 && logoutIdx !== -1 && newProjIdx !== -1 && refreshIdx !== -1 && updateIdx !== -1 && settingsIdx !== -1 && devIdx !== -1 && bpIdx !== -1 &&
      themeIdx < shimIdx && shimIdx < audioIdx && audioIdx < loginIdx && loginIdx < syncIdx && syncIdx < logoutIdx && logoutIdx < newProjIdx && newProjIdx < refreshIdx && refreshIdx < updateIdx && updateIdx < settingsIdx && settingsIdx < devIdx && devIdx < bpIdx)) {
    problems.push('index.html: desktop-theme.js → desktop-shim.js → desktop-audio.js → desktop-login.js → desktop-sync.js → desktop-logout.js → desktop-newproject.js → desktop-refresh.js → desktop-update.js → desktop-settings.js → devboard.js → board-page.js order broken (got indices ' + themeIdx + '/' + shimIdx + '/' + audioIdx + '/' + loginIdx + '/' + syncIdx + '/' + logoutIdx + '/' + newProjIdx + '/' + refreshIdx + '/' + updateIdx + '/' + settingsIdx + '/' + devIdx + '/' + bpIdx + ')')
  }
  for (const kept of ['id="db-toolbar"', 'id="db-loading"', 'id="db-board"', 'data-i18n="db.board"', 'data-i18n="db.backToProject"',
    'js/i18n-en.js', 'js/i18n.js', 'vendor/jalaali.min.js', 'js/chip-render.js', 'vendor/general-sans/GeneralSans-400.woff2']) {
    if (!indexHtml.includes(kept)) problems.push('index.html: kept markup/manifest missing "' + kept + '"')
  }
  // The login gate (guide §5.5): the markup + both desktop-owned files must be
  // exactly what this script generates — a hand-edit anywhere in the chain fails here.
  for (const kept of ['id="login-gate"', 'id="login-gate-form"', 'class="auth-split"', 'class="auth-visual"', 'class="auth-form"', 'src="/logo-dark.png"', 'data-i18n="auth.welcomeBack"', 'data-i18n="auth.signIn"', 'rel="icon" type="image/svg+xml" href="/icon.svg"', 'css/desktop-login.css']) {
    if (!indexHtml.includes(kept)) problems.push('index.html: the login gate is missing "' + kept + '"')
  }
  const loginJs = fileMap['js/desktop-login.js'] || ''
  if (!loginJs.includes('window.__hibanaMe')) problems.push('js/desktop-login.js: the __hibanaMe language hook is missing')
  if (!loginJs.includes("EventsOn('hibana:auth-required'")) problems.push('js/desktop-login.js: the session-expiry listener is missing')
  if (!loginJs.includes('bridgeLogin(login, password)')) problems.push('js/desktop-login.js: the form is not wired to the Go Login binding')
  if (!loginJs.includes("var bridgeLogin = resolveBoundMethod('Login')")) problems.push('js/desktop-login.js: the bridge must resolve at SUBMIT time (the v0.1.1 parse-time snapshot lesson), not at parse time')
  const loginCss = fileMap['css/desktop-login.css'] || ''
  if (!loginCss.includes("html[data-desktop-authed='true'] .login-gate")) problems.push("css/desktop-login.css: the first-paint visibility rule is missing")

  // The v0.1.5 theme round (S216 — the dark-mode + toggle ask): BOTH toggle surfaces
  // must exist in the markup, and the generated controller must resolve the Go
  // SetTheme binding at CLICK time (the v0.1.1 parse-time lesson) + listen for the
  // tray-driven hibana:theme event.
  for (const kept of ['id="db-theme-toggle"', 'class="theme-floater"', 'data-i18n-aria-label="nav.themeHint"', 'data-i18n-aria-label="auth.toggleTheme"']) {
    if (!indexHtml.includes(kept)) problems.push('index.html: the theme round is missing "' + kept + '"')
  }
  const themeJs = fileMap['js/desktop-theme.js'] || ''
  if (!themeJs.includes("resolveBoundMethod('SetTheme')")) problems.push('js/desktop-theme.js: the toggles must resolve the Go SetTheme binding at CLICK time, not at parse time')
  if (!themeJs.includes("EventsOn('hibana:theme'")) problems.push('js/desktop-theme.js: the tray-driven hibana:theme listener is missing')

  // The v0.1.6 sync round (S217 — the physical, visible sync button ask) + the
  // v0.1.8 follow-up (the owner: "There is still No Sync button" — the ghost icon
  // did not read as one): the button must now be the LABELED FILL-COLORED CTA
  // pill (class small db-sync-cta + the #db-sync-btn-label span) sitting right
  // AFTER Labels and BEFORE the theme toggle ("next to sprints and labels"); the
  // modal ids must exist, the controller must resolve the Go SyncNow binding at
  // CLICK time and relay the hibana:sync-progress events, and the "will not
  // vanish" success copy must ship in BOTH languages.
  // The v0.1.21 per-card sync badge round (hibana-sync-status-spec §9): the Sync
  // button's count must derive from the island's OWN tracker (ONE source with the
  // cards' badges) — never a second tally.
  {
    const dsJs = fileMap['js/desktop-sync.js'] || ''
    if (!dsJs.includes('window.HibanaSyncState')) problems.push('js/desktop-sync.js: the Sync button must subscribe to the island\'s HibanaSyncState (the per-card badge round, spec §9 one-source rule)')
    if (!dsJs.includes('db-sync-count')) problems.push('js/desktop-sync.js: the §9 count badge element is missing')
    if (!dsJs.includes('hasSyncing')) problems.push('js/desktop-sync.js: the rotation cue (hasSyncing) is missing')
    const dsCss = fileMap['css/desktop-sync.css'] || ''
    if (!dsCss.includes('.db-sync-count')) problems.push('css/desktop-sync.css: the §9 count badge styles are missing')
  }
  for (const kept of ['id="db-sync-button"', 'class="small db-sync-cta"', 'id="db-sync-btn-label"', 'id="db-sync-dialog"', 'id="db-sync-steps"', 'id="db-sync-panel"', 'aria-label="Sync now"']) {
    if (!indexHtml.includes(kept)) problems.push('index.html: the sync round is missing "' + kept + '"')
  }
  {
    const labelsIdx = indexHtml.indexOf('id="db-labels-btn"')
    const syncIdx = indexHtml.indexOf('id="db-sync-button"')
    const themeIdx = indexHtml.indexOf('id="db-theme-toggle"')
    if (!(labelsIdx !== -1 && syncIdx > labelsIdx && themeIdx > syncIdx)) {
      problems.push('index.html: the Sync button must sit right after Labels and before the theme toggle (the owner ask: next to Sprints and Labels) — got labels@' + labelsIdx + ', sync@' + syncIdx + ', theme@' + themeIdx)
    }
  }
  const syncJs = fileMap['js/desktop-sync.js'] || ''
  if (!syncJs.includes("resolveBoundMethod('SyncNow')")) problems.push('js/desktop-sync.js: the button must resolve the Go SyncNow binding at CLICK time (the v0.1.1 parse-time snapshot lesson)')
  if (!syncJs.includes("EventsOn('hibana:sync-progress'")) problems.push('js/desktop-sync.js: the hibana:sync-progress step relay listener is missing')
  if (!syncJs.includes('db-sync-btn-label')) problems.push('js/desktop-sync.js: the visible Sync label localization hook is missing (the v0.1.8 labeled-button ask)')
  if (!syncJs.includes('they will not vanish.')) problems.push('js/desktop-sync.js: the EN "will not vanish" success copy is missing')
  if (!syncJs.includes('از بین نمی')) problems.push('js/desktop-sync.js: the FA "will not vanish" success copy is missing')
  const syncCss = fileMap['css/desktop-sync.css'] || ''
  if (!syncCss.includes('#db-sprint-link')) problems.push('css/desktop-sync.css: the Sprints/Labels twin-sizing rule is missing (the v0.1.8 "same size" ask)')
  if (!syncCss.includes('#db-sync-button')) problems.push('css/desktop-sync.css: the toolbar Sync CTA pill rule is missing (the v0.1.8 fill-colored ask)')
  // THE v0.1.15 COMPLETE-FACTS FIX (the owner ask: "the modal is not complete
  // and needs fix"): the step notes are the round's LIVE PROOF ("signed in as
  // …", "7 project(s) · 7 board(s)") — they must OWN a full-width line under
  // the label and WRAP. The old 60%-cap ellipsis cut every fact mid-word.
  if (!syncCss.includes('grid-template-columns: auto 1fr')) problems.push('css/desktop-sync.css: the step row must be the mark + (label, note) grid (the v0.1.15 complete-facts fix)')
  if (!syncCss.includes('overflow-wrap: anywhere')) problems.push('css/desktop-sync.css: the step note must wrap anywhere (the v0.1.15 complete-facts fix — an email must never stretch or clip the card)')
  if (syncCss.includes('text-overflow: ellipsis')) problems.push('css/desktop-sync.css: the step note must NEVER ellipsize (the v0.1.15 complete-facts fix — the facts are the proof)')
  if (!fs.existsSync(path.join(outDir, 'css/desktop-sync.css'))) problems.push('css/desktop-sync.css: missing from dist')

  // The v0.1.9 sign-out round (the owner ask: "It must also have option of logout
  // and enter with a new account"): the toolbar's account zone must exist — a
  // VISIBLE, LABELED ghost Log out button at the row's END (after the theme
  // toggle; the S220 lesson: an icon at the row's edge reads as nothing),
  // carrying the PIN'S OWN nav.signout label (EN 'Sign out' / FA 'خروج') via
  // data-i18n; the confirm dialog's ids must exist with the pin's own
  // common.cancel cancel; the controller must resolve the Go Logout binding
  // at CLICK time and reload into the login card on ok; and the body copy must
  // ship in BOTH languages.
  for (const kept of ['id="db-logout-button"', 'id="db-logout-btn-label"', 'data-i18n="nav.signout"', 'data-i18n-aria-label="nav.signout"', 'data-i18n="common.cancel"', 'id="db-logout-dialog"', 'id="db-logout-title"', 'id="db-logout-confirm"', 'id="db-logout-cancel"', 'id="db-logout-body"', 'id="db-logout-error"', 'css/desktop-logout.css',
    // The S186 CTA grammar: the confirm is the BARE <button> (the view's one
    // solid primary — the login gate's own "Sign in" shape), Cancel the
    // neutral secondary ahead of it.
    '<button type="button" id="db-logout-confirm" data-i18n="nav.signout">Sign out</button>']) {
    if (!indexHtml.includes(kept)) problems.push('index.html: the sign-out round is missing "' + kept + '"')
  }
  {
    const syncBtnIdx = indexHtml.indexOf('id="db-sync-button"')
    const themeBtnIdx = indexHtml.indexOf('id="db-theme-toggle"')
    const logoutBtnIdx = indexHtml.indexOf('id="db-logout-button"')
    if (!(syncBtnIdx !== -1 && themeBtnIdx > syncBtnIdx && logoutBtnIdx > themeBtnIdx)) {
      problems.push('index.html: the Log out button must sit at the row\'s END — after Sync and after the theme toggle (the account zone) — got sync@' + syncBtnIdx + ', theme@' + themeBtnIdx + ', logout@' + logoutBtnIdx)
    }
  }
  const logoutJs = fileMap['js/desktop-logout.js'] || ''
  if (!logoutJs.includes("resolveBoundMethod('Logout')")) problems.push('js/desktop-logout.js: the confirm must resolve the Go Logout binding at CLICK time (the v0.1.1 parse-time snapshot lesson)')
  if (!logoutJs.includes('location.reload()')) problems.push('js/desktop-logout.js: the ok-resolve must location.reload() into the login card (data-desktop-authed="false" at first paint)')
  if (!logoutJs.includes('sign in again any time to load them back.')) problems.push('js/desktop-logout.js: the EN sign-out body copy is missing')
  if (!logoutJs.includes('ابر هیبانا امن')) problems.push('js/desktop-logout.js: the FA sign-out body copy is missing')
  const logoutCss = fileMap['css/desktop-logout.css'] || ''
  if (!logoutCss.includes('#db-logout-button')) problems.push('css/desktop-logout.css: the toolbar Log out button rule is missing (the twin-metrics icon+label pill)')
  if (!fs.existsSync(path.join(outDir, 'css/desktop-logout.css'))) problems.push('css/desktop-logout.css: missing from dist')

  // The v0.1.11 new-project round (the owner ask: "Add ability to define a new
  // project, and get a kanban for it as well. this project then will be updated
  // in hibana's cloudflare as a new project."): the create dialog's ids must
  // exist with the PIN'S OWN i18n keys on every label (cmdk.newProject /
  // sparks.title / sparks.description / cat.quickAdd / common.cancel — the
  // logout round's data-i18n discipline); the controller must POST through the
  // shim seam with the client-minted idempotency id + the FIXED 'planning'
  // status (the switcher's list EXCLUDES sparks — a spark would vanish from
  // the very switcher it was created from), deep-link the fresh board on the
  // ok resolve, inject the switcher row via MutationObserver, intercept the
  // dead /projects.html links, and touch NO storage; the sheet must hide the
  // dead "All projects →" link + own the create-row accent.
  for (const kept of ['id="db-newproject-dialog"', 'id="db-newproject-title"', 'id="db-newproject-body"', 'id="db-newproject-title-input"', 'id="db-newproject-description"', 'id="db-newproject-error"', 'id="db-newproject-create"', 'id="db-newproject-cancel"', 'id="db-newproject-form"',
    'data-i18n="cmdk.newProject"', 'data-i18n="sparks.title"', 'data-i18n="sparks.description"', 'data-i18n="cat.quickAdd"', 'data-i18n="common.cancel"', 'css/desktop-newproject.css',
    // The S186 CTA grammar: Create is the BARE <button> (the view's one solid
    // primary — the sign-out confirm's shape), Cancel the neutral secondary.
    '<button type="button" id="db-newproject-create" data-i18n="cat.quickAdd">Create</button>']) {
    if (!indexHtml.includes(kept)) problems.push('index.html: the new-project round is missing "' + kept + '"')
  }
  const newProjectJs = fileMap['js/desktop-newproject.js'] || ''
  if (!newProjectJs.includes("window.hibanaFetch('/api/projects'")) problems.push("js/desktop-newproject.js: the create must POST through the shim's fetch seam (window.hibanaFetch('/api/projects'))")
  if (!newProjectJs.includes("status: 'planning'")) problems.push("js/desktop-newproject.js: the fixed 'planning' status is missing (the switcher's list excludes sparks)")
  if (!newProjectJs.includes('crypto.randomUUID')) problems.push('js/desktop-newproject.js: the client-minted idempotency id is missing')
  if (!newProjectJs.includes('MutationObserver')) problems.push('js/desktop-newproject.js: the runtime switcher-row injection (MutationObserver) is missing')
  if (!newProjectJs.includes('a[href="/projects.html"]')) problems.push('js/desktop-newproject.js: the dead /projects.html link interception is missing')
  if (!newProjectJs.includes('location.assign(')) problems.push('js/desktop-newproject.js: the fresh-board deep-link boot (location.assign) is missing')
  if (!newProjectJs.includes('created on the Hibana cloud')) problems.push('js/desktop-newproject.js: the EN create body copy is missing')
  if (!newProjectJs.includes('ابر هیبانا')) problems.push('js/desktop-newproject.js: the FA create body copy is missing')
  const newProjectCss = fileMap['css/desktop-newproject.css'] || ''
  if (!newProjectCss.includes('.db-switch-all { display: none; }')) problems.push('css/desktop-newproject.css: the dead All-projects link hide rule is missing (the desktop serves no projects page)')
  if (!newProjectCss.includes('.db-switch-new')) problems.push('css/desktop-newproject.css: the switcher New-project row accent rule is missing')
  if (!newProjectCss.includes('.db-newproject-actions')) problems.push('css/desktop-newproject.css: the dialog actions row rule is missing')
  if (!fs.existsSync(path.join(outDir, 'css/desktop-newproject.css'))) problems.push('css/desktop-newproject.css: missing from dist')

  // The v0.1.12 refresh round (the owner ask: "I tried something, deleted
  // something from hibana, clicked sync on the app, but it didn't got deleted.
  // it seems we need a refresh button"): the toolbar's Refresh button — the
  // pull-to-screen affordance — must sit right after the Sync CTA and before
  // the theme toggle (Sprints | Labels | Sync | Refresh | theme | Log out), a
  // VISIBLE, LABELED ghost (the S220 lesson + the row's grammar: Sync stays
  // the ONE colored action) carrying the desktop-owned EN/FA pair; the
  // controller must re-boot the island on click (location.reload); and the
  // sync modal grew the same reflex — the outcome's `pulled` count reaches
  // desktop-sync.js, the ok panel names the updated boards, and the native
  // close listener (Done/Esc) reloads the island so the deletions pulled by
  // the round reach the VISIBLE board.
  for (const kept of ['id="db-refresh-button"', 'id="db-refresh-btn-label"', 'aria-label="Refresh board"', 'css/desktop-refresh.css']) {
    if (!indexHtml.includes(kept)) problems.push('index.html: the refresh round is missing "' + kept + '"')
  }
  {
    const syncBtnIdx = indexHtml.indexOf('id="db-sync-button"')
    const refreshBtnIdx = indexHtml.indexOf('id="db-refresh-button"')
    const themeBtnIdx = indexHtml.indexOf('id="db-theme-toggle"')
    if (!(syncBtnIdx !== -1 && refreshBtnIdx > syncBtnIdx && themeBtnIdx > refreshBtnIdx)) {
      problems.push('index.html: the Refresh button must sit right after the Sync CTA and before the theme toggle — got sync@' + syncBtnIdx + ', refresh@' + refreshBtnIdx + ', theme@' + themeBtnIdx)
    }
  }
  const refreshJs = fileMap['js/desktop-refresh.js'] || ''
  if (!refreshJs.includes('location.reload()')) problems.push('js/desktop-refresh.js: the click must re-boot the island (location.reload — board-page.js\'s pushState\'d ?project= re-enters the same board)')
  if (!refreshJs.includes('db-refresh-btn-label')) problems.push('js/desktop-refresh.js: the visible Refresh label localization hook is missing')
  if (!refreshJs.includes("getAttribute('data-busy'") && !refreshJs.includes("setAttribute('data-busy'")) problems.push('js/desktop-refresh.js: the busy-state spin hook is missing')
  if (!refreshJs.includes('Refresh board')) problems.push('js/desktop-refresh.js: the EN label pair is missing')
  if (!refreshJs.includes('به‌روزرسانی')) problems.push('js/desktop-refresh.js: the FA label pair is missing')
  const refreshCss = fileMap['css/desktop-refresh.css'] || ''
  if (!refreshCss.includes('#db-refresh-button')) problems.push('css/desktop-refresh.css: the toolbar Refresh button rule is missing (the twin-metrics icon+label pill)')
  if (!fs.existsSync(path.join(outDir, 'css/desktop-refresh.css'))) problems.push('css/desktop-refresh.css: missing from dist')
  if (!syncJs.includes('out.pulled > 0')) problems.push('js/desktop-sync.js: the v0.1.12 pulled count must drive the ok panel\'s updated-boards fact + the close-time reload')
  if (!syncJs.includes("addEventListener('close'")) problems.push('js/desktop-sync.js: the native close listener (Done/Esc) must carry the pulled-boards reload')
  if (!syncJs.includes('updated from the cloud')) problems.push('js/desktop-sync.js: the EN pulled-boards fact is missing')
  if (!syncJs.includes('از ابر هیبانا به‌روزرسانی')) problems.push('js/desktop-sync.js: the FA pulled-boards fact is missing')

  // The v0.1.13 sound round (the owner ask: "I want some sound engineering,
  // some modern, futurist and low-key sounds. for this: 1. when you login.
  // 2. when you delete a task 3. when you fulfill a tasks 4. when you move
  // a task to another state 5. when syncing complete. also in modal i want
  // syncing animation with icons and animation"): the sound engine must
  // exist as a generated file carrying the five cues + the seam observer
  // (the hibanaFetch wrapper with the devtasks classifier), the sync modal
  // must carry the HERO (the living emblem: the id pair + the orbit/ring/
  // packets anatomy + the five morphing glyphs) and its controller must
  // wire the stage flips + the all-clear chime, and the login gate must
  // play the welcome chime on the ok resolve with the DELAYED reload (an
  // immediate one clips the cue to silence — a reload kills the context).
  if (!fs.existsSync(path.join(outDir, 'js/desktop-audio.js'))) problems.push('js/desktop-audio.js: missing from dist')
  const audioJs = fileMap['js/desktop-audio.js'] || ''
  if (!audioJs.includes('window.hibanaAudio')) problems.push('js/desktop-audio.js: the window.hibanaAudio API is missing')
  for (const cue of ['login:', 'delete:', 'fulfill:', 'move:', 'sync:']) {
    if (!audioJs.includes(cue)) problems.push('js/desktop-audio.js: the ' + cue.slice(0, -1) + ' cue is missing (the owner ask names all five)')
  }
  if (!audioJs.includes('window.hibanaFetch = function')) problems.push('js/desktop-audio.js: the seam observer wrapper is missing')
  if (!audioJs.includes('/^\\/api\\/devtasks\\/([^\\/?]+)$/')) problems.push('js/desktop-audio.js: the devtasks classifier path regex is missing')
  if (!audioJs.includes("parsed.status === 'done' ? 'fulfill' : 'move'")) problems.push('js/desktop-audio.js: the fulfill-vs-move verdict is missing')
  if (!audioJs.includes('if (parsed.status === prior) return null')) problems.push('js/desktop-audio.js: the same-status plain-edit silence rule is missing (the editor resends status on every save)')
  for (const kept of ['id="db-sync-hero"', 'id="db-sync-emblem"', 'class="db-sync-ring"', 'class="db-sync-orbit"', 'class="db-sync-spark"', 'class="db-sync-packets"',
    'db-sync-glyph-connect', 'db-sync-glyph-upload', 'db-sync-glyph-orbit', 'db-sync-glyph-ok', 'db-sync-glyph-err']) {
    if (!indexHtml.includes(kept)) problems.push('index.html: the sync-modal hero is missing "' + kept + '" (the owner ask: syncing animation with icons)')
  }
  if (!syncJs.includes("getElementById('db-sync-hero')")) problems.push('js/desktop-sync.js: the hero element hook is missing')
  if (!syncJs.includes("setStage('connect')")) problems.push('js/desktop-sync.js: the hero stage reset on a fresh round is missing')
  if (!syncJs.includes("setKind('ok')")) problems.push('js/desktop-sync.js: the hero ok settle is missing')
  if (!syncJs.includes("window.hibanaAudio.play('sync')")) problems.push('js/desktop-sync.js: the sync-complete chime call is missing (cue #5)')
  if (!syncJs.includes("if (payload.state === 'active' && payload.step) setStage(payload.step)")) problems.push('js/desktop-sync.js: the hero live-stage relay is missing')
  if (!loginJs.includes("window.hibanaAudio.play('login')")) problems.push('js/desktop-login.js: the login chime call is missing (cue #1)')
  if (!loginJs.includes('setTimeout(function () { location.reload() }, 700)')) problems.push('js/desktop-login.js: the chime-landing delayed reload is missing (an immediate reload clips the cue to silence)')
  const syncCssFx = fileMap['css/desktop-sync.css'] || ''
  for (const kept of ['.db-sync-hero', '@keyframes db-sync-pulse', '@keyframes db-sync-orbit', '@keyframes db-sync-rise', '@keyframes db-sync-pop', '@keyframes db-sync-panel-in', 'prefers-reduced-motion: reduce']) {
    if (!syncCssFx.includes(kept)) problems.push('css/desktop-sync.css: the hero animation layer is missing "' + kept + '"')
  }

  // The v0.1.14 auto-update round (the owner ask: "Add an auto update for the
  // app. when the new version releases in the github, app syncs with the
  // internet and github, and if new version, whether portable or installer
  // released, show a button for update. it must update from github and
  // replace without losing data or needing user to re login."): the pill must
  // exist HIDDEN right after Refresh (no update = no button), the modal must
  // carry the full anatomy (version line, kind/size, the progress bar, the
  // restarting panel, the panel reuse of the sync grammar), and the
  // controller must subscribe to BOTH Go relays (available + progress),
  // resolve ApplyUpdate at CLICK time, and paint the restarting verdict on
  // ok with NO reload (the Go process restarts the island).
  for (const kept of ['id="db-update-button"', 'class="small db-update-cta"', 'id="db-update-btn-label"', 'id="db-update-dialog"', 'id="db-update-version"',
    'id="db-update-kind"', 'id="db-update-progress"', 'id="db-update-fill"', 'id="db-update-note"', 'id="db-update-panel"', 'id="db-update-later"', 'id="db-update-go"',
    'aria-label="Update Hibana now"', 'id="db-update-fallback"']) {
    if (!indexHtml.includes(kept)) problems.push('index.html: the auto-update round is missing "' + kept + '" (the owner ask: a button for update)')
  }
  if (!indexHtml.includes('id="db-update-button" hidden')) problems.push('index.html: the Update pill must be HIDDEN at boot — no update = no button (the honest default)')
  {
    const refreshIdx2 = indexHtml.indexOf('id="db-refresh-button"')
    const updateIdx2 = indexHtml.indexOf('id="db-update-button"')
    const themeIdx2 = indexHtml.indexOf('id="db-theme-toggle"')
    if (!(refreshIdx2 !== -1 && updateIdx2 > refreshIdx2 && themeIdx2 > updateIdx2)) {
      problems.push('index.html: the Update pill must sit right after Refresh and before the theme toggle — got refresh@' + refreshIdx2 + ', update@' + updateIdx2 + ', theme@' + themeIdx2)
    }
  }
  const updateJs = fileMap['js/desktop-update.js'] || ''
  if (!updateJs.includes("EventsOn('hibana:update-available'")) problems.push('js/desktop-update.js: the hibana:update-available listener is missing (the pill reveals on a newer release)')
  if (!updateJs.includes("EventsOn('hibana:update-progress'")) problems.push('js/desktop-update.js: the hibana:update-progress listener is missing (the live bar)')
  if (!updateJs.includes("resolveBoundMethod('ApplyUpdate')")) problems.push('js/desktop-update.js: the bridge must resolve ApplyUpdate at CLICK time, not at parse time')
  if (!updateJs.includes('btn.hidden = false')) problems.push('js/desktop-update.js: the pill reveal is missing')
  if (!updateJs.includes('if (dlg.open) paintIntro()')) problems.push('js/desktop-update.js: an open modal must repaint with the fresh available facts')
  if (!updateJs.includes('panel.hidden = false')) problems.push('js/desktop-update.js: the restarting verdict panel is missing')
  if (updateJs.includes('location.reload')) problems.push('js/desktop-update.js: NO reload on ok — the Go process restarts the whole island (a reload would race the quit)')
  if (!updateJs.includes('Update now')) problems.push('js/desktop-update.js: the EN label pair is missing')
  if (!updateJs.includes('نسخهٔ جدید')) problems.push('js/desktop-update.js: the FA label pair is missing')
  // The v0.1.19 manual-fallback reflex (the owner ask: "auto-open release page
  // when an apply fails"): the failure branch must pass the resolve's own
  // pageOpened flag to the error paint (never a guess), the fallback line
  // must carry BOTH language pairs, and every fresh round must hide it.
  if (!updateJs.includes('showError(msg, !!(out && out.pageOpened))')) problems.push('js/desktop-update.js: a failed apply must forward the Go resolve\'s pageOpened flag to the error paint (v0.1.19 — the release-page reflex)')
  if (!updateJs.includes('The release page opened in your browser')) problems.push('js/desktop-update.js: the EN manual-fallback line is missing (v0.1.19)')
  if (!updateJs.includes('صفحهٔ انتشار در مرورگر شما باز شد')) problems.push('js/desktop-update.js: the FA manual-fallback line is missing (v0.1.19)')
  if (!updateJs.includes('if (fallEl) fallEl.hidden = true')) problems.push('js/desktop-update.js: every fresh round must hide the fallback note (a stale page-open claim is a lie)')
  const updateCss = fileMap['css/desktop-update.css'] || ''
  for (const kept of ['#db-update-button', '#db-update-button[hidden]', 'background: var(--ok)', 'html[data-theme=', '.db-update-fill', 'prefers-reduced-motion: reduce']) {
    if (!updateCss.includes(kept)) problems.push('css/desktop-update.css: the auto-update style layer is missing "' + kept + '"')
  }
  if (!fs.existsSync(path.join(outDir, 'css/desktop-update.css'))) problems.push('css/desktop-update.css: missing from dist')

  // The v0.1.17 settings round (the owner ask: "Plan for a settings page for
  // hibana's desktop" with four sections: 1. Sync 2. Update app 3.
  // Login/logout 4. fa/en + dark mode/light mode): the gear must exist in the
  // account zone (after the theme toggle, BEFORE Sign out), the wide dialog
  // must carry the owner's four sections in order with the pin's own
  // nav.settings title + nav.signout labels, the controller must resolve
  // SetLanguage / SetTheme / CheckForUpdates / AppInfo / AuthState at USE
  // time, delegate the three proven flows through the toolbar buttons' own
  // handlers (the sheet closing FIRST — the modals never stack), carry the
  // live flip + the delayed reload reflex, and listen for all three relays
  // (hibana:lang / hibana:theme / hibana:update-available); the stylesheet
  // must own the section/row/segment grammar with the aria-pressed state.
  for (const kept of ['id="db-settings-button"', 'data-i18n-aria-label="nav.settings"', 'data-i18n-title="nav.settings"',
    'id="db-settings-dialog"', 'class="dialog dialog-wide"', 'id="db-settings-title"', 'data-i18n="nav.settings"',
    'id="db-settings-sync-heading"', 'id="db-settings-sync-now"',
    'id="db-settings-update-heading"', 'id="db-settings-version"', 'id="db-settings-update-status"', 'id="db-settings-check"',
    'id="db-settings-account-heading"', 'id="db-settings-account"', 'id="db-settings-signout"', 'data-i18n="nav.signout"',
    'id="db-settings-appearance-heading"', 'id="db-settings-lang-seg"', 'data-seg-lang="en"', 'data-seg-lang="fa"',
    'id="db-settings-theme-seg"', 'data-seg-theme="light"', 'data-seg-theme="claude-dark"', 'data-seg-theme="system"',
    'id="db-settings-done"', 'css/desktop-settings.css',
    'id="db-settings-token-input"', 'type="password"', 'id="db-settings-token-save"', 'id="db-settings-token-clear"',
    'id="db-settings-token-test"', 'id="db-settings-token-status"', 'id="db-settings-token-error"']) {
    if (!indexHtml.includes(kept)) problems.push('index.html: the settings round is missing "' + kept + '"')
  }
  {
    // The owner's section ORDER: Sync → Update app → Account → Appearance.
    const syncHeadIdx = indexHtml.indexOf('id="db-settings-sync-heading"')
    const updateHeadIdx = indexHtml.indexOf('id="db-settings-update-heading"')
    const accountHeadIdx = indexHtml.indexOf('id="db-settings-account-heading"')
    const appearanceHeadIdx = indexHtml.indexOf('id="db-settings-appearance-heading"')
    if (!(syncHeadIdx !== -1 && updateHeadIdx > syncHeadIdx && accountHeadIdx > updateHeadIdx && appearanceHeadIdx > accountHeadIdx)) {
      problems.push('index.html: the settings sections must follow the owner\'s order Sync → Update app → Account → Appearance — got sync@' + syncHeadIdx + ', update@' + updateHeadIdx + ', account@' + accountHeadIdx + ', appearance@' + appearanceHeadIdx)
    }
    // The gear sits in the account zone: AFTER the theme toggle, BEFORE Sign out.
    const themeIdx3 = indexHtml.indexOf('id="db-theme-toggle"')
    const gearIdx = indexHtml.indexOf('id="db-settings-button"')
    const logoutIdx3 = indexHtml.indexOf('id="db-logout-button"')
    if (!(themeIdx3 !== -1 && gearIdx > themeIdx3 && logoutIdx3 > gearIdx)) {
      problems.push('index.html: the settings gear must sit after the theme toggle and before Sign out (the account zone) — got theme@' + themeIdx3 + ', gear@' + gearIdx + ', logout@' + logoutIdx3)
    }
    // The settings dialog lands after the update dialog in the body chain.
    const updateDlgIdx = indexHtml.indexOf('id="db-update-dialog"')
    const settingsDlgIdx = indexHtml.indexOf('id="db-settings-dialog"')
    if (!(updateDlgIdx !== -1 && settingsDlgIdx > updateDlgIdx)) {
      problems.push('index.html: the settings dialog must land after the update dialog — got update@' + updateDlgIdx + ', settings@' + settingsDlgIdx)
    }
  }
  const settingsJs = fileMap['js/desktop-settings.js'] || ''
  if (!settingsJs.includes("resolveBoundMethod('SetLanguage')")) problems.push("js/desktop-settings.js: the language segmented control must resolve the Go SetLanguage binding at CLICK time (the round's one new capability)")
  if (!settingsJs.includes("resolveBoundMethod('SetTheme')")) problems.push('js/desktop-settings.js: the theme segmented control must resolve the Go SetTheme binding at CLICK time')
  if (!settingsJs.includes("resolveBoundMethod('CheckForUpdates')")) problems.push('js/desktop-settings.js: the manual check must resolve the Go CheckForUpdates binding at CLICK time')
  if (!settingsJs.includes("resolveBoundMethod('AppInfo')")) problems.push('js/desktop-settings.js: the version line must resolve the Go AppInfo binding at OPEN time')
  if (!settingsJs.includes("resolveBoundMethod('AuthState')")) problems.push('js/desktop-settings.js: the account line must resolve the Go AuthState binding at OPEN time')
  if (!settingsJs.includes("resolveBoundMethod('SetGithubToken')")) problems.push("js/desktop-settings.js: the GitHub-access row must resolve the Go SetGithubToken binding at CLICK time (v0.1.18 — the owner's credentials ask)")
  if (!settingsJs.includes("resolveBoundMethod('GithubTokenState')")) problems.push('js/desktop-settings.js: the GitHub-access row must resolve the Go GithubTokenState binding at OPEN time')
  if (!settingsJs.includes("resolveBoundMethod('TestGithubConnection')")) problems.push("js/desktop-settings.js: the GitHub-access row must resolve the Go TestGithubConnection binding at CLICK time (v0.1.19 — the owner's test-connection ask)")
  if (!settingsJs.includes("test(value)")) problems.push('js/desktop-settings.js: the Test round must send the FIELD\'s value (empty = the stored-or-anonymous round Go-side decides)')
  if (!settingsJs.includes('els.tokenTest.disabled = on')) problems.push('js/desktop-settings.js: the busy guard must cover the Test button (a round in flight refuses a second test)')
  if (!settingsJs.includes('the repository is public — no token needed')) problems.push("js/desktop-settings.js: the EN anonymous-test verdict line is missing (the row must say the tokenless round WORKS)")
  if (!settingsJs.includes('نیازی به توکن نیست')) problems.push('js/desktop-settings.js: the FA anonymous-test verdict line is missing')
  if (!settingsJs.includes("GitHub can't see the repository without credentials")) problems.push("js/desktop-settings.js: the EN private-repo signal line is missing (the anonymous 404 — the owner's exact scenario)")
  if (!settingsJs.includes('بدون اعتبارنامه مخزن را نمی‌بیند')) problems.push('js/desktop-settings.js: the FA private-repo signal line is missing')
  if (!settingsJs.includes("save('')")) problems.push("js/desktop-settings.js: Remove must ride SetGithubToken('') — the Go binding's explicit-clear contract")
  if (!settingsJs.includes('els.check.click()')) problems.push('js/desktop-settings.js: a SAVED token must immediately re-check (the connect-now reflex — the row\'s whole point)')
  if (!settingsJs.includes("ev.key === 'Enter'")) problems.push('js/desktop-settings.js: Enter in the token field must SAVE, never submit the method=dialog form (the sheet would close mid-save)')
  if (!settingsJs.includes("delegate('db-sync-button')")) problems.push("js/desktop-settings.js: the Sync-now row must delegate to the proven #db-sync-button flow")
  if (!settingsJs.includes("delegate('db-update-button')")) problems.push("js/desktop-settings.js: the Update-now row must delegate to the proven #db-update-button flow")
  if (!settingsJs.includes("delegate('db-logout-button')")) problems.push("js/desktop-settings.js: the Sign-out row must delegate to the proven #db-logout-button flow")
  if (!settingsJs.includes('if (dlg.open) dlg.close()')) problems.push('js/desktop-settings.js: the delegation must close the sheet FIRST so the modals never stack (the plan §7 answer)')
  if (!settingsJs.includes('window.hibanaI18n.apply()')) problems.push('js/desktop-settings.js: the live flip must call hibanaI18n.apply() (the plan §2.3 — the chrome flips before the reload)')
  if (!settingsJs.includes('setTimeout(function () { location.reload() }, 700)')) problems.push('js/desktop-settings.js: the ~700ms reload reflex is missing (i18n.js\'s dynamic-markup law — a live-only flip leaves the board behind)')
  if (!settingsJs.includes("EventsOn('hibana:lang'")) problems.push("js/desktop-settings.js: the hibana:lang listener is missing (the tray/sheet agreement)")
  if (!settingsJs.includes("EventsOn('hibana:theme'")) problems.push("js/desktop-settings.js: the hibana:theme listener is missing (the tray/sheet agreement)")
  if (!settingsJs.includes("EventsOn('hibana:update-available'")) problems.push('js/desktop-settings.js: the hibana:update-available listener is missing (the idle-time verdict surface)')
  if (!settingsJs.includes("getAttribute('data-desktop-lang')")) problems.push('js/desktop-settings.js: the language segmented control must read the serve-time data-desktop-lang stamp')
  if (!settingsJs.includes("getAttribute('data-desktop-theme')")) problems.push('js/desktop-settings.js: the theme segmented control must read the serve-time data-desktop-theme attr')
  if (!settingsJs.includes("PIN_PACKAGE_VERSION = '" + PIN_PACKAGE_VERSION + "'")) problems.push('js/desktop-settings.js: the version line must carry the sealed pin package version ' + PIN_PACKAGE_VERSION)
  if (!settingsJs.includes("Couldn't reach hibana.ir — the language is unchanged.")) problems.push("js/desktop-settings.js: the EN offline-language honesty line is missing")
  if (!settingsJs.includes('زبان تغییر نکرد')) problems.push('js/desktop-settings.js: the FA offline-language honesty line is missing')
  if (!settingsJs.includes("You're on the latest version.")) problems.push("js/desktop-settings.js: the EN latest-version line is missing")
  if (!settingsJs.includes('آخرین نسخه')) problems.push('js/desktop-settings.js: the FA latest-version line is missing')
  if (!settingsJs.includes('anonymous GitHub access (fine for public repos)')) problems.push("js/desktop-settings.js: the EN no-token honesty line is missing (the anonymous default is a FACT the row must state)")
  if (!settingsJs.includes('دسترسی ناشناس به گیت‌هاب')) problems.push('js/desktop-settings.js: the FA no-token honesty line is missing')
  if (!settingsJs.includes('GitHub rejected the token — nothing was saved.')) problems.push('js/desktop-settings.js: the EN token-rejected honesty line is missing')
  if (!settingsJs.includes('گیت‌هاب این توکن را نپذیرفت')) problems.push('js/desktop-settings.js: the FA token-rejected honesty line is missing')
  const settingsCss = fileMap['css/desktop-settings.css'] || ''
  for (const kept of ['#db-settings-button', '#db-settings-dialog', '.db-settings-section', '.db-settings-row', '.db-settings-seg', "[aria-pressed='true']", 'prefers-reduced-motion: reduce', '#db-settings-token-input', '.db-settings-token']) {
    if (!settingsCss.includes(kept)) problems.push('css/desktop-settings.css: the settings style layer is missing "' + kept + '"')
  }
  if (!fs.existsSync(path.join(outDir, 'css/desktop-settings.css'))) problems.push('css/desktop-settings.css: missing from dist')
  if (!fs.existsSync(path.join(outDir, 'js/desktop-settings.js'))) problems.push('js/desktop-settings.js: missing from dist')

  // NO storage anywhere in the desktop-owned generated files (v0.1.5's rule: the
  // persisted mirror-meta pref is Go-side; the island never forks it). The bare WORD
  // may appear in comments (desktop-theme.js's header says "NO localStorage:"), so
  // the gate greps for USAGE — a member/index access on the store.
  for (const rel of ['js/desktop-shim.js', 'js/desktop-audio.js', 'js/desktop-login.js', 'js/desktop-theme.js', 'js/desktop-sync.js', 'js/desktop-logout.js', 'js/desktop-newproject.js', 'js/desktop-refresh.js', 'js/desktop-update.js', 'js/desktop-settings.js', 'css/desktop-login.css', 'css/desktop-sync.css', 'css/desktop-logout.css', 'css/desktop-newproject.css', 'css/desktop-refresh.css', 'css/desktop-update.css', 'css/desktop-settings.css', 'index.html']) {
    if (/\blocalStorage\s*[.[]/.test(fileMap[rel] || '')) problems.push(rel + ': localStorage usage — the island must never touch storage (the Go mirror owns persistence)')
  }

  // CSS url()/@import refs that are DEFINED in kept sheets but NEVER APPLIED on the
  // board surface at the pin (verified @ e6661c8): a browser only fetches a url()
  // when a RENDERED element applies it, so these cannot 404 in the embedded server.
  // They are NOT copied (the task rule: assets are copied only if referenced by the
  // kept MARKUP; guide §3.1's verified manifest excludes them). Anything missing that
  // is NOT in this documented map fails the sync below.
  const KNOWN_UNUSED_CSS_ASSETS = {
    '/logo-light.png':
      '--brand-logo/--inline-logo tokens (variables.css:494-495, themes.css:54-55, claude-dark-theme.css:206-207) are consumed only by .brand-logo (layout.css:33 — the STRIPPED topbar chrome) and .auth-logo-inline content property (the mobile inline brand the ≥1100px desktop window never shows); the gate photo panel brand resolves via the markup src (/logo-dark.png), never the url() tokens',
  }

  // (3) no 404s in the embedded server: every local href/src in index.html, every
  // @import (the CSS load graph) and every @font-face src (fonts ARE applied — the
  // text stack) must resolve to a file under dist. Lazy files (i18n-fa.js,
  // image-resize.js) are asserted present too.
  const refRe = /(?:href|src)="([^"]+)"/g
  while ((m = refRe.exec(indexHtml)) !== null) {
    const ref = m[1]
    if (/^(https?:)?\/\//.test(ref) || ref.startsWith('data:')) continue
    const clean = ref.replace(/[?#].*$/, '')
    if (clean === '' || clean === '/') continue
    if (!fs.existsSync(path.join(outDir, clean))) problems.push('index.html references missing dist file: ' + clean)
  }
  const extractUrl = (frag) => frag.replace(/^url\(\s*['"]?/, '').replace(/['"]?\s*\)$/, '')
  for (const cssRel of [...CSS_SHEETS, ...FONT_CSS]) {
    const cssPath = path.join(outDir, cssRel)
    const cssDir = path.dirname(cssPath)
    const css = fs.readFileSync(cssPath, 'utf8')
    // Strip data: URIs FIRST — their payloads can contain nested url(...) (base.css:211's
    // inline SVG feTurbulence filter carries filter='url(%23n)' inside the data string).
    const sansData = css
      .replace(/url\(\s*(['"])data:[\s\S]*?\1\s*\)/g, 'url()')
      .replace(/url\(\s*data:[^)]*\)/g, 'url()')
    // Strict set: @font-face srcs (applied — the board renders text in these faces) +
    // @imports (the CSS load graph itself).
    const strictRefs = new Set()
    for (const block of sansData.match(/@font-face\s*\{[^}]*\}/g) || []) {
      for (const u of block.match(/url\(\s*['"]?[^'")]+['"]?\s*\)/g) || []) strictRefs.add(extractUrl(u))
    }
    for (const imp of sansData.match(/@import[^;]*url\(\s*['"]?[^'")]+['"]?\s*\)/g) || []) {
      strictRefs.add(extractUrl(imp.slice(imp.indexOf('url('))))
    }
    const allRefs = new Set()
    for (const u of sansData.match(/url\(\s*['"]?[^'")]+['"]?\s*\)/g) || []) allRefs.add(extractUrl(u))
    for (const ref of allRefs) {
      if (/^(https?:)?\/\//.test(ref) || ref.startsWith('data:')) continue
      const abs = ref.startsWith('/') ? path.join(outDir, ref) : path.resolve(cssDir, ref)
      if (fs.existsSync(abs)) continue
      if (strictRefs.has(ref)) {
        problems.push(cssRel + ' references missing APPLIED asset (font/@import): ' + ref)
      } else if (!(ref in KNOWN_UNUSED_CSS_ASSETS)) {
        problems.push(cssRel + ' references missing dist file: ' + ref)
      }
    }
  }
  for (const lazy of ['js/i18n-fa.js', 'js/image-resize.js']) {
    if (!fs.existsSync(path.join(outDir, lazy))) problems.push('lazy island asset missing from dist: ' + lazy)
  }

  // (4) the JS is parseable — node --check the shim + audio + login + theme + sync +
  // logout + newproject + refresh + update + settings controllers + every copied .js (belt +
  // braces over the patch step; a mangled patch must never ship). The CSS
  // sheets get the existence check above.
  for (const js of ['js/desktop-shim.js', 'js/desktop-audio.js', 'js/desktop-login.js', 'js/desktop-theme.js', 'js/desktop-sync.js', 'js/desktop-logout.js', 'js/desktop-newproject.js', 'js/desktop-refresh.js', 'js/desktop-update.js', 'js/desktop-settings.js', ...JS_FILES]) {
    try {
      execFileSync(process.execPath, ['--check', path.join(outDir, js)], { stdio: 'pipe' })
    } catch (err) {
      problems.push('node --check failed on ' + js + ': ' + String(err.stderr || err.message))
    }
  }

  if (problems.length) {
    fail('self-verification failed (' + problems.length + ' problem' + (problems.length === 1 ? '' : 's') + '):\n  - ' + problems.join('\n  - '))
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { ref: PIN_REF, src: '/home/z/hibana-source', out: 'frontend/dist', check: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--ref') args.ref = argv[++i]
    else if (a === '--src') args.src = argv[++i]
    else if (a === '--out') args.out = argv[++i]
    else if (a === '--check') args.check = true
    else if (a === '--help' || a === '-h') {
      process.stdout.write('usage: node scripts/sync-island.mjs --ref ' + PIN_REF + ' [--src /home/z/hibana-source] [--out frontend/dist] [--check]\n')
      process.exit(0)
    } else fail('unknown argument: ' + a)
  }
  if (args.ref !== PIN_REF) {
    fail('--ref ' + args.ref + ' != the sealed pin ' + PIN_REF + '. The island is a PINNED SNAPSHOT (guide §3): bump PIN_REF + PIN_PACKAGE_VERSION in sync-island.mjs (and re-record any drifted ops/patches) to move the island — never sync an unpinned ref.')
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const src = path.resolve(args.src)
  const outDir = path.isAbsolute(args.out) ? args.out : path.resolve(REPO_ROOT, args.out)
  const checksPath = path.resolve(outDir, '..', 'island.checksums.json')

  // ---- check mode: recompute + diff, never re-copy (guide §3.3.2) ----
  if (args.check) {
    if (!fs.existsSync(outDir)) fail('--check: out dir ' + outDir + ' does not exist — run the sync first.')
    if (!fs.existsSync(checksPath)) fail('--check: ' + checksPath + ' is missing — run the sync first.')
    let recorded
    try {
      recorded = JSON.parse(fs.readFileSync(checksPath, 'utf8'))
    } catch (err) {
      fail('--check: could not parse ' + checksPath + ': ' + err.message)
    }
    const current = hashDist(outDir)
    const diffs = []
    for (const key of Object.keys(recorded)) {
      if (!(key in current)) diffs.push('MISSING   ' + key)
      else if (recorded[key] !== current[key]) diffs.push('CHANGED   ' + key)
    }
    for (const key of Object.keys(current)) {
      if (!(key in recorded)) diffs.push('EXTRA     ' + key)
    }
    if (diffs.length) {
      process.stderr.write('[sync-island] DRIFT DETECTED — dist no longer matches island.checksums.json (' + diffs.length + ' entr' + (diffs.length === 1 ? 'y' : 'ies') + '):\n')
      for (const d of diffs.sort()) process.stderr.write('  ' + d + '\n')
      process.stderr.write('[sync-island] dist is generated output — never hand-fix it. Re-run the sync (and re-record drifted ops if the web ref moved).\n')
      process.exit(1)
    }
    process.stdout.write('[sync-island] --check OK: ' + Object.keys(current).length + ' files under ' + path.relative(REPO_ROOT, outDir) +
      ' are byte-identical to island.checksums.json (pin ' + PIN_REF + ' @ v' + PIN_PACKAGE_VERSION + ').\n')
    process.exit(0)
  }

  // ---- sync mode ----
  verifyRef(src, PIN_REF)
  process.stdout.write('[sync-island] syncing island from ' + src + ' @ ' + PIN_REF + ' (v' + PIN_PACKAGE_VERSION + ') -> ' + outDir + '\n')

  // Read every manifest file content-addressed from the pin.
  const blobs = {} // rel -> Buffer (verbatim copies)
  for (const rel of COPY_MANIFEST) blobs[rel] = gitShow(src, PIN_REF, rel)
  const boardHtmlRaw = gitShow(src, PIN_REF, 'board.html')

  // Patchable files as utf8 strings (the patches are exact recorded replaces).
  const fileMap = {}
  for (const rel of ['js/devboard.js', 'js/board-page.js']) fileMap[rel] = blobs[rel].toString('utf8')

  // The HTML adaptation (guide §3.2).
  const adapted = adaptBoardHtml(boardHtmlRaw.toString('utf8'))
  fileMap['index.html'] = adapted.html

  // The seam patches (guide §4.1/§4.2) — copies only, never the source.
  const patchLog = applySeamPatches(fileMap)

  // The generated desktop-owned files: the transport shim (guide §4.3), the login
  // gate pair (guide §5.5), the theme controller (v0.1.5 — S216), the sync pair
  // (v0.1.6 — S217), and the sound engine (v0.1.13 — the owner's five-cue ask).
  fileMap['js/desktop-shim.js'] = DESKTOP_SHIM_JS
  fileMap['js/desktop-audio.js'] = DESKTOP_AUDIO_JS
  fileMap['js/desktop-login.js'] = DESKTOP_LOGIN_JS
  fileMap['css/desktop-login.css'] = DESKTOP_LOGIN_CSS
  fileMap['js/desktop-theme.js'] = DESKTOP_THEME_JS
  fileMap['js/desktop-sync.js'] = DESKTOP_SYNC_JS
  fileMap['css/desktop-sync.css'] = DESKTOP_SYNC_CSS
  fileMap['js/desktop-logout.js'] = DESKTOP_LOGOUT_JS
  fileMap['css/desktop-logout.css'] = DESKTOP_LOGOUT_CSS
  fileMap['js/desktop-newproject.js'] = DESKTOP_NEWPROJECT_JS
  fileMap['css/desktop-newproject.css'] = DESKTOP_NEWPROJECT_CSS
  fileMap['js/desktop-refresh.js'] = DESKTOP_REFRESH_JS
  fileMap['css/desktop-refresh.css'] = DESKTOP_REFRESH_CSS
  fileMap['js/desktop-update.js'] = DESKTOP_UPDATE_JS
  fileMap['css/desktop-update.css'] = DESKTOP_UPDATE_CSS
  fileMap['js/desktop-settings.js'] = DESKTOP_SETTINGS_JS
  fileMap['css/desktop-settings.css'] = DESKTOP_SETTINGS_CSS
  fileMap['icon.svg'] = ICON_SVG

  // Wipe + regenerate dist (deterministic + idempotent: running twice is byte-identical;
  // stale files can never linger into the checksums).
  fs.rmSync(outDir, { recursive: true, force: true })
  for (const rel of COPY_MANIFEST) {
    const dest = path.join(outDir, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, blobs[rel])
  }
  for (const rel of Object.keys(fileMap)) {
    const dest = path.join(outDir, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, fileMap[rel], 'utf8')
  }
  // The sealed pin (guide §3.3.1).
  fs.writeFileSync(path.join(outDir, 'web-ref.json'),
    JSON.stringify({ ref: PIN_REF, packageVersion: PIN_PACKAGE_VERSION }, null, 2) + '\n', 'utf8')

  // Self-verify BEFORE writing checksums (a broken run must not stamp a green file).
  verifyDist(outDir, fileMap)

  // Checksums (guide §3.3.2) — outside dist, sorted, stable.
  const hashes = hashDist(outDir)
  fs.writeFileSync(checksPath, JSON.stringify(hashes, null, 2) + '\n', 'utf8')

  // Report.
  for (const line of adapted.log) process.stdout.write('  ' + line + '\n')
  for (const line of patchLog) process.stdout.write('  ' + line + '\n')
  process.stdout.write('  copied   : ' + COPY_MANIFEST.length + ' manifest files (verbatim) + index.html + js/desktop-shim.js + js/desktop-audio.js + js/desktop-login.js + css/desktop-login.css + js/desktop-theme.js + js/desktop-sync.js + css/desktop-sync.css + js/desktop-logout.js + css/desktop-logout.css + js/desktop-newproject.js + css/desktop-newproject.css + js/desktop-refresh.js + css/desktop-refresh.css + js/desktop-update.js + css/desktop-update.css + js/desktop-settings.js + css/desktop-settings.css + icon.svg + web-ref.json\n')
  process.stdout.write('  verified : seam counts, CSS manifest order (rtl.css last), theme → shim → audio → login → sync → logout → newproject → refresh → update → settings → devboard → board-page, the login gate markup + hooks, the theme + sync + sign-out + new-project + refresh + sound + update + settings rounds (both toggle surfaces, the modal ids, click-time SetTheme/SyncNow/Logout/ApplyUpdate/SetLanguage/CheckForUpdates/SetGithubToken, the step relay, the will-not-vanish copy, the login-card reload, the planning-status create through the shim seam, the deep-link boot, the MutationObserver row, the dead-link interception, the Refresh pill + its reload, the pulled-boards reflex on the sync modal, the hero stage wiring + the five synthesized cues + the seam observer, the hidden Update pill + its two event relays + the live bar + the restarting panel, the settings gear in the account zone + the owner\'s four-section order + the three delegation flows + the segmented controls + the live flip + the reload reflex + the three event relays + the v0.1.18 GitHub-access row (password field, Save/Remove/Enter-to-save, the connect-now re-check, both honesty lines) + the v0.1.19 test-connection button (TestGithubConnection, the typed/saved/anonymous verdict lines, the private-repo signal) + the apply-failure release-page note (#db-update-fallback, the pageOpened flag, both language pairs), no-storage), no-404 asset loop, node --check\n')
  process.stdout.write('  checksums: ' + Object.keys(hashes).length + ' files -> ' + path.relative(REPO_ROOT, checksPath) + '\n')
  process.stdout.write('[sync-island] DONE. Island pinned at ' + PIN_REF + ' @ v' + PIN_PACKAGE_VERSION + '.\n')
}

main()
