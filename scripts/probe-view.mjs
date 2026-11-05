#!/usr/bin/env node
// ============================================================================
// probe-view.mjs — the S238 TASK-VIEW probe (Chromium via Playwright).
//
// WHAT IT PROVES, against the REAL generated island bytes (frontend/dist):
//   1. THE ISLAND SERVES + THE CHAIN + THE S238 CARRIERS: /kanban (index.html)
//      returns 200, the desktop-owned chain loads, and the round's carriers
//      ship: board-page.js v28 carries openTaskView/db-view/data-db-sheet-copy
//      + devboard.css v39 carries the blur+greyscale backdrop recipe, the
//      FIXED 800×600 sheet, the .db-view family + .db-sheet-copy + the
//      400-weight priority labels (polish-batch.css / quicknotes.css).
//   2. LOGIN → THE BOARD RENDERS → THE CARD CLICK OPENS THE READ-ONLY VIEW:
//      .db-view-card visible, NO editor modal, focusState().viewTaskId === t1,
//      the full definition (heading + content lines), the inert prio banner
//      at the REGULAR weight, the meta rows.
//   3. THE VIEW'S OWN ACTIONS: Copy writes the RAW full definition to the
//      clipboard (stubbed + counted), Edit hands off to the REAL editor
//      (.db-modal-card), and the ⋯ menu's Edit opens it too (the owner's
//      split: menu = edit).
//   4. THE SHEET (focus mode ON through the desktop panel): the FIXED ~800×600
//      box (computed), the blurred+greyscale backdrop (computed), the one-tap
//      .db-sheet-copy on every row, the ARMED cloned ⋯ (Edit present — the
//      data-ok strip), and the sheet's one-tap copy writing the raw title.
//   5. THE LAYERED ESC: a view opened from a sheet row stacks ABOVE it
//      (z 85 > 80) → ONE Esc peels the VIEW only → the second peels the sheet.
//   6. THE OFF STATE + ZERO PAGE ERRORS through the whole flow.
//
// The mock server reuses probe-focus.mjs's contract. All board data flows
// through the seam (hibanaFetch → the mock's /__probe/request handler)
// exactly as it does inside the real shell. The clipboard is stubbed per
// context (headless Chromium has none) with a write counter.
// ============================================================================

