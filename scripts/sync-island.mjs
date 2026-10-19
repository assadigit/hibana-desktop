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
//      its proof modal), and icon.svg.
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
const PIN_REF = 'e6661c8'
const PIN_PACKAGE_VERSION = '0.4.1.35'

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
// /js/i18n-fa.js?v=94 on FA; devboard.js:307-319 injects /js/image-resize.js?v=1 on
// first editor open) — the embedded asset server serves those exact paths.
const JS_FILES = [
  'js/devboard.js',        // v28 — the data + editor modal; PATCHED (§4.2: 1 choke point + 5 labels + 2 XHR)
  'js/chip-render.js',     // v12 — the markdown-lite title renderer (byte-parity target, UI-UX §3.3)
  'js/board-page.js',      // v21 — the /kanban page; PATCHED (§4.2: 4 direct fetches)
  'js/i18n-en.js',         // v100 — the EN dictionary (loaded before i18n.js; defer order)
  'js/i18n.js',            // v154 — the i18n layer; NOTE: kept VERBATIM (see KNOWN-REMAINS below)
  'js/i18n-fa.js',         // v94 — the LAZY FA dictionary (i18n.js:49-60)
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
//  2. i18n.js:49-60 (dynamic <script> /js/i18n-fa.js?v=94) and devboard.js:307-319
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
  anchor: '<script src="/js/devboard.js?v=28" defer></script>',
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
    anchor: `    <script src="/js/chip-render.js?v=12" defer></script>`,
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
    name: 'insert the #db-sync-button toolbar button right after the theme toggle',
    cite: 'v0.1.6 (S217); a ghost icon button — the refresh-cw glyph',
    anchor: `      <button type="button" class="btn ghost small" id="db-theme-toggle" data-theme-toggle aria-label="Toggle theme" data-i18n-aria-label="nav.themeHint"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg></button>`,
    insert: `      <!-- v0.1.6 (the owner ask: the physical, visible sync button): the manual sync
           trigger — a ghost icon button opening the sync modal, which proves the
           round live (connecting to the Cloudflare server > upload > sync, then the
           success panel) so the user is 100% sure the boards are synced and will
           not vanish. js/desktop-sync.js owns the flow through the Go SyncNow
           binding; the aria-label is desktop-localized (no pin i18n key exists). -->
      <button type="button" class="btn ghost small" id="db-sync-button" aria-label="Sync now" title="Sync now"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/></svg></button>`,
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
  // The v0.1.5 theme round + the v0.1.6 sync round (recorded above, per-round, in
  // the order the head/body chain requires — each op's anchor must already exist
  // when the op runs: the theme script rides the PINNED chip-render line, the
  // floater rides the gate block HTML_GATE_INSERT just emitted, the toolbar toggle
  // rides the PINNED labels line, the sync sheet/script ride the desktop login
  // lines emitted above, the dialog rides the PINNED skip-link, and the sync
  // button rides the toggle line the theme round just inserted).
  for (const op of [...HTML_THEME_OPS, ...HTML_SYNC_OPS]) {
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
//      §5.4; implemented in M4 — until the Upload bridge exists, send() fails fast
//      and LOUD with a named not-implemented error instead of a silent hang.
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
  // responseText, readyState. The Go streaming upload is spec'd in guide §5.4;
  // implemented in M4. Until the Upload bridge exists, send() fires onerror
  // (async, like a real XHR) with a clearly-NAMED not-implemented error so the
  // uploader's progress rows show a real failure instead of a silent hang.
  function HibanaXHR() {
    this.readyState = 0
    this.status = 0
    this.responseText = ''
    this.onreadystatechange = null
    this.onload = null
    this.onerror = null
    this.onabort = null
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
  HibanaXHR.prototype.abort = function () {
    if (this._aborted) return
    this._aborted = true
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
      // M4 not here yet (guide §5.4). Fire onerror asynchronously, like a real XHR —
      // devboard.js assigns its handlers BEFORE send() but real XHR events are tasks.
      queueMicrotask(function () {
        self.readyState = 4
        self.status = 0
        const err = new Error('hibanaXHR: the streaming upload bridge (window.gohibana.api.Upload — guide §5.4) is not implemented until M4; the desktop board cannot upload attachments yet.')
        err.name = 'NotImplementedUntilM4'
        self._error = err
        if (typeof self.onerror === 'function') { try { self.onerror({ type: 'error', error: err }) } catch (e) { /* ditto */ } }
        if (typeof self.onreadystatechange === 'function') { try { self.onreadystatechange() } catch (e) { /* ditto */ } }
      })
      return
    }
    // M4 path (guide §5.4): upload(method, url, body, headers) → { status, body }.
    // Progress events need the streaming contract M4 will define — extended there.
    Promise.resolve()
      .then(function () { return bridge(self._method || 'POST', self._url, body, self._headers) })
      .then(function (res) {
        if (self._aborted) return
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
          busy(false)
          if (res && res.ok) {
            // Reload with the live session: the Go shell now serves this
            // document with data-desktop-authed="true", the card never
            // appears, and the island boots straight into the boards.
            location.reload()
            return
          }
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
      title: 'Sync with Hibana cloud',
      connect: 'Connecting to Cloudflare server',
      upload: 'Uploading changes',
      sync: 'Syncing boards',
      okTitle: 'Everything synced',
      okBody: 'Your boards are saved on the Hibana cloud — they will not vanish.',
      uploaded: '{u} change(s) uploaded',
      noneWaiting: 'no changes were waiting — every edit saves live',
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
      title: 'همگام‌سازی با ابر هیبانا',
      connect: 'اتصال به سرور Cloudflare',
      upload: 'بارگذاری تغییرات',
      sync: 'همگام‌سازی تخته‌ها',
      okTitle: 'همه‌چیز همگام شد',
      okBody: 'تخته‌های شما در ابر هیبانا ذخیره شده‌اند — از بین نمی‌روند.',
      uploaded: '{u} تغییر بارگذاری شد',
      noneWaiting: 'تغییر منتظری نبود — هر ویرایش زنده ذخیره می‌شود',
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
    var panel = document.getElementById('db-sync-panel')
    var panelIcon = panel ? panel.querySelector('.icon') : null
    var panelTitle = document.getElementById('db-sync-panel-title')
    var panelBody = document.getElementById('db-sync-panel-body')
    var closeBtn = document.getElementById('db-sync-close')
    var retryBtn = document.getElementById('db-sync-retry')
    var doneBtn = document.getElementById('db-sync-done')
    var syncing = false

    function setText(id, text) { var el = document.getElementById(id); if (el) el.textContent = text }

    function localize() {
      btn.setAttribute('aria-label', t('btn'))
      btn.setAttribute('title', t('btn'))
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
        showPanel('ok', t('okTitle'), t('okBody') + ' ' + note + ' · ' + counts + ' · ' + when, false)
        return
      }
      if (out.code === 'busy') { showPanel('err', t('busyTitle'), '', false); return }
      if (out.code === 'session') { showPanel('err', t('sessionTitle'), '', false); return }
      if (out.code === 'unreachable') { showPanel('err', t('unreachableTitle'), '', true); return }
      if (out.code === 'pending') { showPanel('warn', t('warnTitle'), out.message || '', true); return }
      showPanel('err', t('errTitle'), out.message || '', true)
    }

    function onReject() {
      syncing = false
      showPanel('err', t('errTitle'), t('notWired'), false)
    }

    function run() {
      syncing = true
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
      })
    }

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
const DESKTOP_SYNC_CSS = `/* desktop-sync.css — the manual sync modal's step rows + result panels (v0.1.6).
   GENERATED FILE — do not hand-edit (guide §3.3.4): emitted by scripts/sync-island.mjs
   into frontend/dist/css/ and checksummed in frontend/island.checksums.json.
   The dialog + .modal card are the island's own (components.css) — this sheet
   starts INSIDE the card. */

/* The three step rows: pending (muted ring) → active (the accent ring spins)
   → done (the green check) / failed (the red cross). */
.db-sync-steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.8rem;
}
.db-sync-steps li {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  color: var(--muted);
  font-size: var(--fs-md);
  transition: color 0.18s ease;
}
.db-sync-steps li .db-sync-label { flex: 1 1 auto; }
.db-sync-steps li[data-state='active'] { color: var(--fg); }
.db-sync-steps li[data-state='done'] { color: var(--fg); }
.db-sync-steps li[data-state='failed'] { color: var(--err); }

.db-sync-mark {
  flex: none;
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

/* The live fact under a step ("hibana.ir reached", "3 change(s) uploaded"…). */
.db-sync-note {
  flex: none;
  font-size: 0.82em;
  color: var(--muted);
  max-inline-size: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
`

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
  // head link block — the gate sheet (guide §5.5) then the sync modal's sheet
  // (v0.1.6); the island's 19-sheet order + rtl-last are untouched around them.
  const expectedLinks = [...CSS_SHEETS.map((p) => '/' + p), '/vendor/manrope/font-face.css', '/css/desktop-login.css', '/css/desktop-sync.css']
  if (JSON.stringify(links) !== JSON.stringify(expectedLinks)) {
    problems.push('index.html CSS manifest mismatch:\n    expected: ' + JSON.stringify(expectedLinks) + '\n    actual:   ' + JSON.stringify(links))
  }
  if (links[CSS_SHEETS.length - 1] !== '/css/rtl.css') problems.push('index.html: rtl.css is not the last ISLAND /css/ sheet (the desktop-owned sheets follow it)')
  // The blocking head chain (v0.1.5 + v0.1.6 grew it): the pre-paint theme bootstrap
  // FIRST, then the transport shim, the login controller, the sync controller — all
  // blocking, so they own their contracts before every deferred island script.
  const themeIdx = indexHtml.indexOf('/js/desktop-theme.js')
  const shimIdx = indexHtml.indexOf('/js/desktop-shim.js')
  const loginIdx = indexHtml.indexOf('/js/desktop-login.js')
  const syncIdx = indexHtml.indexOf('/js/desktop-sync.js')
  const devIdx = indexHtml.indexOf('/js/devboard.js')
  const bpIdx = indexHtml.indexOf('/js/board-page.js')
  if (!(themeIdx !== -1 && shimIdx !== -1 && loginIdx !== -1 && syncIdx !== -1 && devIdx !== -1 && bpIdx !== -1 &&
      themeIdx < shimIdx && shimIdx < loginIdx && loginIdx < syncIdx && syncIdx < devIdx && devIdx < bpIdx)) {
    problems.push('index.html: desktop-theme.js → desktop-shim.js → desktop-login.js → desktop-sync.js → devboard.js → board-page.js order broken (got indices ' + themeIdx + '/' + shimIdx + '/' + loginIdx + '/' + syncIdx + '/' + devIdx + '/' + bpIdx + ')')
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

  // The v0.1.6 sync round (S217 — the physical, visible sync button ask): the modal
  // ids must exist, the controller must resolve the Go SyncNow binding at CLICK time
  // and relay the hibana:sync-progress events, and the "will not vanish" success copy
  // must ship in BOTH languages.
  for (const kept of ['id="db-sync-button"', 'id="db-sync-dialog"', 'id="db-sync-steps"', 'id="db-sync-panel"', 'aria-label="Sync now"']) {
    if (!indexHtml.includes(kept)) problems.push('index.html: the sync round is missing "' + kept + '"')
  }
  const syncJs = fileMap['js/desktop-sync.js'] || ''
  if (!syncJs.includes("resolveBoundMethod('SyncNow')")) problems.push('js/desktop-sync.js: the button must resolve the Go SyncNow binding at CLICK time (the v0.1.1 parse-time snapshot lesson)')
  if (!syncJs.includes("EventsOn('hibana:sync-progress'")) problems.push('js/desktop-sync.js: the hibana:sync-progress step relay listener is missing')
  if (!syncJs.includes('they will not vanish.')) problems.push('js/desktop-sync.js: the EN "will not vanish" success copy is missing')
  if (!syncJs.includes('از بین نمی')) problems.push('js/desktop-sync.js: the FA "will not vanish" success copy is missing')
  if (!fs.existsSync(path.join(outDir, 'css/desktop-sync.css'))) problems.push('css/desktop-sync.css: missing from dist')

  // NO storage anywhere in the desktop-owned generated files (v0.1.5's rule: the
  // persisted mirror-meta pref is Go-side; the island never forks it). The bare WORD
  // may appear in comments (desktop-theme.js's header says "NO localStorage:"), so
  // the gate greps for USAGE — a member/index access on the store.
  for (const rel of ['js/desktop-shim.js', 'js/desktop-login.js', 'js/desktop-theme.js', 'js/desktop-sync.js', 'css/desktop-login.css', 'css/desktop-sync.css', 'index.html']) {
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

  // (4) the JS is parseable — node --check the shim + login + theme + sync
  // controllers + every copied .js (belt + braces over the patch step; a mangled
  // patch must never ship). The CSS sheets get the existence check above.
  for (const js of ['js/desktop-shim.js', 'js/desktop-login.js', 'js/desktop-theme.js', 'js/desktop-sync.js', ...JS_FILES]) {
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
  // gate pair (guide §5.5), the theme controller (v0.1.5 — S216) + the sync pair
  // (v0.1.6 — S217).
  fileMap['js/desktop-shim.js'] = DESKTOP_SHIM_JS
  fileMap['js/desktop-login.js'] = DESKTOP_LOGIN_JS
  fileMap['css/desktop-login.css'] = DESKTOP_LOGIN_CSS
  fileMap['js/desktop-theme.js'] = DESKTOP_THEME_JS
  fileMap['js/desktop-sync.js'] = DESKTOP_SYNC_JS
  fileMap['css/desktop-sync.css'] = DESKTOP_SYNC_CSS
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
  process.stdout.write('  copied   : ' + COPY_MANIFEST.length + ' manifest files (verbatim) + index.html + js/desktop-shim.js + js/desktop-login.js + css/desktop-login.css + js/desktop-theme.js + js/desktop-sync.js + css/desktop-sync.css + icon.svg + web-ref.json\n')
  process.stdout.write('  verified : seam counts, CSS manifest order (rtl.css last), theme → shim → login → sync → devboard → board-page, the login gate markup + hooks, the theme + sync rounds (both toggle surfaces, the modal ids, click-time SetTheme/SyncNow, the step relay, the will-not-vanish copy, no-storage), no-404 asset loop, node --check\n')
  process.stdout.write('  checksums: ' + Object.keys(hashes).length + ' files -> ' + path.relative(REPO_ROOT, checksPath) + '\n')
  process.stdout.write('[sync-island] DONE. Island pinned at ' + PIN_REF + ' @ v' + PIN_PACKAGE_VERSION + '.\n')
}

main()
