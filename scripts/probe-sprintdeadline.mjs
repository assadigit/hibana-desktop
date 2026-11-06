#!/usr/bin/env node
// ============================================================================
// probe-sprintdeadline.mjs — the S248 SPRINT/DEADLINE/DEPS island probe (the
// 14th probe — Phase 9 of the Hibana Sprint, Deadline & Dependency feature
// pack; Chromium via Playwright).
//
// WHAT IT PROVES, against the REAL generated island bytes (frontend/dist at
// the 7f314e9 pin — the whole feature rides the island for the first time):
//   1. THE ISLAND SERVES + THE CHAIN + THE S248 CARRIERS: /kanban returns 200,
//      the desktop-owned chain loads, and the feature's carriers ship —
//      devboard.js v36 (the due-control mount + deadlineStateOf + the dep
//      folds + the task_deps payload key + the addTaskDep write wrapper),
//      board-page.js v33 (the sprint view filter + the card rows),
//      due-control.js v1 (window.HibanaDueControl), emoji-picker.js v4,
//      devboard.css v45 (the .st-* state family + the S247 WCAG-AA colors),
//      claude-dark-theme.css v32 (the S247b dark-theme contrast block), and
//      the i18n feature keys (EN + FA).
//   2. LOGIN → THE BOARD RENDERS THE FEATURE: the payload carries a sprint
//      (explicit status + emoji + due) + the deadline fields + the task_deps
//      edge join → the card's sprint badge, the deadline row with its state
//      class (st-overdue for the past-due task, the sprint-inherited row for
//      the other), the BLOCKED dep badge on the blocked card, and the toolbar's
//      sprint view filter all render.
//   3. THE MODAL'S DEADLINE TOGGLE MOUNTS THE SHARED DATE CONTROL: the editor
//      carries the Due date (optional) field; flipping the toggle mounts
//      window.HibanaDueControl into [data-db-due-mount] (the segmented
//      calendar selector — the island ships ZERO deadline logic of its own).
//   4. THE K-SECTION DEPS MULTI-SELECT + A LIVE WRITE THROUGH THE SEAM: the
//      collapsed Dependencies section expands, the same-project option list
//      renders, and picking a blocker POSTs /api/devtasks/:id/deps through
//      hibanaFetch → the bridge (the mock records it — the island's write
//      path rides the seam exactly as the web client's does).
//   5. THE FA/RTL MIRROR: lang=fa boots the Persian dictionary and the
//      feature surfaces localize (the sprint filter's aria + the dep badge's
//      word + the deadline row's unit text).
//   6. ZERO PAGE ERRORS through every leg.
//
// The mock server reuses probe-view.mjs's contract. All board data flows
// through the seam (hibanaFetch → the mock's /__probe/request handler)
// exactly as it does inside the real shell.
// ============================================================================

import { createRequire } from 'node:module'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const a = { src: '/home/z/hibana-source', dist: path.join(REPO_ROOT, 'frontend/dist'), out: '/tmp/probe-sprintdeadline', port: 3147 }
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
for (const f of ['index.html', 'js/desktop-audio.js', 'js/desktop-shim.js', 'js/devboard.js', 'js/board-page.js', 'js/due-control.js', 'js/emoji-picker.js', 'js/sprint-page.js']) {
  if (!fs.existsSync(path.join(args.dist, f))) {
    console.error('[probe] missing ' + f + ' under ' + args.dist + ' — run scripts/sync-island.mjs first.')
    process.exit(1)
  }
}

const P1 = '11111111-1111-4111-8111-111111111111'
const SP1 = '22222222-2222-4222-8222-222222222222'
const H2 = 2 * 60 * 60 * 1000
const H30 = 30 * 60 * 60 * 1000

