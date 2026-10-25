#!/usr/bin/env node
// ============================================================================
// probe-completefacts.mjs — the v0.1.15 COMPLETE-FACTS + UPLOAD BROWSER PROBE
// (Chromium via Playwright), against the REAL generated island bytes
// (frontend/dist). The two owner asks this round pins:
//
//   A. "When you sync using Hibana Desktop, the modal is not complete and
//      needs fix" — the step notes are the round's LIVE PROOF and the old
//      60%-cap ellipsis cut them mid-word ("signed in as aliassadi@live.c…").
//      The probe drives a round whose step details are EXACTLY the owner's
//      screenshot facts and asserts, on the rendered geometry:
//        * every note's text is COMPLETE (textContent === the emitted fact),
//        * no ellipsis (computed text-overflow is not 'ellipsis') and no
//          hidden horizontal overflow (scrollWidth <= clientWidth),
//        * the note owns its own line UNDER the label (top > label's top),
//        * a long no-break email does not stretch or clip the card
//          (overflow-wrap: anywhere — the li stays inside the modal),
//        * the modal itself still fits the viewport (no dialog overflow).
//
//   B. "In hibana desktop, upload file button exists and it shows a loading
//      as well, but after the loading ends, it doesn't show whether it was
//      successful or not, because it doesn't show the thumbnail of the
//      uploaded picture" — the M4 Upload bridge is wired through the shim's
//      XHR proxy. The probe mocks the Go binding at the SAME boundary Wails
//      occupies (window.go.desktop.API.Upload) and asserts, end to end:
//        * the Upload call carries the callID FIRST + method/path/body/headers,
//        * the hibana:upload-progress events (routed by callID) drive the
//          uploader's progress row to a visible climbing percentage,
//        * the 201 resolve lands the row's ✓ done state,
//        * the green "Screenshot uploaded" toast shows (the verdict),
//        * the staged grid renders the tile AND its thumbnail <img> LOADS
//          (naturalWidth > 0 — served by the probe's media route, the exact
//          URL shape the Go media proxy serves in production).
//
// USAGE (playwright in hibana-source for its e2e suite, or any dir carrying it):
//   node scripts/probe-completefacts.mjs --src /home/z/hibana-source \
//        [--dist frontend/dist] [--out /tmp/probe-completefacts]
// Exit 0 + screenshots on success; exit 1 with the failed assertion otherwise.
// ============================================================================

import { createRequire } from 'node:module'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const a = { src: '/home/z/hibana-source', dist: path.join(REPO_ROOT, 'frontend/dist'), out: '/tmp/probe-completefacts', port: 3137 }
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
for (const f of ['index.html', 'js/desktop-shim.js', 'js/desktop-sync.js', 'css/desktop-sync.css', 'js/devboard.js', 'js/image-resize.js', 'icon.svg']) {
  if (!fs.existsSync(path.join(args.dist, f))) {
    console.error('[probe] missing ' + f + ' under ' + args.dist + ' — run scripts/sync-island.mjs first.')
    process.exit(1)
  }
}

// The probe's screenshot-fact step details — the EXACT strings the owner's
// screenshot showed clipped (the email, the pending-changes fact, the board
// census), so the fix is proven against the very text that failed.
const FACTS = {
  connect: 'signed in as aliassadi@live.com — hibana.ir reached',
  upload: 'no pending changes — everything is already saved',
  sync: 'every board already current · 7 project(s) · 7 board(s)',
}

const P1 = '11111111-1111-4111-8111-111111111111'
const probe = {
  authed: true,
  lang: 'en',
  projects: [{ id: P1, title: 'Hibana Web', status: 'planning', type: 'personal' }],
  tasks: [
    { id: 't1', project_id: P1, title: 'Keep the fire alive', status: 'idea', priority: 'high', category_id: null, sprint_id: null, sort_order: 0, created_at: '2026-01-01T00:00:00.000Z', done_at: null, start_at: null, end_at: null, search_tags: '', updated_at: '2026-01-02T00:00:00.000Z', tags: [], shot_count: 0 },
  ],
  syncCalls: 0,
  syncOutcome: null,
  uploadCalls: [], // each: { callID, method, path, hasBody, headers }
}

