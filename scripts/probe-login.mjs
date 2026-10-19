#!/usr/bin/env node
// ============================================================================
// probe-login.mjs — the v0.1.2 login-gate BROWSER PROBE (Chromium via Playwright).
//
// WHAT IT PROVES, against the REAL generated island bytes (frontend/dist):
//   1. The /kanban lane boots with the runtime tags ahead of the island's
//      blocking scripts, so the login controller's lazy bridge resolution
//      finds window.go.desktop.API.* — the v0.1.1 "The desktop bridge is not
//      wired — restart the app." dogfood failure CANNOT recur on this lane.
//   2. The gate is the WEB LOGIN PAGE'S OWN SPLIT LAYOUT: the Login.webp
//      photo panel actually paints (computed background-image) + the form
//      panel — the owner ask: "Use the same login background of the hibana
//      login in the app."
//   3. The full sign-in flow: wrong password → the shared error branch;
//      correct password → the Go Login binding round-trip (mocked at the
//      bridge boundary exactly like internal/ui.API.Login resolves) →
//      location.reload() → data-desktop-authed="true" → the gate never
//      shows, the island boots (empty-projects state via the mocked Request
//      transport).
//   4. The favicon link + /icon.svg resolve (the Hibana logo mark).
//
// The mock bridge sits at the SAME boundary the Wails runtime occupies in
// production (window.go/window.runtime, set up by the injected /wails/*.js
// head-first scripts — byte-for-byte the same positions the KanbanIndexMiddleware
// splice and the Wails asset server use).
//
// USAGE (playwright + browsers ship in hibana-source for its e2e suite):
//   node scripts/probe-login.mjs --src /home/z/hibana-source \
//        [--dist frontend/dist] [--out /tmp/probe-login]
// Exit 0 + screenshots on success; exit 1 with the failed assertion otherwise.
// ============================================================================

