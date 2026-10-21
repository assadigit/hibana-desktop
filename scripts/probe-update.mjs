#!/usr/bin/env node
// ============================================================================
// probe-update.mjs — the v0.1.14 auto-update BROWSER PROBE (Chromium via
// Playwright).
//
// WHAT IT PROVES, against the REAL generated island bytes (frontend/dist):
//   1. THE HONEST DEFAULT: an authed boot with NO update keeps the toolbar
//      Update pill HIDDEN (no update = no button — the owner asked for a
//      button when a new version exists, and nothing otherwise).
//   2. THE OWNER'S ASK: the Go shell's hibana:update-available event (the
//      mocked EventsOn registry, the exact Wails boundary) reveals the pill —
//      VISIBLE, LABELED 'Update', aria'd ('Update Hibana now'), twin-sized
//      with all five labeled neighbors, sitting right after Refresh (the row:
//      Sprints | Labels | Sync | Refresh | Update | theme | Log out), painted
//      in the solid --ok green (the success grammar, distinct from Sync's
//      teal CTA).
//   3. THE MODAL: the click opens the update dialog with the version line
//      ('Hibana 0.1.13 → 0.1.14'), the asset kind + size ('Portable update —
//      7.2 MB from GitHub'), the data note (boards + sign-in stay — the
//      owner's "without losing data or needing user to re login"), and the
//      Later / Update now pair. Later closes; the pill stays.
//   4. THE LIVE ROUND: Update now → the mocked Go ApplyUpdate binding → the
//      hibana:update-progress events paint the bar (25% → 100% → the verify
//      note) → the {ok:true} resolve shows the RESTARTING panel, hides the
//      actions, and NEVER reloads (the Go process quits + relaunches the
//      island itself ~1.5s later — a JS reload would race the quit).
//   5. THE HONEST VERDICTS: {message:'busy'} → the busy line; a real Go
//      error message → the error line with the actions restored; a rejected
//      promise → the not-wired line. Nothing breaks, nothing lies.
//   6. THE FA/RTL DARK MIRROR: the fa boot paints 'نسخهٔ جدید' + the FA modal
//      copy, mirrors the row, and the dark look carries the olive fill.
//   7. REDUCED MOTION: the bar's transition stills (the STATE stays, the
//      tween goes).
//
// The mock bridge sits at the SAME boundary the Wails runtime occupies in
// production (window.go/window.runtime — byte-for-byte the same positions);
// the ApplyUpdate mock HOLDS its response until the probe releases it, so
// the mid-download progress ticks are drivable deterministically.
//
// USAGE (playwright + browsers ship in hibana-source for its e2e suite):
//   node scripts/probe-update.mjs --src /home/z/hibana-source \
//        [--dist frontend/dist] [--out /tmp/probe-update]
// Exit 0 + screenshots on success; exit 1 with the failed assertion otherwise.
// ============================================================================

import { createRequire } from 'node:module'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const a = { src: '/home/z/hibana-source', dist: path.join(REPO_ROOT, 'frontend/dist'), out: '/tmp/probe-update', port: 3138 }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--src') a.src = argv[++i]
    else if (argv[i] === '--dist') a.dist = path.resolve(argv[++i])
    else if (argv[i] === '--out') a.out = argv[++i]
    else if (argv[i] === '--port') a.port = parseInt(argv[i], 10)
    else { console.error('[probe] unknown arg ' + argv[i]); process.exit(1) }
  }
  return a
}

