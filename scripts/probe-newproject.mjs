#!/usr/bin/env node
// ============================================================================
// probe-newproject.mjs — the v0.1.11 new-project BROWSER PROBE (Chromium via
// Playwright).
//
// WHAT IT PROVES, against the REAL generated island bytes (frontend/dist):
//   1. The switcher popup gains its New project row at RUNTIME (the
//      MutationObserver injects it the moment board-page.js's openSwitch
//      builds the popup), riding the pin's own cmdk.newProject label — and
//      the row SURVIVES the list's innerHTML re-renders (it is a popup
//      SIBLING, not a list child); the dead "All projects →" link is
//      css-hidden (the desktop serves no projects page).
//   2. The create dialog: the WEB'S OWN native dialog with the pin's own
//      labels (cmdk.newProject / sparks.title / sparks.description /
//      cat.quickAdd / common.cancel); an empty title surfaces the honest
//      validation line.
//   3. THE LIVE CREATE (mocked at the bridge boundary, exactly where the
//      Wails runtime sits): Create → window.hibanaFetch POST /api/projects
//      with the client-minted v4 UUID + the FIXED 'planning' status (the
//      switcher's list excludes sparks) → 201 {ok,id} → the island's own
//      /kanban?project=<id> deep-link boot → the fresh board renders THE NEW
//      PROJECT with its empty columns — the kanban for the new project.
//      The captured payload is asserted field-by-field (id/title/description/
//      status + NOTHING else — the optional schema fields stay unsent).
//   4. The Esc-while-busy guard: an in-flight create cannot be dropped by the
//      cancel event (the dialog stays open until the POST resolves).
//   5. The no-projects empty state's dead "Go to projects" CTA
//      (/projects.html — a web page the embedded server does not serve) is
//      click-intercepted into the create dialog.
//   6. The honest failure branches: 401 → the session line (the bridge opens
//      the login card in production); transport failure → the unreachable
//      line. Both keep the dialog open — NO offline queue (M3's scope, not a
//      lie painted over a lost create).
//   7. The FA/RTL mirror in the dark look: the row + the dialog carry the
//      pin's own FA strings (پروژهٔ جدید / عنوان / توضیحات / ساختن /
//      انصراف) + the FA body copy, theme-aware + RTL-native for free.
//
// The mock bridge sits at the SAME boundary the Wails runtime occupies in
// production (window.go/window.runtime, set up by the injected /wails/*.js
// head-first scripts — byte-for-byte the same positions the
// KanbanIndexMiddleware splice and the Wails asset server use).
//
// USAGE (playwright + browsers ship in hibana-source for its e2e suite):
//   node scripts/probe-newproject.mjs --src /home/z/hibana-source \
//        [--dist frontend/dist] [--out /tmp/probe-newproject]
// Exit 0 + screenshots on success; exit 1 with the failed assertion otherwise.
// ============================================================================

import { createRequire } from 'node:module'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const a = { src: '/home/z/hibana-source', dist: path.join(REPO_ROOT, 'frontend/dist'), out: '/tmp/probe-newproject', port: 3131 }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--src') a.src = argv[++i]
    else if (argv[i] === '--dist') a.dist = path.resolve(argv[i])
    else if (argv[i] === '--out') a.out = argv[++i]
    else if (argv[i] === '--port') a.port = parseInt(argv[i], 10)
    else { console.error('[probe] unknown arg ' + argv[i]); process.exit(1) }
  }
  return a
}