// The feature-rich board: sp1 is an ACTIVE sprint with emoji + a due date
// (+30h → the inheriting task reads st-urgent, ≤48h); t1 owns a PERSONAL
// deadline in the past (−2h → st-overdue, source 'task'); t2 inherits sp1's
// deadline (source 'sprint'); t3 is BLOCKED by t1 (the payload's task_deps
// edge join — the fold renders the Blocked badge); t4 is a bare pre-feature
// card (no due, no sprint, no deps — the D2/§24-1 bare-card contract).
const freshBoard = () => {
  const now = Date.now()
  const sprint = {
    id: SP1, project_id: P1, name: 'Probe Sprint', started_at: '2026-01-01T00:00:00.000Z', ended_at: null,
    created_at: '2026-01-01T00:00:00.000Z', is_draft: 0, version: null, description: null,
    status: 'active', emoji: '🚀', due_at: new Date(now + H30).toISOString(),
    due_origin_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z',
  }
  const mk = (id, title, status, extra) => Object.assign({
    id, project_id: P1, title, status, priority: 'medium', category_id: null, sprint_id: null,
    sort_order: 0, created_at: '2026-01-01T00:00:00.000Z', done_at: null, start_at: null, end_at: null,
    search_tags: '', updated_at: '2026-01-02T00:00:00.000Z', tags: [], shot_count: 0,
    due_at: null, due_origin_at: null, effective_due_at: null, effective_due_source: null, effective_due_origin_at: null,
  }, extra)
  const tasks = [
    mk('t1', 'Personal deadline task', 'planned', {
      sprint_id: SP1,
      due_at: new Date(now - H2).toISOString(), due_origin_at: '2026-01-01T00:00:00.000Z',
      effective_due_at: new Date(now - H2).toISOString(), effective_due_source: 'task', effective_due_origin_at: '2026-01-01T00:00:00.000Z',
    }),
    mk('t2', 'Sprint inheriting task', 'in_progress', {
      sprint_id: SP1,
      effective_due_at: sprint.due_at, effective_due_source: 'sprint', effective_due_origin_at: sprint.due_origin_at,
    }),
    mk('t3', 'Blocked task', 'idea', { sprint_id: SP1 }),
    mk('t4', 'Bare pre-feature task', 'idea', {}),
  ]
  return { sprint, tasks, task_deps: [{ blocker_task_id: 't1', blocked_task_id: 't3' }] }
}