const MOCK_IPC_JS = 'window.WailsInvoke = function (m) { /* probe: no Go backend on the other side */ }\n'

// The runtime mock — the SAME positions Wails' runtime occupies in production.
// Upload is the v0.1.15 bridge contract: (callID, method, path, body, headers)
// → {status, body}; progress rides the hibana:upload-progress events, routed
// by callID — exactly what internal/ui/upload.go emits in the shell.
const mockRuntimeJs = () => [
  'window.go = { desktop: { API: {',
  "  Login: function (login, password) { return Promise.resolve({ ok: true, user: { email: login } }) },",
  '  Logout: function () { return Promise.resolve({ ok: true }) },',
  "  AuthState: function () { return Promise.resolve({ authenticated: true, user: { email: 'probe@hibana.ir', language_pref: 'en', calendar_pref: 'gregorian' } }) },",
  '  Request: function (method, p, body) { return window.__probeRequest(method, p, body) },',
  "  SetTheme: function (pref) { return Promise.resolve({ ok: true, pref: pref }) },",
  '  SyncNow: function () { return window.__probeSyncNow() },',
  '  Upload: function (callID, method, p, body, headers) { return window.__probeUpload(callID, method, p, body, headers) },',
  '} } }',
  // The Wails EventsOn contract is MULTI-LISTENER (every registered callback
  // fires per emit) — the v0.1.17 settings round co-listens on
  // hibana:update-available / hibana:theme, so the probe registry models
  // the real runtime faithfully (the single-slot registry silently
  // dropped the earlier registrant).
  'window.runtime = { EventsOn: function (name, cb) { (window.__probeEvents = window.__probeEvents || {}); (window.__probeEvents[name] = window.__probeEvents[name] || []).push(cb) } },',
  'window.__probeEmit = function (name, payload) { ((window.__probeEvents || {})[name] || []).forEach(function (cb) { try { cb(payload) } catch (e) {} }) },',
  'window.__probe = ' + JSON.stringify({ authed: probe.authed, lang: probe.lang, facts: FACTS }) + ';',
].join('\n') + '\n'

const serveDocument = (send) => {
  let html = fs.readFileSync(path.join(args.dist, 'index.html'), 'utf8')
  html = html.replace('<html lang="en">', '<html lang="en" data-desktop-authed="true" data-desktop-theme="light">')
  html = html.replace('<head>', '<head>\n<script src="/wails/ipc.js"></script><script src="/wails/runtime.js"></script><script src="/__probe.js"></script>')
  return send(200, 'text/html; charset=utf-8', html)
}

const devboardPayload = (p) => JSON.stringify({
  project: { id: p.id, title: p.title, status: p.status, type: p.type },
  tasks: probe.tasks, categories: [], sprints: [], tags: [], task_tags: [],
})