import { createRequire } from 'node:module'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const a = { src: '/home/z/hibana-source', dist: path.join(REPO_ROOT, 'frontend/dist'), out: '/tmp/probe-view', port: 3141 }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--src') a.src = argv[++i]
    else if (argv[i] === '--dist') a.dist = path.resolve(argv[++i])
    else if (argv[i] === '--out') a.out = argv[++i]
    else if (argv[i] === '--port') a.port = parseInt(argv[i + 1], 10)
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
// t1 carries a MULTI-LINE definition — the view's full-definition contract.
const freshTasks = () => [
  { id: 't1', project_id: P1, title: 'View probe task one\nwith a second line of the definition\nand a third line for the body', status: 'planned', priority: 'high', category_id: null, sprint_id: null, sort_order: 0, created_at: '2026-01-01T00:00:00.000Z', done_at: null, start_at: null, end_at: null, search_tags: '', updated_at: '2026-01-02T00:00:00.000Z', tags: [], shot_count: 0 },
  { id: 't2', project_id: P1, title: 'View probe task two', status: 'in_progress', priority: 'medium', category_id: null, sprint_id: null, sort_order: 1, created_at: '2026-01-01T00:00:00.000Z', done_at: null, start_at: null, end_at: null, search_tags: '', updated_at: '2026-01-02T00:00:00.000Z', tags: [], shot_count: 0 },
]
const probe = {
  authed: false,
  lang: 'en',
  theme: null,
  projects: [{ id: P1, title: 'Hibana View Probe', status: 'planning', type: 'personal' }],
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
      let m = /^\/api\/projects\/([^/]+)\/devtasks$/.exec(rp)
      if (m && (rm || 'GET').toUpperCase() === 'POST') {
        let parsed = {}
        try { parsed = JSON.parse(body || '{}') } catch (e) { /* the island pre-stringifies */ }
        const t = {
          id: 'vt-' + (probe.createdTasks.length + 1), project_id: m[1],
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

  // The clipboard stub (headless has none) — counts every write.
  const CLIPBOARD_STUB = () => {
    window.__clip = []
    try {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: (t) => { window.__clip.push(String(t)); return Promise.resolve() } }, configurable: true })
    } catch (e) { /* */ }
  }
  const clipWrites = (page) => page.evaluate(() => (window.__clip || []).slice())

  // The view-shape reader.
  const viewShape = (page) => page.evaluate(() => {
    const view = document.getElementById('db-view-overlay')
    const state = (window.HibanaBoard && window.HibanaBoard.focusState) ? window.HibanaBoard.focusState() : null
    return {
      state,
      viewOpen: !!(view && !view.hidden),
      title: view ? (view.querySelector('.db-view-task-title') || {}).textContent : null,
      content: view ? (view.querySelector('.db-view-task-content') || {}).textContent : null,
      banner: view ? (view.querySelector('.db-view-prio') || {}).textContent : null,
      bannerWeight: view ? getComputedStyle(view.querySelector('.db-view-prio')).fontWeight : null,
      headLane: view ? (view.querySelector('.db-view-head h3') || {}).textContent : null,
      metaText: view ? (view.querySelector('.db-view-meta') || {}).textContent : null,
      hasCopy: !!(view && view.querySelector('[data-db-view-copy]')),
      hasEdit: !!(view && view.querySelector('[data-db-view-edit]')),
      hasX: !!(view && view.querySelector('[data-db-view-x]')),
      editorOpen: !!document.querySelector('.db-modal:not([hidden])'),
    }
  })

  console.log('\n— leg 1: the island serves + the desktop chain + the S238 carriers')
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.addInitScript(CLIPBOARD_STUB)
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
      hasFocusCore: !!window.HibanaFocusCore,
      hasEscPeel: !!(window.HibanaFocusCore && typeof window.HibanaFocusCore.escPeel === 'function'),
      coreV2: !!Array.from(document.querySelectorAll('script[src*="/js/focus-core.js?v=2"]')).length,
    }))
    check('the desktop chain loaded (hibanaFetch + __hibanaPage + hibana toast)', chain.hasFetch && chain.hasPage && chain.hasHibana, JSON.stringify(chain))
    check('js/focus-core.js?v=2 loaded + carries escPeel (window.HibanaFocusCore)', chain.hasFocusCore && chain.hasEscPeel && chain.coreV2, JSON.stringify(chain))

    // The S238 carriers, from the REAL dist bytes.
    const boardPageJs = fs.readFileSync(path.join(args.dist, 'js/board-page.js'), 'utf8')
    const devCss = await page.evaluate(() => fetch('/css/devboard.css?v=39').then((r) => r.text()))
    const polishCss = await page.evaluate(() => fetch('/css/polish-batch.css?v=30').then((r) => r.text()))
    const quickCss = await page.evaluate(() => fetch('/css/quicknotes.css?v=51').then((r) => r.text()))
    check('js/board-page.js carries the S238 view layer (openTaskView + db-view + the sheet copy + the data-ok strip)',
      ['openTaskView', 'db-view-overlay', 'data-db-view-edit', 'data-db-view-copy', 'data-db-sheet-copy', 'injectSheetCopyRows', "querySelectorAll('.db-card-menu[data-ok]')", 'escPeel'].every((m) => boardPageJs.includes(m)), '')
    check('css/devboard.css?v=39 carries the blur+greyscale backdrops + the FIXED 800×600 sheet + the view family + the copy button',
      devCss.includes('backdrop-filter: blur(4px) grayscale(1)') && devCss.includes('inline-size: min(50rem, 100%)') && devCss.includes('block-size: min(37.5rem, 100%)') && devCss.includes('.db-view-card') && devCss.includes('.db-sheet-copy'),
      'len=' + devCss.length)
    const bannerRule = (polishCss.match(/\.prio-banner \{[^}]+\}/) || [''])[0]
    check('css/polish-batch.css?v=30 reads the banner at font-weight: 400 (regular)', bannerRule.includes('font-weight: 400'), '')
    const pillRule = (quickCss.match(/\.pd-detail-prio \{[^}]+\}/) || [''])[0]
    check('css/quicknotes.css?v=51 reads the detail pill at font-weight: 400 (regular)', pillRule.includes('font-weight: 400'), '')
    await page.screenshot({ path: path.join(args.out, '00-leg1-carriers.png') })
    check('ZERO page errors (leg 1)', pageErrors.length === 0, pageErrors.join(' | '))
    await context.close()
  }

  console.log('\n— leg 2: login → the board renders → THE CARD CLICK OPENS THE READ-ONLY VIEW')
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.addInitScript(CLIPBOARD_STUB)
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    probe.authed = false

    await page.goto(base + '/kanban?project=' + P1, { waitUntil: 'domcontentloaded' })
    await page.fill('#login-gate-login', 'probe@hibana.ir')
    await page.fill('#login-gate-password', 'probe-right')
    await page.click('#login-gate-submit')
    await page.waitForFunction(() => document.documentElement.getAttribute('data-desktop-authed') === 'true', null, { timeout: 10000 })
    await page.waitForSelector('#login-gate', { state: 'hidden', timeout: 5000 })
    await page.waitForSelector('.db-cols > .pd-col', { timeout: 10000 })

    // THE S238 CONTRACT: the card click opens the VIEW — never the editor.
    await page.click('.pd-col[data-status="planned"] .pd-task')
    await page.waitForSelector('.db-view-card', { timeout: 5000 })
    const v2 = await viewShape(page)
    check('the card click opened the READ-ONLY view (no editor modal)', v2.viewOpen && v2.editorOpen === false, JSON.stringify(v2.state))
    check("focusState().viewTaskId reports the open task ('t1')", v2.state && v2.state.viewTaskId === 't1', JSON.stringify(v2.state))
    check('the view carries the S233 ✕ + the Copy/Edit foot', v2.hasX && v2.hasCopy && v2.hasEdit)
    check('the head names the lane (Plans)', v2.headLane === 'Plans', JSON.stringify(v2.headLane))
    check('the FULL definition renders (heading + the content lines, unclamped)',
      (v2.title || '').includes('View probe task one') && (v2.content || '').includes('second line of the definition') && (v2.content || '').includes('third line for the body'),
      JSON.stringify({ title: (v2.title || '').slice(0, 30), content: (v2.content || '').slice(0, 30) }))
    check('the inert banner reads the priority at the REGULAR weight (400)', /high/i.test(String(v2.banner)) && v2.bannerWeight === '400', JSON.stringify({ banner: v2.banner, weight: v2.bannerWeight }))
    check('the meta row carries the Created line', /created/i.test(String(v2.metaText)), '')
    await page.screenshot({ path: path.join(args.out, '01-leg2-view.png') })

    // Esc closes the view (one layer, nothing else was open).
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
    const v2b = await viewShape(page)
    check('Esc closed the view', v2b.viewOpen === false && (v2b.state ? v2b.state.viewTaskId === null : true), JSON.stringify(v2b.state))
    check('ZERO page errors (leg 2)', pageErrors.length === 0, pageErrors.join(' | '))
    await context.close()
  }

  console.log('\n— leg 3: the view\'s Copy + Edit, and the ⋯ menu\'s Edit (the owner\'s split: menu = edit)')
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.addInitScript(CLIPBOARD_STUB)
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    probe.authed = false

    await page.goto(base + '/kanban?project=' + P1, { waitUntil: 'domcontentloaded' })
    await page.fill('#login-gate-login', 'probe@hibana.ir')
    await page.fill('#login-gate-password', 'probe-right')
    await page.click('#login-gate-submit')
    await page.waitForFunction(() => document.documentElement.getAttribute('data-desktop-authed') === 'true', null, { timeout: 10000 })
    await page.waitForSelector('#login-gate', { state: 'hidden', timeout: 5000 })
    await page.waitForSelector('.db-cols > .pd-col', { timeout: 10000 })

    await page.click('.pd-col[data-status="planned"] .pd-task')
    await page.waitForSelector('.db-view-card', { timeout: 5000 })

    // The view's Copy → the RAW full definition on the clipboard.
    await page.click('[data-db-view-copy]')
    await page.waitForTimeout(300)
    const writes = await clipWrites(page)
    check('the view\'s Copy wrote the RAW full definition (all three lines)',
      writes.length === 1 && writes[0].includes('View probe task one') && writes[0].includes('second line of the definition') && writes[0].includes('third line for the body'),
      JSON.stringify(writes.map((w) => w.slice(0, 24))))

    // The view's Edit → the view closes + the REAL editor opens + it prefills.
    await page.click('[data-db-view-edit]')
    await page.waitForSelector('.db-modal-card', { timeout: 5000 })
    const editTitle = await page.locator('.db-modal [name="title"]').inputValue()
    check('the view\'s Edit handed off to the REAL editor (prefilled with the task)', editTitle.includes('View probe task one'), JSON.stringify(editTitle))
    await page.click('.db-modal [data-db-close]')
    await page.waitForSelector('.db-modal-card', { state: 'detached', timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(250)
    const afterEditor = await viewShape(page)
    check('closing the editor left the view closed (never re-stacked)', afterEditor.viewOpen === false && afterEditor.editorOpen === false, '')

    // The ⋯ menu's Edit — the OTHER sanctioned path.
    await page.locator('.pd-col[data-status="planned"] .pd-task').first().hover()
    await page.locator('.pd-col[data-status="planned"] .db-card-menu [data-menu-open]').first().click()
    await page.locator('.pd-col[data-status="planned"] [data-db-edit-card]').first().click()
    await page.waitForSelector('.db-modal-card', { timeout: 5000 })
    check('the ⋯ menu\'s Edit opened the editor (the owner\'s split holds)', true)
    await page.click('.db-modal [data-db-close]')
    await page.waitForSelector('.db-modal-card', { state: 'detached', timeout: 5000 }).catch(() => {})
    await page.screenshot({ path: path.join(args.out, '02-leg3-edit.png') })
    check('ZERO page errors (leg 3)', pageErrors.length === 0, pageErrors.join(' | '))
    await context.close()
  }

  console.log('\n— leg 4: the sheet (through the desktop panel toggle) — 800×600 + the backdrop + the one-tap copy rows')
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.addInitScript(CLIPBOARD_STUB)
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    probe.authed = false

    await page.goto(base + '/kanban?project=' + P1, { waitUntil: 'domcontentloaded' })
    await page.fill('#login-gate-login', 'probe@hibana.ir')
    await page.fill('#login-gate-password', 'probe-right')
    await page.click('#login-gate-submit')
    await page.waitForFunction(() => document.documentElement.getAttribute('data-desktop-authed') === 'true', null, { timeout: 10000 })
    await page.waitForSelector('#login-gate', { state: 'hidden', timeout: 5000 })
    await page.waitForSelector('.db-cols > .pd-col', { timeout: 10000 })

    // Focus mode ON through the desktop panel (the S237 row — same key + event).
    await page.click('#db-settings-button')
    await page.waitForSelector('#db-settings-dialog', { state: 'visible', timeout: 5000 })
    await page.click('#db-settings-focus-on')
    await page.click('#db-settings-done')
    await page.waitForTimeout(300)

    // Enlarge planned → the sheet.
    await page.click('.db-focus-enlarge[data-db-focus-sheet="planned"]')
    await page.waitForTimeout(300)
    const sheet = await page.evaluate(() => {
      const el = document.querySelector('.db-focus-sheet')
      const overlay = document.getElementById('db-focus-overlay')
      if (!el || !overlay) return null
      const r = el.getBoundingClientRect()
      return {
        w: Math.round(r.width), h: Math.round(r.height),
        backdrop: getComputedStyle(overlay).backdropFilter,
        copyButtons: overlay.querySelectorAll('.db-sheet-copy').length,
        cards: overlay.querySelectorAll('[data-task-card]').length,
        armedEdit: !!overlay.querySelector('.db-card-menu [data-db-edit-card]'),
        open: !overlay.hidden,
      }
    })
    check('the enlarge sheet opened', !!sheet && sheet.open, JSON.stringify(sheet))
    check('the sheet is the FIXED ~800×600 rectangle (computed)', sheet && Math.abs(sheet.w - 800) <= 4 && Math.abs(sheet.h - 600) <= 4, JSON.stringify({ w: sheet && sheet.w, h: sheet && sheet.h }))
    check('the sheet\'s backdrop blurs + drains to greyscale (computed)', sheet && /blur\(4px\)/i.test(sheet.backdrop) && /grayscale\(1\)/i.test(sheet.backdrop), JSON.stringify(sheet && sheet.backdrop))
    check('every sheet row carries the one-tap copy button', sheet && sheet.copyButtons === sheet.cards && sheet.cards >= 1, JSON.stringify({ copies: sheet && sheet.copyButtons, cards: sheet && sheet.cards }))
    check('the sheet\'s cloned ⋯ menu is ARMED (Edit present — the data-ok strip)', sheet && sheet.armedEdit === true, '')
    await page.screenshot({ path: path.join(args.out, '03-leg4-sheet.png') })

    // The one-tap copy writes the RAW title.
    await page.click('.db-focus-cards .db-sheet-copy')
    await page.waitForTimeout(300)
    const writes = await clipWrites(page)
    check('the sheet\'s one-tap copy wrote the RAW full definition', writes.length >= 1 && writes[writes.length - 1].includes('second line of the definition'), JSON.stringify(writes.map((w) => w.slice(0, 24))))

    // A sheet card click opens the VIEW above the sheet (z 85 > 80).
    await page.click('.db-focus-cards .pd-task')
    await page.waitForSelector('.db-view-card', { timeout: 5000 })
    const stack = await page.evaluate(() => ({
      view: getComputedStyle(document.getElementById('db-view-overlay')).zIndex,
      sheet: getComputedStyle(document.getElementById('db-focus-overlay')).zIndex,
      viewOpen: !document.getElementById('db-view-overlay').hidden,
      sheetOpen: !document.getElementById('db-focus-overlay').hidden,
    }))
    check('a sheet row click opened the VIEW stacked ABOVE the sheet (z 85 > 80)', stack.viewOpen && stack.sheetOpen && Number(stack.view) > Number(stack.sheet), JSON.stringify(stack))
    await page.screenshot({ path: path.join(args.out, '04-leg4-stack.png') })

    // ONE Esc peels the VIEW only; the second peels the sheet.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
    const peel1 = await page.evaluate(() => ({ view: document.getElementById('db-view-overlay').hidden, sheet: document.getElementById('db-focus-overlay').hidden }))
    check('the FIRST Esc peeled the VIEW only (the sheet stays)', peel1.view === true && peel1.sheet === false, JSON.stringify(peel1))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
    const peel2 = await page.evaluate(() => ({ view: document.getElementById('db-view-overlay').hidden, sheet: document.getElementById('db-focus-overlay').hidden }))
    check('the SECOND Esc peeled the sheet', peel2.view === true && peel2.sheet === true, JSON.stringify(peel2))

    // The OFF state: the panel toggle off → the buttons render away.
    await page.click('#db-settings-button')
    await page.waitForSelector('#db-settings-dialog', { state: 'visible', timeout: 5000 })
    await page.click('#db-settings-focus-off')
    await page.click('#db-settings-done')
    await page.waitForTimeout(300)
    const offShape = await page.evaluate(() => ({
      buttons: document.querySelectorAll('.db-focus-enlarge').length,
      view: !!(document.getElementById('db-view-overlay') && !document.getElementById('db-view-overlay').hidden),
    }))
    check('disabling the toggle re-rendered the enlarge buttons AWAY', offShape.buttons === 0 && offShape.view === false, JSON.stringify(offShape))
    check('ZERO page errors (leg 4)', pageErrors.length === 0, pageErrors.join(' | '))
    await page.screenshot({ path: path.join(args.out, '05-leg4-off.png') })
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
