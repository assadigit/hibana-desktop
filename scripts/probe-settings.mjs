#!/usr/bin/env node
// ============================================================================
// probe-settings.mjs — the v0.1.17 settings-page BROWSER PROBE (Chromium via
// Playwright).
//
// WHAT IT PROVES, against the REAL generated island bytes (frontend/dist):
//   1. THE GEAR: the toolbar's settings button exists in the account zone
//      (after the theme toggle, BEFORE Sign out — the row: Sprints | Labels |
//      Sync | Refresh | Update | theme | ⚙ | Log out), a ghost icon button
//      with the pin's own nav.settings aria, twin-sized with its neighbors.
//   2. THE SHEET: the gear opens ONE wide native dialog carrying the owner's
//      FOUR sections in order (1. Sync 2. Update app 3. Login/logout
//      4. Appearance), the AppInfo version line (Hibana 0.1.16 · island
//      e6661c8 (v0.4.1.35)), and the AuthState account line
//      (ali · aliassadi@live.com).
//   3. THE MANUAL CHECK verdicts: before any check the status line claims
//      NOTHING (an unchecked app is not "latest"); none → "You're on the
//      latest version."; available → the version line + the Update-now
//      reveal; busy + unreachable → their own honest lines.
//   4. THE DELEGATION: Sync now / Update now / Sign out close the sheet
//      FIRST, then open the PROVEN modals (#db-sync-dialog /
//      #db-update-dialog / #db-logout-dialog) through the toolbar buttons'
//      own handlers — the modals never stack, zero new flows.
//   5. THE THEME SEGMENT: active from the served data-desktop-theme; a pick
//      rides SetTheme with the tray's full 3-state vocabulary and flips the
//      live look; the hibana:theme event keeps the segments in sync.
//   6. THE LANGUAGE SEGMENT (the round's one new capability): the active
//      state from the served data-desktop-lang; an OFFLINE flip resolves
//      {ok:false} → the honest error line + the control STAYS PUT + NO
//      reload; the session-expired variant paints its own line; a SUCCESSFUL
//      flip flips the chrome LIVE (html[lang]/dir + the FA dict loads), then
//      reloads after ~700ms — and the re-booted document serves FA/RTL at
//      the FIRST frame (the serve-time stamping, the FA FOUC kill).
//   7. THE EVENT SYNC: hibana:lang moves the segmented control without a
//      reload (the tray/sheet agreement); hibana:update-available repaints
//      the status line live.
//   8. THE GITHUB-ACCESS ROW (v0.1.18 — the owner ask: "hibana desktop
//      might be a private repo so in setting, add a github credentials so it
//      can connect to the private repo"): a PASSWORD field + Save/Remove over
//      SetGithubToken/GithubTokenState — the no-token honesty line, the
//      saved+verified round (field CLEARED, the ghp_…stuv hint, Remove
//      revealed, and THE CONNECT-NOW RE-CHECK firing through the manual
//      check's own handler), the 401 rejection (nothing saved), Remove (the
//      anonymous-again line), and the malformed-shape rejection line. Since
//      v0.1.19 the row also carries the TEST button (the owner ask: "Yes add
//      a test connection") over TestGithubConnection: the anonymous verdict
//      ("" crossed the bridge, the public-repo line), the typed candidate
//      (accepted line + the field KEEPS its value — only Save clears), the
//      401 typed line, the ANONYMOUS 404 private-repo signal, the saved-token
//      verdict, and the malformed-shape rejection — with NOTHING ever written
//      and NO re-check fired.
//   9. THE FA/RTL DARK MIRROR: the FA boot paints the sheet in Persian
//      (تنظیمات title via the pin's own key, the FA STR pairs), RTL-mirrored,
//      in the dark look; the FA test-connection verdict paints its FA twin.
//   10. REDUCED MOTION: the segment tween stills.
//
// The mock bridge sits at the SAME boundary the Wails runtime occupies in
// production (window.go/window.runtime — byte-for-byte the same positions);
// the SetLanguage / CheckForUpdates mocks route through the probe's HTTP
// endpoints so every outcome is drivable deterministically.
//
// USAGE (playwright + browsers ship in hibana-source for its e2e suite):
//   node scripts/probe-settings.mjs --src /home/z/hibana-source \
//        [--dist frontend/dist] [--out /tmp/probe-settings]
// Exit 0 + screenshots on success; exit 1 with the failed assertion otherwise.
// ============================================================================

import { createRequire } from 'node:module'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const a = { src: '/home/z/hibana-source', dist: path.join(REPO_ROOT, 'frontend/dist'), out: '/tmp/probe-settings', port: 3139 }
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