const args = parseArgs(process.argv.slice(2))
for (const f of ['index.html', 'js/desktop-update.js', 'css/desktop-update.css', 'js/desktop-refresh.js', 'js/desktop-sync.js', 'js/desktop-login.js', 'icon.svg']) {
  if (!fs.existsSync(path.join(args.dist, f))) {
    console.error('[probe] missing ' + f + ' under ' + args.dist + ' — run scripts/sync-island.mjs first.')
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// The probe state. The "GitHub release" the mock reports: 0.1.14 over the
// running 0.1.13, the portable zip at 7.2 MB (the lane's real asset class —
// 7,560,711 bytes at v0.1.13, so 7.2 MB is the honest display round).
// applyOutcome + applyRelease drive the mocked ApplyUpdate: the response
// HOLDS until the probe releases it (the mid-round progress ticks are
// emitted by the probe through the same EventsOn registry Go uses).
// ---------------------------------------------------------------------------
const P1 = '11111111-1111-4111-8111-111111111111'
const AVAILABLE = {
  available: true,
  current: '0.1.13',
  latest: '0.1.14',
  kind: 'portable',
  size: 7560711,
  notes: 'Desktop 0.1.14 — auto-release: every update to main ships a release.',
  url: 'https://github.com/assadigit/hibana-desktop/releases/latest',
}
const probe = {
  authed: true,
  lang: 'en',
  theme: null,
  projects: [{ id: P1, title: 'Hibana Web', status: 'planning', type: 'personal' }],
  tasks: [
    { id: 't1', project_id: P1, title: 'Keep the fire alive', status: 'idea', priority: 'high', category_id: null, sprint_id: null, sort_order: 0, created_at: '2026-01-01T00:00:00.000Z', done_at: null, start_at: null, end_at: null, search_tags: '', updated_at: '2026-01-02T00:00:00.000Z', tags: [], shot_count: 0 },
  ],
  applyOutcome: null, // what the mocked Go ApplyUpdate binding resolves
  applyRelease: false, // the held response's gate — set true to answer
  applyCalls: 0,
}
const MOCK_IPC_JS = 'window.WailsInvoke = function (m) { /* probe: no Go backend on the other side */ }\n'
// The runtime mock is built PER REQUEST from the live probe state (the v0.1.9
// lesson: a module-level constant froze the EN state into the FA pass).
const mockRuntimeJs = () => [
  'window.go = { desktop: { API: {',
  "  Login: function (login, password) { return Promise.resolve({ ok: true, user: { email: login } }) },",
  '  Logout: function () { return Promise.resolve({ ok: true }) },',
  "  AuthState: function () { return Promise.resolve({ authenticated: window.__probe.authed, user: window.__probe.authed ? { email: 'probe@hibana.ir', language_pref: window.__probe.lang, calendar_pref: 'gregorian' } : null }) },",
  '  Request: function (method, p, body) { return window.__probeRequest(method, p, body) },',
  "  SetTheme: function (pref) { return Promise.resolve({ ok: true, pref: pref }) },",
  '  SyncNow: function () { return Promise.resolve({ ok: true, uploaded: 0, pulled: 0, projects: 1, boards: 1, at: new Date().toISOString() }) },',
  '  CheckForUpdates: function () { return Promise.resolve({ available: false }) },',
  '  ApplyUpdate: function () { return window.__probeApplyUpdate() },',
  '} } }',
  'window.runtime = { EventsOn: function (name, cb) { (window.__probeEvents = window.__probeEvents || {})[name] = cb } }',
  'window.__probe = ' + JSON.stringify({ authed: probe.authed, lang: probe.lang }) + ';',
].join('\n') + '\n'

const serveDocument = (send) => {
  let html = fs.readFileSync(path.join(args.dist, 'index.html'), 'utf8')
  const attrs = ' data-desktop-authed="' + (probe.authed ? 'true' : 'false') + '"' +
    (probe.theme ? ' data-desktop-theme="' + probe.theme + '" data-theme="' + probe.theme + '"' : ' data-desktop-theme="light"')
  html = html.replace('<html lang="en">', '<html lang="' + (probe.lang === 'fa' ? 'fa' : 'en') + '"' + attrs + '>')
  html = html.replace('<head>', '<head>\n<script src="/wails/ipc.js"></script><script src="/wails/runtime.js"></script><script src="/__probe.js"></script>')
  return send(200, 'text/html; charset=utf-8', html)
}

const devboardPayload = (p) => JSON.stringify({
  project: { id: p.id, title: p.title, status: p.status, type: p.type },
  tasks: probe.tasks, categories: [], sprints: [], tags: [], task_tags: [],
})

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://probe.local')
  const p = url.pathname
  const send = (code, type, body) => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' })
    res.end(body)
  }
  if (p === '/wails/ipc.js') return send(200, 'application/javascript', MOCK_IPC_JS)
  if (p === '/wails/runtime.js') return send(200, 'application/javascript', mockRuntimeJs())
  if (p === '/__probe.js') {
    return send(200, 'application/javascript', [
      'window.__probeApplyUpdate = function () {',
      '  return fetch("/__probe/apply", { method: "POST" }).then(function (r) { return r.json() })',
      '}',
      'window.__probeRequest = function (method, p, body) {',
      '  return fetch("/__probe/request", { method: "POST", body: JSON.stringify({ method, p, body }) }).then(function (r) { return r.json() })',
      '}',
    ].join('\n') + '\n')
  }
  if (p === '/__probe/apply' && req.method === 'POST') {
    // The HELD response: the real binding resolves only after the download +
    // the verify + the helper spawn — the probe releases the gate once its
    // progress ticks have landed (a 5s belt so a bug can never hang CI).
    probe.applyCalls++
    const started = Date.now()
    const timer = setInterval(() => {
      if (probe.applyRelease || Date.now() - started > 5000) {
        clearInterval(timer)
        send(200, 'application/json', JSON.stringify(probe.applyOutcome || { ok: false, message: '' }))
      }
    }, 15)
    return
  }
  if (p === '/__probe/request' && req.method === 'POST') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    return req.on('end', () => {
      const { p: rp } = JSON.parse(raw)
      if (!probe.authed) return send(200, 'application/json', JSON.stringify({ status: 401, body: '{"error":"unauthorized"}' }))
      if (rp === '/api/projects?sort=recent') {
        return send(200, 'application/json', JSON.stringify({ status: 200, etag: null, body: JSON.stringify({ projects: probe.projects }) }))
      }
      const m = /^\/api\/projects\/([^/]+)\/devboard$/.exec(rp)
      if (m) {
        const found = probe.projects.find((x) => x.id === m[1])
        if (!found) return send(200, 'application/json', JSON.stringify({ status: 404, body: '{"error":"not_found"}' }))
        return send(200, 'application/json', JSON.stringify({ status: 200, etag: null, body: devboardPayload(found) }))
      }
      send(200, 'application/json', JSON.stringify({ status: 200, etag: null, body: '{}' }))
    })
  }
  if (p === '/' || p === '/kanban' || p === '/kanban.html' || p === '/board.html') return serveDocument(send)
  const file = path.join(args.dist, path.normalize(p).replace(/^([/\\])+/, ''))
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    const types = { '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' }
    return send(200, types[path.extname(file)] || 'application/octet-stream', fs.readFileSync(file))
  }
  send(404, 'text/plain', 'not found')
})