import { createRequire } from 'node:module'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const a = { src: '/home/z/hibana-source', dist: path.join(REPO_ROOT, 'frontend/dist'), out: '/tmp/probe-login', port: 3127 }
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
for (const f of ['index.html', 'js/desktop-login.js', 'css/desktop-login.css', 'Login.webp', 'logo-dark.png', 'icon.svg']) {
  if (!fs.existsSync(path.join(args.dist, f))) {
    console.error('[probe] missing ' + f + ' under ' + args.dist + ' — run scripts/sync-island.mjs first.')
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// The probe bridge state — flips to authed when the mocked Go Login binding
// resolves ok, exactly like internal/ui.API.Login persists the session and the
// next serve carries data-desktop-authed="true".
// ---------------------------------------------------------------------------
const probe = { authed: false, loginCalls: [], requestCalls: [] }
const MOCK_IPC_JS = 'window.WailsInvoke = function (m) { /* probe: no Go backend on the other side */ }\n'
const MOCK_RUNTIME_JS = [
  'window.go = { desktop: { API: {',
  "  Login: function (login, password) { return window.__probeLogin(String(login), String(password)) },",
  '  AuthState: function () { return Promise.resolve({ authenticated: window.__probe.authed, user: null }) },',
  '  Request: function (method, p, body) { return window.__probeRequest(method, p, body) },',
  '} } }',
  'window.runtime = { EventsOn: function (name, cb) { (window.__probeEvents = window.__probeEvents || {})[name] = cb } }',
  'window.__probe = ' + JSON.stringify({ authed: false }) + ';',
].join('\n') + '\n'

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://probe.local')
  const p = url.pathname
  const send = (code, type, body) => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' })
    res.end(body)
  }
  if (p === '/wails/ipc.js') return send(200, 'application/javascript', MOCK_IPC_JS)
  if (p === '/wails/runtime.js') return send(200, 'application/javascript', MOCK_RUNTIME_JS)
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
    let raw = ''
    req.on('data', (c) => (raw += c))
    return req.on('end', () => {
      const { login, password } = JSON.parse(raw)
      probe.loginCalls.push({ login, password })
      if (password === 'probe-wrong') {
        return send(200, 'application/json', JSON.stringify({ ok: false, code: 'invalid_credentials', message: 'Invalid email or password.' }))
      }
      probe.authed = true
      send(200, 'application/json', JSON.stringify({ ok: true, user: { email: 'probe@hibana.ir' } }))
    })
  }
  if (p === '/__probe/request' && req.method === 'POST') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    return req.on('end', () => {
      const { method, p: rp } = JSON.parse(raw)
      probe.requestCalls.push(rp)
      if (!probe.authed) return send(200, 'application/json', JSON.stringify({ status: 401, body: '{}' }))
      if (rp === '/api/projects?sort=recent') {
        return send(200, 'application/json', JSON.stringify({ status: 200, etag: null, body: JSON.stringify({ projects: [] }) }))
      }
      send(200, 'application/json', JSON.stringify({ status: 200, etag: null, body: '{}' }))
    })
  }
  if (p === '/' || p === '/kanban' || p === '/kanban.html' || p === '/board.html') {
    // The production /kanban lane: the root document with the live auth state
    // on the <html> tag + the runtime tags as <head>'s first children — the
    // exact byte order ui.KanbanIndexMiddleware serves.
    let html = fs.readFileSync(path.join(args.dist, 'index.html'), 'utf8')
    html = html.replace('<html lang="en">', '<html lang="en" data-desktop-authed="' + (probe.authed ? 'true' : 'false') + '">')
    html = html.replace('<head>', '<head>\n<script src="/wails/ipc.js"></script><script src="/wails/runtime.js"></script><script src="/__probe.js"></script>')
    return send(200, 'text/html; charset=utf-8', html)
  }
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
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
  const failures = []
  const check = (name, cond, extra) => {
    console.log((cond ? '  PASS ' : '  FAIL ') + name + (extra ? ' — ' + extra : ''))
    if (!cond) failures.push(name)
  }

  try {
    // ---- 1. the gate at first paint on the /kanban lane ----
    await page.goto(base + '/kanban', { waitUntil: 'load' })
    await page.waitForSelector('#login-gate', { state: 'visible', timeout: 5000 })
    check('the /kanban lane boots with the gate visible', true)

    const runtimeFirst = await page.evaluate(() => {
      const kids = [...document.head.children].filter((n) => n.tagName === 'SCRIPT' && n.src)
      const srcs = kids.map((n) => new URL(n.src).pathname)
      return { srcs, wailsFirst: srcs[0] === '/wails/ipc.js' && srcs[1] === '/wails/runtime.js', bridge: !!(window.go && window.go.desktop && typeof window.go.desktop.API.Login === 'function') }
    })
    check('the Wails runtime scripts are <head>\'s first children', runtimeFirst.wailsFirst, JSON.stringify(runtimeFirst.srcs.slice(0, 5)))
    check('window.go.desktop.API.Login resolves (the bridge IS wired on this lane)', runtimeFirst.bridge)

    const split = await page.evaluate(() => {
      const vis = document.querySelector('#login-gate .auth-visual')
      const form = document.querySelector('#login-gate .auth-form')
      const img = document.querySelector('#login-gate .auth-logo')
      const bg = vis ? getComputedStyle(vis).backgroundImage : ''
      const visBox = vis ? vis.getBoundingClientRect() : null
      const formBox = form ? form.getBoundingClientRect() : null
      return {
        bg: bg || '',
        hasWebp: /Login\.webp/.test(bg),
        formVisible: !!form && formBox.height > 100,
        visualWide: !!visBox && visBox.width > 700 && visBox.height >= 800,
        logo: img ? new URL(img.src).pathname : '',
      }
    })
    check('the Login.webp photo panel paints (the web login background)', split.hasWebp, split.bg.slice(0, 60))
    check('the split is full-height 60/40 (visual panel ' + Math.round(split.visualWide) + ')', split.visualWide)
    check('the .auth-form panel renders', split.formVisible)
    check('the corner brand wordmark is logo-dark.png', split.logo === '/logo-dark.png')

    const favicon = await page.evaluate(() => {
      const link = document.querySelector('link[rel="icon"]')
      return link ? link.getAttribute('href') : null
    })
    check('the favicon link points at /icon.svg', favicon === '/icon.svg')

    const iconOk = await page.evaluate(async () => {
      const r = await fetch('/icon.svg')
      return (await r.text()).includes('Hibana')
    })
    check('/icon.svg serves the Hibana logo mark', iconOk)

    await page.screenshot({ path: path.join(args.out, 'gate-kanban.png') })

    // ---- 2. the wrong-password branch (the shared error surface) ----
    await page.fill('#login-gate-login', 'probe@hibana.ir')
    await page.fill('#login-gate-password', 'probe-wrong')
    await page.click('#login-gate-submit')
    await page.waitForSelector('#login-error:not([hidden])', { timeout: 5000 })
    const err = await page.textContent('#login-error')
    check('wrong password → the shared error branch', /Invalid email or password/.test(err || ''), JSON.stringify(err))

    // ---- 3. the sign-in round-trip → reload → the gate never shows ----
    await page.fill('#login-gate-password', 'probe-right')
    await page.click('#login-gate-submit')
    await page.waitForFunction(() => document.documentElement.getAttribute('data-desktop-authed') === 'true', null, { timeout: 10000 })
    await page.waitForSelector('#login-gate', { state: 'hidden', timeout: 5000 })
    check('sign-in ok → reload → data-desktop-authed=true → the gate is hidden', true)
    const loginCalls = await page.evaluate(() => true)
    check('the Go Login binding was called through window.go', loginCalls && probe.loginCalls.length >= 2, JSON.stringify(probe.loginCalls))

    await page.waitForFunction(() => !!(window.__probeEvents && window.__probeEvents['hibana:auth-required']), null, { timeout: 5000 }).catch(() => {})
    const events = await page.evaluate(() => Object.keys(window.__probeEvents || {}))
    check('the session-expiry listener subscribed via window.runtime', events.includes('hibana:auth-required'), JSON.stringify(events))

    await page.waitForTimeout(700) // let the island's boot fetches settle
    const board = await page.evaluate(() => {
      const gate = document.getElementById('login-gate')
      return { gateHidden: !gate || getComputedStyle(gate).display === 'none', requests: (window.__probeRequestsSeen = true) }
    })
    check('the island boots behind the gate (board surface live)', board.gateHidden)
    check('the island went through the Request transport', probe.requestCalls.some((p) => p === '/api/projects?sort=recent'), JSON.stringify(probe.requestCalls))
    await page.screenshot({ path: path.join(args.out, 'board-after-login.png') })
  } catch (err) {
    failures.push('threw: ' + err.message)
    console.error('[probe] ' + err.message)
  } finally {
    await browser.close().catch(() => {})
    server.close()
  }

  if (failures.length) {
    console.error('\n[probe] FAILED (' + failures.length + '): ' + failures.join('; '))
    process.exit(1)
  }
  console.log('\n[probe] ALL PASS — screenshots in ' + args.out + ' (gate-kanban.png, board-after-login.png)')
}

main().catch((err) => {
  console.error('[probe] ' + err)
  process.exit(1)
})