const args = parseArgs(process.argv.slice(2))
for (const f of ['index.html', 'js/desktop-newproject.js', 'css/desktop-newproject.css', 'js/desktop-logout.js', 'js/desktop-login.js', 'icon.svg']) {
  if (!fs.existsSync(path.join(args.dist, f))) {
    console.error('[probe] missing ' + f + ' under ' + args.dist + ' — run scripts/sync-island.mjs first.')
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// The probe state — the seeded projects + the create-capture the assertions
// quote. The devboard mock 404s any id NOT in the current projects set, so
// the island's own last-board→404→list→empty-state fallthrough is exercised
// exactly as it behaves in production.
// ---------------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const probe = {
  authed: true,
  lang: 'en',
  theme: null, // null = light boot; 'claude-dark' = the explicit dark boot
  projects: [
    { id: '11111111-1111-4111-8111-111111111111', title: 'Hibana Web', status: 'planning', type: 'personal' },
    { id: '22222222-2222-4222-8222-222222222222', title: 'Desktop Port', status: 'developing', type: 'personal' },
  ],
  createCalls: [], // parsed POST /api/projects bodies (the wire payload)
  devboardGets: [], // the devboard paths the board boot issued
  nextCreateStatus: null, // null = 201; 401/409/429 = the honest branches
  failTransport: null, // a path to reject like a dead connection
  slowCreateMs: 0, // delay the create response (the Esc-while-busy pass)
}
const MOCK_IPC_JS = 'window.WailsInvoke = function (m) { /* probe: no Go backend on the other side */ }\n'
// The runtime mock is built PER REQUEST from the live probe state (the v0.1.9
// lesson: a module-level constant froze the EN state into the FA pass).
const mockRuntimeJs = () => [
  'window.go = { desktop: { API: {',
  "  Login: function (login, password) { return window.__probeLogin(String(login), String(password)) },",
  '  Logout: function () { return Promise.resolve({ ok: true }) },',
  "  AuthState: function () { return Promise.resolve({ authenticated: window.__probe.authed, user: window.__probe.authed ? { email: 'probe@hibana.ir', language_pref: window.__probe.lang, calendar_pref: 'gregorian' } : null }) },",
  '  Request: function (method, p, body) { return window.__probeRequest(method, p, body) },',
  "  SetTheme: function (pref) { return Promise.resolve({ ok: true, pref: pref }) },",
  "  SyncNow: function () { return Promise.resolve({ ok: true, uploaded: 0, projects: 1, boards: 1, at: new Date().toISOString() }) },",
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
  tasks: [], categories: [], sprints: [], tags: [], task_tags: [],
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
      'window.__probeLogin = function (login, password) {',
      '  return fetch("/__probe/login", { method: "POST", body: JSON.stringify({ login, password }) }).then(function (r) { return r.json() })',
      '}',
      'window.__probeRequest = function (method, p, body) {',
      '  return fetch("/__probe/request", { method: "POST", body: JSON.stringify({ method, p, body }) }).then(function (r) { return r.json() })',
      '}',
    ].join('\n') + '\n')
  }
  if (p === '/__probe/login' && req.method === 'POST') {
    return send(200, 'application/json', JSON.stringify({ ok: true, user: { email: 'probe@hibana.ir' } }))
  }
  if (p === '/__probe/request' && req.method === 'POST') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    return req.on('end', () => {
      const { method, p: rp, body } = JSON.parse(raw)
      if (!probe.authed) return send(200, 'application/json', JSON.stringify({ status: 401, body: '{"error":"unauthorized"}' }))
      if (probe.failTransport && rp === probe.failTransport && method === 'POST') {
        return send(200, 'application/json', '__FAIL__') // the shim-side fetch rejects on a non-JSON body → transport-shaped throw
      }
      if (method === 'POST' && rp === '/api/projects') {
        let parsed = {}
        try { parsed = JSON.parse(body || '{}') } catch {}
        probe.createCalls.push(parsed)
        const respond = () => {
          if (probe.nextCreateStatus) {
            const st = probe.nextCreateStatus
            probe.nextCreateStatus = null
            return send(200, 'application/json', JSON.stringify({ status: st, body: '{"error":"unauthorized"}' }))
          }
          // 201 {ok,id} — the real API's idempotent-create resolve; the project
          // joins the seeded set so the fresh devboard + the switcher list have it.
          probe.projects.push({ id: parsed.id, title: parsed.title, status: 'planning', type: 'personal' })
          return send(200, 'application/json', JSON.stringify({ status: 201, body: JSON.stringify({ ok: true, id: parsed.id }) }))
        }
        if (probe.slowCreateMs > 0) return setTimeout(respond, probe.slowCreateMs)
        return respond()
      }
      if (rp === '/api/projects?sort=recent') {
        return send(200, 'application/json', JSON.stringify({ status: 200, etag: null, body: JSON.stringify({ projects: probe.projects }) }))
      }
      const m = /^\/api\/projects\/([^/]+)\/devboard$/.exec(rp)
      if (m) {
        probe.devboardGets.push(rp)
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

  try {
    // ---- 1. the authed boot with two seeded projects ----
    await page.goto(base + '/kanban?project=11111111-1111-4111-8111-111111111111', { waitUntil: 'load' })
    await page.waitForFunction(() => {
      const t = document.getElementById('db-title')
      return t && t.textContent.trim() === 'Hibana Web'
    }, null, { timeout: 8000 })
    check('the authed boot loads the seeded board (Hibana Web)', true)

    // ---- 2. the switcher popup: the runtime-injected New project row ----
    await page.click('#db-project-switch')
    await page.waitForSelector('#db-switch-pop', { state: 'visible', timeout: 5000 })
    await page.waitForSelector('#db-switch-new', { timeout: 5000 })
    const sw = await page.evaluate(() => {
      const pop = document.getElementById('db-switch-pop')
      const row = document.getElementById('db-switch-new')
      const all = pop ? pop.querySelector('.db-switch-all') : null
      return {
        rowCount: pop ? pop.querySelectorAll('.db-switch-row[data-switch-id]').length : 0,
        newRowLabel: row ? row.textContent.trim() : null,
        newRowVisible: row ? row.getBoundingClientRect().height > 0 : false,
        newRowIsLastChild: !!(pop && row && pop.lastElementChild === row),
        allLinkDisplay: all ? getComputedStyle(all).display : null,
      }
    })
    check('the switcher renders the 2 seeded projects', sw.rowCount === 2, 'rows: ' + sw.rowCount)
    check('the New project row is injected at the popup\'s foot (the last child)', sw.newRowIsLastChild)
    check('the New project row is visible + labeled with the pin\'s cmdk.newProject', sw.newRowVisible && sw.newRowLabel === 'New project', JSON.stringify(sw.newRowLabel))
    check('the dead "All projects →" link is css-hidden (the desktop serves no projects page)', sw.allLinkDisplay === 'none', JSON.stringify(sw.allLinkDisplay))

    await page.screenshot({ path: path.join(args.out, 'switcher-new-row.png') })

    // the row SURVIVES the list's re-render (type in the search box)
    await page.fill('#db-switch-q', 'desktop')
    await page.waitForFunction(() => {
      const l = document.getElementById('db-switch-list')
      return l && l.querySelectorAll('.db-switch-row[data-switch-id]').length === 1
    }, null, { timeout: 5000 })
    const rowAfterSearch = await page.evaluate(() => !!document.getElementById('db-switch-new'))
    check('the New project row SURVIVES the list re-render (a popup sibling, not a list child)', rowAfterSearch)

    // ---- 3. the create dialog: open via the row; the labels; the validation ----
    await page.click('#db-switch-new')
    await page.waitForFunction(() => { const d = document.getElementById('db-newproject-dialog'); return d && d.open }, null, { timeout: 5000 })
    const dlg = await page.evaluate(() => {
      const g = (id) => (document.getElementById(id) || {})
      return {
        title: (g('db-newproject-title') || {}).textContent.trim(),
        body: (g('db-newproject-body') || {}).textContent.trim(),
        focused: document.activeElement && document.activeElement.id === 'db-newproject-title-input',
        labels: Array.from(document.querySelectorAll('#db-newproject-dialog .modal label > span')).map((s) => s.textContent.trim()),
        create: g('db-newproject-create').textContent.trim(),
        cancel: g('db-newproject-cancel').textContent.trim(),
        cta: g('db-newproject-create').className,
      }
    })
    check('clicking the row opens the native create dialog', true)
    check('the dialog title rides the pin\'s cmdk.newProject', dlg.title === 'New project', JSON.stringify(dlg.title))
    check('the dialog body is the cloud-create copy', /created on the Hibana cloud/.test(dlg.body), JSON.stringify(dlg.body))
    check('the title input is focused on open', dlg.focused)
    check('the field labels ride sparks.title / sparks.description', dlg.labels.join('|') === 'Title|Description', JSON.stringify(dlg.labels))
    check('the actions ride cat.quickAdd / common.cancel (Create is the BARE CTA button)', dlg.create === 'Create' && dlg.cancel === 'Cancel' && dlg.cta === '', JSON.stringify({ c: dlg.create, x: dlg.cancel, cls: dlg.cta }))

    await page.screenshot({ path: path.join(args.out, 'newproject-dialog.png') })

    // the empty-title validation
    await page.click('#db-newproject-create')
    await page.waitForFunction(() => {
      const e = document.getElementById('db-newproject-error')
      return e && !e.hidden && e.textContent.trim().length > 0
    }, null, { timeout: 5000 })
    const emptyErr = await page.textContent('#db-newproject-error')
    check('an empty title surfaces the honest validation line', /name first/.test(emptyErr), JSON.stringify(emptyErr))

    // ---- 4. THE LIVE CREATE: the wire payload + the fresh-board boot ----
    await page.fill('#db-newproject-title-input', 'Probe Project Alpha')
    await page.fill('#db-newproject-description', 'Born from the desktop probe')
    const before = probe.createCalls.length
    await page.click('#db-newproject-create')
    await page.waitForFunction(() => location.search.indexOf('project=') > -1 && location.search !== '?project=11111111-1111-4111-8111-111111111111', null, { timeout: 8000 })
    const call = probe.createCalls[before]
    check('Create POSTs /api/projects through the shim seam (the bridge capture)', !!call, JSON.stringify(probe.createCalls.length))
    check('the payload carries the client-minted v4 UUID (the idempotency key)', !!call && UUID_RE.test(call.id), JSON.stringify(call && call.id))
    check('the payload carries the title + the description', !!call && call.title === 'Probe Project Alpha' && call.description === 'Born from the desktop probe')
    check('the payload pins status \'planning\' (the switcher\'s list excludes sparks)', !!call && call.status === 'planning', JSON.stringify(call && call.status))
    check('the payload sends NOTHING else (type/tags/due_date/folder_id stay unsent)', !!call && Object.keys(call).sort().join(',') === 'description,id,status,title', JSON.stringify(call && Object.keys(call).sort()))
    await page.waitForFunction(() => {
      const t = document.getElementById('db-title')
      return t && t.textContent.trim() === 'Probe Project Alpha'
    }, null, { timeout: 8000 })
    const board = await page.evaluate(() => ({
      title: (document.getElementById('db-title') || {}).textContent.trim(),
      counts: (document.getElementById('db-counts') || {}).textContent.trim(),
      columns: document.querySelectorAll('#db-board .pd-col').length,
      url: location.href,
    }))
    check('the 201 {ok,id} resolve deep-links the island\'s /kanban?project=<id> boot', /kanban\?project=/.test(board.url), JSON.stringify(board.url))
    check('the fresh board renders THE NEW PROJECT as its board', board.title === 'Probe Project Alpha', JSON.stringify(board.title))
    check('the fresh kanban renders (the columns + the 0/0 counts line)', board.columns > 0 && /0 of 0 done/.test(board.counts), 'columns: ' + board.columns + ' counts: ' + JSON.stringify(board.counts))
    check('the board boot issued the new project\'s devboard GET', probe.devboardGets.some((g) => g.includes(call.id)), JSON.stringify(probe.devboardGets))

    await page.screenshot({ path: path.join(args.out, 'newproject-created-board.png') })

    // the switcher list now contains the created project too (the mock set grew:
    // the 2 seeded + Probe Project Alpha — "Slow Create" joins later, in step 5)
    await page.click('#db-project-switch')
    await page.waitForSelector('#db-switch-pop', { state: 'visible', timeout: 5000 })
    await page.waitForFunction(() => document.querySelectorAll('#db-switch-list .db-switch-row[data-switch-id]').length >= 3, null, { timeout: 8000 })
    const hasNew = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#db-switch-list .db-switch-row[data-switch-id]'))
      const names = rows.map((r) => r.textContent.trim())
      return { n: rows.length, has: names.some((x) => x.includes('Probe Project Alpha')), newRow: !!document.getElementById('db-switch-new') }
    })
    check('the created project + the New project row render together in the re-opened switcher', hasNew.n === 3 && hasNew.has && hasNew.newRow, JSON.stringify(hasNew))
    await page.keyboard.press('Escape')

    // ---- 5. the Esc-while-busy guard (an in-flight create cannot be dropped) ----
    probe.slowCreateMs = 600
    await page.click('#db-project-switch')
    await page.waitForSelector('#db-switch-pop', { state: 'visible', timeout: 5000 })
    await page.click('#db-switch-new')
    await page.waitForFunction(() => { const d = document.getElementById('db-newproject-dialog'); return d && d.open }, null, { timeout: 5000 })
    await page.fill('#db-newproject-title-input', 'Slow Create')
    await page.click('#db-newproject-create')
    await page.waitForTimeout(150) // the POST is now in flight
    await page.keyboard.press('Escape')
    const stillOpen = await page.evaluate(() => { const d = document.getElementById('db-newproject-dialog'); return !!(d && d.open) })
    check('Esc during the in-flight create keeps the dialog open (the cancel is guarded)', stillOpen)
    await page.waitForFunction(() => document.getElementById('db-title') && document.getElementById('db-title').textContent.trim() === 'Slow Create', null, { timeout: 8000 })
    check('the slow create resolves → the fresh board boots anyway', true)
    probe.slowCreateMs = 0

    // ---- 6. the no-projects empty state + the dead CTA interception ----
    probe.projects = []
    await page.goto(base + '/kanban', { waitUntil: 'load' })
    await page.waitForFunction(() => {
      const el = document.querySelector('#db-board .db-noprojects .empty-state-cta')
      return el && el.href.endsWith('/projects.html') && el.getBoundingClientRect().height > 0
    }, null, { timeout: 8000 })
    check('the no-projects empty state renders (the seeded set was emptied)', true)
    const ctaText = await page.evaluate(() => document.querySelector('#db-board .db-noprojects .empty-state-cta').textContent.trim())
    check('the empty state\'s CTA is the dead /projects.html link (the interception target)', /Go to projects/.test(ctaText), JSON.stringify(ctaText))
    await page.click('#db-board .db-noprojects .empty-state-cta')
    await page.waitForFunction(() => { const d = document.getElementById('db-newproject-dialog'); return d && d.open }, null, { timeout: 5000 })
    const stillKanban = await page.evaluate(() => location.pathname + location.search)
    check('clicking the dead CTA opens the CREATE dialog (no dead navigation)', stillKanban.startsWith('/kanban'), JSON.stringify(stillKanban))

    await page.screenshot({ path: path.join(args.out, 'newproject-empty-cta.png') })

    // ---- 7. the honest failure branches (the dialog stays open, no fake queue) ----
    // 401 — the session line (the bridge opens the login card in production)
    probe.nextCreateStatus = 401
    await page.fill('#db-newproject-title-input', 'Denied Create')
    await page.click('#db-newproject-create')
    await page.waitForFunction(() => {
      const e = document.getElementById('db-newproject-error')
      const d = document.getElementById('db-newproject-dialog')
      return e && !e.hidden && /session expired/.test(e.textContent) && d && d.open
    }, null, { timeout: 5000 })
    check('a 401 surfaces the session line + the dialog stays open', true)
    // transport — the unreachable line
    probe.failTransport = '/api/projects'
    await page.evaluate(() => { const b = document.getElementById('db-newproject-create'); if (b) b.disabled = false })
    await page.fill('#db-newproject-title-input', 'Offline Create')
    await page.click('#db-newproject-create')
    await page.waitForFunction(() => {
      const e = document.getElementById('db-newproject-error')
      const d = document.getElementById('db-newproject-dialog')
      return e && !e.hidden && /Cannot reach hibana\.ir/.test(e.textContent) && d && d.open
    }, null, { timeout: 5000 })
    check('a transport failure surfaces the unreachable line + NO fake offline queue', true)
    probe.failTransport = null
    probe.projects = [
      { id: '11111111-1111-4111-8111-111111111111', title: 'Hibana Web', status: 'planning', type: 'personal' },
    ]

    // ---- 8. the FA/RTL mirror in the dark look ----
    probe.lang = 'fa'
    probe.theme = 'claude-dark'
    await page.goto(base + '/kanban?project=11111111-1111-4111-8111-111111111111', { waitUntil: 'load' })
    await page.waitForFunction(() => {
      const t = document.getElementById('db-title')
      return t && t.textContent.trim() === 'Hibana Web'
    }, null, { timeout: 8000 })
    await page.click('#db-project-switch')
    await page.waitForSelector('#db-switch-pop', { state: 'visible', timeout: 5000 })
    await page.waitForFunction(() => {
      const r = document.getElementById('db-switch-new-label')
      return r && r.textContent.trim() === 'پروژهٔ جدید'
    }, null, { timeout: 8000 })
    check('the FA switcher row carries the pin\'s own پروژهٔ جدید label', true)
    await page.click('#db-switch-new')
    await page.waitForFunction(() => { const d = document.getElementById('db-newproject-dialog'); return d && d.open }, null, { timeout: 5000 })
    const faDlg = await page.evaluate(() => {
      const g = (id) => (document.getElementById(id) || {})
      return {
        dir: document.documentElement.getAttribute('dir'),
        body: (g('db-newproject-body') || {}).textContent.trim(),
        labels: Array.from(document.querySelectorAll('#db-newproject-dialog .modal label > span')).map((s) => s.textContent.trim()),
        create: g('db-newproject-create').textContent.trim(),
        cancel: g('db-newproject-cancel').textContent.trim(),
        theme: document.documentElement.getAttribute('data-theme') || document.documentElement.getAttribute('data-desktop-theme'),
      }
    })
    check('i18n applied dir=rtl', faDlg.dir === 'rtl', JSON.stringify(faDlg.dir))
    check('the dark look painted at first boot (data-theme)', faDlg.theme === 'claude-dark', JSON.stringify(faDlg.theme))
    check('the FA dialog body copy ships (ابر هیبانا)', /ابر هیبانا/.test(faDlg.body), JSON.stringify(faDlg.body))
    check('the FA field labels ride the pin dictionary (عنوان / توضیحات)', faDlg.labels.join('|') === 'عنوان|توضیحات', JSON.stringify(faDlg.labels))
    check('the FA actions ride the pin dictionary (ساختن / انصراف)', faDlg.create === 'ساختن' && faDlg.cancel === 'انصراف', JSON.stringify({ c: faDlg.create, x: faDlg.cancel }))

    await page.screenshot({ path: path.join(args.out, 'newproject-fa-dark.png') })
  } catch (err) {
    failures.push('threw: ' + err.message)
    console.error('[probe] ' + err.message)
  } finally {
    await browser.close().catch(() => {})
    server.close()
  }

  check('ZERO page errors through the whole round', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300))

  if (failures.length) {
    console.error('\n[probe] FAILED (' + failures.length + '): ' + failures.join('; '))
    process.exit(1)
  }
  console.log('\n[probe] ALL PASS — screenshots in ' + args.out + ' (switcher-new-row.png, newproject-dialog.png, newproject-created-board.png, newproject-empty-cta.png, newproject-fa-dark.png)')
}

main().catch((err) => {
  console.error('[probe] ' + err)
  process.exit(1)
})
