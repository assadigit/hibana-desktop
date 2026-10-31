#!/usr/bin/env node
// ============================================================================
// probe-labels.mjs — the S232 DELETE-ANY-LABEL island probe (Chromium via
// Playwright), against the REAL generated island bytes (frontend/dist) at the
// current pin. Two halves, one round:
//
//   A. THE LABEL FLOWS (the owner's ask: "There are two labels that can't be
//      deleted. why? fix it."):
//      1. The labels dialog: every row — used OR unused — carries the ✕
//         (data-lbl-del); usage counts render honestly.
//      2. A USED label deletes through the CONFIRM modal (the count baked into
//         the message) with ?force=1 on the DELETE; the row goes, the list
//         re-fetches, the ok toast lands.
//      3. Escape cancels; Cancel keeps the label; nothing crosses the bridge.
//      4. The 409 race (a label re-used between load and click) surfaces the
//         db.labelsInUse toast and keeps the row.
//      5. An UNUSED label deletes immediately — no confirm, no force param.
//      6. The MERGE flow (the S30 feature the missing confirm broke on desktop)
//         confirms and POSTs /api/tags/:id/merge through the seam.
//   B. THE SHIM'S window.hibana.confirm (the round's second fix — the island's
//      five S210 call sites had NO implementation since app.js is stripped):
//      7. The task EDITOR's Delete opens the confirm modal (no TypeError — the
//         pre-fix island threw "window.hibana.confirm is not a function" and
//         the button died silently); Cancel keeps the task.
//      8. FA/RTL: the confirm's buttons localize (حذف / انصراف) with the lazy
//         FA dictionary, the dialog mirrors.
//      9. ZERO page errors on every leg.
//
// USAGE (playwright + browsers ship in hibana-source for its e2e suite):
//   node scripts/probe-labels.mjs --src /home/z/hibana-source \
//        [--dist frontend/dist] [--out /tmp/probe-labels] [--port 3993]
// ============================================================================
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