// The island pin + the desktop's own version, read LIVE from the generated
// artifacts — the stub and the expected version line can never go stale on a
// pin move again (the v0.1.21 round's lesson: the hardcoded e6661c8/v0.4.1.35
// pair failed the moment the island moved to 7a3198b/v0.4.1.37).
const WEB_REF = JSON.parse(fs.readFileSync(path.join(args.dist, 'web-ref.json'), 'utf8'))
const DESKTOP_VERSION = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'wails.json'), 'utf8')).info.productVersion
const VERSION_LINE = 'Hibana ' + DESKTOP_VERSION + ' · island ' + WEB_REF.ref + ' (v' + WEB_REF.packageVersion + ')'
const VERSION_LINE_FA = 'هیبانا ' + DESKTOP_VERSION + ' · جزیره ' + WEB_REF.ref + ' (v' + WEB_REF.packageVersion + ')'
for (const f of ['index.html', 'js/desktop-settings.js', 'css/desktop-settings.css', 'js/desktop-update.js', 'js/desktop-sync.js', 'js/desktop-logout.js', 'js/desktop-login.js', 'js/i18n-fa.js', 'icon.svg']) {
  if (!fs.existsSync(path.join(args.dist, f))) {
    console.error('[probe] missing ' + f + ' under ' + args.dist + ' — run scripts/sync-island.mjs first.')
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// The probe state. The "running app" the mock reports: 0.1.16 over the
// e6661c8 island, the test account ali · aliassadi@live.com. langOutcome /
// checkOutcome drive the mocked bindings; langCalls / checkCalls / syncClicks
// capture what crossed the bridge.
// ---------------------------------------------------------------------------
const P1 = '11111111-1111-4111-8111-111111111111'
const AVAILABLE = {
  available: true,
  current: '0.1.16',
  latest: '0.1.17',
  kind: 'portable',
  size: 7560711,
  notes: 'Desktop 0.1.17 — auto-release: every update to main ships a release.',
  url: 'https://github.com/assadigit/hibana-desktop/releases/latest',
}
const probe = {
  authed: true,
  lang: 'en',
  theme: null, // null → the serve stamps 'system' (no data-theme)
  projects: [{ id: P1, title: 'Hibana Web', status: 'planning', type: 'personal' }],
  tasks: [
    { id: 't1', project_id: P1, title: 'Keep the fire alive', status: 'idea', priority: 'high', category_id: null, sprint_id: null, sort_order: 0, created_at: '2026-01-01T00:00:00.000Z', done_at: null, start_at: null, end_at: null, search_tags: '', updated_at: '2026-01-02T00:00:00.000Z', tags: [], shot_count: 0 },
  ],
  langOutcome: { ok: true, lang: 'fa' },
  langCalls: [],
  checkOutcome: { available: false, current: '0.1.16', latest: '0.1.16' },
  checkCalls: 0,
  // v0.1.18 — the GitHub-access row's mock state: the stored-token truth
  // GithubTokenState reports, the verdict SetGithubToken resolves, and the
  // calls that crossed the bridge (the LAST one may be "" — the clear).
  token: { set: false, hint: 'ghp_…stuv' },
  tokenOutcome: { ok: true, saved: true, verified: true },
  tokenCalls: [],
  // v0.1.19 — the test-connection round's mock state: the verdict
  // TestGithubConnection resolves + the candidates that crossed the bridge
  // ("" = the stored-or-anonymous round Go-side decides).
  testOutcome: { ok: true, code: 'verified', using: 'anonymous' },
  testCalls: [],
}
const MOCK_IPC_JS = 'window.WailsInvoke = function (m) { /* probe: no Go backend on the other side */ }\n'
// The runtime mock is built PER REQUEST from the live probe state (the v0.1.9
// lesson: a module-level constant froze the EN state into the FA pass).
const mockRuntimeJs = () => [
  'window.go = { desktop: { API: {',
  "  Login: function (login, password) { return Promise.resolve({ ok: true, user: { email: login } }) },",
  '  Logout: function () { return Promise.resolve({ ok: true }) },',
  "  AuthState: function () { return Promise.resolve({ authenticated: window.__probe.authed, user: window.__probe.authed ? { username: 'ali', email: 'aliassadi@live.com', language_pref: window.__probe.lang, calendar_pref: 'gregorian' } : null }) },",
  '  Request: function (method, p, body) { return window.__probeRequest(method, p, body) },',
  '  AppInfo: function () { return Promise.resolve({ version: ' + JSON.stringify(DESKTOP_VERSION) + ', webRef: ' + JSON.stringify(WEB_REF.ref) + ' }) },',
  '  SetTheme: function (pref) { window.__probeThemeCalls.push(pref); return Promise.resolve({ ok: true, pref: pref }) },',
  '  SetLanguage: function (lang) { return window.__probeSetLanguage(lang) },',
  '  SetGithubToken: function (tok) { return window.__probeSetToken(tok) },',
  '  TestGithubConnection: function (tok) { return window.__probeTestConnection(tok) },',
  '  GithubTokenState: function () { return fetch("/__probe/tokenstate").then(function (r) { return r.json() }) },',
  '  SyncNow: function () { return Promise.resolve({ ok: true, uploaded: 0, pulled: 0, projects: 1, boards: 1, at: new Date().toISOString() }) },',
  '  CheckForUpdates: function () { return window.__probeCheck() },',
  '  ApplyUpdate: function () { return Promise.resolve({ ok: false, message: \'probe: apply is not this round\\\'s leg\' }) },',
  '} } }',
  // The Wails EventsOn contract is MULTI-LISTENER (every registered callback
  // fires per emit) — the v0.1.17 settings round co-listens on
  // hibana:update-available / hibana:theme, so the probe registry models
  // the real runtime faithfully (the single-slot registry silently
  // dropped the earlier registrant).
  'window.runtime = { EventsOn: function (name, cb) { (window.__probeEvents = window.__probeEvents || {}); (window.__probeEvents[name] = window.__probeEvents[name] || []).push(cb) } },',
  'window.__probeEmit = function (name, payload) { ((window.__probeEvents || {})[name] || []).forEach(function (cb) { try { cb(payload) } catch (e) {} }) },',
  'window.__probeThemeCalls = [];',
  'window.__probe = ' + JSON.stringify({ authed: probe.authed, lang: probe.lang }) + ';',
].join('\n') + '\n'

// serveDocument mirrors ui.InjectShellState's output byte-for-byte in shape:
// the served <html> carries lang + dir + data-desktop-lang (the settings
// round's serve-time stamping) + the auth + theme attrs.
const serveDocument = (send) => {
  let html = fs.readFileSync(path.join(args.dist, 'index.html'), 'utf8')
  const l = probe.lang === 'fa' ? 'fa' : 'en'
  const theme = probe.theme || 'system'
  const attrs = ' lang="' + l + '" dir="' + (l === 'fa' ? 'rtl' : 'ltr') + '" data-desktop-lang="' + l + '"' +
    ' data-desktop-authed="' + (probe.authed ? 'true' : 'false') + '"' +
    ' data-desktop-theme="' + theme + '"' +
    (theme === 'light' || theme === 'claude-dark' ? ' data-theme="' + theme + '"' : '')
  html = html.replace('<html lang="en">', '<html' + attrs + '>')
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
      'window.__probeSetLanguage = function (lang) {',
      '  return fetch("/__probe/setlang", { method: "POST", body: JSON.stringify({ lang: lang }) }).then(function (r) { return r.json() })',
      '}',
      'window.__probeCheck = function () {',
      '  return fetch("/__probe/check", { method: "POST" }).then(function (r) { return r.json() }).then(function (body) {',
      '    if (body && body.reject) return Promise.reject(new Error(body.message || ""))',
      '    return body',
      '  })',
      '}',
      'window.__probeSetToken = function (tok) {',
      '  return fetch("/__probe/settoken", { method: "POST", body: JSON.stringify({ token: tok }) }).then(function (r) { return r.json() }).then(function (body) {',
      '    if (body && body.reject) return Promise.reject(new Error(body.message || ""))',
      '    return body',
      '  })',
      '}',
      'window.__probeTestConnection = function (tok) {',
      '  return fetch("/__probe/testconnection", { method: "POST", body: JSON.stringify({ token: tok }) }).then(function (r) { return r.json() }).then(function (body) {',
      '    if (body && body.reject) return Promise.reject(new Error(body.message || ""))',
      '    return body',
      '  })',
      '}',
      'window.__probeRequest = function (method, p, body) {',
      '  return fetch("/__probe/request", { method: "POST", body: JSON.stringify({ method, p, body }) }).then(function (r) { return r.json() })',
      '}',
    ].join('\n') + '\n')
  }
  if (p === '/__probe/setlang' && req.method === 'POST') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    return req.on('end', () => {
      const body = JSON.parse(raw || '{}')
      probe.langCalls.push(String(body.lang || ''))
      // The mock's a.me: a SUCCESSFUL write moves the session language the
      // next serve reads (exactly what the Go binding's un-stale buys).
      const out = Object.assign({}, probe.langOutcome)
      if (out.ok && (body.lang === 'en' || body.lang === 'fa')) {
        out.lang = body.lang
        probe.lang = body.lang
      }
      send(200, 'application/json', JSON.stringify(out))
    })
  }
  if (p === '/__probe/check' && req.method === 'POST') {
    probe.checkCalls++
    const out = Object.assign({}, probe.checkOutcome)
    if (out.reject) send(200, 'application/json', JSON.stringify(out))
    else send(200, 'application/json', JSON.stringify(out))
    return
  }
  if (p === '/__probe/tokenstate') {
    return send(200, 'application/json', JSON.stringify(probe.token.set ? { set: true, hint: probe.token.hint } : { set: false }))
  }
  if (p === '/__probe/settoken' && req.method === 'POST') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    return req.on('end', () => {
      const body = JSON.parse(raw || '{}')
      probe.tokenCalls.push(String(body.token == null ? '' : body.token))
      const out = Object.assign({}, probe.tokenOutcome)
      // The mock's stored state moves exactly the way the Go binding's file
      // write does: a saved round stores the hint, a cleared round empties it.
      if (out.ok && out.saved) probe.token = { set: true, hint: 'ghp_…stuv' }
      if (out.ok && out.cleared) probe.token = { set: false, hint: '' }
      send(200, 'application/json', JSON.stringify(out))
    })
  }
  if (p === '/__probe/testconnection' && req.method === 'POST') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    return req.on('end', () => {
      const body = JSON.parse(raw || '{}')
      probe.testCalls.push(String(body.token == null ? '' : body.token))
      // A pure READ: the verdict resolves and the stored state never moves.
      send(200, 'application/json', JSON.stringify(Object.assign({}, probe.testOutcome)))
    })
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
  const emit = (name, payload) => page.evaluate(([n, x]) => {
    window.__probeEmit(n, x)
  }, [name, payload])

  try {
    // ---- 1. the stored-session EN boot: the gear exists in the account zone ----
    await page.goto(base + '/kanban', { waitUntil: 'load' })
    await page.waitForSelector('#login-gate', { state: 'hidden', timeout: 5000 })
    check('the stored-session boot hides the gate at first paint', true)
    await page.waitForFunction(() => document.querySelectorAll('.pd-task').length === 1, null, { timeout: 8000 })
    check('the board boots with its task card', true)

    const row = await page.evaluate(() => {
      const ids = ['db-sprint-link', 'db-labels-btn', 'db-sync-button', 'db-refresh-button', 'db-update-button', 'db-theme-toggle', 'db-settings-button', 'db-logout-button']
      const out = {}
      for (const id of ids) {
        const el = document.getElementById(id)
        if (!el) { out[id] = null; continue }
        const r = el.getBoundingClientRect()
        out[id] = { x: Math.round(r.x * 10) / 10, h: Math.round(r.height * 10) / 10, visible: r.width > 0 && r.height > 0, hidden: el.hidden, aria: el.getAttribute('aria-label') || '', cls: el.className }
      }
      // The Update pill is HIDDEN at boot (no update = no button, the honest
      // default — the probe-update round's own law), so the row ORDER is read
      // from the DOM chain (compareDocumentPosition), not from geometry.
      const domOrder = {}
      const els = ids.map((id) => document.getElementById(id))
      els.forEach((a, i) => {
        domOrder[ids[i]] = els.filter((b) => b && a && b.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING).length
      })
      return { els: out, domOrder }
    })
    for (const id of Object.keys(row.els)) {
      if (id === 'db-update-button') continue // covered below (the hidden default)
      check('the toolbar renders ' + id, row.els[id] !== null && row.els[id].visible)
    }
    check('the Update pill EXISTS but stays HIDDEN at boot (no update = no button, the honest default)', row.els['db-update-button'] && row.els['db-update-button'].hidden)
    const ord = row.domOrder
    check('the row order is Sprints | Labels | Sync | Refresh | Update | theme | ⚙ Settings | Log out (the account zone)',
      ord['db-sprint-link'] < ord['db-labels-btn'] && ord['db-labels-btn'] < ord['db-sync-button'] && ord['db-sync-button'] < ord['db-refresh-button'] &&
      ord['db-refresh-button'] < ord['db-update-button'] && ord['db-update-button'] < ord['db-theme-toggle'] && ord['db-theme-toggle'] < ord['db-settings-button'] && ord['db-settings-button'] < ord['db-logout-button'],
      JSON.stringify(ord))
    const heights = [row.els['db-sprint-link'].h, row.els['db-labels-btn'].h, row.els['db-sync-button'].h, row.els['db-refresh-button'].h, row.els['db-logout-button'].h]
    const spread = Math.max(...heights) - Math.min(...heights)
    check('the labeled pills stay twin-sized (heights spread ' + spread.toFixed(1) + 'px)', spread < 1.5)
    const gearSpread = Math.abs(row.els['db-settings-button'].h - row.els['db-theme-toggle'].h)
    check('the gear is twin-sized with the theme toggle (the icon-only grammar)', gearSpread < 1.5, 'gear ' + row.els['db-settings-button'].h + 'px vs toggle ' + row.els['db-theme-toggle'].h + 'px')
    check('the gear is the ghost grammar (Settings is chrome, not a CTA)', /(^|\s)ghost(\s|$)/.test(row.els['db-settings-button'].cls), JSON.stringify(row.els['db-settings-button'].cls))
    check('the gear aria reads the pin\'s own nav.settings key', row.els['db-settings-button'].aria === 'Settings', JSON.stringify(row.els['db-settings-button'].aria))
    check('the serve stamped data-desktop-lang="en" (the serve-time stamping)', await page.evaluate(() => document.documentElement.getAttribute('data-desktop-lang') === 'en'))

    await page.screenshot({ path: path.join(args.out, 'settings-row.png') })

    // ---- 2. the gear opens the sheet: the owner's four sections in order ----
    await page.click('#db-settings-button')
    await page.waitForFunction(() => (document.getElementById('db-settings-dialog') || {}).open === true, null, { timeout: 5000 })
    check('the gear opens ONE native dialog (#db-settings-dialog)', true)

    const sheet = await page.evaluate(() => {
      const g = (id) => document.getElementById(id)
      const heads = ['db-settings-sync-heading', 'db-settings-update-heading', 'db-settings-account-heading', 'db-settings-appearance-heading'].map((id) => (g(id) || {}).textContent || '')
      return {
        title: (g('db-settings-title') || {}).textContent || '',
        heads,
        version: (g('db-settings-version') || {}).textContent || '',
        status: (g('db-settings-update-status') || {}).textContent || '',
        account: (g('db-settings-account') || {}).textContent || '',
        updateNowHidden: (g('db-settings-update-now') || {}).hidden,
        langEnPressed: (g('db-settings-lang-en') || {}).getAttribute('aria-pressed'),
        langFaPressed: (g('db-settings-lang-fa') || {}).getAttribute('aria-pressed'),
        themeLightPressed: (g('db-settings-theme-light') || {}).getAttribute('aria-pressed'),
        themeDarkPressed: (g('db-settings-theme-claude-dark') || {}).getAttribute('aria-pressed'),
        themeSystemPressed: (g('db-settings-theme-system') || {}).getAttribute('aria-pressed'),
        wide: !!(document.querySelector('#db-settings-dialog.dialog-wide')),
        modalClass: ((document.querySelector('.db-settings-modal') || {}).className || ''),
      }
    })
    check('the sheet title rides the pin\'s own nav.settings key', sheet.title === 'Settings', JSON.stringify(sheet.title))
    check('the owner\'s four sections render IN ORDER (1. Sync 2. Update app 3. Account 4. Appearance)',
      sheet.heads[0] === 'Sync' && sheet.heads[1] === 'Update app' && sheet.heads[2] === 'Account' && sheet.heads[3] === 'Appearance',
      JSON.stringify(sheet.heads))
    check('the sheet is the wide-dialog grammar', sheet.wide && /modal/.test(sheet.modalClass))
    check('the version line names the app + the island pin (AppInfo + the baked package version)',
      sheet.version === VERSION_LINE, JSON.stringify(sheet.version))
    check('the account line names the signed-in identity (AuthState)', sheet.account === 'ali · aliassadi@live.com', JSON.stringify(sheet.account))
    check('before any check the status line claims NOTHING (an unchecked app is not "latest")', sheet.status === '', JSON.stringify(sheet.status))
    check('Update now is hidden before an available verdict', sheet.updateNowHidden === true)
    check('the language segment carries the served active state (en)', sheet.langEnPressed === 'true' && sheet.langFaPressed === 'false')
    check('the theme segment carries the served active state (system)', sheet.themeSystemPressed === 'true' && sheet.themeLightPressed === 'false' && sheet.themeDarkPressed === 'false')

    await page.screenshot({ path: path.join(args.out, 'settings-sheet.png') })

    // ---- 3. the manual Check-for-updates verdicts ----
    // 3a. none → "You're on the latest version."
    await page.click('#db-settings-check')
    await page.waitForFunction(() => /latest version/i.test((document.getElementById('db-settings-update-status') || {}).textContent || ''), null, { timeout: 5000 })
    check('the none verdict paints "You\'re on the latest version."', true)
    check('the mocked CheckForUpdates binding was exercised', probe.checkCalls === 1, 'calls=' + probe.checkCalls)

    // 3b. available → the version line + the Update-now reveal
    probe.checkOutcome = AVAILABLE
    await page.click('#db-settings-check')
    await page.waitForFunction(() => {
      const s = document.getElementById('db-settings-update-status')
      const u = document.getElementById('db-settings-update-now')
      return s && /0\.1\.17/.test(s.textContent) && u && !u.hidden
    }, null, { timeout: 5000 })
    const avail = await page.evaluate(() => ({
      status: (document.getElementById('db-settings-update-status') || {}).textContent || '',
      go: (document.getElementById('db-settings-update-now') || {}).textContent || '',
    }))
    check('the available verdict paints the version line + the honest size', avail.status === 'Hibana 0.1.16 → 0.1.17 is available (7.2 MB).', JSON.stringify(avail.status))
    check('the revealed Update now is LABELED', /Update now/.test(avail.go), JSON.stringify(avail.go))

    await page.screenshot({ path: path.join(args.out, 'settings-available.png') })

    // 3c. busy → the honest busy line (a refused check is not a dead network)
    probe.checkOutcome = { reject: true, message: 'bridge: update: a check or update is already running' }
    await page.click('#db-settings-check')
    await page.waitForFunction(() => {
      const e = document.getElementById('db-settings-update-error')
      return e && !e.hidden && /already in progress/i.test(e.textContent)
    }, null, { timeout: 5000 })
    check('the busy rejection paints its own honest line', true)

    // 3d. unreachable → the can't-reach line
    probe.checkOutcome = { reject: true, message: 'update: github: deadline exceeded' }
    await page.click('#db-settings-check')
    await page.waitForFunction(() => {
      const e = document.getElementById('db-settings-update-error')
      return e && !e.hidden && /Couldn't reach GitHub/i.test(e.textContent)
    }, null, { timeout: 5000 })
    check('the unreachable rejection paints the can\'t-reach line', true)

    // ---- 4. THE DELEGATION: the sheet closes FIRST, the proven modal opens ----
    // 4a. Sync now → #db-sync-dialog (the round resolves ok with pulled=0 —
    //     the exit button is Done, and closing reloads NOTHING).
    await page.click('#db-settings-sync-now')
    await page.waitForFunction(() => {
      const s = document.getElementById('db-settings-dialog')
      const y = document.getElementById('db-sync-dialog')
      return s && !s.open && y && y.open
    }, null, { timeout: 5000 })
    check('Sync now closes the sheet and opens the PROVEN sync modal', true)
    await page.waitForFunction(() => {
      const d = document.getElementById('db-sync-done')
      return d && !d.hidden
    }, null, { timeout: 5000 })
    await page.evaluate(() => { window.__probeMarker = 'planted' })
    await page.click('#db-sync-done')
    await page.waitForFunction(() => (document.getElementById('db-sync-dialog') || {}).open === false, null, { timeout: 5000 })
    await page.waitForTimeout(400)
    check('the delegated sync round (pulled=0) reloads NOTHING (the screen was already the truth)', await page.evaluate(() => !!window.__probeMarker))

    // 4b. Update now → #db-update-dialog (re-earn the verdict first — the
    // busy/unreachable legs cleared it; the settings surface is the manual
    // trigger the owner asked for, so the check runs through the sheet).
    probe.checkOutcome = AVAILABLE
    await page.click('#db-settings-button')
    await page.waitForFunction(() => (document.getElementById('db-settings-dialog') || {}).open === true, null, { timeout: 5000 })
    await page.click('#db-settings-check')
    await page.waitForFunction(() => {
      const u = document.getElementById('db-settings-update-now')
      return u && !u.hidden
    }, null, { timeout: 5000 })
    await page.click('#db-settings-update-now')
    await page.waitForFunction(() => {
      const s = document.getElementById('db-settings-dialog')
      const u = document.getElementById('db-update-dialog')
      return s && !s.open && u && u.open
    }, null, { timeout: 5000 })
    check('Update now closes the sheet and opens the PROVEN update modal', true)
    await page.click('#db-update-later')
    await page.waitForFunction(() => (document.getElementById('db-update-dialog') || {}).open === false, null, { timeout: 5000 })

    // 4c. Sign out → #db-logout-dialog (the existing confirm)
    await page.click('#db-settings-button')
    await page.waitForFunction(() => (document.getElementById('db-settings-dialog') || {}).open === true, null, { timeout: 5000 })
    await page.click('#db-settings-signout')
    await page.waitForFunction(() => {
      const s = document.getElementById('db-settings-dialog')
      const l = document.getElementById('db-logout-dialog')
      return s && !s.open && l && l.open
    }, null, { timeout: 5000 })
    check('Sign out closes the sheet and opens the PROVEN logout confirm', true)
    await page.click('#db-logout-cancel')
    await page.waitForFunction(() => (document.getElementById('db-logout-dialog') || {}).open === false, null, { timeout: 5000 })
    check('the delegation exercised ZERO new flows (the modals never stack)', true)

    // ---- 5. the theme segmented control (the tray's full 3-state vocabulary) ----
    await page.click('#db-settings-button')
    await page.waitForFunction(() => (document.getElementById('db-settings-dialog') || {}).open === true, null, { timeout: 5000 })
    await page.click('#db-settings-theme-claude-dark')
    const darkPick = await page.evaluate(() => ({
      pressed: document.getElementById('db-settings-theme-claude-dark').getAttribute('aria-pressed'),
      lightPressed: document.getElementById('db-settings-theme-light').getAttribute('aria-pressed'),
      served: document.documentElement.getAttribute('data-desktop-theme'),
      look: document.documentElement.getAttribute('data-theme'),
      calls: window.__probeThemeCalls,
    }))
    check('the Dark pick rides SetTheme with the tray vocabulary', darkPick.calls.includes('claude-dark'), JSON.stringify(darkPick.calls))
    check('the segmented active state moves to Dark', darkPick.pressed === 'true' && darkPick.lightPressed === 'false')
    check('the live look flips (data-theme=claude-dark)', darkPick.served === 'claude-dark' && darkPick.look === 'claude-dark', JSON.stringify({ served: darkPick.served, look: darkPick.look }))

    // The tray's hibana:theme event keeps the segments honest (no reload).
    await page.evaluate(() => { window.__probeMarker = 'planted' })
    await emit('hibana:theme', { pref: 'light' })
    await page.waitForFunction(() => document.getElementById('db-settings-theme-light').getAttribute('aria-pressed') === 'true', null, { timeout: 5000 })
    const traySync = await page.evaluate(() => ({
      light: document.getElementById('db-settings-theme-light').getAttribute('aria-pressed'),
      dark: document.getElementById('db-settings-theme-claude-dark').getAttribute('aria-pressed'),
      served: document.documentElement.getAttribute('data-desktop-theme'),
    }))
    check('the tray-driven hibana:theme moves the segment (the tray/sheet agreement)', traySync.light === 'true' && traySync.dark === 'false' && traySync.served === 'light')

    // The update-available relay repaints the status line with the sheet open.
    await emit('hibana:update-available', AVAILABLE)
    await page.waitForFunction(() => /0\.1\.17/.test((document.getElementById('db-settings-update-status') || {}).textContent || ''), null, { timeout: 5000 })
    check('the hibana:update-available relay repaints the open sheet\'s status line', true)

    // ---- 5½. THE GITHUB-ACCESS ROW (v0.1.18 — the owner ask: "hibana desktop
    //      might be a private repo so in setting, add a github credentials so
    //      it can connect to the private repo") ----
    // 5½a. the honest default: no token stored → the anonymous line, Remove hidden.
    const tokenRow0 = await page.evaluate(() => {
      const g = (id) => document.getElementById(id)
      const input = g('db-settings-token-input')
      return {
        type: input ? input.getAttribute('type') : null,
        autoComplete: input ? input.getAttribute('autocomplete') : null,
        status: (g('db-settings-token-status') || {}).textContent || '',
        removeHidden: (g('db-settings-token-clear') || {}).hidden,
        label: (g('db-settings-token-label') || {}).textContent || '',
        saveLabel: (g('db-settings-token-save-label') || {}).textContent || '',
        removeLabel: (g('db-settings-token-clear-label') || {}).textContent || '',
        placeholder: input ? input.getAttribute('placeholder') : null,
      }
    })
    check('the GitHub-access field is a PASSWORD input (the token never renders in clear)', tokenRow0.type === 'password', JSON.stringify(tokenRow0.type))
    check('the field opts out of autocomplete', tokenRow0.autoComplete === 'off')
    check('the row is labeled GitHub access + Save/Remove', tokenRow0.label === 'GitHub access' && tokenRow0.saveLabel === 'Save' && tokenRow0.removeLabel === 'Remove', JSON.stringify({ label: tokenRow0.label, save: tokenRow0.saveLabel, remove: tokenRow0.removeLabel }))
    check('no token stored → the anonymous honesty line', tokenRow0.status === 'No token — anonymous GitHub access (fine for public repos).', JSON.stringify(tokenRow0.status))
    check('Remove stays hidden while no token is stored', tokenRow0.removeHidden === true)

    // 5½b. THE SAVED+VERIFIED ROUND: field cleared, the hint line, Remove
    //      revealed, and THE CONNECT-NOW RE-CHECK (the row's whole point).
    const checkCallsBeforeSave = probe.checkCalls
    await page.fill('#db-settings-token-input', 'ghp_0123456789abcdefghijklmnopqrstuv')
    await page.click('#db-settings-token-save')
    await page.waitForFunction(() => /Token saved/.test((document.getElementById('db-settings-token-status') || {}).textContent || ''), null, { timeout: 5000 })
    const tokenRow1 = await page.evaluate(() => {
      const g = (id) => document.getElementById(id)
      return {
        status: (g('db-settings-token-status') || {}).textContent || '',
        fieldValue: (g('db-settings-token-input') || {}).value || '',
        removeHidden: (g('db-settings-token-clear') || {}).hidden,
        errHidden: (g('db-settings-token-error') || {}).hidden,
      }
    })
    check('the saved round paints the hint line (never the token itself)', tokenRow1.status === 'Token saved (ghp_…stuv) — release checks use it.', JSON.stringify(tokenRow1.status))
    check('the field is CLEARED on the resolve (the value lives Go-side only)', tokenRow1.fieldValue === '')
    check('Remove is revealed once a token is stored', tokenRow1.removeHidden === false)
    check('the saved round stays error-free', tokenRow1.errHidden === true)
    await page.waitForFunction(() => document.getElementById('db-settings-token-save').disabled === false, null, { timeout: 5000 })
    check('a SAVED token immediately re-checks (the connect-now reflex)', probe.checkCalls === checkCallsBeforeSave + 1, 'calls=' + probe.checkCalls + ' (was ' + checkCallsBeforeSave + ')')
    check('the token crossed the bridge exactly once, verbatim', probe.tokenCalls.length === 1 && probe.tokenCalls[0] === 'ghp_0123456789abcdefghijklmnopqrstuv', JSON.stringify(probe.tokenCalls))
    await page.screenshot({ path: path.join(args.out, 'settings-token-saved.png') })

    // 5½c. the 401 rejection: GitHub refused the token — nothing was saved.
    probe.tokenOutcome = { ok: false, code: 'invalid', message: 'GitHub rejected the token — nothing was saved.' }
    await page.fill('#db-settings-token-input', 'ghp_0000000000000000000000000000000000')
    await page.click('#db-settings-token-save')
    await page.waitForFunction(() => {
      const e = document.getElementById('db-settings-token-error')
      return e && !e.hidden && /GitHub rejected the token/i.test(e.textContent)
    }, null, { timeout: 5000 })
    check('the 401 verdict paints the honest rejected line', true)
    check('the rejected round leaves the stored state untouched (the hint line still paints)', /Token saved/.test(await page.evaluate(() => (document.getElementById('db-settings-token-status') || {}).textContent || '')))
    check('the rejected round does NOT re-check (nothing changed)', probe.checkCalls === checkCallsBeforeSave + 1, 'calls=' + probe.checkCalls)

    // 5½d. the malformed-shape rejection (the binding's rejected promise).
    probe.tokenOutcome = { reject: true, message: 'bridge: github token: malformed value' }
    await page.fill('#db-settings-token-input', 'not a token')
    await page.click('#db-settings-token-save')
    await page.waitForFunction(() => {
      const e = document.getElementById('db-settings-token-error')
      return e && !e.hidden && /does not look like a GitHub token/i.test(e.textContent)
    }, null, { timeout: 5000 })
    check('the malformed shape paints its own line (the hostile-input law)', true)

    // 5½e. REMOVE: the Go clear contract rides SetGithubToken("").
    probe.tokenOutcome = { ok: true, cleared: true }
    await page.click('#db-settings-token-clear')
    await page.waitForFunction(() => /anonymous again/.test((document.getElementById('db-settings-token-status') || {}).textContent || ''), null, { timeout: 5000 })
    const tokenRow2 = await page.evaluate(() => ({
      status: (document.getElementById('db-settings-token-status') || {}).textContent || '',
      removeHidden: (document.getElementById('db-settings-token-clear') || {}).hidden,
    }))
    check('Remove paints the anonymous-again line', tokenRow2.status === 'Token removed — release checks are anonymous again.', JSON.stringify(tokenRow2.status))
    check('Remove hides itself once no token is stored', tokenRow2.removeHidden === true)
    check('Remove rode the empty-string clear contract (the last call is "")', probe.tokenCalls[probe.tokenCalls.length - 1] === '', JSON.stringify(probe.tokenCalls))

    // ---- 5½f. THE TEST-CONNECTION ROUND (v0.1.19 — the owner ask: "Yes add
    //      a test connection"): verify-before-save over the Go
    //      TestGithubConnection binding — the field's value when typed, else
    //      "" (Go picks stored-vs-anonymous) — and NOTHING is ever written. ----
    const checkCallsBeforeTest = probe.checkCalls
    const tokenCallsBeforeTest = probe.tokenCalls.length
    await page.click('#db-settings-token-test')
    await page.waitForFunction(() => /no token needed/.test((document.getElementById('db-settings-token-status') || {}).textContent || ''), null, { timeout: 5000 })
    const testRow0 = await page.evaluate(() => {
      const g = (id) => document.getElementById(id)
      return {
        status: (g('db-settings-token-status') || {}).textContent || '',
        errHidden: (g('db-settings-token-error') || {}).hidden,
        testLabel: (g('db-settings-token-test-label') || {}).textContent || '',
        testDisabled: (g('db-settings-token-test') || {}).disabled,
        saveDisabled: (g('db-settings-token-save') || {}).disabled,
      }
    })
    check('the row renders a Test button (labeled, re-enabled after the round)', testRow0.testLabel === 'Test' && testRow0.testDisabled === false && testRow0.saveDisabled === false, JSON.stringify(testRow0))
    check('the anonymous test paints the public-repo verdict line', testRow0.status === 'GitHub is reachable and the repository is public — no token needed.', JSON.stringify(testRow0.status))
    check('the test round stays error-free', testRow0.errHidden === true)
    check('a test NEVER re-checks (it changes no state)', probe.checkCalls === checkCallsBeforeTest, 'calls=' + probe.checkCalls)
    check('a test NEVER writes (the save binding is untouched)', probe.tokenCalls.length === tokenCallsBeforeTest, 'calls=' + probe.tokenCalls.length)
    check('the empty-field test crossed the bridge with "" (Go picks the credential)', probe.testCalls.length === 1 && probe.testCalls[0] === '', JSON.stringify(probe.testCalls))

    // The typed-candidate verdict: paste a token, Test, the accepted line
    // paints — and the FIELD KEEPS ITS VALUE (only Save clears it; the value
    // stays for the Save click the verdict invites).
    probe.testOutcome = { ok: true, code: 'verified', using: 'typed' }
    await page.fill('#db-settings-token-input', 'ghp_0123456789abcdefghijklmnopqrstuv')
    await page.click('#db-settings-token-test')
    await page.waitForFunction(() => /accepted the token/.test((document.getElementById('db-settings-token-status') || {}).textContent || ''), null, { timeout: 5000 })
    const testRow1 = await page.evaluate(() => ({
      status: (document.getElementById('db-settings-token-status') || {}).textContent || '',
      fieldValue: (document.getElementById('db-settings-token-input') || {}).value || '',
    }))
    check('the typed test paints the accepted verdict line', testRow1.status === 'GitHub accepted the token — the repository is visible.', JSON.stringify(testRow1.status))
    check('the test round NEVER clears the field (Save is the clear path)', testRow1.fieldValue === 'ghp_0123456789abcdefghijklmnopqrstuv', JSON.stringify(testRow1.fieldValue))
    check('the typed candidate crossed the bridge once, verbatim', probe.testCalls.length === 2 && probe.testCalls[1] === 'ghp_0123456789abcdefghijklmnopqrstuv')

    // The 401 typed verdict → its own honest line.
    probe.testOutcome = { ok: false, code: 'invalid', using: 'typed' }
    await page.click('#db-settings-token-test')
    await page.waitForFunction(() => {
      const e = document.getElementById('db-settings-token-error')
      return e && !e.hidden && /GitHub rejected this token/i.test(e.textContent)
    }, null, { timeout: 5000 })
    check('the 401 typed test paints its own honest line', true)

    // THE OWNER'S PRIVATE-REPO SIGNAL: nothing in play, GitHub 404s the
    // anonymous ask → the credential-gap line (the exact scenario the
    // GitHub-access row exists for).
    probe.testOutcome = { ok: false, code: 'no_access', using: 'anonymous' }
    await page.fill('#db-settings-token-input', '')
    await page.click('#db-settings-token-test')
    await page.waitForFunction(() => {
      const e = document.getElementById('db-settings-token-error')
      return e && !e.hidden && /without credentials/i.test(e.textContent)
    }, null, { timeout: 5000 })
    check('the anonymous 404 paints the private-repo signal (the credential-gap line)', true)

    // The saved-token verdict: the mock stores one, the field stays empty,
    // the round rides the STORED token Go-side ("using":"saved").
    probe.testOutcome = { ok: true, code: 'verified', using: 'saved' }
    probe.token = { set: true, hint: 'ghp_…stuv' }
    await page.click('#db-settings-token-test')
    await page.waitForFunction(() => /saved token works/.test((document.getElementById('db-settings-token-status') || {}).textContent || ''), null, { timeout: 5000 })
    check('the saved-token test paints its own verdict line (the stored token rode the round)', true)

    // The malformed-shape rejection (the binding's rejected promise).
    probe.testOutcome = { reject: true }
    await page.fill('#db-settings-token-input', 'not a token')
    await page.click('#db-settings-token-test')
    await page.waitForFunction(() => {
      const e = document.getElementById('db-settings-token-error')
      return e && !e.hidden && /does not look like a GitHub token/i.test(e.textContent)
    }, null, { timeout: 5000 })
    check('the malformed test candidate paints the shape line (the hostile-input law)', true)
    await page.screenshot({ path: path.join(args.out, 'settings-token-test.png') })
    // Restore the no-token state for the FA mirror leg below.
    probe.token = { set: false, hint: '' }
    probe.testOutcome = { ok: true, code: 'verified', using: 'anonymous' }

    // ---- 6. THE LANGUAGE SEGMENT (the round's one new capability) ----
    // 6a. offline → the honest line, the control STAYS, NO reload.
    probe.langOutcome = { ok: false, message: "Couldn't reach hibana.ir — the language is unchanged." }
    await page.evaluate(() => { window.__probeMarker = 'planted' })
    await page.click('#db-settings-lang-fa')
    await page.waitForFunction(() => {
      const e = document.getElementById('db-settings-lang-error')
      return e && !e.hidden && /language is unchanged/i.test(e.textContent)
    }, null, { timeout: 5000 })
    const offlineLang = await page.evaluate(() => ({
      en: document.getElementById('db-settings-lang-en').getAttribute('aria-pressed'),
      fa: document.getElementById('db-settings-lang-fa').getAttribute('aria-pressed'),
      lang: document.documentElement.lang,
    }))
    check('the offline flip paints the honest line (the sheet shows WHY)', true)
    check('the offline flip leaves the segmented control at EN (the language is unchanged)', offlineLang.en === 'true' && offlineLang.fa === 'false' && offlineLang.lang === 'en', JSON.stringify(offlineLang))
    await page.waitForTimeout(950) // past the 700ms reflex window
    check('the offline flip NEVER reloads (the marker survives)', await page.evaluate(() => !!window.__probeMarker))
    check('the mocked SetLanguage binding was exercised once', probe.langCalls.length === 1 && probe.langCalls[0] === 'fa', JSON.stringify(probe.langCalls))

    // 6b. the session-expired variant paints its own line.
    probe.langOutcome = { ok: false, message: 'Your session expired — sign in again.' }
    await page.click('#db-settings-lang-fa')
    await page.waitForFunction(() => {
      const e = document.getElementById('db-settings-lang-error')
      return e && !e.hidden && /session expired/i.test(e.textContent)
    }, null, { timeout: 5000 })
    check('the session-expired verdict paints its own line', true)
    check('the failed session flip keeps the control at EN', await page.evaluate(() => document.getElementById('db-settings-lang-en').getAttribute('aria-pressed') === 'true'))

    // 6c. THE SUCCESSFUL FLIP: live chrome flip → FA dict → sheet closes →
    //     the ~700ms reload → the re-booted document serves FA/RTL at the
    //     FIRST frame (the serve-time stamping — the FA FOUC kill).
    probe.langOutcome = { ok: true }
    await page.evaluate(() => { window.__probeMarker = 'planted' })
    await page.click('#db-settings-lang-fa')
    await page.waitForFunction(() => {
      const h = document.documentElement
      return h.lang === 'fa' && h.getAttribute('dir') === 'rtl' && h.getAttribute('data-desktop-lang') === 'fa'
    }, null, { timeout: 5000 })
    check('the live flip lands html[lang]=fa + dir=rtl + data-desktop-lang=fa', true)
    check('the sheet closed before the reload (the reload lands on the board)', await page.evaluate(() => !document.getElementById('db-settings-dialog').open))
    await page.waitForFunction(() => !window.__probeMarker, null, { timeout: 8000 })
    check('the ~700ms reload reflex re-boots the island (i18n.js\'s dynamic-markup law)', true)
    await page.waitForFunction(() => document.querySelectorAll('.pd-task').length === 1, null, { timeout: 8000 })
    const faBoot = await page.evaluate(() => ({
      lang: document.documentElement.lang,
      dir: document.documentElement.getAttribute('dir'),
      stamped: document.documentElement.getAttribute('data-desktop-lang'),
      seg: document.getElementById('db-settings-lang-fa') ? document.getElementById('db-settings-lang-fa').getAttribute('aria-pressed') : null,
      dict: !!window.__hibanaDictFA,
      gearAria: (document.getElementById('db-settings-button') || {}).getAttribute('aria-label') || '',
    }))
    check('the re-booted document serves FA/RTL at the FIRST frame (the serve-time stamp)', faBoot.lang === 'fa' && faBoot.dir === 'rtl' && faBoot.stamped === 'fa', JSON.stringify({ lang: faBoot.lang, dir: faBoot.dir, stamped: faBoot.stamped }))
    check('the FA dictionary is live (the flip loaded i18n-fa.js)', faBoot.dict === true)
    check('the FA boot reads the gear aria from the pin\'s own key', faBoot.gearAria === 'تنظیمات', JSON.stringify(faBoot.gearAria))

    // 6d. the flip BACK to en (the mirror of the same round).
    probe.langOutcome = { ok: true }
    await page.click('#db-settings-button')
    await page.waitForFunction(() => (document.getElementById('db-settings-dialog') || {}).open === true, null, { timeout: 5000 })
    check('the FA sheet opens (the FA labels paint through the STR pair)', await page.evaluate(() => (document.getElementById('db-settings-sync-heading') || {}).textContent === 'همگام‌سازی'))
    await page.evaluate(() => { window.__probeMarker = 'planted' })
    await page.click('#db-settings-lang-en')
    await page.waitForFunction(() => document.documentElement.lang === 'en' && document.documentElement.getAttribute('dir') === 'ltr', null, { timeout: 5000 })
    await page.waitForFunction(() => !window.__probeMarker, null, { timeout: 8000 })
    check('the en flip-back re-boots the island (the mirror round)', true)
    await page.waitForFunction(() => document.querySelectorAll('.pd-task').length === 1, null, { timeout: 8000 })
    check('the re-booted document serves EN/LTR again', await page.evaluate(() => document.documentElement.lang === 'en' && document.documentElement.getAttribute('data-desktop-lang') === 'en'))

    // 6e. the hibana:lang event moves the segment WITHOUT a reload (the
    //     tray/sheet agreement — the event is Go's, not the click's).
    await page.evaluate(() => { window.__probeMarker = 'planted' })
    await emit('hibana:lang', { lang: 'fa' })
    await page.waitForFunction(() => document.getElementById('db-settings-lang-fa').getAttribute('aria-pressed') === 'true', null, { timeout: 5000 })
    const langEvent = await page.evaluate(() => ({
      fa: document.getElementById('db-settings-lang-fa').getAttribute('aria-pressed'),
      stamped: document.documentElement.getAttribute('data-desktop-lang'),
    }))
    check('the hibana:lang relay moves the segment (the tray/sheet agreement)', langEvent.fa === 'true' && langEvent.stamped === 'fa', JSON.stringify(langEvent))
    await page.waitForTimeout(950)
    check('the hibana:lang relay alone NEVER reloads (the marker survives)', await page.evaluate(() => !!window.__probeMarker))
    // Restore the EN state for the mirror leg below (the event only moved the
    // live attr — the mock's session language is untouched).
    await emit('hibana:lang', { lang: 'en' })
    await page.waitForFunction(() => document.getElementById('db-settings-lang-en').getAttribute('aria-pressed') === 'true', null, { timeout: 5000 })

    // ---- 7. the FA/RTL dark mirror of the whole sheet ----
    probe.lang = 'fa'
    probe.theme = 'claude-dark'
    await page.goto(base + '/kanban', { waitUntil: 'load' })
    await page.waitForFunction(() => document.querySelectorAll('.pd-task').length === 1, null, { timeout: 8000 })
    await page.click('#db-settings-button')
    await page.waitForFunction(() => (document.getElementById('db-settings-dialog') || {}).open === true, null, { timeout: 5000 })
    const faSheet = await page.evaluate(() => {
      const g = (id) => document.getElementById(id)
      return {
        title: (g('db-settings-title') || {}).textContent || '',
        heads: ['db-settings-sync-heading', 'db-settings-update-heading', 'db-settings-account-heading', 'db-settings-appearance-heading'].map((id) => (g(id) || {}).textContent || ''),
        version: (g('db-settings-version') || {}).textContent || '',
        syncNow: (g('db-settings-sync-now-label') || {}).textContent || '',
        check: (g('db-settings-check-label') || {}).textContent || '',
        signout: (g('db-settings-signout') || {}).textContent || '',
        langLabel: (g('db-settings-lang-label') || {}).textContent || '',
        themeLabel: (g('db-settings-theme-label') || {}).textContent || '',
        themeDark: (g('db-settings-theme-claude-dark') || {}).textContent || '',
        done: (g('db-settings-done-label') || {}).textContent || '',
        tokenLabel: (g('db-settings-token-label') || {}).textContent || '',
        tokenTest: (g('db-settings-token-test-label') || {}).textContent || '',
        tokenSave: (g('db-settings-token-save-label') || {}).textContent || '',
        tokenRemove: (g('db-settings-token-clear-label') || {}).textContent || '',
        tokenStatus: (g('db-settings-token-status') || {}).textContent || '',
        tokenPlaceholder: (g('db-settings-token-input') || {}).getAttribute('placeholder') || '',
        dir: document.documentElement.getAttribute('dir'),
        darkActive: (g('db-settings-theme-claude-dark') || {}).getAttribute('aria-pressed'),
        faActive: (g('db-settings-lang-fa') || {}).getAttribute('aria-pressed'),
      }
    })
    check('the FA sheet title rides the pin\'s own nav.settings key (تنظیمات)', faSheet.title === 'تنظیمات', JSON.stringify(faSheet.title))
    check('the FA sections keep the owner\'s order', faSheet.heads[0] === 'همگام‌سازی' && faSheet.heads[1] === 'بروزرسانی برنامه' && faSheet.heads[2] === 'حساب' && faSheet.heads[3] === 'ظاهر', JSON.stringify(faSheet.heads))
    check('the FA version line names the app + the island pin', faSheet.version === VERSION_LINE_FA, JSON.stringify(faSheet.version))
    check('the FA Sync-now + Check labels', faSheet.syncNow === 'همگام‌سازی کن' && faSheet.check === 'بررسی بروزرسانی', JSON.stringify({ syncNow: faSheet.syncNow, check: faSheet.check }))
    check('the FA Sign out rides the pin\'s own nav.signout key (خروج)', faSheet.signout === 'خروج', JSON.stringify(faSheet.signout))
    check('the FA labels: Language/Theme + the Dark option', faSheet.langLabel === 'زبان' && faSheet.themeLabel === 'پوسته' && faSheet.themeDark === 'تیره', JSON.stringify({ langLabel: faSheet.langLabel, themeLabel: faSheet.themeLabel, themeDark: faSheet.themeDark }))
    check('the FA Done label', faSheet.done === 'انجام شد', JSON.stringify(faSheet.done))
    check('the FA GitHub-access row: label + Test/Save/Remove + the placeholder',
      faSheet.tokenLabel === 'دسترسی گیت‌هاب' && faSheet.tokenTest === 'تست' && faSheet.tokenSave === 'ذخیره' && faSheet.tokenRemove === 'حذف' && faSheet.tokenPlaceholder === 'ghp_… (اختیاری)',
      JSON.stringify({ label: faSheet.tokenLabel, test: faSheet.tokenTest, save: faSheet.tokenSave, remove: faSheet.tokenRemove, placeholder: faSheet.tokenPlaceholder }))
    check('the FA GitHub-access row paints the no-token honesty line', faSheet.tokenStatus === 'توکنی ذخیره نشده — دسترسی ناشناس به گیت‌هاب (برای مخازن عمومی کافی است).', JSON.stringify(faSheet.tokenStatus))

    // The v0.1.19 test-connection round's FA twin: the anonymous verdict
    // paints its FA line through the same STR pair the EN round rode.
    await page.click('#db-settings-token-test')
    await page.waitForFunction(() => /نیازی به توکن نیست/.test((document.getElementById('db-settings-token-status') || {}).textContent || ''), null, { timeout: 5000 })
    check('the FA anonymous test verdict paints its FA twin', true)
    check('the FA sheet is RTL (dir=rtl)', faSheet.dir === 'rtl')
    check('the FA/dark serve stamps the active states (fa + claude-dark)', faSheet.faActive === 'true' && faSheet.darkActive === 'true')

    await page.screenshot({ path: path.join(args.out, 'settings-fa-dark.png') })

    // ---- 8. reduced motion: the segment tween stills ----
    await context.close()
    const rmContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    const rmPage = await rmContext.newPage()
    rmPage.on('pageerror', (e) => pageErrors.push('rm: ' + String(e)))
    await rmPage.goto(base + '/kanban', { waitUntil: 'load' })
    await rmPage.waitForFunction(() => document.querySelectorAll('.pd-task').length === 1, null, { timeout: 8000 })
    const rmTransition = await rmPage.evaluate(() => {
      const b = document.querySelector('.db-settings-seg-btn')
      return b ? getComputedStyle(b).transitionDuration : ''
    })
    // Chromium may serialize a stilled transition as "0s" or as a Blink
    // epsilon ("1e-05s"); the gate proves the TWEEN IS GONE (never the base
    // 0.18s).
    const rmSecs = parseFloat(rmTransition)
    check('prefers-reduced-motion stills the segment tween', rmSecs === 0 || rmSecs < 0.05, JSON.stringify(rmTransition))
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
    console.error('[probe-settings] FAIL — ' + total + ' failing assertion(s), ' + pageErrors.length + ' page error(s).')
    process.exit(1)
  }
  console.log('[probe-settings] ALL GREEN — the settings page is proven on the real island bytes (screenshots in ' + args.out + ').')
  process.exit(0)
}

main().catch((e) => { console.error('[probe-settings] ' + e); process.exit(1) })
