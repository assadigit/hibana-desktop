#!/usr/bin/env node
// ============================================================================
// probe-refresh.mjs — the v0.1.12 refresh BROWSER PROBE (Chromium via Playwright).
//
// WHAT IT PROVES, against the REAL generated island bytes (frontend/dist):
//   1. The stored-session boot: data-desktop-authed="true" → the login gate
//      never shows, and the toolbar row renders its full v0.1.12 shape —
//      Sprints | Labels | Sync | Refresh | theme | Log out — with the Refresh
//      button VISIBLE, LABELED (the desktop-owned EN/FA pair), aria'd
//      ('Refresh board'), and twin-sized with its neighbors (the S220 "same
//      size" grammar extends to the pull-to-screen affordance).
//   2. THE OWNER'S EXACT SCENARIO, end to end: the board boots with TWO task
//      cards; the task is deleted server-side (the mock's equivalent of
//      "deleted something from hibana"); the still-booted island KEEPS showing
//      two cards (the honest before — the boot-time render the owner saw);
//      ONE click on Refresh re-boots the island and the deletion lands — ONE
//      card renders. The kanban now matches the cloud.
//   3. The sync round's own reflex (desktop-sync.js v0.1.12): an ok outcome
//      with pulled>0 names the updated boards in the success panel ("2
//      board(s) updated from the cloud — the board shows them when you close
//      this.") and the modal's close (Done) reloads the island — the deletions
//      the round pulled reach the VISIBLE board, closing the exact gap
//      "clicked sync on the app, but it didn't got deleted".
//   4. The no-op honesty: an ok outcome with pulled=0 (every board answered
//      304 — nothing changed server-side) claims NO update and reloads
//      NOTHING on close — the screen was already the cloud's truth.
//   5. The FA/RTL mirror in the dark look: a fa language_pref boot paints the
//      'به‌روزرسانی' label + the 'به‌روزرسانی تخته' aria, mirrors the row
//      (Log out leftmost), and the sync panel carries the FA fact —
//      theme-aware + RTL-native for free.
//
// The mock bridge sits at the SAME boundary the Wails runtime occupies in
// production (window.go/window.runtime — byte-for-byte the same positions).
// The SyncNow mock resolves the PROBE-CONTROLLED outcome (probe.syncOutcome,
// read at CALL time like a live Go binding would), so pulled>0 vs pulled=0
// are both drivable.
//
// USAGE (playwright + browsers ship in hibana-source for its e2e suite):
//   node scripts/probe-refresh.mjs --src /home/z/hibana-source \
//        [--dist frontend/dist] [--out /tmp/probe-refresh]
// Exit 0 + screenshots on success; exit 1 with the failed assertion otherwise.
// ============================================================================

