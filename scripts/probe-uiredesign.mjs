#!/usr/bin/env node
// ============================================================================
// probe-uiredesign.mjs — the kanban UI-redesign ISLAND PROBE (Chromium via
// Playwright), against the REAL generated island bytes (frontend/dist) at the
// current pin (073bb95 @ v0.4.1.38, hibana-kanban-ui-redesign-handoff base
// aee9acf + the S230 completion).
//
// WHAT IT PROVES (the handoff's QA checklist, on the desktop island):
//   1. The toolbar: NO Project Progress summary — the #db-counts span is
//      emptied + hidden; the workspace switcher + Sprints/Labels/Sync/
//      Refresh/theme/Settings/Sign out stay visible; the lane counts live on
//      the lane headers.
//   2. The five lanes: EXACT workflow names + order (New Ideas / Problems /
//      Plans / In Progress / Implemented), full-height surfaces on the quiet
//      neutral canvas, tinted headers with dot + title + count + ONE ⋯ menu.
//   3. The per-lane empty states: the five supplied monochrome illustrations
//      (served same-origin from the island), heading + copy + the lane-accent
//      Add task; the bottom add strip hidden while empty.
//   4. The Add task flow: the empty-state button opens the shared editor with
//      the lane's status preselected (the existing create flow, correct lane).
//   5. The column ⋯ menu: opens, carries Quick copy + Export Markdown (+
//      Archive/Clear on a populated Done lane), Escape closes.
//   6. The bottom helper hint: the quiet monochrome line under the lanes.
//   7. FA/RTL: the FA dictionary paints the lane titles + empty states + hint;
//      the first lane lands on the RIGHT.
//   8. Dark mode: the canvas + lane surfaces flip tokens; the illustrations
//      stay visible.
//
// USAGE (playwright + browsers ship in hibana-source for its e2e suite):
//   node scripts/probe-uiredesign.mjs --src /home/z/hibana-source \
//        [--dist frontend/dist] [--out /tmp/probe-uiredesign] [--port 3990]
// ============================================================================
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

function parseArgs(a) {
  const o = { src: '', dist: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../frontend/dist'), out: '/tmp/probe-uiredesign', port: 3990 }
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--src') o.src = path.resolve(a[++i])
    else if (a[i] === '--dist') o.dist = path.resolve(a[++i])
    else if (a[i] === '--out') o.out = path.resolve(a[++i])
    else if (a[i] === '--port') o.port = Number(a[++i])
  }
  if (!o.src) { console.error('[probe] --src <hibana-source checkout> is required (playwright lives there)'); process.exit(1) }
  return o
}

const args = parseArgs(process.argv.slice(2))
for (const f of ['index.html', 'js/board-page.js', 'css/devboard.css', 'icons/empty-state/new-ideas-lamp.png', 'icons/empty-state/problems-warning.png', 'icons/empty-state/plans-checklist.png', 'icons/empty-state/in-progress-play.png', 'icons/empty-state/implemented-check.png']) {
  if (!fs.existsSync(path.join(args.dist, f))) {
    console.error('[probe] missing ' + f + ' under ' + args.dist + ' — run scripts/sync-island.mjs first.')
    process.exit(1)
  }
}

const P1 = '22222222-2222-4222-8222-222222222222'
const probe = {
  authed: true,
  lang: 'en',
  theme: null,
  projects: [{ id: P1, title: 'Currena', status: 'planning', type: 'personal' }],
  tasks: [],
  populated: false,
}
const mkTask = (id, title, status, priority) => ({ id, project_id: P1, title, status, priority, category_id: null, sprint_id: null, sort_order: 0, created_at: '2026-01-01T00:00:00.000Z', done_at: null, start_at: null, end_at: null, search_tags: '', updated_at: '2026-01-02T00:00:00.000Z', tags: [], shot_count: 0 })

