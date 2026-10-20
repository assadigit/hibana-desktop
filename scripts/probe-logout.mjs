#!/usr/bin/env node
// ============================================================================
// probe-logout.mjs — the v0.1.9 sign-out BROWSER PROBE (Chromium via Playwright).
//
// WHAT IT PROVES, against the REAL generated island bytes (frontend/dist):
//   1. The stored-session boot: data-desktop-authed="true" → the login gate
//      never shows, and the toolbar row renders its full END — Sprints |
//      Labels | Sync | theme | Log out — with the Log out button VISIBLE,
//      LABELED (the pin's own nav.signout), and twin-sized with its
//      neighbors (the S220 "same size" grammar extends to the account zone).
//   2. The confirm round: click Log out → the native #db-logout-dialog opens
//      (Cancel + Sign out); Cancel closes it with NO state change; Sign out
//      resolves the Go Logout binding (mocked at the bridge boundary exactly
//      like internal/ui.API.Logout resolves {ok:true}) → location.reload()
//      → the serve carries data-desktop-authed="false" → the login card is
//      visible at FIRST PAINT (the owner ask: "option of logout").
//   3. The new account: on that gate the user signs in with a DIFFERENT
//      account → the Go Login binding round-trip → reload → authed=true →
//      the gate never shows again (the owner ask: "enter with a new account").
//   4. The FA/RTL mirror in the dark look: a fa language_pref boot paints the
//      'خروج' label, mirrors the row (Log out leftmost), and the dialog
//      carries the FA body copy — theme-aware + RTL-native for free.
//
// The mock bridge sits at the SAME boundary the Wails runtime occupies in
// production (window.go/window.runtime, set up by the injected /wails/*.js
// head-first scripts — byte-for-byte the same positions the
// KanbanIndexMiddleware splice and the Wails asset server use).
//
// USAGE (playwright + browsers ship in hibana-source for its e2e suite):
//   node scripts/probe-logout.mjs --src /home/z/hibana-source \
//        [--dist frontend/dist] [--out /tmp/probe-logout]
// Exit 0 + screenshots on success; exit 1 with the failed assertion otherwise.
// ============================================================================