import { createRequire } from 'node:module'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const a = { src: '/home/z/hibana-source', dist: path.join(REPO_ROOT, 'frontend/dist'), out: '/tmp/probe-refresh', port: 3132 }
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
for (const f of ['index.html', 'js/desktop-refresh.js', 'css/desktop-refresh.css', 'js/desktop-sync.js', 'js/desktop-login.js', 'icon.svg']) {
  if (!fs.existsSync(path.join(args.dist, f))) {
    console.error('[probe] missing ' + f + ' under ' + args.dist + ' — run scripts/sync-island.mjs first.')
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// The probe state. projects[] carries the seeded set the devboard + switcher
// mocks serve; tasks[] is the live board payload — the probe DELETES one task
// server-side to reproduce the owner's exact scenario ("deleted something
// from hibana"), and the still-booted island's boot-time render is asserted
// BEFORE the Refresh click lands the deletion. syncOutcome is what the mocked
// Go SyncNow binding resolves — read at CALL time, exactly like the live
// binding reads the real engine's round outcome.
// ---------------------------------------------------------------------------
const P1 = '11111111-1111-4111-8111-111111111111'
const probe = {
  authed: true,
  lang: 'en',
  theme: null, // null = light boot; 'claude-dark' = the explicit dark boot
  projects: [{ id: P1, title: 'Hibana Web', status: 'planning', type: 'personal' }],
  tasks: [
    { id: 't1', project_id: P1, title: 'Keep the fire alive', status: 'idea', priority: 'high', category_id: null, sprint_id: null, sort_order: 0, created_at: '2026-01-01T00:00:00.000Z', done_at: null, start_at: null, end_at: null, search_tags: '', updated_at: '2026-01-02T00:00:00.000Z', tags: [], shot_count: 0 },
    { id: 't2', project_id: P1, title: 'Ship the desktop port', status: 'planned', priority: 'medium', category_id: null, sprint_id: null, sort_order: 0, created_at: '2026-01-01T00:00:00.000Z', done_at: null, start_at: null, end_at: null, search_tags: '', updated_at: '2026-01-02T00:00:00.000Z', tags: [], shot_count: 0 },
  ],
  syncOutcome: null, // resolved by the mocked SyncNow binding when clicked
  syncCalls: 0,
  devboardGets: [],
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
  '  SyncNow: function () { return window.__probeSyncNow() },',
  '} } }',
  // The Wails EventsOn contract is MULTI-LISTENER (every registered callback
  // fires per emit) — the v0.1.17 settings round co-listens on
  // hibana:update-available / hibana:theme, so the probe registry models
  // the real runtime faithfully (the single-slot registry silently
  // dropped the earlier registrant).
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
      'window.__probeSyncNow = function () {',
      '  return fetch("/__probe/syncnow", { method: "POST" }).then(function (r) { return r.json() })',
      '}',
      'window.__probeRequest = function (method, p, body) {',
      '  return fetch("/__probe/request", { method: "POST", body: JSON.stringify({ method, p, body }) }).then(function (r) { return r.json() })',
      '}',
    ].join('\n') + '\n')
  }
  if (p === '/__probe/syncnow' && req.method === 'POST') {
    probe.syncCalls++
    return send(200, 'application/json', JSON.stringify(probe.syncOutcome))
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
  const cardCount = () => page.evaluate(() => document.querySelectorAll('.pd-task').length)
  const rebootWatcher = async () => {
    // The reload proof: a window property planted pre-click must be GONE after
    // the document re-boots (the fresh window never carried it).
    await page.evaluate(() => { window.__probeMarker = 'planted' })
  }

  try {
    // ---- 1. the stored-session boot: the gate never shows, the row is whole ----
    await page.goto(base + '/kanban', { waitUntil: 'load' })
    await page.waitForSelector('#login-gate', { state: 'hidden', timeout: 5000 })
    check('the stored-session boot hides the gate at first paint', true)
    await page.waitForFunction(() => document.querySelectorAll('.pd-task').length === 2, null, { timeout: 8000 })

    const row = await page.evaluate(() => {
      const ids = ['db-sprint-link', 'db-labels-btn', 'db-sync-button', 'db-refresh-button', 'db-theme-toggle', 'db-logout-button']
      const out = {}
      for (const id of ids) {
        const el = document.getElementById(id)
        if (!el) { out[id] = null; continue }
        const r = el.getBoundingClientRect()
        const label = el.querySelector('#db-refresh-btn-label') || el.querySelector('#db-sync-btn-label') || el.querySelector('#db-logout-btn-label')
        out[id] = { x: Math.round(r.x * 10) / 10, h: Math.round(r.height * 10) / 10, visible: r.width > 0 && r.height > 0, text: el.textContent.trim(), label: label ? label.textContent.trim() : '', aria: el.getAttribute('aria-label') || '', cls: el.className }
      }
      return out
    })
    for (const id of Object.keys(row)) check('the toolbar renders ' + id, row[id] !== null && row[id].visible)
    check('the row order is Sprints | Labels | Sync | Refresh | theme | Log out',
      row['db-sprint-link'] && row['db-labels-btn'] && row['db-sync-button'] && row['db-refresh-button'] && row['db-theme-toggle'] && row['db-logout-button'] &&
      row['db-sprint-link'].x < row['db-labels-btn'].x && row['db-labels-btn'].x < row['db-sync-button'].x && row['db-sync-button'].x < row['db-refresh-button'].x && row['db-refresh-button'].x < row['db-theme-toggle'].x && row['db-theme-toggle'].x < row['db-logout-button'].x,
      JSON.stringify(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v && v.x]))))
    const heights = [row['db-sprint-link'].h, row['db-labels-btn'].h, row['db-sync-button'].h, row['db-refresh-button'].h, row['db-logout-button'].h]
    const spread = Math.max(...heights) - Math.min(...heights)
    check('Sprints / Labels / Sync / Refresh / Log out are twin-sized (heights ' + heights.join('px, ') + 'px)', spread < 1.5, 'spread ' + spread + 'px')
    check('the Refresh button is LABELED (the S220 lesson: a bare icon reads as nothing)', row['db-refresh-button'].label === 'Refresh', JSON.stringify(row['db-refresh-button'].label))
    check('the Refresh aria reads the desktop-owned EN pair', row['db-refresh-button'].aria === 'Refresh board', JSON.stringify(row['db-refresh-button'].aria))
    check('the Refresh button is the row\'s ghost grammar (Sync stays the ONE colored action)', /(^|\s)ghost(\s|$)/.test(row['db-refresh-button'].cls), JSON.stringify(row['db-refresh-button'].cls))

    await page.screenshot({ path: path.join(args.out, 'toolbar-row.png') })

    // ---- 2. THE OWNER'S EXACT SCENARIO: a server-side deletion + the Refresh click ----
    // The board booted with BOTH task cards on screen.
    check('the board boots with the two seeded task cards', (await cardCount()) === 2, 'cards=' + (await cardCount()))
    // …the task is deleted on "hibana" (the mock's server-side state):
    probe.tasks = probe.tasks.filter((t) => t.id !== 't2')
    await page.waitForTimeout(300) // no island-side poll exists — the render must stand
    check('the still-booted island KEEPS the deleted card on screen (the honest before — no island-side poll)', (await cardCount()) === 2, 'cards=' + (await cardCount()))
    // ONE click on Refresh re-boots the island → the deletion lands.
    await rebootWatcher()
    await page.click('#db-refresh-button')
    await page.waitForFunction(() => !window.__probeMarker, null, { timeout: 8000 })
    check('clicking Refresh re-boots the island (the document reloaded)', true)
    await page.waitForFunction(() => document.querySelectorAll('.pd-task').length === 1, null, { timeout: 8000 })
    check('the re-booted board shows the cloud\'s truth — the deleted task is GONE (1 card)', (await cardCount()) === 1, 'cards=' + (await cardCount()))

    await page.screenshot({ path: path.join(args.out, 'refresh-applied.png') })

    // ---- 3. the sync round's own reflex: pulled>0 names the boards + reloads on close ----
    probe.syncOutcome = { ok: true, uploaded: 0, pulled: 2, projects: 1, boards: 1, at: new Date().toISOString() }
    await page.click('#db-sync-button')
    await page.waitForFunction(() => {
      const p = document.getElementById('db-sync-panel')
      return p && !p.hidden && /updated from the cloud/.test((document.getElementById('db-sync-panel-body') || {}).textContent || '')
    }, null, { timeout: 8000 })
    const pulledPanel = await page.evaluate(() => ({
      body: (document.getElementById('db-sync-panel-body') || {}).textContent || '',
      done: (document.getElementById('db-sync-done') || {}).hidden,
    }))
    check('the ok panel names the pulled boards', /2 board\(s\) updated from the cloud/.test(pulledPanel.body), JSON.stringify(pulledPanel.body))
    check('the ok panel says the board shows them on close (the reload is never a surprise)', /when you close this/.test(pulledPanel.body))
    check('the Done button is the ok panel\'s exit', pulledPanel.done === false)

    await page.screenshot({ path: path.join(args.out, 'sync-modal-pulled.png') })

    await rebootWatcher()
    await page.click('#db-sync-done')
    await page.waitForFunction(() => !window.__probeMarker, null, { timeout: 8000 })
    check('closing the modal (Done) after a pulled round reloads the island — the deletions reach the VISIBLE board', true)
    await page.waitForFunction(() => document.querySelectorAll('.pd-task').length === 1, null, { timeout: 8000 })
    check('the post-sync board still shows the cloud\'s truth (1 card)', (await cardCount()) === 1)

    // ---- 4. the no-op honesty: pulled=0 claims nothing + reloads nothing ----
    probe.syncOutcome = { ok: true, uploaded: 0, pulled: 0, projects: 1, boards: 1, at: new Date().toISOString() }
    await page.click('#db-sync-button')
    await page.waitForFunction(() => {
      const p = document.getElementById('db-sync-panel')
      return p && !p.hidden
    }, null, { timeout: 8000 })
    const quietPanel = await page.evaluate(() => (document.getElementById('db-sync-panel-body') || {}).textContent || '')
    check('an all-304 round (pulled=0) claims NO update in the ok panel', !/updated from the cloud/.test(quietPanel), JSON.stringify(quietPanel))
    await rebootWatcher()
    await page.click('#db-sync-done')
    await page.waitForTimeout(700)
    check('closing the modal after a pulled=0 round reloads NOTHING (the screen was already the truth)', await page.evaluate(() => !!window.__probeMarker))
    check('the mocked Go SyncNow binding was exercised every round', probe.syncCalls === 2, 'calls=' + probe.syncCalls)

    // ---- 5. the FA/RTL mirror in the dark look ----
    probe.lang = 'fa'
    probe.theme = 'claude-dark'
    await page.goto(base + '/kanban', { waitUntil: 'load' })
    await page.waitForFunction(() => {
      const lbl = document.querySelector('#db-refresh-btn-label')
      return lbl && lbl.textContent.trim() === 'به‌روزرسانی'
    }, null, { timeout: 8000 })
    check('the FA boot paints the desktop-owned به‌روزرسانی label', true)
    const rtl = await page.evaluate(() => {
      const dir = document.documentElement.getAttribute('dir')
      const re = document.getElementById('db-refresh-button')
      const sy = document.getElementById('db-sync-button')
      const th = document.getElementById('db-theme-toggle')
      const lo = document.getElementById('db-logout-button')
      const sp = document.getElementById('db-sprint-link')
      const theme = (document.documentElement.getAttribute('data-theme') || document.documentElement.getAttribute('data-desktop-theme'))
      return { dir, reX: re.getBoundingClientRect().x, syX: sy.getBoundingClientRect().x, thX: th.getBoundingClientRect().x, loX: lo.getBoundingClientRect().x, spX: sp.getBoundingClientRect().x, reAria: re.getAttribute('aria-label') || '', theme }
    })
    check('i18n applied dir=rtl', rtl.dir === 'rtl', JSON.stringify(rtl.dir))
    check('the row MIRRORS (Log out leftmost, Refresh between Sync and theme under RTL)', rtl.loX < rtl.reX && rtl.reX < rtl.syX && rtl.reX > rtl.thX && rtl.reX < rtl.spX, JSON.stringify({ loX: rtl.loX, syX: rtl.syX, reX: rtl.reX, thX: rtl.thX, spX: rtl.spX }))
    check('the FA aria reads the desktop-owned pair', rtl.reAria === 'به‌روزرسانی تخته', JSON.stringify(rtl.reAria))
    check('the dark look painted at first boot (data-theme)', rtl.theme === 'claude-dark', JSON.stringify(rtl.theme))

    // The FA sync panel fact — the pulled-boards line in Persian.
    probe.syncOutcome = { ok: true, uploaded: 0, pulled: 1, projects: 1, boards: 1, at: new Date().toISOString() }
    await page.click('#db-sync-button')
    await page.waitForFunction(() => {
      const p = document.getElementById('db-sync-panel')
      return p && !p.hidden && /ابر هیبانا به‌روزرسانی/.test((document.getElementById('db-sync-panel-body') || {}).textContent || '')
    }, null, { timeout: 8000 })
    check('the FA ok panel carries the FA pulled-boards fact', true)
    await page.evaluate(() => { window.__probeMarker = 'planted' })
    await page.click('#db-sync-done')
    await page.waitForFunction(() => !window.__probeMarker, null, { timeout: 8000 })
    check('the FA round\'s close reloads the island too', true)

    await page.screenshot({ path: path.join(args.out, 'refresh-fa-dark.png') })
  } catch (err) {
    failures.push('threw: ' + err.message)
    console.error('[probe] ' + err.message)
  } finally {
    await browser.close().catch(() => {})
    server.close()
  }

  check('ZERO page errors through the whole round', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200))

  if (failures.length) {
    console.error('\n[probe] FAILED (' + failures.length + '): ' + failures.join('; '))
    process.exit(1)
  }
  console.log('\n[probe] ALL PASS — screenshots in ' + args.out + ' (toolbar-row.png, refresh-applied.png, sync-modal-pulled.png, refresh-fa-dark.png)')
}

main().catch((err) => {
  console.error('[probe] ' + err)
  process.exit(1)
})