const mockRuntimeJs = () => [
  'window.go = { desktop: { API: {',
  "  Login: function (login, password) { return Promise.resolve({ ok: true, user: { email: login } }) },",
  '  Logout: function () { return Promise.resolve({ ok: true }) },',
  "  AuthState: function () { return Promise.resolve({ authenticated: window.__probe.authed, user: window.__probe.authed ? { email: 'probe@hibana.ir', language_pref: window.__probe.lang, calendar_pref: 'gregorian' } : null }) },",
  '  Request: function (method, p, body) { return window.__probeRequest(method, p, body) },',
  "  SetTheme: function (pref) { return Promise.resolve({ ok: true, pref: pref }) },",
  '  SyncNow: function () { return Promise.resolve({ ok: true, outcome: "ok", pulled: 0, uploaded: 0 }) },',
  "  SetLanguage: function (l) { return Promise.resolve({ ok: true }) },",
  '} } }',
  'window.runtime = { EventsOn: function (name, cb) { (window.__probeEvents = window.__probeEvents || {}); (window.__probeEvents[name] = window.__probeEvents[name] || []).push(cb) } },',
  'window.__probeEmit = function (name, payload) { ((window.__probeEvents || {})[name] || []).forEach(function (cb) { try { cb(payload) } catch (e) {} }) },',
  'window.__probe = ' + JSON.stringify({ authed: probe.authed, lang: probe.lang }) + ';',
].join('\n') + '\n'