import { createRequire } from 'node:module'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const a = { src: '/home/z/hibana-source', dist: path.join(REPO_ROOT, 'frontend/dist'), out: '/tmp/probe-logout', port: 3129 }
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
for (const f of ['index.html', 'js/desktop-logout.js', 'css/desktop-logout.css', 'js/desktop-login.js', 'icon.svg']) {
  if (!fs.existsSync(path.join(args.dist, f))) {
    console.error('[probe] missing ' + f + ' under ' + args.dist + ' — run scripts/sync-island.mjs first.')
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// The probe bridge state — starts AUTHED (the stored-session boot), flips to
// false on the mocked Go Logout binding (exactly like internal/ui.API.Logout
// drops the cookie + the session file + flips the state), and back to true on
// the mocked Login — the next serve then carries data-desktop-authed per the
// flip, byte-for-byte the ui.InjectShellState contract.
// ---------------------------------------------------------------------------
const probe = {
  authed: true,
  lang: 'en',
  theme: null, // null = light boot; 'claude-dark' = the explicit dark boot
  loginCalls: [],
  logoutCalls: [],
  requestCalls: [],
}
const MOCK_IPC_JS = 'window.WailsInvoke = function (m) { /* probe: no Go backend on the other side */ }\n'
// The runtime mock is built PER REQUEST from the live probe state — the exact
// contract the Wails runtime has in production (the bindings read the LIVE Go
// state at call time; the document's data-desktop-authed is only the first-paint
// hint). A module-level constant would freeze the state at boot and the FA/
// dark pass would read the EN boot forever.
const mockRuntimeJs = () => [
  'window.go = { desktop: { API: {',
  "  Login: function (login, password) { return window.__probeLogin(String(login), String(password)) },",
  '  Logout: function () { return window.__probeLogout() },',
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
      'window.__probeLogout = function () {',
      '  return fetch("/__probe/logout", { method: "POST" }).then(function (r) { return r.json() })',
      '}',
      'window.__probeRequest = function (method, p, body) {',
      '  return fetch("/__probe/request", { method: "POST", body: JSON.stringify({ method, p, body }) }).then(function (r) { return r.json() })',
      '}',
    ].join('\n') + '\n')
  }
  if (p === '/__probe/login' && req.method === 'POST') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    return req.on('end', () => {
      const { login } = JSON.parse(raw)
      probe.loginCalls.push(login)
      probe.authed = true
      send(200, 'application/json', JSON.stringify({ ok: true, user: { email: login } }))
    })
  }
  if (p === '/__probe/logout' && req.method === 'POST') {
    probe.logoutCalls.push(Date.now())
    probe.authed = false // the LOCAL account state dies — the next serve carries the gate
    return send(200, 'application/json', JSON.stringify({ ok: true }))
  }
  if (p === '/__probe/request' && req.method === 'POST') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    return req.on('end', () => {
      const { p: rp } = JSON.parse(raw)
      probe.requestCalls.push(rp)
      if (!probe.authed) return send(200, 'application/json', JSON.stringify({ status: 401, body: '{}' }))
      if (rp === '/api/projects?sort=recent') {
        return send(200, 'application/json', JSON.stringify({ status: 200, etag: null, body: JSON.stringify({ projects: [] }) }))
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
    // ---- 1. the stored-session boot: the gate never shows, the row is whole ----
    await page.goto(base + '/kanban', { waitUntil: 'load' })
    await page.waitForSelector('#login-gate', { state: 'hidden', timeout: 5000 })
    check('the stored-session boot hides the gate at first paint', true)

    const row = await page.evaluate(() => {
      const ids = ['db-sprint-link', 'db-labels-btn', 'db-sync-button', 'db-theme-toggle', 'db-logout-button']
      const out = {}
      for (const id of ids) {
        const el = document.getElementById(id)
        if (!el) { out[id] = null; continue }
        const r = el.getBoundingClientRect()
        const label = el.querySelector('#db-logout-btn-label') || el.querySelector('#db-sync-btn-label')
        out[id] = { x: Math.round(r.x * 10) / 10, h: Math.round(r.height * 10) / 10, w: Math.round(r.width * 10) / 10, visible: r.width > 0 && r.height > 0, text: el.textContent.trim(), label: label ? label.textContent.trim() : '' }
      }
      return out
    })
    for (const id of Object.keys(row)) check('the toolbar renders ' + id, row[id] !== null && row[id].visible)
    check('the row order is Sprints | Labels | Sync | theme | Log out',
      row['db-sprint-link'] && row['db-labels-btn'] && row['db-sync-button'] && row['db-theme-toggle'] && row['db-logout-button'] &&
      row['db-sprint-link'].x < row['db-labels-btn'].x && row['db-labels-btn'].x < row['db-sync-button'].x && row['db-sync-button'].x < row['db-theme-toggle'].x && row['db-theme-toggle'].x < row['db-logout-button'].x,
      JSON.stringify(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v && v.x]))))
    const heights = [row['db-sprint-link'].h, row['db-labels-btn'].h, row['db-sync-button'].h, row['db-logout-button'].h]
    const spread = Math.max(...heights) - Math.min(...heights)
    check('Sprints / Labels / Sync / Log out are twin-sized (heights ' + heights.join('px, ') + 'px)', spread < 1.5, 'spread ' + spread + 'px')
    check('the Log out button is LABELED (the S220 lesson: a bare icon reads as nothing)', row['db-logout-button'].label === 'Sign out', JSON.stringify(row['db-logout-button'].label))
    check('the label rides the pin\'s own nav.signout key', row['db-logout-button'].text === 'Sign out')

    await page.screenshot({ path: path.join(args.out, 'toolbar-row.png') })

    // ---- 2. the confirm round: open → Cancel changes nothing ----
    await page.click('#db-logout-button')
    const dlg = await page.evaluate(() => {
      const d = document.getElementById('db-logout-dialog')
      return { open: !!(d && d.open), title: (document.getElementById('db-logout-title') || {}).textContent || '', body: (document.getElementById('db-logout-body') || {}).textContent || '', confirm: (document.getElementById('db-logout-confirm') || {}).textContent.trim(), cancel: (document.getElementById('db-logout-cancel') || {}).textContent.trim() }
    })
    check('clicking Log out opens the native confirm dialog', dlg.open)
    check('the dialog title rides nav.signout', dlg.title === 'Sign out', JSON.stringify(dlg.title))
    check('the dialog body is the safe-to-leave copy', /sign in again any time to load them back/.test(dlg.body), JSON.stringify(dlg.body))
    check('the confirm button rides nav.signout', dlg.confirm === 'Sign out')
    check('the cancel button rides common.cancel', dlg.cancel === 'Cancel')

    await page.screenshot({ path: path.join(args.out, 'logout-confirm.png') })

    await page.click('#db-logout-cancel')
    await page.waitForFunction(() => { const d = document.getElementById('db-logout-dialog'); return d && !d.open }, null, { timeout: 5000 })
    check('Cancel closes the dialog with NO state change (still authed)', probe.authed === true && probe.logoutCalls.length === 0)

    // ---- 3. the sign-out: confirm → the Go Logout binding → reload → the gate ----
    await page.click('#db-logout-button')
    await page.waitForFunction(() => { const d = document.getElementById('db-logout-dialog'); return d && d.open }, null, { timeout: 5000 })
    await page.click('#db-logout-confirm')
    await page.waitForFunction(() => document.documentElement.getAttribute('data-desktop-authed') === 'false', null, { timeout: 10000 })
    check('confirm → the Go Logout binding → reload → data-desktop-authed="false"', probe.logoutCalls.length === 1)
    await page.waitForSelector('#login-gate', { state: 'visible', timeout: 5000 })
    check('the login card is VISIBLE at the post-sign-out paint (the logout ask)', true)
    const gateSub = await page.textContent('#login-gate-sub')
    check('the gate asks for the (new) account — not an expiry line', /Sign in to your Hibana account/.test(gateSub || ''), JSON.stringify(gateSub))

    await page.screenshot({ path: path.join(args.out, 'logout-gate.png') })

    // ---- 4. enter with a NEW account on that gate ----
    await page.fill('#login-gate-login', 'new-account@hibana.ir')
    await page.fill('#login-gate-password', 'new-account-password')
    await page.click('#login-gate-submit')
    await page.waitForFunction(() => document.documentElement.getAttribute('data-desktop-authed') === 'true', null, { timeout: 10000 })
    await page.waitForSelector('#login-gate', { state: 'hidden', timeout: 5000 })
    check('signing in with the NEW account → reload → the gate never shows again', probe.loginCalls.includes('new-account@hibana.ir'), JSON.stringify(probe.loginCalls))
    const rowAgain = await page.evaluate(() => !!document.getElementById('db-logout-button'))
    check('the toolbar (and its account zone) is back on the new account\'s board', rowAgain)

    await page.screenshot({ path: path.join(args.out, 'new-account-board.png') })

    // ---- 5. the FA/RTL mirror in the dark look ----
    probe.lang = 'fa'
    probe.theme = 'claude-dark'
    await page.goto(base + '/kanban', { waitUntil: 'load' })
    await page.waitForFunction(() => {
      const lbl = document.querySelector('#db-logout-btn-label')
      return lbl && lbl.textContent.trim() === 'خروج'
    }, null, { timeout: 8000 })
    check('the FA boot paints the pin\'s own خروج label', true)
    const rtl = await page.evaluate(() => {
      const dir = document.documentElement.getAttribute('dir')
      const lo = document.getElementById('db-logout-button').getBoundingClientRect().x
      const sp = document.getElementById('db-sprint-link').getBoundingClientRect().x
      const body = (document.getElementById('db-logout-body') || {}).textContent || ''
      const confirm = (document.getElementById('db-logout-confirm') || {}).textContent.trim()
      const theme = (document.documentElement.getAttribute('data-theme') || document.documentElement.getAttribute('data-desktop-theme'))
      return { dir, loX: lo, spX: sp, mirroredRow: lo < sp, body, confirm, theme }
    })
    check('i18n applied dir=rtl', rtl.dir === 'rtl', JSON.stringify(rtl.dir))
    check('the row MIRRORS (Log out leftmost under RTL)', rtl.mirroredRow, 'logout@' + rtl.loX + ' sprints@' + rtl.spX)
    check('the dark look painted at first boot (data-theme)', rtl.theme === 'claude-dark', JSON.stringify(rtl.theme))

    await page.click('#db-logout-button')
    await page.waitForFunction(() => { const d = document.getElementById('db-logout-dialog'); return d && d.open }, null, { timeout: 5000 })
    const faDlg = await page.evaluate(() => {
      const d = document.getElementById('db-logout-dialog')
      return { open: !!(d && d.open), body: (document.getElementById('db-logout-body') || {}).textContent || '', confirm: (document.getElementById('db-logout-confirm') || {}).textContent.trim(), cancel: (document.getElementById('db-logout-cancel') || {}).textContent.trim() }
    })
    check('the FA dialog opens with the FA body copy', faDlg.open && /ابر هیبانا امن/.test(faDlg.body), JSON.stringify(faDlg.body))
    check('the FA confirm + cancel ride the pin dictionary', faDlg.confirm === 'خروج' && faDlg.cancel === 'انصراف', JSON.stringify({ c: faDlg.confirm, x: faDlg.cancel }))

    await page.screenshot({ path: path.join(args.out, 'logout-fa-dark.png') })
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
  console.log('\n[probe] ALL PASS — screenshots in ' + args.out + ' (toolbar-row.png, logout-confirm.png, logout-gate.png, new-account-board.png, logout-fa-dark.png)')
}

main().catch((err) => {
  console.error('[probe] ' + err)
  process.exit(1)
})
