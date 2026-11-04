#!/usr/bin/env node
// ============================================================================
// probe-focus.mjs — the S237 FOCUS-MODE probe (Chromium via Playwright).
//
// WHAT IT PROVES, against the REAL generated island bytes (frontend/dist):
//   1. THE ISLAND SERVES + THE CHAIN: /kanban (index.html) returns 200, the
//      desktop-owned chain loads (theme → shim → audio → login) AND the two
//      S237 carriers ship: js/focus-core.js (window.HibanaFocusCore) + the
//      focus recipe inside css/devboard.css?v=38.
//   2. LOGIN → THE BOARD RENDERS: the five lanes appear (.pd-col ×5).
//   3. THE SETTINGS TOGGLE IS LIVE: opening the desktop settings panel and
//      turning Focus mode ON (the S237 row — same localStorage key as the
//      web page) closes → ALL FIVE lane heads grow the two buttons
//      (window.HibanaBoard.focusState().enabled === true).
//   4. THE BLUR FOCUS: clicking planned's focus button dims the other four
//      lanes (.db-dim, planned clear) → ] moves the focus to in_progress →
//      Esc clears every dim. The focus SURVIVES a re-render (a task created
//      through the normal board flow re-applies the dim).
//   5. THE ENLARGE SHEET: planned's enlarge opens the centered sheet with the
//      sticky quick-add AUTO-FOCUSED → typing + Enter creates the task through
//      the REAL seam (POST /api/projects/:id/devtasks — the S234 classifier
//      fires the create cue) → the lane count +1 → the sheet STAYS OPEN → Esc
//      closes it (exactly one layer).
//   6. AUTO-RESTORE + THE OFF STATE: a reload with the toggle on +
//      hibana-focus-last=planned re-enters planned's focus automatically;
//      disabling the toggle in the panel re-renders the buttons AWAY.
//      ZERO page errors through the whole flow.
//
// The mock server reuses probe-sprint.mjs's contract (+ the devtasks POST the
// quick-add needs). All board data flows through the seam (hibanaFetch → the
// mock's /__probe/request handler) exactly as it does inside the real shell.
// ============================================================================

import { createRequire } from 'node:module'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const a = { src: '/home/z/hibana-source', dist: path.join(REPO_ROOT, 'frontend/dist'), out: '/tmp/probe-focus', port: 3140 }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--src') a.src = argv[++i]
    else if (argv[i] === '--dist') a.dist = path.resolve(argv[++i])
    else if (argv[i] === '--out') a.out = argv[++i]
    else if (argv[i] === '--port') a.port = parseInt(argv[++i], 10)
    else { console.error('[probe] unknown arg ' + argv[i]); process.exit(1) }
  }
  return a
}

const args = parseArgs(process.argv.slice(2))
for (const f of ['index.html', 'js/desktop-audio.js', 'js/desktop-shim.js', 'js/desktop-settings.js', 'js/board-page.js', 'js/focus-core.js']) {
  if (!fs.existsSync(path.join(args.dist, f))) {
    console.error('[probe] missing ' + f + ' under ' + args.dist + ' — run scripts/sync-island.mjs first.')
    process.exit(1)
  }
}