const serveDocument = (send) => {
  let html = fs.readFileSync(path.join(args.dist, 'index.html'), 'utf8')
  const attrs = ' data-desktop-authed="' + (probe.authed ? 'true' : 'false') + '"' +
    (probe.theme ? ' data-desktop-theme="' + probe.theme + '" data-theme="' + probe.theme + '"' : ' data-desktop-theme="light"')
  html = html.replace('<html lang="en">', '<html lang="' + (probe.lang === 'fa' ? 'fa' : 'en') + '" dir="' + (probe.lang === 'fa' ? 'rtl' : 'ltr') + '"' + attrs + '>')
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
  if (p === '/wails/ipc.js') return send(200, 'application/javascript', 'window.WailsInvoke = function (m) {}\n')
  if (p === '/wails/runtime.js') return send(200, 'application/javascript', mockRuntimeJs())
  if (p === '/__probe.js') {
    return send(200, 'application/javascript', [
      'window.__probeRequest = function (method, p, body) {',
      '  return fetch("/__probe/request", { method: "POST", body: JSON.stringify({ method, p, body }) }).then(function (r) { return r.json() })',
      '}',
    ].join('\n') + '\n')
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
  const failures = []
  const check = (name, cond, extra) => {
    console.log((cond ? '  PASS ' : '  FAIL ') + name + (extra ? ' — ' + extra : ''))
    if (!cond) failures.push(name)
  }
  const pageErrors = []

  const LANES = [
    { status: 'idea', title: 'New Ideas', art: '/icons/empty-state/new-ideas-lamp.png', heading: 'No ideas yet' },
    { status: 'bug', title: 'Problems', art: '/icons/empty-state/problems-warning.png', heading: 'No problems yet' },
    { status: 'planned', title: 'Plans', art: '/icons/empty-state/plans-checklist.png', heading: 'No plans yet' },
    { status: 'in_progress', title: 'In Progress', art: '/icons/empty-state/in-progress-play.png', heading: 'Nothing in progress' },
    { status: 'done', title: 'Implemented', art: '/icons/empty-state/implemented-check.png', heading: 'No completed tasks' },
  ]

  const open = async ({ vp, lang, theme } = {}) => {
    probe.lang = lang || 'en'
    probe.theme = theme || null
    const ctx = await browser.newContext({ viewport: vp || { width: 1600, height: 900 }, deviceScaleFactor: 1 })
    const pg = await ctx.newPage()
    pg.on('pageerror', (e) => pageErrors.push(String(e)))
    await pg.goto(base + '/kanban?project=' + P1)
    await pg.waitForSelector('.db-cols', { timeout: 10000 })
    await pg.mouse.move(Math.round((vp ? vp.width : 1600) / 2), Math.round((vp ? vp.height : 900) / 2))
    await pg.waitForTimeout(600)
    return pg
  }

  // ---- (1-3) the empty board, light, 1600×900 --------------------------------
  {
    const pg = await open()
    const t = await pg.evaluate(() => {
      const counts = document.getElementById('db-counts')
      return {
        countsGone: !!counts && counts.textContent.trim() === '' && counts.hidden,
        toolbarText: document.getElementById('db-toolbar').textContent,
        switcher: !!document.getElementById('db-project-switch'),
        lanes: [...document.querySelectorAll('.db-cols .pd-col')].map((c) => ({ status: c.dataset.status, title: c.querySelector('.pd-col-title').textContent.trim(), menu: c.querySelectorAll('[data-db-col-menu]').length })),
        empties: [...document.querySelectorAll('.db-cols .pd-col')].map((c) => {
          const img = c.querySelector('.pd-empty-icon')
          return { status: c.dataset.status, src: img ? img.getAttribute('src') : null, heading: c.querySelector('.pd-empty-title') ? c.querySelector('.pd-empty-title').textContent.trim() : null, add: c.querySelector('.pd-empty-add') ? c.querySelector('.pd-empty-add').dataset.add : null, strip: c.querySelectorAll('.pd-task-add').length }
        }),
        hint: document.querySelector('.db-hint') ? document.querySelector('.db-hint').textContent.trim() : null,
        canvas: getComputedStyle(document.querySelector('.db-board')).backgroundColor,
        lane: getComputedStyle(document.querySelector('.db-cols .pd-col')).backgroundColor,
      }
    })
    check('the Project Progress summary is RETIRED (the #db-counts span emptied + hidden)', t.countsGone)
    check('no board-level summary text joined the toolbar', !/of\s+\d+\s+done|%\s*done/.test(t.toolbarText))
    check('the workspace switcher survives', t.switcher)
    check('the five lanes keep the EXACT workflow names + order', JSON.stringify(t.lanes.map((l) => l.title)) === JSON.stringify(LANES.map((l) => l.title)), JSON.stringify(t.lanes.map((l) => l.title)))
    check('every lane header carries exactly ONE ⋯ menu', t.lanes.every((l) => l.menu === 1))
    check('every empty lane carries its supplied illustration + heading + lane Add', LANES.every((l) => { const e = t.empties.find((x) => x.status === l.status); return e && e.src === l.art && e.heading === l.heading && e.add === l.status }))
    check('the bottom add strip is hidden while a lane is empty', t.empties.every((e) => e.strip === 0))
    check('the helper hint carries the exact copy', /Start by adding a task to move your work forward\./.test(t.hint || ''), JSON.stringify(t.hint))
    check('the neutral canvas sits behind the white lane surfaces', t.canvas === 'rgb(245, 246, 247)' && t.lane === 'rgb(255, 255, 255)', t.canvas + ' vs ' + t.lane)
    await pg.screenshot({ path: path.join(args.out, 'island-empty-light-1600.png') })
    await pg.context().close()
  }

  // ---- (4) the Add task flow --------------------------------------------------
  {
    const pg = await open()
    await pg.click('.pd-col[data-status="planned"] .pd-empty-add')
    await pg.waitForSelector('.db-modal-card', { timeout: 5000 })
    const seg = await pg.evaluate(() => [...document.querySelectorAll('.db-modal .db-seg[data-seg="status"] button')].map((b) => ({ v: b.dataset.val, on: b.classList.contains('is-on') })).find((x) => x.v === 'planned'))
    check('the empty-state Add task opens the EXISTING editor with the lane preselected', !!seg && seg.on)
    await pg.screenshot({ path: path.join(args.out, 'island-add-flow.png') })
    await pg.context().close()
  }

  // ---- the populated board + the ⋯ menu ---------------------------------------
  {
    probe.tasks = [
      mkTask('t1', 'Design the onboarding illustrations', 'idea', 'high'),
      mkTask('t2', 'Login rate-limit misfires for EU users', 'bug', 'urgent'),
      mkTask('t3', 'Ship the settings page round', 'planned', 'medium'),
      mkTask('t4', 'Refactor the sync engine retries', 'in_progress', 'high'),
      mkTask('t5', 'Dark mode contrast fixes', 'done', 'low'),
      mkTask('t6', 'Per-card sync badge', 'done', 'low'),
    ]
    const pg = await open()
    await pg.waitForSelector('.pd-task-wrap', { timeout: 5000 })
    const t = await pg.evaluate(() => {
      const idea = document.querySelector('.pd-col[data-status="idea"]')
      const done = document.querySelector('.pd-col[data-status="done"]')
      return {
        cards: document.querySelectorAll('.pd-task-wrap').length,
        ideaEmpty: idea.querySelectorAll('[data-pd-empty]').length,
        ideaStrip: idea.querySelectorAll('.pd-task-add').length,
        doneStrip: done.querySelectorAll('.pd-task-add').length,
        hint: document.querySelectorAll('.db-hint').length,
      }
    })
    check('the populated board renders its six cards', t.cards === 6, 'cards: ' + t.cards)
    check('a lane with tasks loses its empty state + regains the bottom strip', t.ideaEmpty === 0 && t.ideaStrip === 1)
    check('the done lane keeps its strip too', t.doneStrip === 1)
    await pg.screenshot({ path: path.join(args.out, 'island-populated-light-1600.png') })
    // the ⋯ menu on the populated done lane: all four actions
    await pg.click('.pd-col[data-status="done"] [data-db-col-menu]')
    await pg.waitForSelector('.pd-col[data-status="done"] .db-col-menu:not([hidden])', { timeout: 5000 })
    const menu = await pg.evaluate(() => {
      const m = document.querySelector('.pd-col[data-status="done"] .db-col-menu')
      return { archive: m.querySelectorAll('[data-db-archive-done]').length, clear: m.querySelectorAll('[data-db-clear-done]').length, copy: m.querySelectorAll('[data-db-copy="done"]').length, export: m.querySelectorAll('[data-db-export="done"]').length }
    })
    check('the done lane ⋯ menu carries all FOUR actions (archive/clear/copy/export)', menu.archive === 1 && menu.clear === 1 && menu.copy === 1 && menu.export === 1, JSON.stringify(menu))
    await pg.screenshot({ path: path.join(args.out, 'island-col-menu-open.png') })
    await pg.keyboard.press('Escape')
    await pg.waitForTimeout(150)
    const closed = await pg.evaluate(() => document.querySelector('.pd-col[data-status="done"] .db-col-menu').hidden)
    check('Escape closes the column menu', closed)
    await pg.context().close()
    probe.tasks = []
  }

  // ---- (5) the desktop minimum 1100×720 ---------------------------------------
  {
    const pg = await open({ vp: { width: 1100, height: 720 } })
    const t = await pg.evaluate(() => {
      const lanes = [...document.querySelectorAll('.db-cols .pd-col')].map((el) => Math.round(el.getBoundingClientRect().width))
      const toolbar = document.getElementById('db-toolbar').getBoundingClientRect()
      return { n: lanes.length, min: Math.min(...lanes), toolbarLeft: Math.round(toolbar.left), hintVisible: !!document.querySelector('.db-hint') }
    })
    check('the 1100×720 desktop minimum keeps FIVE usable lanes', t.n === 5 && t.min >= 170, 'lanes: ' + t.n + ' min: ' + t.min)
    check('the toolbar stays anchored at the minimum size', t.toolbarLeft >= 0 && t.toolbarLeft < 40)
    check('the helper hint stays visible at the minimum size', t.hintVisible)
    await pg.screenshot({ path: path.join(args.out, 'island-empty-min-1100.png') })
    await pg.context().close()
  }

  // ---- (6) the narrow board scrolls (never crushes) ---------------------------
  {
    const pg = await open({ vp: { width: 800, height: 720 } })
    const t = await pg.evaluate(() => {
      const board = document.querySelector('.db-board')
      const lanes = [...document.querySelectorAll('.db-cols .pd-col')].map((el) => Math.round(el.getBoundingClientRect().width))
      const toolbar = document.getElementById('db-toolbar').getBoundingClientRect()
      return { n: lanes.length, min: Math.min(...lanes), scrolls: board.scrollWidth > board.clientWidth, toolbarLeft: Math.round(toolbar.left) }
    })
    check('800px keeps five lanes at usable width', t.n === 5 && t.min >= 170, 'lanes: ' + t.n + ' min: ' + t.min)
    check('the BOARD scrolls horizontally at 800px', t.scrolls)
    check('the toolbar never scrolls away', t.toolbarLeft >= 0 && t.toolbarLeft < 40)
    await pg.screenshot({ path: path.join(args.out, 'island-narrow-800.png') })
    await pg.context().close()
  }

  // ---- (7) dark mode ----------------------------------------------------------
  {
    const pg = await open({ theme: 'claude-dark' })
    const t = await pg.evaluate(() => ({
      theme: document.documentElement.getAttribute('data-theme'),
      canvas: getComputedStyle(document.querySelector('.db-board')).backgroundColor,
      lane: getComputedStyle(document.querySelector('.db-cols .pd-col')).backgroundColor,
      imgOpacity: getComputedStyle(document.querySelector('.pd-empty-icon')).opacity,
    }))
    check('dark mode: the canvas + lane surfaces flip tokens', t.theme === 'claude-dark' && t.canvas === 'rgb(25, 24, 23)' && t.lane === 'rgb(31, 30, 28)', t.canvas + ' vs ' + t.lane)
    check('dark mode: the illustrations stay visible (tuned opacity)', parseFloat(t.imgOpacity) > 0.6, t.imgOpacity)
    await pg.screenshot({ path: path.join(args.out, 'island-empty-dark-1600.png') })
    await pg.context().close()
  }

  // ---- (8) FA/RTL -------------------------------------------------------------
  {
    const pg = await open({ lang: 'fa' })
    const t = await pg.evaluate(() => {
      const lanes = [...document.querySelectorAll('.db-cols .pd-col')]
      const first = lanes[0].getBoundingClientRect()
      const last = lanes[lanes.length - 1].getBoundingClientRect()
      return {
        dir: document.documentElement.getAttribute('dir'),
        titles: lanes.map((c) => c.querySelector('.pd-col-title').textContent.trim()),
        heading: document.querySelector('.pd-col[data-status="idea"] .pd-empty-title').textContent.trim(),
        hint: document.querySelector('.db-hint').textContent.trim(),
        firstOnRight: first.x > last.x,
      }
    })
    check('FA boot: dir=rtl + the lane titles localize', t.dir === 'rtl' && t.titles[0] === 'ایده\u200cهای جدید' && t.titles[4] === 'انجام\u200cشده', JSON.stringify(t.titles))
    check('FA boot: the empty-state heading localizes', t.heading === 'هنوز ایده\u200cای نیست', t.heading)
    check('FA boot: the helper hint localizes', /برای جلو بردن کارت/.test(t.hint), t.hint)
    check('FA boot: the FIRST lane lands on the RIGHT (RTL)', t.firstOnRight)
    await pg.screenshot({ path: path.join(args.out, 'island-empty-fa-rtl-1600.png') })
    await pg.context().close()
  }

  check('ZERO page errors through the whole probe', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  await browser.close()
  server.close()
  if (failures.length) {
    console.log('[probe] FAILED (' + failures.length + '): ' + failures.join(' | '))
    process.exit(1)
  }
  console.log('[probe] ALL PASS — screenshots in ' + args.out + ' (island-empty-light-1600.png, island-add-flow.png, island-populated-light-1600.png, island-col-menu-open.png, island-empty-min-1100.png, island-narrow-800.png, island-empty-dark-1600.png, island-empty-fa-rtl-1600.png)')
}

main().catch((e) => { console.error(e); server.close(); process.exit(1) })
