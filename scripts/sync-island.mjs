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
//   5. Generates js/desktop-shim.js (guide §4.3 — the only NEW island file).
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

// Favicon/logo: NONE — board.html@e6661c8 references no favicon/logo in the kept
// markup (verified: the only <svg> is the inline switch chevron), so none is copied.

const COPY_MANIFEST = [...CSS_SHEETS, ...FONT_CSS, ...FONT_FILES, ...JS_FILES]

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
// by boot.js before first paint on the web; the desktop shell owns theme natively per
// UI-UX-REPLICATION-SPEC §7.2 + guide §5.6, so NO theme inline script is added here).
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

// The one INSERT: the seam shim loads BEFORE devboard.js/board-page.js (guide §3.2
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
// desktop-shim.js — generated below into dist/js/ (guide §4.3: the only NEW island
// file). Written without template literals/backticks so it can nest in this literal.
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
  const expectedLinks = [...CSS_SHEETS.map((p) => '/' + p), '/vendor/manrope/font-face.css']
  if (JSON.stringify(links) !== JSON.stringify(expectedLinks)) {
    problems.push('index.html CSS manifest mismatch:\n    expected: ' + JSON.stringify(expectedLinks) + '\n    actual:   ' + JSON.stringify(links))
  }
  if (links[CSS_SHEETS.length - 1] !== '/css/rtl.css') problems.push('index.html: rtl.css is not the last /css/ sheet')
  const shimIdx = indexHtml.indexOf('/js/desktop-shim.js')
  const devIdx = indexHtml.indexOf('/js/devboard.js')
  const bpIdx = indexHtml.indexOf('/js/board-page.js')
  if (!(shimIdx !== -1 && devIdx !== -1 && bpIdx !== -1 && shimIdx < devIdx && devIdx < bpIdx)) {
    problems.push('index.html: desktop-shim.js must load before devboard.js before board-page.js (got indices ' + shimIdx + '/' + devIdx + '/' + bpIdx + ')')
  }
  for (const kept of ['id="db-toolbar"', 'id="db-loading"', 'id="db-board"', 'data-i18n="db.board"', 'data-i18n="db.backToProject"',
    'js/i18n-en.js', 'js/i18n.js', 'vendor/jalaali.min.js', 'js/chip-render.js', 'vendor/general-sans/GeneralSans-400.woff2']) {
    if (!indexHtml.includes(kept)) problems.push('index.html: kept markup/manifest missing "' + kept + '"')
  }

  // CSS url()/@import refs that are DEFINED in kept sheets but NEVER APPLIED on the
  // board surface at the pin (verified @ e6661c8): a browser only fetches a url()
  // when a RENDERED element applies it, so these cannot 404 in the embedded server.
  // They are NOT copied (the task rule: assets are copied only if referenced by the
  // kept MARKUP; guide §3.1's verified manifest excludes them). Anything missing that
  // is NOT in this documented map fails the sync below.
  const KNOWN_UNUSED_CSS_ASSETS = {
    '/logo-light.png':
      '--brand-logo/--inline-logo tokens (variables.css:494-495, themes.css:54-55, claude-dark-theme.css:206-207) are consumed only by .brand-logo (layout.css:33 — the STRIPPED topbar chrome) and .auth-brand (quicknotes.css:997 — the login page); no such element exists in the island markup/JS',
    '/Login.webp':
      '.auth-visual (quicknotes.css:937) is the login page photo — never rendered on the board surface',
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

  // (4) the JS is parseable — node --check the shim + every copied .js (belt + braces
  // over the patch step; a mangled patch must never ship).
  for (const js of ['js/desktop-shim.js', ...JS_FILES]) {
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

  // The generated shim (guide §4.3).
  fileMap['js/desktop-shim.js'] = DESKTOP_SHIM_JS

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
  process.stdout.write('  copied   : ' + COPY_MANIFEST.length + ' manifest files (verbatim) + index.html + js/desktop-shim.js + web-ref.json\n')
  process.stdout.write('  verified : seam counts, CSS manifest order (rtl.css last), shim-before-devboard, no-404 asset loop, node --check\n')
  process.stdout.write('  checksums: ' + Object.keys(hashes).length + ' files -> ' + path.relative(REPO_ROOT, checksPath) + '\n')
  process.stdout.write('[sync-island] DONE. Island pinned at ' + PIN_REF + ' @ v' + PIN_PACKAGE_VERSION + '.\n')
}

main()