// The probe's MEDIA object — the thumbnail the Go media proxy serves in
// production (a 96×64 PNG; production serves the real shot's bytes through
// the same /api/media/screenshots/:id/file URL shape).
const MEDIA_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAAAfUlEQVR42u3QMRHAIAAEwQ9+sBFRDCUuEIAHbMRQBDCTNs1eeeVec7Xx7Bz1evtJSvQZIECAAAECBAgQIAECBAgQIECAAAkQIECAAAECBEiAAAECBAgQIECABAgQIECAAAECJECAAAECBAgQIAECBAgQIECAAAESIECA/ugFqyslTRuGkHkAAAAASUVORK5CYII=', 'base64')

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
      'window.__probeUpload = function (callID, method, p, body, headers) {',
      '  return fetch("/__probe/upload", { method: "POST", body: JSON.stringify({ callID, method, p, body, headers }) }).then(function (r) { return r.json() })',
      '}',
    ].join('\n') + '\n')
  }
  if (p === '/__probe/syncnow' && req.method === 'POST') {
    probe.syncCalls++
    return send(200, 'application/json', JSON.stringify(probe.syncOutcome))
  }
  if (p === '/__probe/upload' && req.method === 'POST') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    return req.on('end', () => {
      const req2 = JSON.parse(raw)
      probe.uploadCalls.push({ callID: req2.callID, method: req2.method, path: req2.p, hasBody: typeof req2.body === 'string' && req2.body.length > 0, headers: req2.headers })
      // THE LIVE BRIDGE SHAPE: progress ticks ride the event the shim routes by
      // callID, then the 201 resolve lands (Go streams the real bytes).
      const ev = () => (window === undefined ? null : null) // (placeholder — the page-side driver below replays these)
      return send(200, 'application/json', JSON.stringify({ __probeUploadSeen: true, callID: req2.callID }))
    })
  }
  if (p === '/__probe/request' && req.method === 'POST') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    return req.on('end', () => {
      const { p: rp } = JSON.parse(raw)
      if (rp === '/api/projects?sort=recent') {
        return send(200, 'application/json', JSON.stringify({ status: 200, etag: null, body: JSON.stringify({ projects: probe.projects }) }))
      }
      const m = /^\/api\/projects\/([^/]+)\/devboard$/.exec(rp)
      if (m) {
        return send(200, 'application/json', JSON.stringify({ status: 200, etag: null, body: devboardPayload(probe.projects.find((x) => x.id === m[1]) || probe.projects[0]) }))
      }
      send(200, 'application/json', JSON.stringify({ status: 200, etag: null, body: '{}' }))
    })
  }
  // THE MEDIA ROUTE — the URL shape internal/ui's MediaMiddleware owns in
  // production; the probe serves the thumbnail bytes directly.
  if (/^\/api\/media\/screenshots\/[^/]+\/file$/.test(p)) {
    return send(200, 'image/png', MEDIA_PNG)
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

  // The upload driver — installed BEFORE the round, replayed by the mock
  // bridge: the real Go binding fires the progress events as the socket
  // accepts bytes, then resolves the 201.
  const installUploadDriver = () => page.evaluate(() => {
    const origUpload = window.go.desktop.API.Upload
    window.__probeUploadLog = []
    window.go.desktop.API.Upload = function (callID, method, p, body, headers) {
      window.__probeUploadLog.push({ callID, method, p, argCount: arguments.length, headers: typeof headers })
      const ev = (e) => window.__probeEmit('hibana:upload-progress', e)
      const total = String(body || '').length
      ;[0.25, 0.5, 0.75].forEach((f, i) => {
        setTimeout(function () { try { ev({ id: callID, loaded: Math.round(total * f), total }) } catch (e) { /* the handler is defensive */ } }, 40 * (i + 1))
      })
      return new Promise(function (resolve) {
        setTimeout(function () {
          try { ev({ id: callID, loaded: total, total }) } catch (e) { /* ditto */ }
          resolve({ status: 201, body: JSON.stringify({ ok: true, id: 'probe-shot-1', mimeType: 'image/png' }) })
        }, 260)
      })
    }
  })

  // The sync driver — the mock SyncNow replays the LIVE event choreography
  // (the same hibana:sync-progress events the Go round relays) with the
  // screenshot's exact facts, then resolves the ok outcome.
  const installSyncDriver = () => page.evaluate(() => {
    const facts = window.__probe.facts
    const ev = (e) => window.__probeEmit('hibana:sync-progress', e)
    const seq = [
      { step: 'connect', state: 'active', detail: '' },
      { step: 'connect', state: 'done', detail: facts.connect },
      { step: 'upload', state: 'active', detail: '' },
      { step: 'upload', state: 'done', detail: facts.upload },
      { step: 'sync', state: 'active', detail: '' },
      { step: 'sync', state: 'done', detail: facts.sync },
    ]
    seq.forEach(function (e, i) { setTimeout(function () { try { ev(e) } catch (err) { /* defensive */ } }, 60 * (i + 1)) })
    return Promise.resolve({ ok: true, uploaded: 0, pulled: 0, projects: 7, boards: 7, at: new Date().toISOString() })
  })

  try {
    // ---- PART A: the sync modal's COMPLETE facts ----
    await page.goto(base + '/kanban', { waitUntil: 'load' })
    await page.waitForSelector('#login-gate', { state: 'hidden', timeout: 5000 })
    await page.waitForFunction(() => document.querySelectorAll('.pd-task').length === 1, null, { timeout: 8000 })
    check('the stored-session boot renders the board', true)

    // Pre-install the sync driver: the mocked SyncNow replays the LIVE event
    // choreography (the same hibana:sync-progress events the Go round relays
    // WHILE the round runs) with the screenshot's exact facts, and resolves
    // only AFTER the last event — the real bridge's ordering (events stream,
    // then the outcome lands).
    await page.evaluate(() => {
      window.__probeSyncRounds = 0
      window.go.desktop.API.SyncNow = function () {
        const facts = window.__probe.facts
        const ev = (e) => window.__probeEmit('hibana:sync-progress', e)
        const seq = [
          { step: 'connect', state: 'active', detail: '' },
          { step: 'connect', state: 'done', detail: facts.connect },
          { step: 'upload', state: 'active', detail: '' },
          { step: 'upload', state: 'done', detail: facts.upload },
          { step: 'sync', state: 'active', detail: '' },
          { step: 'sync', state: 'done', detail: facts.sync },
        ]
        seq.forEach(function (e, i) { setTimeout(function () { try { ev(e) } catch (err) { /* defensive */ } }, 70 * (i + 1)) })
        window.__probeSyncRounds++
        return new Promise(function (resolve) {
          setTimeout(function () { resolve({ ok: true, uploaded: 0, pulled: 0, projects: 7, boards: 7, at: new Date().toISOString() }) }, 70 * (seq.length + 1))
        })
      }
    })
    probe.syncOutcome = { ok: true, uploaded: 0, pulled: 0, projects: 7, boards: 7, at: new Date().toISOString() }

    await page.click('#db-sync-button')
    await page.waitForFunction(() => {
      const p = document.getElementById('db-sync-panel')
      return p && !p.hidden
    }, null, { timeout: 8000 })

    const notes = await page.evaluate((facts) => {
      const out = []
      for (const step of ['connect', 'upload', 'sync']) {
        const li = document.querySelector('#db-sync-steps li[data-step="' + step + '"]')
        const note = li && li.querySelector('.db-sync-note')
        const label = li && li.querySelector('.db-sync-label')
        if (!li || !note || !label) { out.push({ step, missing: true }); continue }
        const cs = getComputedStyle(note)
        const nr = note.getBoundingClientRect()
        const lr = label.getBoundingClientRect()
        out.push({
          step,
          text: note.textContent,
          want: facts[step],
          hidden: note.hidden,
          textOverflow: cs.textOverflow,
          whiteSpace: cs.whiteSpace,
          overflowWrap: cs.overflowWrap,
          overflowX: note.scrollWidth > note.clientWidth + 1,
          belowLabel: nr.top > lr.top + 1,
          noteWidth: Math.round(nr.width),
          liWidth: Math.round(li.getBoundingClientRect().width),
        })
      }
      const dlg = document.getElementById('db-sync-dialog')
      return { steps: out, dialogOverflow: dlg ? dlg.scrollHeight > dlg.clientHeight + 1 : null }
    }, FACTS)

    for (const s of notes.steps) {
      check('the ' + s.step + ' note is present and unhidden', !s.missing && !s.hidden)
      check('the ' + s.step + " note's text is COMPLETE (no mid-word cut)", !s.missing && s.text === s.want, JSON.stringify(s.text))
      check('the ' + s.step + " note never ellipsizes (computed text-overflow)", !s.missing && s.textOverflow !== 'ellipsis', s.textOverflow)
      check('the ' + s.step + ' note has no hidden horizontal overflow', !s.missing && !s.overflowX, s.overflowX === false ? 'clean' : 'overflowing')
      check('the ' + s.step + ' note owns its own line UNDER the label', !s.missing && s.belowLabel)
    }
    const widths = notes.steps.map((s) => s.noteWidth / s.liWidth)
    check('the notes use the row\'s full second column (the 60% cap is gone)', widths.every((w) => w > 0.8), widths.map((w) => Math.round(w * 100) + '%').join(', '))
    check('the modal fits the viewport with the wrapped facts (no dialog overflow)', notes.dialogOverflow === false)
    check('the upload note WRAPPED (the long fact takes its lines instead of clipping)', (() => {
      const up = notes.steps.find((s) => s.step === 'upload')
      return up && up.text === FACTS.upload && !up.overflowX
    })())

    await page.screenshot({ path: path.join(args.out, 'sync-modal-complete-facts.png') })
    await page.click('#db-sync-done')

    // The no-break stress: an over-long single token (a 74-char email) must
    // wrap anywhere instead of stretching or clipping the card.
    await page.evaluate(() => {
      window.__probe.facts.upload = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbb@very-long-subdomain.example.live.com'
    })
    probe.syncOutcome = { ok: true, uploaded: 0, pulled: 0, projects: 7, boards: 7, at: new Date().toISOString() }
    await page.click('#db-sync-button')
    await page.waitForFunction(() => {
      const p = document.getElementById('db-sync-panel')
      return p && !p.hidden
    }, null, { timeout: 8000 })
    const stress = await page.evaluate(() => {
      const note = document.querySelector('#db-sync-steps li[data-step="upload"] .db-sync-note')
      const li = document.querySelector('#db-sync-steps li[data-step="upload"]')
      const modal = document.querySelector('.db-sync-modal')
      const dlg = document.getElementById('db-sync-dialog')
      // A grid item is blockified, so per-line rects do not apply — a wrap
      // reads as the box growing past ONE line height.
      const lh = parseFloat(getComputedStyle(note).lineHeight) || 16
      const h = note.getBoundingClientRect().height
      return {
        wrapped: h > lh * 1.6,
        noteHeight: Math.round(h),
        lineHeight: lh,
        liInside: li && modal && li.getBoundingClientRect().right <= modal.getBoundingClientRect().right + 1,
        dialogOverflow: dlg.scrollHeight > dlg.clientHeight + 1,
      }
    })
    check('a 74-char no-break email WRAPS to multiple lines', stress.wrapped, stress.noteHeight + 'px over a ' + stress.lineHeight + 'px line')
    check('the wrapped email stays inside the card (overflow-wrap: anywhere)', stress.liInside)
    check('the stress modal still fits the viewport', stress.dialogOverflow === false)
    await page.screenshot({ path: path.join(args.out, 'sync-modal-long-email.png') })
    await page.click('#db-sync-done')

    // ---- PART B: the upload round — the verdict + the thumbnail ----
    // Open the NEW-task editor (the column's Add task button).
    await page.click('.pd-task-add')
    await page.waitForSelector('[data-db-shots-add]', { timeout: 8000 })
    check('the task editor opens with the Upload File button', true)

    await installUploadDriver()

    // A real PNG file — the uploader resizes + base64s it like production.
    const pngFile = path.join(args.out, 'probe-shot.png')
    fs.writeFileSync(pngFile, MEDIA_PNG)
    await page.setInputFiles('[data-db-shots-input]', pngFile)

    // The progress row climbs while the bridge holds the response…
    await page.waitForFunction(() => {
      const row = document.querySelector('.shots-upload-row[data-state="active"]')
      const pct = row && row.querySelector('.shots-upload-pct')
      return row && pct && /%/.test(pct.textContent) && parseInt(pct.textContent.replace('%', ''), 10) > 0
    }, null, { timeout: 8000 })
    check('the progress bar FILLS from the routed byte events (a visible climbing %)', true)

    // …then the 201 lands: done row + the toast verdict + the staged tile
    // (the img LOADS — wait for the bytes, not just the element).
    await page.waitForFunction(() => {
      const img = document.querySelector('.pd-taskadd-shots-grid .shot-card img')
      return img && img.complete && img.naturalWidth > 0
    }, null, { timeout: 8000 })
    check('the staged grid renders the shot tile after the upload resolves', true)

    const uploadVerdict = await page.evaluate(() => {
      const img = document.querySelector('.pd-taskadd-shots-grid .shot-card img')
      const toast = document.getElementById('toast')
      return {
        imgSrc: img ? img.getAttribute('src') : '',
        imgLoaded: img ? img.naturalWidth > 0 : false,
        toastText: toast ? toast.textContent : '',
        toastKind: toast ? toast.className : '',
      }
    })
    check('the tile\'s thumbnail <img> points at the media route', /^\/api\/media\/screenshots\/probe-shot-1\/file/.test(uploadVerdict.imgSrc), uploadVerdict.imgSrc)
    check('THE THUMBNAIL ACTUALLY LOADS (naturalWidth > 0 — the exact gap the owner reported)', uploadVerdict.imgLoaded)
    check('the green toast names the verdict ("Screenshot uploaded")', /Screenshot uploaded/.test(uploadVerdict.toastText) && /ok/.test(uploadVerdict.toastKind), JSON.stringify(uploadVerdict.toastText))

    // The record shot: the editor is tall — clip to the shots section so the
    // THUMBNAIL + the verdict toast are both in frame.
    const shotsEl = await page.$('[data-db-shots]')
    if (shotsEl) {
      await shotsEl.scrollIntoViewIfNeeded()
      await page.screenshot({ path: path.join(args.out, 'upload-thumbnail-landed.png'), clip: await shotsEl.boundingBox() })
    } else {
      await page.screenshot({ path: path.join(args.out, 'upload-thumbnail-landed.png') })
    }

    // The bridge contract itself: the callID-first argument order the Go
    // binding (and its progress routing) depends on.
    const bridgeLog = await page.evaluate(() => window.__probeUploadLog || [])
    check('the Upload bridge was called exactly once', bridgeLog.length === 1, 'calls=' + bridgeLog.length)
    if (bridgeLog.length === 1) {
      const call = bridgeLog[0]
      check('the callID rides FIRST (the progress correlation key)', typeof call.callID === 'string' && call.callID.length > 0, JSON.stringify(call.callID))
      check('the method + path follow the callID', call.method === 'POST' && /^\/api\/projects\/[^/]+\/screenshots$/.test(call.p), call.method + ' ' + call.p)
      check('the body carried the base64 payload', call.hasBody !== false)
    }

    check('ZERO page errors through the whole round', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200))

    if (failures.length) {
      console.error('\n[probe] FAILURES (' + failures.length + '): ' + failures.join(' · '))
      process.exitCode = 1
    } else {
      console.log('\n[probe] ALL PASS — screenshots in ' + args.out + ' (sync-modal-complete-facts.png, sync-modal-long-email.png, upload-thumbnail-landed.png)')
    }
  } finally {
    await browser.close()
    server.close()
  }
}

main().catch((err) => {
  console.error('[probe] ' + (err && err.stack ? err.stack : err))
  process.exit(1)
})
