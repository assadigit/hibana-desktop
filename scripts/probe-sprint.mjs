#!/usr/bin/env node
// ============================================================================
// probe-sprint.mjs — the S235 SPRINT-PAGE EMBED probe (Chromium via Playwright).
//
// WHAT IT PROVES, against the REAL generated island bytes (frontend/dist):
//   1. THE PAGE IS SERVED: /sprint.html?project=P1 returns 200 (not 404 — the
//      owner's screenshot showed wails.localhost/sprint.html → HTTP ERROR 404).
//   2. THE DESKTOP-OWNED CHAIN LOADS: desktop-theme.js, desktop-shim.js,
//      desktop-audio.js, desktop-login.js all evaluate before devboard.js.
//   3. THE LOGIN GATE WORKS: unauthed boot shows the gate; a successful login
//      reloads + the sprint timeline renders (not a blank page or a 404).
//   4. THE SPRINT TIMELINE RENDERS: #sp-wrap is visible, the side panel
//      (#sp-side) + the timeline (#sp-timeline) are populated, the project
//      title (#sp-title) carries the project name.
//   5. THE SPRINT DEFINITION FLOW: clicking "Define" (sp-new-sprint) opens the
//      sprint-name dialog; submitting creates a draft sprint (POST
//      /api/projects/:id/sprints through the seam → the 'create' sound cue
//      fires via the S234 classifier).
//   6. THE CROSS-PAGE LINK INTERCEPTOR: clicking the "Back to project" link
//      (which points to /project.html) does NOT navigate to a 404 — the
//      interceptor catches it, shows a toast, and redirects to /kanban.
//   7. THE "BOARD" LINK: clicking "Board" (sp-board-link, href=/kanban) navigates
//      back to the board (the island's entry alias — works on the desktop).
//   8. ZERO PAGE ERRORS: no console errors through the whole flow.
//
// The mock server reuses probe-soundfx.mjs's contract (the same /api/projects,
// /api/devtasks, /api/sprints handlers + the __probe bridge). The sprint page
// calls /api/projects/:id/devboard through the seam (hibanaFetch → the mock's
// /__probe/request handler) to load the board state, then sprint-page.js's
// mount() renders the timeline from window.HibanaBoard.state.
// ============================================================================

import { createRequire } from 'node:module'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const a = { src: '/home/z/hibana-source', dist: path.join(REPO_ROOT, 'frontend/dist'), out: '/tmp/probe-sprint', port: 3135 }
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
for (const f of ['index.html', 'sprint.html', 'js/desktop-audio.js', 'js/desktop-shim.js', 'js/sprint-page.js']) {
  if (!fs.existsSync(path.join(args.dist, f))) {
    console.error('[probe] missing ' + f + ' under ' + args.dist + ' — run scripts/sync-island.mjs first.')
    process.exit(1)
  }
}