// ---------------------------------------------------------------------------
async function main() {
  const require2 = createRequire(path.join(args.src, 'package.json'))
  const { chromium } = require2('playwright')
  fs.mkdirSync(args.out, { recursive: true })

  await new Promise((r) => server.listen(args.port, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + args.port
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  const failures = []
  const check = (name, cond, extra) => {
    console.log((cond ? '  PASS ' : '  FAIL ') + name + (extra ? ' — ' + extra : ''))
    if (!cond) failures.push(name)
  }
  // The available/progress relays: the probe drives them through the SAME
  // EventsOn registry the real Go EventsEmit reaches.
  const emitAvailable = () => page.evaluate((payload) => {
    const cb = (window.__probeEvents || {})['hibana:update-available']
    if (typeof cb === 'function') cb(payload)
  }, AVAILABLE)
  const emitProgress = (stage, pct, received, total) => page.evaluate(([s, p, r, t]) => {
    const cb = (window.__probeEvents || {})['hibana:update-progress']
    if (typeof cb === 'function') cb({ stage: s, pct: p, received: r, total: t })
  }, [stage, pct, received, total])

  try {
    // ---- 1. the honest default: the stored-session boot keeps the pill HIDDEN ----
    await page.goto(base + '/kanban', { waitUntil: 'load' })
    await page.waitForSelector('#login-gate', { state: 'hidden', timeout: 5000 })
    check('the stored-session boot hides the gate at first paint', true)
    await page.waitForFunction(() => document.querySelectorAll('.pd-task').length === 1, null, { timeout: 8000 })
    check('the board boots with its task card', true)

    const hiddenPill = await page.evaluate(() => {
      const b = document.getElementById('db-update-button')
      if (!b) return { exists: false }
      const r = b.getBoundingClientRect()
      return { exists: true, hidden: b.hidden, w: r.width, h: r.height, display: getComputedStyle(b).display }
    })
    check('the Update pill EXISTS in the toolbar', hiddenPill.exists)
    check('the Update pill is HIDDEN before any release (no update = no button, the honest default)', hiddenPill.hidden && hiddenPill.display === 'none' && hiddenPill.w === 0, JSON.stringify(hiddenPill))
    check('no update event fired on its own (the mock reported available:false)', await page.evaluate(() => !((document.getElementById('db-update-button') || {}).hidden === false)))

    // ---- 2. THE OWNER'S ASK: the available event reveals the pill ----
    await emitAvailable()
    await page.waitForFunction(() => {
      const b = document.getElementById('db-update-button')
      return b && !b.hidden && b.getBoundingClientRect().width > 0
    }, null, { timeout: 5000 })
    check('the hibana:update-available event REVEALS the pill', true)

    const row = await page.evaluate(() => {
      const ids = ['db-sprint-link', 'db-labels-btn', 'db-sync-button', 'db-refresh-button', 'db-update-button', 'db-theme-toggle', 'db-logout-button']
      const out = {}
      for (const id of ids) {
        const el = document.getElementById(id)
        if (!el) { out[id] = null; continue }
        const r = el.getBoundingClientRect()
        const label = el.querySelector('#db-refresh-btn-label') || el.querySelector('#db-sync-btn-label') || el.querySelector('#db-logout-btn-label') || el.querySelector('#db-update-btn-label')
        out[id] = {
          x: Math.round(r.x * 10) / 10, h: Math.round(r.height * 10) / 10,
          visible: r.width > 0 && r.height > 0, text: el.textContent.trim(),
          label: label ? label.textContent.trim() : '',
          aria: el.getAttribute('aria-label') || '',
          cls: el.className,
          bg: getComputedStyle(el).backgroundColor,
          color: getComputedStyle(el).color,
        }
      }
      return out
    })
    for (const id of Object.keys(row)) check('the toolbar renders ' + id, row[id] !== null && row[id].visible)
    check('the row order is Sprints | Labels | Sync | Refresh | Update | theme | Log out',
      row['db-sprint-link'] && row['db-labels-btn'] && row['db-sync-button'] && row['db-refresh-button'] && row['db-update-button'] && row['db-theme-toggle'] && row['db-logout-button'] &&
        row['db-sprint-link'].x < row['db-labels-btn'].x && row['db-labels-btn'].x < row['db-sync-button'].x && row['db-sync-button'].x < row['db-refresh-button'].x &&
        row['db-refresh-button'].x < row['db-update-button'].x && row['db-update-button'].x < row['db-theme-toggle'].x && row['db-theme-toggle'].x < row['db-logout-button'].x,
      JSON.stringify(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v && v.x]))))
    const heights = [row['db-sprint-link'].h, row['db-labels-btn'].h, row['db-sync-button'].h, row['db-refresh-button'].h, row['db-update-button'].h, row['db-logout-button'].h]
    const spread = Math.max(...heights) - Math.min(...heights)
    check('Sprints / Labels / Sync / Refresh / Update / Log out are twin-sized (heights ' + heights.join('px, ') + 'px)', spread < 1.5, 'spread ' + spread + 'px')
    check('the Update pill is LABELED (the S220 lesson: a bare icon reads as nothing)', row['db-update-button'].label === 'Update', JSON.stringify(row['db-update-button'].label))
    check('the Update aria reads the desktop-owned EN pair', row['db-update-button'].aria === 'Update Hibana now', JSON.stringify(row['db-update-button'].aria))
    check('the Update pill is the solid --ok green (light: #1f7a34, white ink)', row['db-update-button'].bg === 'rgb(31, 122, 52)' && row['db-update-button'].color === 'rgb(255, 255, 255)', JSON.stringify({ bg: row['db-update-button'].bg, color: row['db-update-button'].color }))
    check('the Update pill is NOT the ghost grammar (the good news is an action, not chrome)', !/ghost/.test(row['db-update-button'].cls), JSON.stringify(row['db-update-button'].cls))

    await page.screenshot({ path: path.join(args.out, 'update-pill-row.png') })

    // ---- 3. the modal: the version line, the kind/size, the note, the pair ----
    await page.click('#db-update-button')
    await page.waitForFunction(() => (document.getElementById('db-update-dialog') || {}).open === true, null, { timeout: 5000 })
    const intro = await page.evaluate(() => ({
      title: (document.getElementById('db-update-title') || {}).textContent || '',
      version: (document.getElementById('db-update-version') || {}).textContent || '',
      kind: (document.getElementById('db-update-kind') || {}).textContent || '',
      body: (document.getElementById('db-update-body') || {}).textContent || '',
      later: (document.getElementById('db-update-later') || {}).hidden,
      go: (document.getElementById('db-update-go') || {}).hidden,
      goText: (document.getElementById('db-update-go') || {}).textContent || '',
    }))
    check('the modal opens with the localized title', intro.title === 'A new version is available', JSON.stringify(intro.title))
    check('the version line names the running + the new version', intro.version === 'Hibana 0.1.13 → 0.1.14', JSON.stringify(intro.version))
    check('the kind line names the portable asset + its honest size', intro.kind === 'Portable update — 7.2 MB from GitHub', JSON.stringify(intro.kind))
    check('the data note answers the owner\'s "without losing data or needing user to re login"', /boards and your sign-in stay/i.test(intro.body), JSON.stringify(intro.body))
    check('Later + Update now are the action pair', intro.later === false && intro.go === false && intro.goText === 'Update now')

    await page.screenshot({ path: path.join(args.out, 'update-modal.png') })

    // ---- Later closes the modal; the pill STAYS (the ask is a button, not a nag) ----
    await page.click('#db-update-later')
    await page.waitForFunction(() => (document.getElementById('db-update-dialog') || {}).open === false, null, { timeout: 5000 })
    check('Later closes the modal', true)
    check('the Update pill STAYS visible after Later (the offer stands)', await page.evaluate(() => {
      const b = document.getElementById('db-update-button')
      return b && !b.hidden && b.getBoundingClientRect().width > 0
    }))

    // ---- 4. THE LIVE ROUND: Update now → progress → the restarting panel, NO reload ----
    await page.click('#db-update-button')
    await page.waitForFunction(() => (document.getElementById('db-update-dialog') || {}).open === true, null, { timeout: 5000 })
    probe.applyOutcome = { ok: true }
    probe.applyRelease = false
    await page.click('#db-update-go')
    // The controller paints the bar from the first frame of the round.
    await page.waitForFunction(() => {
      const pr = document.getElementById('db-update-progress')
      return pr && !pr.hidden
    }, null, { timeout: 5000 })
    check('the round opens with the progress bar visible (the first frame paints 0%)', true)

    await emitProgress('download', 25, 1890178, 7560711)
    await page.waitForFunction(() => {
      const f = document.getElementById('db-update-fill')
      const n = document.getElementById('db-update-note')
      return f && n && f.style.width === '25%' && /Downloading — 25%/.test(n.textContent)
    }, null, { timeout: 5000 })
    check('the download tick paints the fill at 25% + the honest note', true)
    // The RENDERED geometry, not just the inline style — and read it AFTER
    // the 0.25s width tween settles (the probe's own second lesson: a read
    // at the style-flip frame sees the transition's 0px START and would
    // fail a healthy bar; the tween is the honest first ~6 frames).
    await page.waitForFunction(() => {
      const f = document.getElementById('db-update-fill')
      return f && f.getBoundingClientRect().width > 60
    }, null, { timeout: 3000 })
    const fillGeo = await page.evaluate(() => {
      const f = document.getElementById('db-update-fill')
      const bar = document.querySelector('.db-update-bar')
      if (!f || !bar) return null
      const fr = f.getBoundingClientRect()
      const br = bar.getBoundingClientRect()
      return { fw: Math.round(fr.width * 10) / 10, fh: fr.height, bw: Math.round(br.width * 10) / 10, bh: br.height }
    })
    check("the bar's fill RENDERS (a visible green box at ~25% of the track)", fillGeo && fillGeo.fw > 60 && fillGeo.bw > 100 && fillGeo.fh > 2 && fillGeo.bh >= fillGeo.fh, JSON.stringify(fillGeo))
    await page.screenshot({ path: path.join(args.out, 'update-progress.png') })

    await emitProgress('download', 100, 7560711, 7560711)
    await page.waitForFunction(() => {
      const f = document.getElementById('db-update-fill')
      const n = document.getElementById('db-update-note')
      return f && n && f.style.width === '100%' && /Downloading — 100%/.test(n.textContent)
    }, null, { timeout: 5000 })
    check('the 100% tick lands the bar', true)

    await emitProgress('verify', 100, 7560711, 7560711)
    await page.waitForFunction(() => {
      const n = document.getElementById('db-update-note')
      return n && /Verifying the download/.test(n.textContent)
    }, null, { timeout: 5000 })
    check('the verify stage swaps the note (the checksums chain has a visible step)', true)

    // Release the held binding → {ok:true} → the restarting panel, no reload.
    await page.evaluate(() => { window.__probeMarker = 'planted' })
    probe.applyRelease = true
    await page.waitForFunction(() => {
      const p = document.getElementById('db-update-panel')
      return p && !p.hidden
    }, null, { timeout: 5000 })
    const verdict = await page.evaluate(() => ({
      title: (document.getElementById('db-update-panel-title') || {}).textContent || '',
      body: (document.getElementById('db-update-panel-body') || {}).textContent || '',
      later: (document.getElementById('db-update-later') || {}).hidden,
      go: (document.getElementById('db-update-go') || {}).hidden,
      progressHidden: (document.getElementById('db-update-progress') || {}).hidden,
      kind: (document.getElementById('db-update-panel') || {}).getAttribute('data-kind'),
    }))
    check('the {ok:true} resolve shows the RESTARTING panel', /restarting/i.test(verdict.title), JSON.stringify(verdict.title))
    check('the restarting body names the installed version + the data promise', /Hibana 0\.1\.14 is installed/.test(verdict.body) && /sign-in stay/i.test(verdict.body), JSON.stringify(verdict.body))
    check('Later + Update now are gone once the round is won', verdict.later === true && verdict.go === true)
    check('the panel rides the sync grammar\'s ok kind', verdict.kind === 'ok')
    await page.waitForTimeout(400)
    check('NO reload on ok — the Go process restarts the island (the marker survives)', await page.evaluate(() => !!window.__probeMarker))
    check('the mocked Go ApplyUpdate binding was exercised once', probe.applyCalls === 1, 'calls=' + probe.applyCalls)

    await page.screenshot({ path: path.join(args.out, 'update-restarting.png') })

    // ---- 5. the honest verdicts on a fresh round ----
    await page.goto(base + '/kanban', { waitUntil: 'load' })
    await page.waitForFunction(() => document.querySelectorAll('.pd-task').length === 1, null, { timeout: 8000 })
    await emitAvailable()
    await page.click('#db-update-button')
    await page.waitForFunction(() => (document.getElementById('db-update-dialog') || {}).open === true, null, { timeout: 5000 })

    // busy
    probe.applyOutcome = { ok: false, message: 'busy' }
    probe.applyRelease = true
    await page.click('#db-update-go')
    await page.waitForFunction(() => {
      const e = document.getElementById('db-update-error')
      return e && !e.hidden && /An update is already in progress/.test(e.textContent)
    }, null, { timeout: 5000 })
    check('the busy verdict paints its own honest line', true)
    const restored = await page.evaluate(() => ({
      goHidden: (document.getElementById('db-update-go') || {}).hidden,
      goDisabled: (document.getElementById('db-update-go') || {}).disabled,
      laterHidden: (document.getElementById('db-update-later') || {}).hidden,
    }))
    check('a failed verdict RESTORES the actions (Update now re-enabled for the retry)', restored.goHidden === false && restored.goDisabled === false && restored.laterHidden === false, JSON.stringify(restored))

    // a real Go error message (the sha256 chain refusing a tampered release)
    probe.applyOutcome = { ok: false, message: 'update: hibana-portable-0.1.14.zip failed verification (want abcd…, got ef01…)' }
    probe.applyRelease = true
    await page.click('#db-update-go')
    await page.waitForFunction(() => {
      const e = document.getElementById('db-update-error')
      return e && !e.hidden && /Update failed/.test(e.textContent) && /failed verification/.test(e.textContent)
    }, null, { timeout: 5000 })
    check('a Go error message rides the localized error title verbatim', true)
    await page.screenshot({ path: path.join(args.out, 'update-error.png') })

    // a rejected promise (the bridge not wired — the honest v0.1.1 lesson)
    await page.evaluate(() => { window.__probeApplyUpdate = function () { return Promise.reject(new Error('not wired')) } })
    await page.click('#db-update-go')
    await page.waitForFunction(() => {
      const e = document.getElementById('db-update-error')
      return e && !e.hidden && /bridge is not wired/.test(e.textContent)
    }, null, { timeout: 5000 })
    check('a rejected promise paints the not-wired line (the modal never lies)', true)

    // ---- 6. the FA/RTL mirror in the dark look ----
    probe.lang = 'fa'
    probe.theme = 'claude-dark'
    probe.applyOutcome = { ok: false, message: 'no update is available' }
    probe.applyRelease = false
    await page.goto(base + '/kanban', { waitUntil: 'load' })
    await page.waitForFunction(() => document.querySelectorAll('.pd-task').length === 1, null, { timeout: 8000 })
    await emitAvailable()
    await page.waitForFunction(() => {
      const b = document.getElementById('db-update-button')
      const l = document.getElementById('db-update-btn-label')
      return b && !b.hidden && l && l.textContent.trim() === 'نسخهٔ جدید'
    }, null, { timeout: 5000 })
    check('the FA boot paints the desktop-owned نسخهٔ جدید label', true)
    const faRow = await page.evaluate(() => {
      const g = (id) => document.getElementById(id)
      const dir = document.documentElement.getAttribute('dir')
      const up = g('db-update-button'), re = g('db-refresh-button'), th = g('db-theme-toggle'), sy = g('db-sync-button')
      const theme = (document.documentElement.getAttribute('data-theme') || document.documentElement.getAttribute('data-desktop-theme'))
      return {
        dir, upX: up.getBoundingClientRect().x, reX: re.getBoundingClientRect().x, thX: th.getBoundingClientRect().x, syX: sy.getBoundingClientRect().x,
        upAria: up.getAttribute('aria-label') || '', upBg: getComputedStyle(up).backgroundColor, upInk: getComputedStyle(up).color, theme,
      }
    })
    check('i18n applied dir=rtl', faRow.dir === 'rtl', JSON.stringify(faRow.dir))
    check('the row MIRRORS (Update between Refresh and theme under RTL)', faRow.upX < faRow.reX && faRow.upX > faRow.thX && faRow.reX < faRow.syX, JSON.stringify({ upX: faRow.upX, reX: faRow.reX, thX: faRow.thX, syX: faRow.syX }))
    check('the FA aria reads the desktop-owned pair', faRow.upAria === 'بروزرسانی هیبانا', JSON.stringify(faRow.upAria))
    check('the dark look carries the olive fill with DARK ink (the AA pair flip)', faRow.upBg === 'rgb(155, 167, 122)' && faRow.upInk === 'rgb(20, 20, 19)', JSON.stringify({ bg: faRow.upBg, ink: faRow.upInk }))

    // The FA modal round: intro + the no-update verdict in Persian.
    await page.click('#db-update-button')
    await page.waitForFunction(() => (document.getElementById('db-update-dialog') || {}).open === true, null, { timeout: 5000 })
    const faIntro = await page.evaluate(() => ({
      title: (document.getElementById('db-update-title') || {}).textContent || '',
      version: (document.getElementById('db-update-version') || {}).textContent || '',
      kind: (document.getElementById('db-update-kind') || {}).textContent || '',
      goText: (document.getElementById('db-update-go') || {}).textContent || '',
      laterText: (document.getElementById('db-update-later') || {}).textContent || '',
    }))
    check('the FA modal title', faIntro.title === 'نسخهٔ جدید در دسترس است', JSON.stringify(faIntro.title))
    check('the FA version line', faIntro.version === 'هیبانا 0.1.13 → 0.1.14', JSON.stringify(faIntro.version))
    check('the FA kind line (the portable asset from GitHub)', /پرتابل/.test(faIntro.kind) && /گیت‌هاب/.test(faIntro.kind), JSON.stringify(faIntro.kind))
    check('the FA action pair', faIntro.goText === 'بروزرسانی کن' && faIntro.laterText === 'بعداً', JSON.stringify(faIntro))

    probe.applyRelease = false
    await page.click('#db-update-go')
    // The click paints the bar's first frame (0%) — the probe THEN drives the
    // mid-download tick (the emit order must follow the click, or run()'s own
    // setStage('download', 0) repaints over it).
    await page.waitForFunction(() => {
      const pr = document.getElementById('db-update-progress')
      return pr && !pr.hidden
    }, null, { timeout: 5000 })
    await emitProgress('download', 25, 1890178, 7560711)
    await page.waitForFunction(() => {
      const n = document.getElementById('db-update-note')
      return n && /در حال دانلود — 25٪/.test(n.textContent)
    }, null, { timeout: 5000 })
    check('the FA progress note paints the live percent', true)
    probe.applyRelease = true
    await page.waitForFunction(() => {
      const e = document.getElementById('db-update-error')
      return e && !e.hidden && /بروزرسانی‌ای در دسترس نیست/.test(e.textContent)
    }, null, { timeout: 5000 })
    check('the FA no-update verdict paints its own honest line', true)

    await page.screenshot({ path: path.join(args.out, 'update-fa-dark.png') })

    // ---- 7. reduced motion: the tween stills, the state stays ----
    await context.close()
    const rmContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    const rmPage = await rmContext.newPage()
    rmPage.on('pageerror', (e) => pageErrors.push('rm: ' + String(e)))
    await rmPage.goto(base + '/kanban', { waitUntil: 'load' })
    await rmPage.waitForFunction(() => document.querySelectorAll('.pd-task').length === 1, null, { timeout: 8000 })
    await rmPage.evaluate((payload) => {
      const cb = (window.__probeEvents || {})['hibana:update-available']
      if (typeof cb === 'function') cb(payload)
    }, AVAILABLE)
    await rmPage.waitForFunction(() => {
      const b = document.getElementById('db-update-button')
      return b && !b.hidden
    }, null, { timeout: 5000 })
    const rmTransition = await rmPage.evaluate(() => {
      const f = document.getElementById('db-update-fill')
      return f ? getComputedStyle(f).transitionDuration : ''
    })
    // Chromium may serialize a stilled transition as "0s" or as a Blink
    // epsilon ("1e-05s" — 10ns, the internal none encoding); what the gate
    // proves is the TWEEN IS GONE (a duration well under one frame, never
    // the base 0.25s).
    const rmSecs = parseFloat(rmTransition)
    check('prefers-reduced-motion stills the bar\'s tween (the state still fills)', rmSecs === 0 || rmSecs < 0.05, JSON.stringify(rmTransition))
    await rmContext.close()
  } catch (err) {
    failures.push('threw: ' + err.message)
    console.error('[probe] ' + err.message)
  }

  const total = failures.length
  if (pageErrors.length) {
    console.log('  PAGE ERRORS:')
    for (const e of pageErrors) console.log('    ' + e)
  }
  await browser.close().catch(() => {})
  server.close()
  if (total || pageErrors.length) {
    console.error('[probe-update] FAIL — ' + total + ' failing assertion(s), ' + pageErrors.length + ' page error(s).')
    process.exit(1)
  }
  console.log('[probe-update] ALL GREEN — the auto-update round is proven on the real island bytes (screenshots in ' + args.out + ').')
  process.exit(0)
}

main().catch((e) => { console.error('[probe-update] ' + e); process.exit(1) })