const P1 = '11111111-1111-4111-8111-111111111111'
const freshTasks = () => [
  { id: 't1', project_id: P1, title: 'Focus probe task one', status: 'planned', priority: 'high', category_id: null, sprint_id: null, sort_order: 0, created_at: '2026-01-01T00:00:00.000Z', done_at: null, start_at: null, end_at: null, search_tags: '', updated_at: '2026-01-02T00:00:00.000Z', tags: [], shot_count: 0 },
  { id: 't2', project_id: P1, title: 'Focus probe task two', status: 'in_progress', priority: 'medium', category_id: null, sprint_id: null, sort_order: 1, created_at: '2026-01-01T00:00:00.000Z', done_at: null, start_at: null, end_at: null, search_tags: '', updated_at: '2026-01-02T00:00:00.000Z', tags: [], shot_count: 0 },
]
const probe = {
  authed: false,
  lang: 'en',
  theme: null,
  projects: [{ id: P1, title: 'Hibana Focus Probe', status: 'planning', type: 'personal' }],
  tasks: freshTasks(),
  createdTasks: [],
  deleted: [],
  patched: [],
  loginCalls: [],
}
const MOCK_IPC_JS = 'window.WailsInvoke = function (m) { /* probe: no Go backend */ }\n'
const mockRuntimeJs = () => [
  'window.go = { desktop: { API: {',
  "  Login: function (login, password) { return fetch('/__probe/login-ok', { method: 'POST', body: JSON.stringify({ login: login }) }).then(function () { return { ok: true, user: { email: login } } }) },",
  '  Logout: function () { return Promise.resolve({ ok: true }) },',
  "  AuthState: function () { return Promise.resolve({ authenticated: window.__probe.authed, user: window.__probe.authed ? { email: 'probe@hibana.ir', language_pref: window.__probe.lang, calendar_pref: 'gregorian' } : null }) },",
  '  Request: function (method, p, body) { return window.__probeRequest(method, p, body) },',
  "  SetTheme: function (pref) { return Promise.resolve({ ok: true, pref: pref }) },",
  '} } }',
  'window.runtime = { EventsOn: function (name, cb) { (window.__probeEvents = window.__probeEvents || {}); (window.__probeEvents[name] = window.__probeEvents[name] || []).push(cb) } },',
  'window.__probeEmit = function (name, payload) { ((window.__probeEvents || {})[name] || []).forEach(function (cb) { try { cb(payload) } catch (e) {} }) },',
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
      'window.__probeRequest = function (method, p, body) {',
      '  return fetch("/__probe/request", { method: "POST", body: JSON.stringify({ method, p, body }) }).then(function (r) { return r.json() })',
      '}',
    ].join('\n') + '\n')
  }
  if (p === '/__probe/login-ok' && req.method === 'POST') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    return req.on('end', () => {
      probe.loginCalls.push(JSON.parse(raw || '{}'))
      probe.authed = true
      send(200, 'application/json', '{"ok":true}')
    })
  }
  if (p === '/__probe/request' && req.method === 'POST') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    return req.on('end', () => {
      const { method: rm, p: rp, body } = JSON.parse(raw)
      if (!probe.authed) return send(200, 'application/json', JSON.stringify({ status: 401, body: '{"error":"unauthorized"}' }))
      if (rp === '/api/projects?sort=recent') {
        return send(200, 'application/json', JSON.stringify({ status: 200, etag: null, body: JSON.stringify({ projects: probe.projects }) }))
      }
      // S237 LEG 5: the quick-add's createTask POST (the editor's own path).
      let m = /^\/api\/projects\/([^/]+)\/devtasks$/.exec(rp)
      if (m && (rm || 'GET').toUpperCase() === 'POST') {
        let parsed = {}
        try { parsed = JSON.parse(body || '{}') } catch (e) { /* the island pre-stringifies */ }
        const t = {
          id: 'ft-' + (probe.createdTasks.length + 1), project_id: m[1],
          title: parsed.title || 'Task', status: parsed.status || 'idea',
          priority: parsed.priority || 'medium', category_id: parsed.category_id || null,
          sprint_id: parsed.sprint_id || null, sort_order: probe.tasks.length,
          created_at: new Date().toISOString(), done_at: null, start_at: null, end_at: null,
          search_tags: '', updated_at: new Date().toISOString(), tags: [], shot_count: 0,
        }
        probe.createdTasks.push(t)
        probe.tasks.push(t)
        return send(200, 'application/json', JSON.stringify({ status: 200, etag: null, body: JSON.stringify(t) }))
      }
      m = /^\/api\/projects\/([^/]+)\/devboard$/.exec(rp)
      if (m) {
        const found = probe.projects.find((x) => x.id === m[1])
        if (!found) return send(200, 'application/json', JSON.stringify({ status: 404, body: '{"error":"not_found"}' }))
        return send(200, 'application/json', JSON.stringify({ status: 200, etag: null, body: devboardPayload(found) }))
      }
      m = /^\/api\/devtasks\/([^/]+)$/.exec(rp)
      if (m) {
        if ((rm || 'GET').toUpperCase() === 'DELETE') {
          probe.deleted.push(m[1])
          probe.tasks = probe.tasks.filter((t) => t.id !== m[1])
          return send(200, 'application/json', JSON.stringify({ status: 200, etag: null, body: '{"ok":true}' }))
        }
        if ((rm || 'GET').toUpperCase() === 'PATCH') {
          let parsed = {}
          try { parsed = JSON.parse(body || '{}') } catch (e) { /* */ }
          probe.patched.push({ id: m[1], status: parsed.status || null })
          const t = probe.tasks.find((x) => x.id === m[1])
          if (t && typeof parsed.status === 'string') t.status = parsed.status
          return send(200, 'application/json', JSON.stringify({ status: 200, etag: null, body: '{"ok":true}' }))
        }
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

async function main() {
  const require2 = createRequire(path.join(args.src, 'package.json'))
  const { chromium } = require2('playwright')
  fs.mkdirSync(args.out, { recursive: true })

  await new Promise((r) => server.listen(args.port, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + args.port
  const browser = await chromium.launch()
  const failures = []
  const check = (name, cond, extra) => {
    console.log((cond ? '  PASS ' : '  FAIL ') + name + (extra ? ' — ' + extra : ''))
    if (!cond) failures.push(name)
  }

  const AUDIO_INSTRUMENT = () => {
    window.__audioOps = { starts: 0, freqs: [] }
    const RealCtx = window.AudioContext || window.webkitAudioContext
    if (RealCtx) {
      const Wrapped = class extends RealCtx {
        createOscillator() {
          const osc = super.createOscillator()
          const realStart = osc.start.bind(osc)
          osc.start = function (...a) { window.__audioOps.starts++; return realStart(...a) }
          const param = osc.frequency
          const realSet = param.setValueAtTime.bind(param)
          param.setValueAtTime = function (v, t) { window.__audioOps.freqs.push(Math.round(v)); return realSet(v, t) }
          return osc
        }
      }
      try { window.AudioContext = Wrapped } catch (e) { /* */ }
    }
  }
  const audioStats = (page) => page.evaluate(() => ({ starts: window.__audioOps ? window.__audioOps.starts : -1, freqs: window.__audioOps ? window.__audioOps.freqs.slice() : [] }))
  const resetAudio = (page) => page.evaluate(() => { if (window.__audioOps) { window.__audioOps.starts = 0; window.__audioOps.freqs = [] } })

  // The board-shape reader (reused by every leg).
  const boardShape = (page) => page.evaluate(() => {
    const state = (window.HibanaBoard && window.HibanaBoard.focusState) ? window.HibanaBoard.focusState() : null
    const cols = Array.from(document.querySelectorAll('.db-cols > .pd-col'))
    const lanes = {}
    for (const col of cols) {
      lanes[col.getAttribute('data-status')] = {
        dim: col.classList.contains('db-dim'),
        focusBtn: !!col.querySelector('.db-focus-btn'),
        enlargeBtn: !!col.querySelector('.db-focus-enlarge'),
        count: (col.querySelector('.detail-tab-count') || {}).textContent || '',
      }
    }
    const sheet = document.getElementById('db-focus-overlay')
    const quick = sheet ? sheet.querySelector('[data-db-focus-quick]') : null
    return {
      state, lanes,
      laneCount: cols.length,
      focusActive: !!(document.querySelector('.db-cols') && document.querySelector('.db-cols').hasAttribute('data-focus-active')),
      sheetOpen: !!(sheet && !sheet.hidden),
      sheetLane: sheet ? (sheet.querySelector('[data-sheet-lane]') || {}).textContent : null,
      sheetCount: sheet ? (sheet.querySelector('[data-sheet-count]') || {}).textContent : null,
      sheetCards: sheet ? sheet.querySelectorAll('[data-task-card]').length : 0,
      quickFocused: !!(quick && document.activeElement === quick),
      quickValue: quick ? quick.value : null,
    }
  })

  console.log('\n— leg 1: the island serves + the desktop chain + the S237 carriers')
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.addInitScript(AUDIO_INSTRUMENT)
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))

    const resp = await page.goto(base + '/kanban?project=' + P1, { waitUntil: 'domcontentloaded' })
    check('the board page is served at /kanban (HTTP 200, not 404)', resp && resp.status() === 200, resp ? 'status=' + resp.status() : 'no response')

    await page.waitForSelector('#login-gate', { state: 'visible', timeout: 5000 })
    const chain = await page.evaluate(() => ({
      hasFetch: typeof window.hibanaFetch === 'function',
      hasPage: typeof window.__hibanaPage === 'function',
      hasHibana: !!(window.hibana && typeof window.hibana.toast === 'function'),
      hasAudio: !!(window.hibanaAudio && typeof window.hibanaAudio.play === 'function'),
      hasTheme: !!document.documentElement.dataset.theme,
      hasFocusCore: !!window.HibanaFocusCore,
      focusTag: !!Array.from(document.querySelectorAll('script[src*="/js/focus-core.js"]')).length,
    }))
    check('the desktop chain loaded (theme → shim → audio → login; hibanaFetch + __hibanaPage + hibana)', chain.hasFetch && chain.hasPage && chain.hasHibana && chain.hasAudio && chain.hasTheme, JSON.stringify(chain))
    check('js/focus-core.js loaded (window.HibanaFocusCore + the <script> tag)', chain.hasFocusCore && chain.focusTag, JSON.stringify(chain))
    const devCss = await page.evaluate(() => fetch('/css/devboard.css?v=38').then((r) => r.text()))
    check('css/devboard.css?v=38 carries the focus recipe (.db-dim + the sheet + the <800px hide)',
      devCss.includes('.db-cols[data-focus-active] .pd-col.db-dim') && devCss.includes('.db-focus-overlay') && devCss.includes('@media (max-width: 799px)'),
      'len=' + devCss.length)
    await page.screenshot({ path: path.join(args.out, '00-leg1-chain.png') })
    await context.close()
  }

  console.log('\n— leg 2: login → the board renders the five lanes')
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.addInitScript(AUDIO_INSTRUMENT)
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))

    await page.goto(base + '/kanban?project=' + P1, { waitUntil: 'domcontentloaded' })
    await page.fill('#login-gate-login', 'probe@hibana.ir')
    await page.fill('#login-gate-password', 'probe-right')
    await page.click('#login-gate-submit')
    await page.waitForFunction(() => document.documentElement.getAttribute('data-desktop-authed') === 'true', null, { timeout: 10000 })
    await page.waitForSelector('#login-gate', { state: 'hidden', timeout: 5000 })
    await page.waitForSelector('.db-cols > .pd-col', { timeout: 10000 })
    const shape = await boardShape(page)
    check('the board rendered the five lanes', shape.laneCount === 5, 'lanes=' + shape.laneCount)
    check('the lanes are idea/bug/planned/in_progress/done in DOM order', Object.keys(shape.lanes).join(',') === 'idea,bug,planned,in_progress,done', Object.keys(shape.lanes).join(','))
    check('focus mode defaults OFF (no head buttons, focusState().enabled === false)',
      shape.state && shape.state.enabled === false && !Object.values(shape.lanes).some((l) => l.focusBtn || l.enlargeBtn), JSON.stringify(shape.state))
    await page.screenshot({ path: path.join(args.out, '01-leg2-board.png') })
    await context.close()
  }

  console.log('\n— leg 3: the settings panel toggle is live (Focus mode ON → the five heads grow the two buttons)')
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.addInitScript(AUDIO_INSTRUMENT)
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))

    // A fresh browser context but the SHARED mock: reset the auth stamp so this
    // leg's first load boots through the login gate (probe-sprint's one-context
    // flow never sees this — this probe gives every leg its own context).
    probe.authed = false
    await page.goto(base + '/kanban?project=' + P1, { waitUntil: 'domcontentloaded' })
    await page.fill('#login-gate-login', 'probe@hibana.ir')
    await page.fill('#login-gate-password', 'probe-right')
    await page.click('#login-gate-submit')
    await page.waitForFunction(() => document.documentElement.getAttribute('data-desktop-authed') === 'true', null, { timeout: 10000 })
    await page.waitForSelector('#login-gate', { state: 'hidden', timeout: 5000 })
    await page.waitForSelector('.db-cols > .pd-col', { timeout: 10000 })

    // Open the desktop settings panel → the S237 Focus-mode row → ON → Done.
    await page.click('#db-settings-button')
    await page.waitForSelector('#db-settings-dialog', { state: 'visible', timeout: 5000 })
    check('the settings panel opened (the gear → the wide dialog)', true)
    const rowSeen = await page.evaluate(() => ({
      on: !!document.getElementById('db-settings-focus-on'),
      off: !!document.getElementById('db-settings-focus-off'),
      hint: !!(document.getElementById('db-settings-focus-hint')),
      label: (document.getElementById('db-settings-focus-label') || {}).textContent,
    }))
    check('the S237 Focus-mode row rides the Appearance section (On/Off seg + hint + label)', rowSeen.on && rowSeen.off && rowSeen.hint && rowSeen.label === 'Focus mode', JSON.stringify(rowSeen))
    await page.click('#db-settings-focus-on')
    await page.click('#db-settings-done')
    await page.waitForTimeout(300) // the live event → the board re-render

    const stored = await page.evaluate(() => localStorage.getItem('hibana-focus-mode'))
    check("the row wrote the SAME key the web page writes (localStorage 'hibana-focus-mode' === 'on')", stored === 'on', JSON.stringify(stored))
    const shape = await boardShape(page)
    check('ALL FIVE lane heads grew the focus button + the enlarge button (live, no reload)',
      shape.state && shape.state.enabled === true && Object.values(shape.lanes).every((l) => l.focusBtn && l.enlargeBtn),
      JSON.stringify(shape.state))
    check('window.HibanaBoard.focusState() reports the live triple', shape.state && shape.state.enabled === true && shape.state.focusedStatus === null && shape.state.sheetStatus === null, JSON.stringify(shape.state))
    await page.screenshot({ path: path.join(args.out, '02-leg3-buttons.png') })

    console.log('\n— leg 4: the blur focus (dim the other four, ] moves, Esc clears, re-render survives)')
    await page.click('.db-focus-btn[data-db-focus="planned"]')
    await page.waitForTimeout(250)
    let s4 = await boardShape(page)
    check('focusing planned dims the OTHER FOUR lanes (planned stays clear)',
      s4.state && s4.state.focusedStatus === 'planned' && ['idea', 'bug', 'in_progress', 'done'].every((k) => s4.lanes[k].dim) && s4.lanes.planned.dim === false,
      JSON.stringify(s4.state))
    check('the scope attribute rides .db-cols (the CSS recipe is armed)', s4.focusActive === true)
    const pressed = await page.evaluate(() => document.querySelector('.db-focus-btn[data-db-focus="planned"]').getAttribute('aria-pressed'))
    check('the focused lane\'s button carries aria-pressed="true"', pressed === 'true', JSON.stringify(pressed))
    await page.screenshot({ path: path.join(args.out, '03-leg4-dim.png') })

    // ] moves the focus to the next lane (planned → in_progress).
    await page.keyboard.press(']')
    await page.waitForTimeout(250)
    s4 = await boardShape(page)
    check("']' moves the focus to in_progress (wrap cycle, DOM order)", s4.state && s4.state.focusedStatus === 'in_progress' && ['idea', 'bug', 'planned', 'done'].every((k) => s4.lanes[k].dim) && s4.lanes.in_progress.dim === false, JSON.stringify(s4.state))

    // The focus SURVIVES a re-render: create a task through the NORMAL board
    // flow (the FOCUSED lane's Add-task — the dimmed lanes are pointer-inert
    // by design, the focused lane stays fully interactive) → the editor →
    // save → POST + reload, then assert the dim classes were re-applied by
    // render()'s tail.
    await resetAudio(page)
    const beforeCount = probe.createdTasks.length
    await page.click('.pd-col[data-status="in_progress"] .pd-task-add')
    await page.waitForSelector('.db-modal', { state: 'visible', timeout: 5000 })
    await page.fill('.db-modal [name=title]', 'Focus survives the re-render')
    await page.click('.db-modal [data-db-save]')
    await page.waitForFunction(() => document.querySelectorAll('.db-modal').length === 0 || !document.querySelector('.db-modal:not([hidden])'), null, { timeout: 8000 })
    await page.waitForTimeout(400)
    s4 = await boardShape(page)
    check('a task created through the normal board flow re-applied the dim (focus survives the re-render)',
      s4.state && s4.state.focusedStatus === 'in_progress' && ['idea', 'bug', 'planned', 'done'].every((k) => s4.lanes[k].dim) && s4.lanes.in_progress.dim === false,
      JSON.stringify(s4.state))
    check('the editor round crossed the seam (POST /api/projects/:id/devtasks)', probe.createdTasks.length === beforeCount + 1, 'created=' + probe.createdTasks.length)
    const chime = await audioStats(page)
    check('the create cue fired (the S234 classifier sees the editor path too)', chime.starts >= 3 && chime.freqs.includes(220) && chime.freqs.includes(440), JSON.stringify(chime))

    // Esc peels exactly ONE layer: with no sheet open, it clears the focus.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
    s4 = await boardShape(page)
    check('Esc cleared the blur focus (every dim class gone, no sheet was open)',
      s4.state && s4.state.focusedStatus === null && !Object.values(s4.lanes).some((l) => l.dim) && s4.focusActive === false,
      JSON.stringify(s4.state))
    const lastStored = await page.evaluate(() => localStorage.getItem('hibana-focus-last'))
    check("hibana-focus-last remembers the lane ('in_progress')", lastStored === 'in_progress', JSON.stringify(lastStored))
    await page.screenshot({ path: path.join(args.out, '04-leg4-esc.png') })

    console.log('\n— leg 5: the enlarge sheet (auto-focus quick-add → Enter creates → +1 → stays open → Esc closes)')
    const laneCountBefore = (await boardShape(page)).lanes.planned.count
    await page.click('.db-focus-enlarge[data-db-focus-sheet="planned"]')
    await page.waitForTimeout(300)
    let s5 = await boardShape(page)
    check('the enlarge sheet opened (the overlay is visible, role=dialog)', s5.sheetOpen && s5.state.sheetStatus === 'planned', JSON.stringify(s5.state))
    check('the sheet\'s title rides the lane (Plans) + its count badge mirrors the lane\'s', s5.sheetLane === 'Plans' && s5.sheetCount.trim() === s5.lanes.planned.count.trim(), JSON.stringify({ lane: s5.sheetLane, sheetCount: s5.sheetCount, laneCount: s5.lanes.planned.count }))
    check('the sticky quick-add is AUTO-FOCUSED', s5.quickFocused === true)
    check('the sheet mirrors the lane\'s cards (the lane\'s own card count, cloned in)', s5.sheetCards === Number(s5.lanes.planned.count.trim()), 'cards=' + s5.sheetCards + ' lane=' + s5.lanes.planned.count)
    const draggable = await page.evaluate(() => Array.from(document.querySelectorAll('#db-focus-overlay .pd-task')).every((el) => el.getAttribute('draggable') === 'false'))
    check('drag is disabled inside the sheet (v1 — draggable=false on every card)', draggable)
    await page.screenshot({ path: path.join(args.out, '05-leg5-sheet.png') })

    // Type + Enter → createTask through the REAL seam → count +1 → sheet STAYS OPEN.
    await resetAudio(page)
    const postsBefore = probe.createdTasks.length
    await page.keyboard.type('A quick-added task from the sheet')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(900) // the POST + reload + refreshSheet beat
    s5 = await boardShape(page)
    check('the quick-add crossed the seam (POST /api/projects/:id/devtasks, +1 task)', probe.createdTasks.length === postsBefore + 1, 'created=' + probe.createdTasks.length)
    check('the lane count badge grew by one (+1)', s5.lanes.planned.count.trim() === String(Number(laneCountBefore.trim()) + 1), JSON.stringify({ before: laneCountBefore, after: s5.lanes.planned.count }))
    check('the sheet STAYED OPEN after the create (rapid entry)', s5.sheetOpen === true && s5.state.sheetStatus === 'planned')
    check('the input was cleared + re-focused for the next line', s5.quickValue === '' && s5.quickFocused === true, JSON.stringify({ value: s5.quickValue, focused: s5.quickFocused }))
    const quickChime = await audioStats(page)
    check('the S234 create cue fired for the sheet\'s quick-add (the classifier sees the seam)', quickChime.starts >= 3 && quickChime.freqs.includes(220) && quickChime.freqs.includes(440), JSON.stringify(quickChime))

    // Esc peels exactly ONE layer: the SHEET closes while any blur focus stays.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
    s5 = await boardShape(page)
    check('Esc closed the sheet (exactly one layer)', s5.sheetOpen === false && s5.state && s5.state.sheetStatus === null, JSON.stringify(s5.state))
    await page.screenshot({ path: path.join(args.out, '06-leg5-esc.png') })

    console.log('\n— leg 6: auto-restore on reload + the OFF state re-render')
    // Re-enter a focus (writes hibana-focus-last), then reload: auto-restore.
    await page.click('.db-focus-btn[data-db-focus="planned"]')
    await page.waitForTimeout(250)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.db-cols > .pd-col', { timeout: 10000 })
    await page.waitForTimeout(400)
    const s6 = await boardShape(page)
    check('after the reload the toggle is still ON (the persisted key)', s6.state && s6.state.enabled === true, JSON.stringify(s6.state))
    check('auto-restore re-entered the remembered lane (hibana-focus-last=planned)',
      s6.state && s6.state.focusedStatus === 'planned' && ['idea', 'bug', 'in_progress', 'done'].every((k) => s6.lanes[k].dim) && s6.lanes.planned.dim === false,
      JSON.stringify(s6.state))
    await page.screenshot({ path: path.join(args.out, '07-leg6-restore.png') })

    // Disable in the panel → the live event re-renders the buttons AWAY.
    await page.click('#db-settings-button')
    await page.waitForSelector('#db-settings-dialog', { state: 'visible', timeout: 5000 })
    await page.click('#db-settings-focus-off')
    await page.click('#db-settings-done')
    await page.waitForTimeout(300)
    const s6b = await boardShape(page)
    check('disabling the toggle re-rendered the buttons AWAY (off = today\'s board)',
      s6b.state && s6b.state.enabled === false && !Object.values(s6b.lanes).some((l) => l.focusBtn || l.enlargeBtn) && !Object.values(s6b.lanes).some((l) => l.dim),
      JSON.stringify(s6b.state))
    const storedOff = await page.evaluate(() => localStorage.getItem('hibana-focus-mode'))
    check("the row wrote 'off' to the shared key", storedOff === 'off', JSON.stringify(storedOff))
    await page.screenshot({ path: path.join(args.out, '08-leg6-off.png') })

    check('ZERO page errors through the whole focus flow', pageErrors.length === 0, pageErrors.join(' | '))
    await context.close()
  }

  await browser.close()
  server.close()

  if (failures.length) {
    console.error('\n[probe] ' + failures.length + ' FAILED assertion' + (failures.length === 1 ? '' : 's') + ':\n  - ' + failures.join('\n  - '))
    process.exit(1)
  }
  console.log('\n[probe] ALL GREEN — screenshots under ' + args.out)
}

main().catch((e) => { console.error('[probe] fatal:', e); process.exit(1) })