function parseArgs(a) {
  const o = { src: '', dist: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../frontend/dist'), out: '/tmp/probe-labels', port: 3993 }
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
for (const f of ['index.html', 'js/devboard.js', 'js/desktop-shim.js', 'js/i18n-fa.js']) {
  if (!fs.existsSync(path.join(args.dist, f))) {
    console.error('[probe] missing ' + f + ' under ' + args.dist + ' — run scripts/sync-island.mjs first.')
    process.exit(1)
  }
}

const P1 = '33333333-3333-4333-8333-333333333333'
const probe = {
  authed: true,
  lang: 'en',
  theme: null,
  // The owner's screenshot shape: s208-live used 2×, s211-acceptance used 1× —
  // plus a fresh unused label and a merge target.
  tags: [
    { id: 'tag-a', user_id: 'u1', name: 's208-live', color: '#7CC7C1', usage_count: 2, created_at: '2026-01-01T00:00:00.000Z' },
    { id: 'tag-b', user_id: 'u1', name: 's211-acceptance', color: '#E59AA5', usage_count: 1, created_at: '2026-01-01T00:00:00.000Z' },
    { id: 'tag-c', user_id: 'u1', name: 's232-fresh', color: '#F2D58A', usage_count: 0, created_at: '2026-01-01T00:00:00.000Z' },
    { id: 'tag-d', user_id: 'u1', name: 's232-target', color: '#8AB8F0', usage_count: 1, created_at: '2026-01-01T00:00:00.000Z' },
  ],
  tasks: [],
  requests: [], // { method, path } — every bridge crossing
  failNextDeleteWith409: false,
}
const mkTask = (id, title, tagIds) => ({
  id, project_id: P1, title, status: 'idea', priority: 'medium', category_id: null, sprint_id: null, sort_order: 0,
  created_at: '2026-01-01T00:00:00.000Z', done_at: null, start_at: null, end_at: null, search_tags: '', updated_at: '2026-01-02T00:00:00.000Z',
  tags: tagIds, shot_count: 0,
})
probe.tasks = [mkTask('t1', 'carry live one', ['tag-a']), mkTask('t2', 'carry live two', ['tag-a']), mkTask('t3', 'carry acceptance', ['tag-b']), mkTask('t4', 'carry target', ['tag-d'])]

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

const devboardPayload = () => JSON.stringify({
  project: { id: P1, title: 'Probe Board', status: 'developing', type: 'personal' },
  tasks: probe.tasks, categories: [], sprints: [],
  tags: probe.tags, task_tags: probe.tasks.flatMap((t) => t.tags.map((tagId) => ({ task_id: t.id, tag_id: tagId }))),
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
      const { method, p: rp } = JSON.parse(raw)
      probe.requests.push({ method, path: rp })
      if (!probe.authed) return send(200, 'application/json', JSON.stringify({ status: 401, body: '{"error":"unauthorized"}' }))
      if (rp === '/api/projects?sort=recent') {
        return send(200, 'application/json', JSON.stringify({ status: 200, etag: null, body: JSON.stringify({ projects: [{ id: P1, title: 'Probe Board', status: 'developing', type: 'personal' }] }) }))
      }
      if (rp === '/api/tags' && method === 'GET') {
        return send(200, 'application/json', JSON.stringify({ status: 200, etag: null, body: JSON.stringify({ tags: probe.tags }) }))
      }
      const del = /^\/api\/tags\/([^/?]+)(\?force=1)?$/.exec(rp)
      if (del && method === 'DELETE') {
        const id = del[1]
        const forced = !!del[2]
        const tag = probe.tags.find((t) => t.id === id)
        if (!tag) return send(200, 'application/json', JSON.stringify({ status: 404, body: '{"error":"not_found"}' }))
        if (tag.usage_count > 0 && !forced) return send(200, 'application/json', JSON.stringify({ status: 409, body: '{"error":"tag_in_use"}' }))
        if (probe.failNextDeleteWith409) {
          probe.failNextDeleteWith409 = false
          return send(200, 'application/json', JSON.stringify({ status: 409, body: '{"error":"tag_in_use"}' }))
        }
        const removed = probe.tasks.filter((t) => t.tags.includes(id)).length
        probe.tasks.forEach((t) => { t.tags = t.tags.filter((x) => x !== id) })
        probe.tags = probe.tags.filter((t) => t.id !== id)
        return send(200, 'application/json', JSON.stringify({ status: 200, etag: null, body: JSON.stringify({ ok: true, removed_from: removed }) }))
      }
      const merge = /^\/api\/tags\/([^/]+)\/merge$/.exec(rp)
      if (merge && method === 'POST') {
        const src = merge[1]
        // merge into the only OTHER remaining tag
        const dst = probe.tags.find((t) => t.id !== src)
        if (!dst) return send(200, 'application/json', JSON.stringify({ status: 404, body: '{"error":"not_found"}' }))
        probe.tasks.forEach((t) => { if (t.tags.includes(src)) t.tags = t.tags.filter((x) => x !== src).concat(dst.id) })
        probe.tags = probe.tags.filter((t) => t.id !== src)
        return send(200, 'application/json', JSON.stringify({ status: 200, etag: null, body: JSON.stringify({ ok: true }) }))
      }
      const board = /^\/api\/projects\/([^/]+)\/devboard$/.exec(rp)
      if (board) {
        return send(200, 'application/json', JSON.stringify({ status: 200, etag: null, body: devboardPayload() }))
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

  const open = async ({ lang, theme } = {}) => {
    probe.lang = lang || 'en'
    probe.theme = theme || null
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 })
    const pg = await ctx.newPage()
    pg.on('pageerror', (e) => pageErrors.push(String(e)))
    await pg.goto(base + '/kanban?project=' + P1)
    await pg.waitForSelector('.db-cols', { timeout: 10000 })
    await pg.mouse.move(800, 450)
    await pg.waitForTimeout(600)
    return pg
  }
  const openLabels = async (pg) => {
    await pg.click('#db-labels-btn')
    const dlg = pg.locator('.db-modal:not([hidden])')
    await dlg.waitFor({ state: 'visible', timeout: 5000 })
    await pg.waitForFunction(() => document.querySelectorAll('.db-label-row[data-tag-id]').length > 0, null, { timeout: 5000 }).catch(() => {})
    return dlg
  }

  // ---- (1-2) the dialog: every row carries the ✕; the used-label confirm ----
  {
    const pg = await open()
    const dlg = await openLabels(pg)
    const rows = dlg.locator('.db-label-row[data-tag-id]')
    await rows.first().waitFor({ timeout: 5000 })
    check('A1. the four label rows render with honest usage', await rows.count() === 4, String(await rows.count()))
    check('A2. EVERY row carries the ✕ (used labels included — the owner\'s case)', await dlg.locator('[data-lbl-del]').count() === 4, String(await dlg.locator('[data-lbl-del]').count()))
    const liveRow = dlg.locator('.db-label-row[data-tag-id]', { has: pg.locator('input[value="s208-live"]') })
    check('A3. s208-live shows used 2×', (await liveRow.locator('.db-label-usage').textContent()).includes('2'))

    // the used-label delete → the confirm modal (the shim's own window.hibana.confirm)
    await liveRow.locator('[data-lbl-del]').click()
    const overlay = pg.locator('.hib-confirm-overlay')
    await overlay.waitFor({ state: 'visible', timeout: 5000 })
    check('B1. the USED delete opens the confirm modal (the shim\'s hibana.confirm)', await overlay.count() === 1)
    const msg = await overlay.locator('.hib-confirm-message').textContent()
    check('B2. the message names the label + the count', msg.includes('s208-live') && msg.includes('2 tasks'), msg)
    check('B3. the OK button wears the danger grammar', (await overlay.locator('[data-hib-confirm="ok"]').getAttribute('class') || '').includes('danger'))

    // (3) Escape cancels — nothing crosses the bridge
    const before = probe.requests.length
    await pg.keyboard.press('Escape')
    await pg.waitForTimeout(300)
    check('B4. Escape closes the confirm', await overlay.count() === 0)
    check('B5. Escape crossed NO bridge (the label survives)', probe.requests.length === before)

    // Cancel keeps the label
    await liveRow.locator('[data-lbl-del]').click()
    await overlay.waitFor({ state: 'visible', timeout: 5000 })
    await overlay.locator('[data-hib-confirm="cancel"]').click()
    await pg.waitForTimeout(300)
    check('B6. Cancel keeps the row + crosses nothing', (await rows.count() === 4) && probe.requests.length === before)

    // OK → DELETE ?force=1 crosses the seam, the row goes, the toast lands
    await liveRow.locator('[data-lbl-del]').click()
    await overlay.waitFor({ state: 'visible', timeout: 5000 })
    await overlay.locator('[data-hib-confirm="ok"]').click()
    await pg.waitForFunction(() => document.querySelectorAll('.db-label-row[data-tag-id]').length === 3, null, { timeout: 5000 })
    const forcedReq = probe.requests.filter((r) => r.method === 'DELETE' && r.path.includes('tag-a')).pop()
    check('B7. OK sends DELETE ?force=1 through the bridge', !!forcedReq && forcedReq.path.includes('force=1'), forcedReq ? forcedReq.path : 'none')
    check('B8. the row is gone + the ok toast lands', (await rows.count() === 3) && await pg.locator('#toast.ok').count() >= 1)

    // (4) the 409 race → the in-use toast, the row stays
    probe.failNextDeleteWith409 = true
    const accRow = dlg.locator('.db-label-row[data-tag-id]', { has: pg.locator('input[value="s211-acceptance"]') })
    await accRow.locator('[data-lbl-del]').click()
    await overlay.waitFor({ state: 'visible', timeout: 5000 })
    await overlay.locator('[data-hib-confirm="ok"]').click()
    await pg.waitForSelector('#toast.err', { timeout: 5000 })
    check('B9. a 409 race surfaces the in-use toast + keeps the row', (await rows.count() === 3) && (await pg.locator('#toast.err').textContent()).includes('in use'))

    // (5) the UNUSED label deletes immediately — no confirm, no force
    const freshRow = dlg.locator('.db-label-row[data-tag-id]', { has: pg.locator('input[value="s232-fresh"]') })
    await freshRow.locator('[data-lbl-del]').click()
    await pg.waitForFunction(() => document.querySelectorAll('.db-label-row[data-tag-id]').length === 2, null, { timeout: 5000 })
    check('B10. the UNUSED delete is immediate (no confirm opened)', (await overlay.count() === 0) && (await rows.count() === 2))
    const freshReq = probe.requests.filter((r) => r.method === 'DELETE' && r.path.includes('tag-c')).pop()
    check('B11. the unused DELETE carries NO force param', !!freshReq && !freshReq.path.includes('force'), freshReq ? freshReq.path : 'none')

    // (6) the MERGE flow — the S30 feature the missing confirm broke on desktop
    const accRow2 = dlg.locator('.db-label-row[data-tag-id]', { has: pg.locator('input[value="s211-acceptance"]') })
    await accRow2.locator('[data-lbl-merge]').selectOption({ label: 's232-target' })
    await overlay.waitFor({ state: 'visible', timeout: 5000 })
    check('B12. the MERGE confirm opens (was a silent TypeError pre-fix)', await overlay.count() === 1)
    await overlay.locator('[data-hib-confirm="ok"]').click()
    await pg.waitForFunction(() => document.querySelectorAll('.db-label-row[data-tag-id]').length === 1, null, { timeout: 5000 })
    const mergeReq = probe.requests.filter((r) => r.method === 'POST' && r.path.includes('/merge')).pop()
    check('B13. the merge POSTs through the bridge + the row merges away', !!mergeReq && mergeReq.path.includes('tag-b'), mergeReq ? mergeReq.path : 'none')

    await pg.keyboard.press('Escape')
    await pg.close()
  }

  // ---- (7) the task EDITOR's delete confirm (the pre-fix silent breakage) ----
  {
    const pg = await open()
    await pg.locator('.pd-task').first().click()
    const editor = pg.locator('.db-modal:not([hidden])')
    await editor.waitFor({ state: 'visible', timeout: 5000 })
    await editor.locator('[data-db-del]').click()
    const overlay = pg.locator('.hib-confirm-overlay')
    await overlay.waitFor({ state: 'visible', timeout: 5000 })
    check('C1. the editor Delete opens the confirm (no TypeError)', await overlay.count() === 1)
    await overlay.locator('[data-hib-confirm="cancel"]').click()
    await pg.waitForTimeout(300)
    check('C2. Cancel keeps the task on the board', await pg.locator('.pd-task').count() === 4, String(await pg.locator('.pd-task').count()))
    await pg.keyboard.press('Escape')
    await pg.close()
  }

  // ---- (8) FA/RTL: the confirm localizes with the lazy FA dictionary -------
  {
    const pg = await open({ lang: 'fa' })
    const dlg = await openLabels(pg)
    const liveRow = dlg.locator('.db-label-row[data-tag-id]', { has: pg.locator('input[value="s232-target"]') })
    await liveRow.locator('[data-lbl-del]').click()
    const overlay = pg.locator('.hib-confirm-overlay')
    await overlay.waitFor({ state: 'visible', timeout: 5000 })
    const cancelText = (await overlay.locator('[data-hib-confirm="cancel"]').textContent()).trim()
    const okText = (await overlay.locator('[data-hib-confirm="ok"]').textContent()).trim()
    check('D1. FA: the confirm buttons localize (انصراف / حذف)', cancelText.includes('انصراف') && okText.includes('حذف'), cancelText + ' / ' + okText)
    const faMsg = await overlay.locator('.hib-confirm-message').textContent()
    check('D2. FA: the delete message rides the FA dictionary', faMsg.includes('حذف') && faMsg.includes('s232-target'), faMsg)
    await overlay.locator('[data-hib-confirm="cancel"]').click()
    await pg.keyboard.press('Escape')
    await pg.close()
  }

  check('E1. ZERO page errors on every leg (the pre-fix island threw here)', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))

  await browser.close()
  server.close()
  if (failures.length) {
    console.log('\n' + failures.length + ' FAILED')
    process.exit(1)
  }
  console.log('\nALL PASS')
}

main().catch((e) => { console.error(e); process.exit(1) })