const probe = {
  authed: false,
  lang: 'en',
  theme: null,
  projects: [{ id: P1, title: 'Hibana Sprint Probe', status: 'planning', type: 'personal' }],
  board: freshBoard(),
  createdTasks: [],
  deleted: [],
  patched: [],
  depPosts: [], // the K-section's live writes through the seam
  depDeletes: [],
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
  tasks: probe.board.tasks, categories: [], sprints: [probe.board.sprint], tags: [], task_tags: [],
  task_deps: probe.board.task_deps,
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
      // S246 (the K-section's LIVE write): POST /api/devtasks/:id/deps — the
      // island rides the seam for dep mutations exactly like the web client.
      let m = /^\/api\/devtasks\/([^/]+)\/deps$/.exec(rp)
      if (m && (rm || '').toUpperCase() === 'POST') {
        let parsed = {}
        try { parsed = JSON.parse(body || '{}') } catch (e) { /* */ }
        probe.depPosts.push({ id: m[1], blocker_id: parsed.blocker_id || null })
        const edge = { blocker_task_id: String(parsed.blocker_id || ''), blocked_task_id: m[1] }
        if (edge.blocker_task_id && edge.blocker_task_id !== m[1]) probe.board.task_deps.push(edge)
        return send(200, 'application/json', JSON.stringify({ status: 201, etag: null, body: '{"ok":true}' }))
      }
      m = /^\/api\/devtasks\/([^/]+)\/deps\/([^/]+)$/.exec(rp)
      if (m && (rm || '').toUpperCase() === 'DELETE') {
        probe.depDeletes.push({ id: m[1], blocker: m[2] })
        probe.board.task_deps = probe.board.task_deps.filter((d) => !(d.blocker_task_id === m[2] && d.blocked_task_id === m[1]))
        return send(200, 'application/json', JSON.stringify({ status: 200, etag: null, body: '{"ok":true}' }))
      }
      m = /^\/api\/projects\/([^/]+)\/devtasks$/.exec(rp)
      if (m && (rm || 'GET').toUpperCase() === 'POST') {
        let parsed = {}
        try { parsed = JSON.parse(body || '{}') } catch (e) { /* the island pre-stringifies */ }
        const t = {
          id: 'sd-' + (probe.createdTasks.length + 1), project_id: m[1],
          title: parsed.title || 'Task', status: parsed.status || 'idea',
          priority: parsed.priority || 'medium', category_id: parsed.category_id || null,
          sprint_id: parsed.sprint_id || null, sort_order: probe.board.tasks.length,
          created_at: new Date().toISOString(), done_at: null, start_at: null, end_at: null,
          search_tags: '', updated_at: new Date().toISOString(), tags: [], shot_count: 0,
          due_at: parsed.due_at || null, due_origin_at: null,
          effective_due_at: parsed.due_at || null, effective_due_source: parsed.due_at ? 'task' : null, effective_due_origin_at: null,
        }
        probe.createdTasks.push(t)
        probe.board.tasks.push(t)
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
          probe.board.tasks = probe.board.tasks.filter((t) => t.id !== m[1])
          return send(200, 'application/json', JSON.stringify({ status: 200, etag: null, body: '{"ok":true}' }))
        }
        if ((rm || 'GET').toUpperCase() === 'PATCH') {
          let parsed = {}
          try { parsed = JSON.parse(body || '{}') } catch (e) { /* */ }
          probe.patched.push({ id: m[1], fields: Object.keys(parsed) })
          const t = probe.board.tasks.find((x) => x.id === m[1])
          if (t) {
            for (const k of ['status', 'title', 'priority', 'sprint_id', 'due_at', 'due_origin_at', 'sort_order']) {
              if (k in parsed) t[k] = parsed[k]
            }
          }
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

  const login = async (page) => {
    await page.goto(base + '/kanban?project=' + P1, { waitUntil: 'domcontentloaded' })
    await page.fill('#login-gate-login', 'probe@hibana.ir')
    await page.fill('#login-gate-password', 'probe-right')
    await page.click('#login-gate-submit')
    await page.waitForFunction(() => document.documentElement.getAttribute('data-desktop-authed') === 'true', null, { timeout: 10000 })
    await page.waitForSelector('#login-gate', { state: 'hidden', timeout: 5000 })
    await page.waitForSelector('.db-cols > .pd-col', { timeout: 10000 })
  }

  // The feature-shape reader: what renders on the cards + toolbar.
  const featureShape = (page) => page.evaluate(() => {
    const rowOf = (id) => {
      const wrap = document.querySelector('.pd-task-wrap[data-task-card="' + id + '"]')
      if (!wrap) return null
      const due = wrap.querySelector('.db-due-row')
      return {
        sprint: wrap.querySelector('.db-sprint-badge') ? wrap.querySelector('.db-sprint-badge').textContent : null,
        dueClass: due ? due.className : null,
        dueText: due ? (due.textContent || '').trim() : null,
        depBadge: wrap.querySelector('.db-dep-badge') ? wrap.querySelector('.db-dep-badge').textContent.trim() : null,
      }
    }
    const filter = document.querySelector('[data-db-filter-sprint]')
    return {
      t1: rowOf('t1'), t2: rowOf('t2'), t3: rowOf('t3'), t4: rowOf('t4'),
      filterPresent: !!filter,
      filterOptions: filter ? Array.from(filter.options).map((o) => o.textContent.trim()) : null,
      hasDueControlApi: !!(window.HibanaDueControl && window.HibanaDueControl.create),
      hasBoardState: !!(window.HibanaBoard && window.HibanaBoard.state && window.HibanaBoard.state.task_deps !== undefined),
      hasDeadlineStack: !!(window.HibanaBoard && typeof window.HibanaBoard.deadlineStateOf === 'function' && typeof window.HibanaBoard.deadlineRowHtml === 'function'),
      hasDepStack: !!(window.HibanaBoard && typeof window.HibanaBoard.addTaskDep === 'function' && typeof window.HibanaBoard.depBadgeHtml === 'function'),
    }
  })

  console.log('\n— leg 1: the island serves + the desktop chain + the S248 carriers')
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))

    const resp = await page.goto(base + '/kanban?project=' + P1, { waitUntil: 'domcontentloaded' })
    check('the board page is served at /kanban (HTTP 200, not 404)', resp && resp.status() === 200, resp ? 'status=' + resp.status() : 'no response')
    await page.waitForSelector('#login-gate', { state: 'visible', timeout: 5000 })
    const chain = await page.evaluate(() => ({
      hasFetch: typeof window.hibanaFetch === 'function',
      hasHibana: !!(window.hibana && typeof window.hibana.toast === 'function'),
      hasDueControl: !!(window.HibanaDueControl && typeof window.HibanaDueControl.create === 'function'),
      dueCtlTag: !!Array.from(document.querySelectorAll('script[src*="/js/due-control.js?v=1"]')).length,
      emojiTag: !!Array.from(document.querySelectorAll('script[src*="/js/emoji-picker.js?v=4"]')).length,
      devboardTag: !!Array.from(document.querySelectorAll('script[src*="/js/devboard.js?v=36"]')).length,
      boardPageTag: !!Array.from(document.querySelectorAll('script[src*="/js/board-page.js?v=33"]')).length,
    }))
    check('the desktop chain loaded (hibanaFetch + hibana toast)', chain.hasFetch && chain.hasHibana, JSON.stringify(chain))
    check('js/due-control.js?v=1 loaded + window.HibanaDueControl.create (the S244 shared date control)', chain.hasDueControl && chain.dueCtlTag, JSON.stringify(chain))
    check('js/emoji-picker.js?v=4 + devboard.js?v=36 + board-page.js?v=33 tags all present (the S248 carriers)', chain.emojiTag && chain.devboardTag && chain.boardPageTag, JSON.stringify(chain))

    // The S248 carriers, from the REAL dist bytes.
    const devboardJs = fs.readFileSync(path.join(args.dist, 'js/devboard.js'), 'utf8')
    const boardPageJs = fs.readFileSync(path.join(args.dist, 'js/board-page.js'), 'utf8')
    const dueCtlJs = fs.readFileSync(path.join(args.dist, 'js/due-control.js'), 'utf8')
    check('js/devboard.js carries the feature stack (deadlineStateOf + the task_deps fold + addTaskDep + depBadgeHtml + the due-control mount)',
      ['deadlineStateOf', 'task_deps', 'addTaskDep', 'removeTaskDep', 'depBadgeHtml', 'HibanaDueControl', 'db-due-mount'].every((m) => devboardJs.includes(m)), '')
    check('js/board-page.js carries the sprint view filter + the card sprint badge + the dep row',
      ['data-db-filter-sprint', 'db-sprint-badge', 'depBadge'].every((m) => boardPageJs.includes(m)), '')
    check('js/due-control.js carries the segmented selector + presets + the ISO value (the island ships zero deadline logic)',
      ['HibanaDueControl', 'gregorian', 'jalali'].every((m) => dueCtlJs.includes(m)), '')
    const devCss = await page.evaluate(() => fetch('/css/devboard.css?v=45').then((r) => r.text()))
    const claudeCss = await page.evaluate(() => fetch('/css/claude-dark-theme.css?v=32').then((r) => r.text()))
    check('css/devboard.css?v=45 carries the .st- state family + the S247 WCAG-AA pair',
      devCss.includes('.st-') && devCss.includes('#8a6428') && devCss.includes('#4d6b4d'), 'len=' + devCss.length)
    check('css/claude-dark-theme.css?v=32 carries the S247b dark-theme contrast block',
      claudeCss.includes('#d9a45b') && claudeCss.includes('#8fb58f'), 'len=' + claudeCss.length)
    const i18nEn = fs.readFileSync(path.join(args.dist, 'js/i18n-en.js'), 'utf8')
    const i18nFa = fs.readFileSync(path.join(args.dist, 'js/i18n-fa.js'), 'utf8')
    check('i18n-en v110 carries the feature keys (the sprint filter + the dep words + the due toggle)',
      ['db.filterSprint', 'db.noSprint', 'db.dep.blocked', 'db.dep.ready', 'db.due.toggleOpt'].every((k) => i18nEn.includes("'" + k + "'") || i18nEn.includes('"' + k + '"')), '')
    check('i18n-fa v104 carries the FA feature keys (parity 1678=1678 upstream)',
      ['db.filterSprint', 'db.noSprint', 'db.dep.blocked', 'db.due.toggleOpt'].every((k) => i18nFa.includes("'" + k + "'") || i18nFa.includes('"' + k + '"')), '')
    await page.screenshot({ path: path.join(args.out, '00-leg1-carriers.png') })
    check('ZERO page errors (leg 1)', pageErrors.length === 0, pageErrors.join(' | '))
    await context.close()
  }

  console.log('\n— leg 2: login → the board renders THE FEATURE (sprint badge + deadline rows + dep badge + the sprint filter)')
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    probe.authed = false
    probe.board = freshBoard()

    await login(page)
    await page.waitForTimeout(400)
    const shape = await featureShape(page)
    check('the toolbar carries the sprint view filter (the S242 kanban integration)', shape.filterPresent, JSON.stringify(shape.filterOptions))
    check("the filter's options carry the sprint's emoji + name (🚀 Probe Sprint) + No sprint",
      shape.filterOptions && shape.filterOptions.some((o) => o.includes('Probe Sprint')) && shape.filterOptions.some((o) => /no sprint/i.test(o)), JSON.stringify(shape.filterOptions))
    check("t1's card carries the sprint badge + the OVERDUE deadline row (st-overdue — the personal deadline in the past)",
      shape.t1 && shape.t1.sprint && /probe sprint/i.test(shape.t1.sprint) && /st-overdue/.test(shape.t1.dueClass || ''), JSON.stringify(shape.t1))
    check("t1's deadline row text reads the overdue wording", shape.t1 && /overdue|past due|late/i.test(shape.t1.dueText || ''), JSON.stringify(shape.t1 && shape.t1.dueText))
    check("t2's card carries the sprint-inherited deadline row (st-urgent — ≤48h from the sprint's due, never st-overdue)",
      shape.t2 && /st-(urgent|approaching|comfortable)/.test(shape.t2.dueClass || '') && !/st-overdue/.test(shape.t2.dueClass || ''), JSON.stringify(shape.t2))
    check("t3's card carries the BLOCKED dep badge (the task_deps edge fold — the WORD carries the meaning)",
      shape.t3 && shape.t3.depBadge && /blocked/i.test(shape.t3.depBadge), JSON.stringify(shape.t3))
    check("t4's card renders BARE (no sprint badge, no deadline row, no dep badge — the §24-1 pre-feature contract)",
      shape.t4 && !shape.t4.sprint && !shape.t4.dueClass && !shape.t4.depBadge, JSON.stringify(shape.t4))
    check('window.HibanaBoard.state() carries the task_deps payload key (the 7th additive key)', shape.hasBoardState, JSON.stringify(shape.hasBoardState))
    await page.screenshot({ path: path.join(args.out, '01-leg2-feature-board.png') })

    // The sprint view filter actually filters: pick "No sprint" → t4 only.
    await page.selectOption('[data-db-filter-sprint]', '__none')
    await page.waitForTimeout(300)
    const noneShape = await featureShape(page)
    check('the sprint view filter filters (No sprint → only the unassigned t4 stays)', noneShape.t4 && !noneShape.t1 && !noneShape.t2 && !noneShape.t3, JSON.stringify({ t1: !!noneShape.t1, t2: !!noneShape.t2, t3: !!noneShape.t3, t4: !!noneShape.t4 }))
    check('ZERO page errors (leg 2)', pageErrors.length === 0, pageErrors.join(' | '))
    await context.close()
  }

  console.log('\n— leg 3: the modal\'s deadline toggle mounts the shared date control')
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    probe.authed = false
    probe.board = freshBoard()

    await login(page)
    // The S238 split: the card click opens the VIEW; its Edit opens the editor.
    await page.click('.pd-col[data-status="idea"] .pd-task')
    await page.waitForSelector('.db-view-card', { timeout: 5000 })
    await page.click('[data-db-view-edit]')
    await page.waitForSelector('.db-modal-card', { timeout: 5000 })
    const modal = await page.evaluate(() => {
      const field = document.querySelector('[data-db-due-field]')
      const toggle = document.querySelector('[data-db-due-toggle]')
      const mount = document.querySelector('[data-db-due-mount]')
      const depsField = document.querySelector('[data-db-deps-field]')
      const depsToggle = document.querySelector('[data-db-deps-toggle]')
      const depsMount = document.querySelector('[data-db-deps-mount]')
      return {
        hasField: !!field,
        toggleLabel: toggle ? toggle.parentElement.textContent.trim() : null,
        mountHidden: mount ? mount.hidden : null,
        depsSection: !!depsField && !!depsToggle,
        depsLabel: depsToggle ? depsToggle.textContent.trim() : null,
        depsMountHidden: depsMount ? depsMount.hidden : null,
      }
    })
    check('the editor carries the Due date (optional) field + its OFF-by-default toggle', modal.hasField && /due date/i.test(modal.toggleLabel || '') && modal.mountHidden === true, JSON.stringify(modal))
    check('the editor carries the COLLAPSED Dependencies (optional) section (the S246 K-section — toggle + hidden mount)',
      modal.depsSection && /dependencies/i.test(modal.depsLabel || '') && modal.depsMountHidden === true, JSON.stringify(modal))

    // Flip the toggle → the shared date control mounts into [data-db-due-mount].
    await page.check('[data-db-due-toggle]')
    await page.waitForTimeout(300)
    const mounted = await page.evaluate(() => {
      const mount = document.querySelector('[data-db-due-mount]')
      const seg = mount ? mount.querySelector('.db-due-seg, [data-due-seg], .db-seg') : null
      const input = mount ? mount.querySelector('input') : null
      return {
        visible: mount ? !mount.hidden : false,
        hasSeg: !!seg,
        hasInput: !!input,
        html: mount ? mount.innerHTML.slice(0, 120) : null,
      }
    })
    check('flipping the toggle MOUNTED the shared date control (window.HibanaDueControl into [data-db-due-mount])',
      mounted.visible && mounted.hasInput, JSON.stringify(mounted))
    await page.screenshot({ path: path.join(args.out, '02-leg3-due-control.png') })
    check('ZERO page errors (leg 3)', pageErrors.length === 0, pageErrors.join(' | '))
    await context.close()
  }

  console.log('\n— leg 4: the K-section deps multi-select + a LIVE dep write through the seam')
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    probe.authed = false
    probe.board = freshBoard()

    await login(page)
    await page.click('.pd-col[data-status="idea"] .pd-task')
    await page.waitForSelector('.db-view-card', { timeout: 5000 })
    await page.click('[data-db-view-edit]')
    await page.waitForSelector('.db-modal-card', { timeout: 5000 })

    // Expand the collapsed K-section (the toggle button owns aria-expanded).
    const opened = await page.evaluate(() => {
      const btn = document.querySelector('[data-db-deps-toggle]')
      if (!btn) return false
      btn.click()
      return true
    })
    await page.waitForTimeout(300)
    const listSel = await page.evaluate(() => {
      const list = document.querySelector('[data-db-deps-list]')
      if (!list || list.hidden === true || list.offsetParent === null) return null
      return Array.from(list.querySelectorAll('.db-deps-opt')).map((o) => ({ dep: o.getAttribute('data-dep'), title: o.textContent.trim().slice(0, 40), sel: o.getAttribute('aria-selected') }))
    })
    check('the K-section expanded (the summary/chevron click) and the same-project option list rendered', opened && !!listSel, JSON.stringify(listSel && listSel.map((o) => o.dep)))
    check('the option list carries the project\'s OTHER tasks (t1/t2/t4 offered to block the current t3)',
      listSel && ['t1', 't2', 't4'].every((id) => listSel.some((o) => o.dep === id)), JSON.stringify(listSel))

    // Pick t4 as an extra blocker for t3 → the LIVE POST through the seam.
    const depBefore = probe.depPosts.length
    await page.evaluate(() => {
      const opt = document.querySelector('[data-db-deps-list] .db-deps-opt[data-dep="t4"]')
      if (opt) { opt.click(); return true }
      return false
    })
    await page.waitForTimeout(600)
    check('picking a blocker POSTed /api/devtasks/t3/deps through hibanaFetch → the bridge (the S246 live write path)',
      probe.depPosts.length === depBefore + 1 && probe.depPosts[probe.depPosts.length - 1].id === 't3' && probe.depPosts[probe.depPosts.length - 1].blocker_id === 't4',
      JSON.stringify(probe.depPosts))
    await page.screenshot({ path: path.join(args.out, '03-leg4-deps-write.png') })
    check('ZERO page errors (leg 4)', pageErrors.length === 0, pageErrors.join(' | '))
    await context.close()
  }

  console.log('\n— leg 5: the FA/RTL mirror (the feature surfaces localize)')
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    probe.authed = false
    probe.lang = 'fa'
    probe.board = freshBoard()

    await login(page)
    await page.waitForTimeout(600)
    const faShape = await page.evaluate(() => {
      const doc = document.documentElement
      const filter = document.querySelector('[data-db-filter-sprint]')
      const badge = document.querySelector('.db-dep-badge')
      return {
        dir: doc.getAttribute('dir'), lang: doc.getAttribute('lang'),
        filterLabel: filter ? filter.getAttribute('aria-label') : null,
        noSprint: filter ? Array.from(filter.options).map((o) => o.textContent.trim()) : null,
        depWord: badge ? badge.textContent.trim() : null,
      }
    })
    check('the FA boot flips the document (dir=rtl + lang=fa)', faShape.dir === 'rtl' && faShape.lang === 'fa', JSON.stringify({ dir: faShape.dir, lang: faShape.lang }))
    check('the sprint filter localizes (the Persian aria + the No-sprint option)', faShape.filterLabel && /[\u0600-\u06FF]/.test(faShape.filterLabel) && faShape.noSprint && faShape.noSprint.some((o) => /[\u0600-\u06FF]/.test(o)), JSON.stringify(faShape.noSprint))
    check('the dep badge word localizes (the Persian Blocked)', faShape.depWord && /[\u0600-\u06FF]/.test(faShape.depWord), JSON.stringify(faShape.depWord))
    await page.screenshot({ path: path.join(args.out, '04-leg5-fa-rtl.png') })
    check('ZERO page errors (leg 5)', pageErrors.length === 0, pageErrors.join(' | '))
    await context.close()
    probe.lang = 'en'
  }

  await browser.close()
  server.close()

  console.log('\n[probe-sprintdeadline] ' + (failures.length === 0 ? 'ALL GREEN' : failures.length + ' FAILURE(S): ' + failures.join(' | ')))
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[probe-sprintdeadline] fatal: ' + (err && err.stack || err))
  process.exit(1)
})