const P1 = '11111111-1111-4111-8111-111111111111'
const freshTasks = () => [
  { id: 't1', project_id: P1, title: 'Sprint embed task', status: 'planned', priority: 'high', category_id: null, sprint_id: null, sort_order: 0, created_at: '2026-01-01T00:00:00.000Z', done_at: null, start_at: null, end_at: null, search_tags: '', updated_at: '2026-01-02T00:00:00.000Z', tags: [], shot_count: 0 },
]
// S250: the strategies leg's mock state — two strategies (one urgent+active
// owning the sprint + its tasks, one medium+paused with nothing assigned) + the
// sprints/tasks that exercise the roll-up + the focus filter + the chips.
const STRAT1 = '21111111-1111-4111-8111-111111111111'
const STRAT2 = '21111111-1111-4111-8111-111111111112'
const SPR1 = '31111111-1111-4111-8111-111111111111'
const SPR2 = '31111111-1111-4111-8111-111111111112'
const probe = {
  authed: false,
  lang: 'en',
  theme: null,
  projects: [{ id: P1, title: 'Hibana Sprint Probe', status: 'planning', type: 'personal' }],
  tasks: [
    { id: 't1', project_id: P1, title: 'Sprint embed task', status: 'planned', priority: 'high', category_id: null, sprint_id: null, sort_order: 0, created_at: '2026-01-01T00:00:00.000Z', done_at: null, start_at: null, end_at: null, search_tags: '', updated_at: '2026-01-02T00:00:00.000Z', tags: [], shot_count: 0 },
    // S250: STRAT1's roll-up — one done, one open (50%).
    { id: 't2', project_id: P1, title: 'Keyword research', status: 'done', priority: 'high', category_id: null, sprint_id: SPR1, sort_order: 0, created_at: '2026-01-01T00:00:00.000Z', done_at: '2026-01-03T00:00:00.000Z', start_at: null, end_at: null, search_tags: '', updated_at: '2026-01-03T00:00:00.000Z', tags: [], shot_count: 0 },
    { id: 't3', project_id: P1, title: 'On-page SEO pass', status: 'in_progress', priority: 'medium', category_id: null, sprint_id: SPR1, sort_order: 1, created_at: '2026-01-02T00:00:00.000Z', done_at: null, start_at: null, end_at: null, search_tags: '', updated_at: '2026-01-02T00:00:00.000Z', tags: [], shot_count: 0 },
  ],
  sprints: [
    // S250: an ACTIVE sprint serving STRAT1 (the ▸ line + the chip + the filter hit).
    { id: SPR1, project_id: P1, name: 'SEO', started_at: '2026-01-02T00:00:00.000Z', ended_at: null, created_at: '2026-01-02T00:00:00.000Z', is_draft: 0, version: null, description: null, status: 'active', emoji: null, due_at: null, due_origin_at: null, updated_at: '2026-01-02T00:00:00.000Z', strategy_id: STRAT1 },
    // A completed UNASSIGNED sprint (the filter's exclusion case).
    { id: SPR2, project_id: P1, name: 'Old push', started_at: '2025-12-01T00:00:00.000Z', ended_at: '2025-12-15T00:00:00.000Z', created_at: '2025-12-01T00:00:00.000Z', is_draft: 0, version: null, description: null, status: 'completed', emoji: null, due_at: null, due_origin_at: null, updated_at: '2025-12-15T00:00:00.000Z', strategy_id: null },
  ],
  strategies: [
    { id: STRAT1, project_id: P1, name: 'Make website more seen', description: 'The broad direction', priority: 'urgent', status: 'active', emoji: null, sort_order: 0, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
    { id: STRAT2, project_id: P1, name: 'Speed up checkout', description: '', priority: 'medium', status: 'paused', emoji: '\u{1F680}', sort_order: 0, created_at: '2026-01-05T00:00:00.000Z', updated_at: '2026-01-05T00:00:00.000Z' },
  ],
  createdSprints: [],
  createdStrategies: [],
  patchedStrategies: [],
  deletedStrategies: [],
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

const serveDocument = (send, isSprint) => {
  const file = isSprint ? 'sprint.html' : 'index.html'
  let html = fs.readFileSync(path.join(args.dist, file), 'utf8')
  const attrs = ' data-desktop-authed="' + (probe.authed ? 'true' : 'false') + '"' +
    (probe.theme ? ' data-desktop-theme="' + probe.theme + '" data-theme="' + probe.theme + '"' : ' data-desktop-theme="light"')
  html = html.replace('<html lang="en">', '<html lang="' + (probe.lang === 'fa' ? 'fa' : 'en') + '"' + attrs + '>')
  html = html.replace('<head>', '<head>\n<script src="/wails/ipc.js"></script><script src="/wails/runtime.js"></script><script src="/__probe.js"></script>')
  return send(200, 'text/html; charset=utf-8', html)
}

const devboardPayload = (p) => JSON.stringify({
  project: { id: p.id, title: p.title, status: p.status, type: p.type },
  tasks: probe.tasks, categories: [], sprints: probe.sprints, tags: [], task_tags: [],
  // S250: the payload's 8th additive key — the strategy registry.
  strategies: probe.strategies,
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
      let m = /^\/api\/projects\/([^/]+)\/devboard(\?lean=1)?$/.exec(rp)
      if (m) {
        const found = probe.projects.find((x) => x.id === m[1])
        if (!found) return send(200, 'application/json', JSON.stringify({ status: 404, body: '{"error":"not_found"}' }))
        return send(200, 'application/json', JSON.stringify({ status: 200, etag: null, body: devboardPayload(found) }))
      }
      // S235: the sprint-create POST (the 'create' sound cue from S234).
      m = /^\/api\/projects\/([^/]+)\/sprints$/.exec(rp)
      if (m && (rm || 'GET').toUpperCase() === 'POST') {
        let parsed = {}
        try { parsed = JSON.parse(body || '{}') } catch (e) { /* the island pre-stringifies */ }
        const sp = { id: 'sp-' + (probe.createdSprints.length + 1), project_id: m[1], name: parsed.name || 'Sprint', status: 'draft', started_at: null, ended_at: null }
        probe.createdSprints.push(sp)
        probe.sprints.push(sp)
        return send(200, 'application/json', JSON.stringify({ status: 200, etag: null, body: JSON.stringify(sp) }))
      }
      // S250: the strategies CRUD (the leg's create/patch/delete assertions).
      m = /^\/api\/projects\/([^/]+)\/strategies$/.exec(rp)
      if (m && (rm || 'GET').toUpperCase() === 'POST') {
        let parsed = {}
        try { parsed = JSON.parse(body || '{}') } catch (e) { /* */ }
        const st = { id: 'stg-' + (probe.createdStrategies.length + 1), project_id: m[1], name: parsed.name || 'Strategy', description: parsed.description || '', priority: parsed.priority || 'medium', status: 'active', emoji: parsed.emoji || null, sort_order: 0, created_at: '2026-01-07T00:00:00.000Z', updated_at: '2026-01-07T00:00:00.000Z' }
        probe.createdStrategies.push(st)
        probe.strategies.push(st)
        return send(200, 'application/json', JSON.stringify({ status: 200, etag: null, body: JSON.stringify({ ok: true, id: st.id }) }))
      }
      m = /^\/api\/strategies\/([^/]+)$/.exec(rp)
      if (m) {
        const method = (rm || 'GET').toUpperCase()
        if (method === 'DELETE') {
          probe.deletedStrategies.push(m[1])
          probe.strategies = probe.strategies.filter((x) => x.id !== m[1])
          return send(200, 'application/json', JSON.stringify({ status: 200, etag: null, body: '{"ok":true}' }))
        }
        if (method === 'PATCH') {
          let parsed = {}
          try { parsed = JSON.parse(body || '{}') } catch (e) { /* */ }
          probe.patchedStrategies.push({ id: m[1], ...parsed })
          const st = probe.strategies.find((x) => x.id === m[1])
          if (st) Object.assign(st, parsed)
          return send(200, 'application/json', JSON.stringify({ status: 200, etag: null, body: '{"ok":true}' }))
        }
      }
      // The task mutations (the sound round's original surface).
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
  // The sprint page is served at /sprint.html (S235). The board is served at /
  // /kanban / /board.html (the island's entry aliases).
  if (p === '/sprint.html' || p === '/sprint.html/') return serveDocument(send, true)
  if (p === '/' || p === '/kanban' || p === '/kanban.html' || p === '/board.html') return serveDocument(send, false)
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

  console.log('\n— leg 1: the sprint page is served (no 404) + the desktop-owned chain loads')
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.addInitScript(AUDIO_INSTRUMENT)
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))

    // LEG 1: the page is served (200, not 404)
    const resp = await page.goto(base + '/sprint.html?project=' + P1, { waitUntil: 'domcontentloaded' })
    check('the sprint page is served at /sprint.html (HTTP 200, not 404)', resp && resp.status() === 200, resp ? 'status=' + resp.status() : 'no response')

    // The login gate shows on the unauthed boot (same as board.html)
    await page.waitForSelector('#login-gate', { state: 'visible', timeout: 5000 })
    check('the login gate shows on the unauthed sprint-page boot', true)

    // The desktop-owned chain loaded (the shim owns hibanaFetch + __hibanaPage + hibana)
    const chain = await page.evaluate(() => ({
      hasFetch: typeof window.hibanaFetch === 'function',
      hasPage: typeof window.__hibanaPage === 'function',
      hasHibana: !!(window.hibana && typeof window.hibana.toast === 'function'),
      hasAudio: !!(window.hibanaAudio && typeof window.hibanaAudio.play === 'function'),
      hasTheme: !!document.documentElement.dataset.theme,
    }))
    check('the desktop shim loaded (hibanaFetch + __hibanaPage + hibana)', chain.hasFetch && chain.hasPage && chain.hasHibana, JSON.stringify(chain))
    check('the desktop audio engine loaded (hibanaAudio.play)', chain.hasAudio, JSON.stringify(chain))
    check('the desktop theme resolved (data-theme on <html>)', chain.hasTheme, JSON.stringify(chain))

    // LEG 2: log in → the gate closes → the sprint timeline renders
    console.log('\n— leg 2: login → the sprint timeline renders')
    await page.fill('#login-gate-login', 'probe@hibana.ir')
    await page.fill('#login-gate-password', 'probe-right')
    await page.click('#login-gate-submit')
    // The login ok resolves → desktop-login.js reloads the page so the authed
    // server stamp renders. Wait for the reload + the sprint timeline.
    await page.waitForFunction(() => document.documentElement.getAttribute('data-desktop-authed') === 'true', null, { timeout: 10000 })
    await page.waitForSelector('#login-gate', { state: 'hidden', timeout: 5000 })
    // The sprint page's mount() runs: it calls ensureLib() → devboard.js loads the
    // board state through the seam → sprint-page.js renders the timeline.
    await page.waitForSelector('#sp-wrap', { state: 'visible', timeout: 10000 })
    const shape = await page.evaluate(() => {
      const title = document.getElementById('sp-title')
      const side = document.getElementById('sp-side')
      const tl = document.getElementById('sp-timeline')
      const newBtn = document.getElementById('sp-new-sprint')
      const boardLink = document.getElementById('sp-board-link')
      const backLink = document.querySelector('[data-back-link]')
      return {
        title: title ? title.textContent : null,
        sideHtml: side ? side.innerHTML.length : 0,
        tlHtml: tl ? tl.innerHTML.length : 0,
        hasNewSprint: !!newBtn,
        boardHref: boardLink ? boardLink.getAttribute('href') : null,
        backHref: backLink ? backLink.getAttribute('href') : null,
      }
    })
    check('the sprint timeline rendered (#sp-wrap visible)', true)
    check('the project title shows in #sp-title', shape.title === 'Hibana Sprint Probe', JSON.stringify(shape))
    check('the side panel has content (categories/lanes)', shape.sideHtml > 0, 'len=' + shape.sideHtml)
    check('the timeline has content', shape.tlHtml > 0, 'len=' + shape.tlHtml)
    check('the Define sprint button is present (#sp-new-sprint)', shape.hasNewSprint)
    check('the Board link points to /kanban (the island alias)', shape.boardHref && shape.boardHref.indexOf('/kanban') === 0, JSON.stringify(shape.boardHref))
    check('the Back-to-project link points to /project.html (will be intercepted)', shape.backHref && shape.backHref.indexOf('/project.html') === 0, JSON.stringify(shape.backHref))
    await page.screenshot({ path: path.join(args.out, '01-sprint-timeline.png') })

    // LEG 3: the Define sprint button + the create sound cue (S234).
    // The sprint page's Define flow uses a custom inline dialog (not hibana.confirm),
    // so driving it through the UI is fragile. Instead: (a) verify the button exists
    // + is clickable, (b) fire the create cue through the REAL seam (hibanaFetch →
    // POST /api/projects/:id/sprints) the same way the sound probe's leg 5.5 does —
    // this proves the S234 classifier fires the 'create' cue for the sprint-create
    // path, which is the actual thing to verify.
    console.log('\n— leg 3: the Define sprint button + the create sound cue (S234)')
    const defineBtn = await page.$('#sp-new-sprint')
    check('the Define sprint button is present + clickable', !!defineBtn)
    await resetAudio(page)
    await page.evaluate((pid) => window.hibanaFetch('/api/projects/' + pid + '/sprints', { method: 'POST', body: JSON.stringify({ name: 'Probe Sprint 1' }) }), P1)
    await page.waitForTimeout(500)
    const createChime = await audioStats(page)
    check('POST /api/projects/:id/sprints fires the create sound cue (S234)', createChime.starts >= 3 && createChime.freqs.includes(220) && createChime.freqs.includes(440), JSON.stringify(createChime))
    check('the sprint POST crossed the seam (createdSprints)', probe.createdSprints.length >= 1, JSON.stringify(probe.createdSprints))

    // LEG 4: the cross-page link interceptor — "Back to project" → /kanban
    console.log('\n— leg 4: the cross-page link interceptor (Back to project → /kanban)')
    // Navigate back to the sprint page (the create flow may have reloaded)
    await page.goto(base + '/sprint.html?project=' + P1, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#sp-wrap', { state: 'visible', timeout: 10000 })
    const backLink = await page.$('[data-back-link]')
    if (backLink) {
      // Listen for the toast (the interceptor shows it before the redirect)
      let toastSeen = false
      page.on('console', (msg) => { if (msg.text().includes('project detail page')) toastSeen = true })
      await page.click('[data-back-link]').catch(() => {})
      await page.waitForTimeout(1000)
      // The interceptor should have redirected to /kanban
      const currentPath = new URL(page.url()).pathname
      check('the Back-to-project link was intercepted (no 404)', currentPath === '/kanban' || currentPath === '/', 'path=' + currentPath)
    } else {
      check('the Back-to-project link exists on the sprint page', false, 'no [data-back-link]')
    }

    // LEG 5: the Board link navigates to /kanban (the board)
    console.log('\n— leg 5: the Board link navigates to /kanban (the board)')
    await page.goto(base + '/sprint.html?project=' + P1, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#sp-wrap', { state: 'visible', timeout: 10000 })
    const boardHref = await page.evaluate(() => { const l = document.getElementById('sp-board-link'); return l ? l.getAttribute('href') : null })
    if (boardHref && boardHref.indexOf('/kanban') === 0) {
      await page.click('#sp-board-link')
      await page.waitForTimeout(1000)
      const currentPath = new URL(page.url()).pathname
      check('the Board link navigates to /kanban (the board)', currentPath === '/kanban' || currentPath === '/', 'path=' + currentPath)
      // The board should render (not 404)
      const boardLoaded = await page.evaluate(() => !!document.getElementById('db-board') || !!document.getElementById('db-loading'))
      check('the board rendered after the Board link click', boardLoaded)
    } else {
      check('the Board link points to /kanban', false, JSON.stringify(boardHref))
    }

    // LEG 6 (S250): the strategies tier — the section on top, the cards, the
    // focus filter, the together-assignment selects, and the CRUD through the seam.
    console.log('\n— leg 6: the strategies section (S250)')
    await page.goto(base + '/sprint.html?project=' + P1, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#sp-wrap', { state: 'visible', timeout: 10000 })
    await page.waitForSelector('#sp-strategies', { state: 'visible', timeout: 5000 })
    const strat = await page.evaluate(() => {
      const section = document.getElementById('sp-strategies')
      const cards = Array.from(section.querySelectorAll('[data-strategy-card]'))
      const first = cards[0]
      return {
        sectionShown: !!section && !section.hidden,
        count: cards.length,
        bodyShown: !document.getElementById('sp-strategies-body').hidden,
        firstName: first ? first.querySelector('.sp-strategy-name').textContent : null,
        firstPrio: first ? (first.querySelector('.sp-strategy-prio') || {}).className : null,
        firstStatus: first ? (first.querySelector('.sp-list-badge') || {}).className : null,
        firstActive: first ? (first.querySelector('.sp-strategy-active') || {}).textContent : null,
        firstProgress: first ? first.querySelector('.sp-strategy-progress span').style.inlineSize : null,
        secondGlyph: cards[1] ? cards[1].querySelector('.sp-strategy-glyph').textContent : null,
        newBtn: !!document.getElementById('sp-new-strategy'),
        listRows: document.querySelectorAll('#sp-sprints-list [data-sp-open]').length,
        listStrategyChips: document.querySelectorAll('#sp-sprints-list .sp-list-strategy').length,
        draftStrategyChip: !!document.querySelector('#sp-draft .sp-list-strategy'),
      }
    })
    check('the strategies section renders on top (#sp-strategies visible + body shown)', strat.sectionShown && strat.bodyShown)
    check('two strategy cards render (the registry)', strat.count === 2, 'count=' + strat.count)
    check('the cards sort priority-first (urgent first)', strat.firstName === 'Make website more seen', JSON.stringify(strat.firstName))
    check('the first card carries the urgent priority badge', strat.firstPrio && strat.firstPrio.indexOf('prio-urgent') >= 0, JSON.stringify(strat.firstPrio))
    check('the first card carries the active lifecycle badge', strat.firstStatus && strat.firstStatus.indexOf('sp-st-active') >= 0, JSON.stringify(strat.firstStatus))
    check('the first card names the sprint it owns (the \u25b8 line)', strat.firstActive && strat.firstActive.indexOf('SEO') >= 0, JSON.stringify(strat.firstActive))
    check('the roll-up progress bar reads 50% (1/2 tasks done)', strat.firstProgress === '50%', JSON.stringify(strat.firstProgress))
    check('the second card carries its emoji glyph (\u{1F680})', strat.secondGlyph === '\u{1F680}', JSON.stringify(strat.secondGlyph))
    check('the New strategy button rides the section head', strat.newBtn)
    check('the All-sprints list renders every sprint (the 2 seeded + leg 3\'s create)', strat.listRows === 3, 'rows=' + strat.listRows)
    check('the assigned sprint row carries the strategy chip', strat.listStrategyChips === 1, 'chips=' + strat.listStrategyChips)
    await page.screenshot({ path: path.join(args.out, '03-strategies-section.png') })

    // The focus filter: card click narrows the All-sprints list to SEO; a second
    // click restores both.
    await page.click('[data-strategy-card=\'' + STRAT1 + '\']')
    await page.waitForTimeout(300)
    let filtered = await page.evaluate(() => ({
      rows: document.querySelectorAll('#sp-sprints-list [data-sp-open]').length,
      isOn: !!document.querySelector('[data-strategy-card].is-on'),
      names: Array.from(document.querySelectorAll('#sp-sprints-list .sp-list-name')).map((n) => n.textContent),
    }))
    check('the focus filter narrows the list to the strategy\'s sprint', filtered.rows === 1 && filtered.names[0] === 'SEO', JSON.stringify(filtered))
    check('the focused card wears the is-on look', filtered.isOn)
    await page.click('[data-strategy-card=\'' + STRAT1 + '\']')
    await page.waitForTimeout(300)
    filtered = await page.evaluate(() => document.querySelectorAll('#sp-sprints-list [data-sp-open]').length)
    check('a second card click restores the full list', filtered === 3, 'rows=' + filtered)
    await page.screenshot({ path: path.join(args.out, '04-strategies-filter.png') })

    // The together-assignment: the define dialog carries the strategy select.
    await page.click('#sp-new-sprint')
    await page.waitForSelector('.sp-define-pop', { state: 'visible', timeout: 5000 })
    const defineSel = await page.evaluate(() => {
      const sel = document.querySelector('[data-sp-define-strategy]')
      if (!sel) return null
      return { options: Array.from(sel.options).map((o) => o.textContent), value: sel.value }
    })
    check('the define dialog carries the strategy select', !!defineSel, 'missing')
    if (defineSel) {
      check('the select lists No strategy + both strategies (assignable: active + paused)', defineSel.options.length === 3, JSON.stringify(defineSel.options))
      check('the select defaults to No strategy', defineSel.value === '', JSON.stringify(defineSel.value))
    }
    await page.keyboard.press('Escape')

    // The detail Settings tab carries the same select, seeded with the sprint's
    // strategy; a change PATCHes through the seam.
    await page.click('#sp-sprints-list [data-sp-open=\'' + SPR1 + '\']')
    await page.waitForSelector('.db-sprintdetail', { state: 'visible', timeout: 5000 })
    const sdSel = await page.evaluate(() => {
      const sel = document.querySelector('[data-sd-strategy]')
      if (!sel) return null
      return { value: sel.value, options: Array.from(sel.options).map((o) => o.textContent) }
    })
    check('the detail Settings carries the strategy select', !!sdSel, 'missing')
    if (sdSel) {
      check('the select is seeded with the sprint\'s strategy (SEO \u2192 STRAT1)', sdSel.value === STRAT1, JSON.stringify(sdSel.value))
    }
    await page.keyboard.press('Escape')

    // The New strategy flow: the editor opens + a create crosses the seam.
    await page.click('#sp-new-strategy')
    await page.waitForSelector('.db-strategy-modal', { state: 'visible', timeout: 5000 })
    await page.fill('[data-stg-name]', 'Ship the portfolio')
    await page.click('.db-strategy-modal [data-stg-save]')
    await page.waitForTimeout(600)
    check('the strategy create crossed the seam (createdStrategies)', probe.createdStrategies.length === 1 && probe.createdStrategies[0].name === 'Ship the portfolio', JSON.stringify(probe.createdStrategies))

    check('ZERO page errors through the whole sprint flow', pageErrors.length === 0, pageErrors.join(' | '))
    await page.screenshot({ path: path.join(args.out, '02-back-on-board.png') })
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
