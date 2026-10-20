#!/usr/bin/env node
// ============================================================================
// probe-soundfx.mjs — the v0.1.13 SOUND + SYNC-MODAL-ANIMATION BROWSER PROBE
// (Chromium via Playwright).
//
// WHAT IT PROVES, against the REAL generated island bytes (frontend/dist):
//   1. THE ENGINE: js/desktop-audio.js loads as a generated file in the head
//      chain (right after the shim), exposes window.hibanaAudio.play, and
//      every one of the owner's five cues schedules real oscillators —
//      counted through an instrumented AudioContext (osc.start() tallied +
//      the f0 frequencies captured; headless Chromium runs the scheduler
//      silently, so the proof is the SCHEDULING, which is the cue).
//   2. CUE #1 — LOGIN: on the unauthed boot the gate shows; a successful
//      submit plays the welcome fifth (the E5/B5 oscillator pair) and the
//      reload is DELAYED ~700ms so the chime lands (the document must still
//      be alive 400ms after the submit — an immediate reload would clip the
//      cue to silence), then the re-booted document serves authed.
//   3. CUE #2 — DELETE, through the REAL UI PATH: the card's ⋯ menu →
//      Delete → the native confirm → the Go-bound DELETE /api/devtasks/:id
//      crosses the seam, the 200 resolves, the dissolve thock schedules, and
//      the reloaded board shows the card GONE.
//   4. CUE #3 — FULFILL: a status transition to 'done' (the exact PATCH the
//      drop-into-done and the editor's save both make) schedules the
//      completion ding.
//   5. CUE #4 — MOVE: a status transition to a non-done state schedules the
//      micro tick — and the SILENCE rules hold: a same-status PATCH (the
//      editor resends status on EVERY save — a plain title edit must never
//      chime), the /api/devtasks/:id/tags/:tagId delete (a different path —
//      the classifier's one-segment regex must not match it), and a second
//      same-cue play within 150ms (the bulk "Clear done" coalescing) are all
//      SILENT.
//   6. CUE #5 + THE HERO — the sync modal: the living emblem renders above
//      the step rows, and the round drives it live — connect (the cloud
//      glyph + the outgoing pulse ring) → upload (the arrow + the rising
//      packets, animation RUNNING) → sync (the orbit glyph + the spark
//      spinning) — then the ok outcome settles it (the green-tinted emblem
//      + the check pop) and the ALL-CLEAR chime schedules, side by side
//      with the green panel. Done closes the modal with NO reload (pulled=0
//      — the screen was already the truth). The err round tints the emblem
//      danger and shows the cross.
//   7. THE FA/RTL MIRROR: a fa boot renders the FA modal labels + the hero,
//      and the chimes fire identically (sounds are language-free).
//   8. THE MOTION BUDGET: under prefers-reduced-motion the hero keeps its
//      STATE legibility (the glyphs still morph, the verdict tints still
//      land, the panel still shows) but the loop animations go still.
//
// The mock bridge sits at the SAME boundary the Wails runtime occupies in
// production (window.go/window.runtime — byte-for-byte the same positions).
// The SyncNow mock resolves PROBE-CONTROLLED + PROBE-DEFERRED (probe.syncOutcome
// + probe.syncRelease, read at CALL time; the /__probe/syncnow handler holds
// the response until the release flips) so the mid-round hero stages are
// drivable exactly as round.go emits them.
//
// USAGE (playwright + browsers ship in hibana-source for its e2e suite):
//   node scripts/probe-soundfx.mjs --src /home/z/hibana-source \
//        [--dist frontend/dist] [--out /tmp/probe-soundfx]
// Exit 0 + screenshots on success; exit 1 with the failed assertion otherwise.
// ============================================================================

import { createRequire } from 'node:module'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const a = { src: '/home/z/hibana-source', dist: path.join(REPO_ROOT, 'frontend/dist'), out: '/tmp/probe-soundfx', port: 3133 }
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
for (const f of ['index.html', 'js/desktop-audio.js', 'js/desktop-sync.js', 'js/desktop-login.js', 'css/desktop-sync.css']) {
  if (!fs.existsSync(path.join(args.dist, f))) {
    console.error('[probe] missing ' + f + ' under ' + args.dist + ' — run scripts/sync-island.mjs first.')
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// The probe state. tasks[] is the live board payload — the DELETE leg really
// removes a task server-side (the reloaded board renders the deletion), and
// the PATCH legs really flip statuses (so a re-boot reflects them and the
// classifier's prior-status read is honest on every leg). syncOutcome is what
// the mocked Go SyncNow binding resolves; syncRelease DEFERS that resolve so
// the mid-round hero stages are observable before the outcome takes the
// modal.
// ---------------------------------------------------------------------------
const P1 = '11111111-1111-4111-8111-111111111111'
const freshTasks = () => [
  { id: 't1', project_id: P1, title: 'Keep the fire alive', status: 'idea', priority: 'high', category_id: null, sprint_id: null, sort_order: 0, created_at: '2026-01-01T00:00:00.000Z', done_at: null, start_at: null, end_at: null, search_tags: '', updated_at: '2026-01-02T00:00:00.000Z', tags: [], shot_count: 0 },
  { id: 't2', project_id: P1, title: 'Ship the sound round', status: 'planned', priority: 'medium', category_id: null, sprint_id: null, sort_order: 0, created_at: '2026-01-01T00:00:00.000Z', done_at: null, start_at: null, end_at: null, search_tags: '', updated_at: '2026-01-02T00:00:00.000Z', tags: [], shot_count: 0 },
]
const probe = {
  authed: false, // the login leg boots UNAUTHED; the Login mock flips it
  lang: 'en',
  theme: null,
  projects: [{ id: P1, title: 'Hibana Web', status: 'planning', type: 'personal' }],
  tasks: freshTasks(),
  syncOutcome: { ok: true, uploaded: 2, projects: 1, boards: 1, pulled: 0, at: new Date().toISOString() },
  syncRelease: true,
  syncCalls: 0,
  deleted: [],
  patched: [],
  loginCalls: [],
}
const MOCK_IPC_JS = 'window.WailsInvoke = function (m) { /* probe: no Go backend on the other side */ }\n'
// The runtime mock is built PER REQUEST from the live probe state (the v0.1.9
// lesson: a module-level constant froze the EN state into the FA pass). The
// Login mock models the Go binding's server-side persistence: it pings
// /__probe/login-ok (the probe flips authed there — the cookie jar lives
// server-side in production, never in JS) and then resolves ok.
const mockRuntimeJs = () => [
  'window.go = { desktop: { API: {',
  "  Login: function (login, password) { return fetch('/__probe/login-ok', { method: 'POST', body: JSON.stringify({ login: login }) }).then(function () { return { ok: true, user: { email: login } } }) },",
  '  Logout: function () { return Promise.resolve({ ok: true }) },',
  "  AuthState: function () { return Promise.resolve({ authenticated: window.__probe.authed, user: window.__probe.authed ? { email: 'probe@hibana.ir', language_pref: window.__probe.lang, calendar_pref: 'gregorian' } : null }) },",
  '  Request: function (method, p, body) { return window.__probeRequest(method, p, body) },',
  "  SetTheme: function (pref) { return Promise.resolve({ ok: true, pref: pref }) },",
  '  SyncNow: function () { return window.__probeSyncNow() },',
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
  if (p === '/__probe/login-ok' && req.method === 'POST') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    return req.on('end', () => {
      probe.loginCalls.push(JSON.parse(raw || '{}'))
      probe.authed = true // the session lands server-side, like the Go cookie jar
      send(200, 'application/json', '{"ok":true}')
    })
  }
  if (p === '/__probe/syncnow' && req.method === 'POST') {
    probe.syncCalls++
    const started = Date.now()
    const respond = () => {
      if (probe.syncRelease) return send(200, 'application/json', JSON.stringify(probe.syncOutcome))
      if (Date.now() - started > 20000) return send(200, 'application/json', JSON.stringify({ ok: false, code: 'unreachable', message: 'probe: syncnow hold timed out' }))
      setTimeout(respond, 25)
    }
    return respond()
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
      let m = /^\/api\/projects\/([^/]+)\/devboard$/.exec(rp)
      if (m) {
        const found = probe.projects.find((x) => x.id === m[1])
        if (!found) return send(200, 'application/json', JSON.stringify({ status: 404, body: '{"error":"not_found"}' }))
        return send(200, 'application/json', JSON.stringify({ status: 200, etag: null, body: devboardPayload(found) }))
      }
      // The task mutations — the legs the sound round observes on the seam.
      m = /^\/api\/devtasks\/([^/]+)$/.exec(rp)
      if (m) {
        if ((rm || 'GET').toUpperCase() === 'DELETE') {
          probe.deleted.push(m[1])
          probe.tasks = probe.tasks.filter((t) => t.id !== m[1])
          return send(200, 'application/json', JSON.stringify({ status: 200, etag: null, body: '{"ok":true}' }))
        }
        if ((rm || 'GET').toUpperCase() === 'PATCH') {
          let parsed = {}
          try { parsed = JSON.parse(body || '{}') } catch (e) { /* the island pre-stringifies; a mangle still 200s like the worker would reject */ }
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

  // The audio instrumentation: wrap AudioContext BEFORE any page script so
  // every oscillator the engine schedules is tallied. The f0s are captured on
  // frequency.setValueAtTime — the engine schedules ~20ms ahead, so the
  // param's .value at start() time is still the 440Hz default (the first
  // probe run's lesson); the SCHEDULED automation values are the truth.
  const AUDIO_INSTRUMENT = () => {
    window.__audioOps = { starts: 0, freqs: [] }
    const RealCtx = window.AudioContext || window.webkitAudioContext
    if (RealCtx) {
      const Wrapped = class extends RealCtx {
        createOscillator() {
          const osc = super.createOscillator()
          const realStart = osc.start.bind(osc)
          osc.start = function (...a) {
            window.__audioOps.starts++
            return realStart(...a)
          }
          const param = osc.frequency
          const realSet = param.setValueAtTime.bind(param)
          param.setValueAtTime = function (v, t) {
            window.__audioOps.freqs.push(Math.round(v))
            return realSet(v, t)
          }
          return osc
        }
      }
      try { window.AudioContext = Wrapped } catch (e) { /* the engine falls back to the real class — still audible */ }
    }
  }

  const audioStats = (page) => page.evaluate(() => ({ starts: window.__audioOps ? window.__audioOps.starts : -1, freqs: window.__audioOps ? window.__audioOps.freqs.slice() : [] }))
  const resetAudio = (page) => page.evaluate(() => { if (window.__audioOps) { window.__audioOps.starts = 0; window.__audioOps.freqs = [] } })

  const bootPage = async (context) => {
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    await page.goto(base + '/kanban?project=' + P1, { waitUntil: 'domcontentloaded' })
    return { page, pageErrors }
  }
  const cardCount = (page) => page.evaluate(() => document.querySelectorAll('.pd-task').length)

  // =========================================================================
  // LEG 1 + 2 — the engine loads on the unauthed boot; the LOGIN chime fires
  // on the ok resolve and the reload is DELAYED so the chime lands.
  // =========================================================================
  console.log('\n— leg 1+2: the sound engine + the login chime (the unauthed boot)')
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.addInitScript(AUDIO_INSTRUMENT)
    const { page, pageErrors } = await bootPage(context)

    await page.waitForSelector('#login-gate', { state: 'visible', timeout: 5000 })
    const engineThere = await page.evaluate(() => !!(window.hibanaAudio && typeof window.hibanaAudio.play === 'function'))
    check('the engine loads on the unauthed boot (window.hibanaAudio.play)', engineThere)

    // The five cues schedule real oscillators, with the cue-specific f0s.
    const perCue = await page.evaluate(() => {
      const out = {}
      for (const name of ['login', 'delete', 'fulfill', 'move', 'sync']) {
        window.__audioOps.starts = 0
        window.__audioOps.freqs = []
        out[name] = { played: window.hibanaAudio.play(name), starts: window.__audioOps.starts, freqs: window.__audioOps.freqs.slice() }
      }
      return out
    })
    check('cue login schedules the welcome fifth', perCue.login.played === true && perCue.login.starts >= 3 && perCue.login.freqs.includes(659) && perCue.login.freqs.includes(988), JSON.stringify(perCue.login))
    check('cue delete schedules the dissolve thock', perCue.delete.played === true && perCue.delete.starts >= 2 && perCue.delete.freqs.includes(320), JSON.stringify(perCue.delete))
    check('cue fulfill schedules the completion ding', perCue.fulfill.played === true && perCue.fulfill.starts >= 3 && perCue.fulfill.freqs.includes(784) && perCue.fulfill.freqs.includes(1175), JSON.stringify(perCue.fulfill))
    check('cue move schedules the micro tick', perCue.move.played === true && perCue.move.starts >= 1 && perCue.move.freqs.includes(540), JSON.stringify(perCue.move))
    check('cue sync schedules the all-clear', perCue.sync.played === true && perCue.sync.starts >= 4 && perCue.sync.freqs.includes(440) && perCue.sync.freqs.includes(988), JSON.stringify(perCue.sync))
    const bogus = await page.evaluate(() => window.hibanaAudio.play('nope'))
    check('an unknown cue name is a silent no-op', bogus === false)
    // Let the cue loop's lastPlay stamps age past the 150ms coalescing window
    // (the first run's lesson: the submit's login chime coalesced with the
    // loop's own login play and scheduled nothing).
    await page.waitForTimeout(300)
    const coalesce = await page.evaluate(() => { const a = window.hibanaAudio.play('move'); const b = window.hibanaAudio.play('move'); return { a, b } })
    check('same-cue plays within 150ms coalesce (bulk "Clear done" sounds once)', coalesce.a === true && coalesce.b === false)
    await page.waitForTimeout(300) // the coalesce pair's own window must age out before the submit

    // The coalescing above rode evaluate calls, not gestures — the SCHEDULING
    // counted anyway (the headless context runs unlocked); reset and take the
    // REAL submit path.
    await resetAudio(page)
    await page.fill('#login-gate-login', 'probe@hibana.ir')
    await page.fill('#login-gate-password', 'probe-right')
    await page.click('#login-gate-submit')
    await page.waitForTimeout(250)
    const chime = await audioStats(page)
    check('the ok login resolve plays the chime (cue #1)', chime.starts >= 3 && chime.freqs.includes(659), JSON.stringify(chime))
    await page.evaluate(() => { window.__probeMarker = 'planted' })
    await page.waitForTimeout(350) // ~T+600ms — still inside the 700ms delay
    const aliveLater = await page.evaluate(() => window.__probeMarker || null)
    check('the reload is DELAYED ~700ms so the chime lands (the doc still alive at ~T+600ms)', aliveLater === 'planted')
    await page.waitForFunction(() => document.documentElement.getAttribute('data-desktop-authed') === 'true', null, { timeout: 10000 })
    await page.waitForSelector('#login-gate', { state: 'hidden', timeout: 5000 })
    check('the delayed reload still lands (authed=true, the gate hidden)', probe.loginCalls.length >= 1)
    await page.waitForSelector('.pd-task', { timeout: 10000 })
    check('the re-booted island renders the board (2 cards)', (await cardCount(page)) === 2)
    await page.screenshot({ path: path.join(args.out, '01-after-login.png') })

    // =======================================================================
    // LEG 3 — DELETE through the REAL UI path: ⋯ menu → Delete → confirm →
    // the seam DELETE → 200 → the dissolve thock → the reloaded board shows
    // the card gone.
    // =======================================================================
    console.log('\n— leg 3: the delete cue (the real card-menu → confirm path)')
    await resetAudio(page)
    await page.click('.pd-task-wrap[data-task-card="t1"] [data-menu-open]')
    await page.waitForSelector('.pd-task-wrap[data-task-card="t1"] .spark-menu-pop:not([hidden])', { timeout: 5000 })
    await page.click('[data-db-del-card="t1"]')
    await page.waitForSelector('#db-del-confirm', { state: 'visible', timeout: 5000 })
    await page.click('#db-del-ok')
    await page.waitForTimeout(400)
    const delChime = await audioStats(page)
    check('the confirmed delete schedules the thock (cue #2)', delChime.starts >= 2 && delChime.freqs.includes(320), JSON.stringify(delChime))
    check('the delete crossed the seam server-side', probe.deleted.includes('t1'), JSON.stringify(probe.deleted))
    await page.waitForFunction(() => document.querySelectorAll('.pd-task').length === 1, null, { timeout: 10000 })
    check('the reloaded board shows the card GONE (1 card)', (await cardCount(page)) === 1)
    await page.screenshot({ path: path.join(args.out, '02-after-delete.png') })

    // =======================================================================
    // LEG 4 — FULFILL: the exact PATCH the drop-into-done and the editor
    // save both make, status -> 'done', schedules the completion ding.
    // =======================================================================
    console.log('\n— leg 4: the fulfill cue (the status -> done PATCH)')
    await resetAudio(page)
    await page.evaluate(() => window.HibanaBoard.patchTask('t2', { status: 'done' }))
    await page.waitForTimeout(300)
    const fulChime = await audioStats(page)
    check("the status->'done' PATCH schedules the ding (cue #3)", fulChime.starts >= 3 && fulChime.freqs.includes(784), JSON.stringify(fulChime))
    check("the PATCH crossed the seam with status 'done'", probe.patched.length > 0 && probe.patched[probe.patched.length - 1].status === 'done', JSON.stringify(probe.patched))

    // =======================================================================
    // LEG 5 — MOVE + the SILENCE rules. The reload below re-boots the island
    // off the server (t2='done' — leg 4 flipped it), which is exactly the
    // freshness contract the classifier rides in the REAL flows: every
    // island mutation path ends in reload(), so the in-memory state the
    // classifier reads is the last LOADED board. The editor's save resends
    // the task's status on EVERY save — the same-status resend is the plain
    // title-edit case and must stay SILENT.
    // =======================================================================
    console.log('\n— leg 5: the move cue + the silence rules')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.pd-task', { timeout: 10000 })
    await resetAudio(page)
    await page.evaluate(() => window.HibanaBoard.patchTask('t2', { status: 'done', title: 'A plain title edit' }))
    await page.waitForTimeout(300)
    const sameChime = await audioStats(page)
    check('the same-status resend (the editor resends status on EVERY save) is SILENT', sameChime.starts === 0, JSON.stringify(sameChime))

    await resetAudio(page)
    await page.evaluate(() => window.HibanaBoard.patchTask('t2', { status: 'in_progress' }))
    await page.waitForTimeout(300)
    const movChime = await audioStats(page)
    check("the status->'in_progress' PATCH schedules the tick (cue #4)", movChime.starts >= 1 && movChime.freqs.includes(540), JSON.stringify(movChime))

    await resetAudio(page)
    await page.evaluate(() => window.hibanaFetch('/api/devtasks/t2/tags/tg1', { method: 'DELETE' }))
    await page.waitForTimeout(300)
    const tagChime = await audioStats(page)
    check('the /tags/:tagId delete (a different path) is SILENT', tagChime.starts === 0, JSON.stringify(tagChime))

    // =======================================================================
    // LEG 6 — THE HERO + cue #5: the sync modal's living emblem, driven live
    // through the exact event choreography round.go emits, ending in the ok
    // settle + the all-clear chime.
    // =======================================================================
    console.log('\n— leg 6: the sync modal hero (the round, live) + the all-clear chime')
    probe.syncOutcome = { ok: true, uploaded: 2, projects: 1, boards: 1, pulled: 0, at: new Date().toISOString() }
    probe.syncRelease = false // hold the round open so the stages are observable
    await resetAudio(page)
    await page.click('#db-sync-button')
    await page.waitForSelector('#db-sync-dialog[open]', { timeout: 5000 })

    const heroShape = () => page.evaluate(() => {
      const hero = document.getElementById('db-sync-hero')
      if (!hero) return null
      const vis = (sel) => { const el = hero.querySelector(sel); if (!el) return null; const cs = getComputedStyle(el); return { opacity: cs.opacity, anim: cs.animationName } }
      return {
        stage: hero.getAttribute('data-stage'),
        kind: hero.getAttribute('data-kind'),
        ring: vis('.db-sync-ring'),
        orbit: vis('.db-sync-orbit'),
        packets: vis('.db-sync-packets'),
        packetDot: vis('.db-sync-packets span'),
        cloud: vis('.db-sync-glyph-connect'),
        upload: vis('.db-sync-glyph-upload'),
        orbitGlyph: vis('.db-sync-glyph-orbit'),
        ok: vis('.db-sync-glyph-ok'),
        err: vis('.db-sync-glyph-err'),
      }
    })
    let hero = await heroShape()
    check('the hero renders above the step rows (connect stage, no verdict)', hero && hero.stage === 'connect' && hero.kind === '', JSON.stringify({ stage: hero && hero.stage, kind: hero && hero.kind }))
    check('the connect cloud glyph is the one showing', hero.cloud && Number(hero.cloud.opacity) >= 0.9 && hero.ok.opacity === '0', JSON.stringify({ cloud: hero.cloud && hero.cloud.opacity, ok: hero.ok.opacity }))
    check('the connect pulse ring is reaching out', hero.ring && hero.ring.anim === 'db-sync-pulse', JSON.stringify(hero.ring))
    check('the h-spark is orbiting while the round is in flight', hero.orbit && hero.orbit.anim === 'db-sync-orbit', JSON.stringify(hero.orbit))
    await page.screenshot({ path: path.join(args.out, '03-hero-connect.png') })

    const emit = (step, state, detail) => page.evaluate(({ step, state, detail }) => {
      window.__probeEvents['hibana:sync-progress']({ step, state, detail })
    }, { step, state, detail })
    // The glyph morph is a 280ms CSS transition — let each stage settle before
    // its computed state is read (the first run read mid-morph and saw both
    // glyphs at their pre-flip opacities).
    const settle = () => page.waitForTimeout(400)

    await emit('connect', 'done', 'hibana.ir reached')
    await emit('upload', 'active', '2 change(s) uploaded')
    await settle()
    hero = await heroShape()
    check('the upload stage morphs the arrow in', hero.stage === 'upload' && Number(hero.upload.opacity) >= 0.9 && Number(hero.cloud.opacity) === 0, JSON.stringify({ stage: hero.stage, upload: hero.upload.opacity, cloud: hero.cloud.opacity }))
    check('the packets rise through the upload stage', hero.packets && Number(hero.packets.opacity) >= 0.9 && hero.packetDot && hero.packetDot.anim === 'db-sync-rise', JSON.stringify({ packets: hero.packets, dot: hero.packetDot }))
    await page.screenshot({ path: path.join(args.out, '04-hero-upload.png') })

    await emit('upload', 'done', '2 change(s) uploaded')
    await emit('sync', 'active', '1 board(s) checked')
    await settle()
    hero = await heroShape()
    check('the sync stage morphs the orbit glyph in (faster spin)', hero.stage === 'sync' && Number(hero.orbitGlyph.opacity) >= 0.9, JSON.stringify({ stage: hero.stage, orbitGlyph: hero.orbitGlyph && hero.orbitGlyph.opacity }))
    await page.screenshot({ path: path.join(args.out, '05-hero-sync.png') })

    // Release the outcome: the ok settle + the chime, side by side.
    probe.syncRelease = true
    await page.waitForSelector('#db-sync-panel:not([hidden])', { timeout: 5000 })
    await settle()
    hero = await heroShape()
    const okPanel = await page.evaluate(() => {
      const panel = document.getElementById('db-sync-panel')
      return { kind: panel.getAttribute('data-kind'), title: document.getElementById('db-sync-panel-title').textContent }
    })
    const syncChime = await audioStats(page)
    check('the ok outcome settles the hero (kind=ok, the check shows)', hero.kind === 'ok' && Number(hero.ok.opacity) >= 0.9 && hero.ok.anim === 'db-sync-pop', JSON.stringify({ kind: hero.kind, ok: hero.ok }))
    check('the green panel shows beside it', okPanel.kind === 'ok' && /Everything synced/.test(okPanel.title), JSON.stringify(okPanel))
    check('the all-clear chime schedules with the settle (cue #5)', syncChime.starts >= 4 && syncChime.freqs.includes(440), JSON.stringify(syncChime))
    await page.screenshot({ path: path.join(args.out, '06-hero-ok.png') })

    // Done closes with NO reload (pulled=0 — the screen was already the truth).
    await page.evaluate(() => { window.__probeMarker = 'planted' })
    await page.click('#db-sync-done')
    await page.waitForFunction(() => { const d = document.getElementById('db-sync-dialog'); return d && !d.open }, null, { timeout: 5000 })
    await page.waitForTimeout(500)
    const markerAfterClose = await page.evaluate(() => window.__probeMarker || null)
    check('pulled=0 → Done closes with NO reload (the no-op honesty holds)', markerAfterClose === 'planted')

    // The err round: the danger tint + the cross.
    probe.syncOutcome = { ok: false, code: 'unreachable', message: 'probe: the wire is cut' }
    probe.syncRelease = true
    await page.click('#db-sync-button')
    await page.waitForSelector('#db-sync-panel:not([hidden])', { timeout: 5000 })
    await settle()
    hero = await heroShape()
    check('the err outcome tints the emblem danger (kind=err, the cross shows)', hero.kind === 'err' && Number(hero.err.opacity) >= 0.9 && hero.orbit.anim === 'none', JSON.stringify({ kind: hero.kind, err: hero.err, orbit: hero.orbit }))
    await page.screenshot({ path: path.join(args.out, '07-hero-err.png') })
    await page.evaluate(() => document.getElementById('db-sync-close').click())
    await page.waitForFunction(() => { const d = document.getElementById('db-sync-dialog'); return d && !d.open }, null, { timeout: 5000 })

    check('ZERO page errors through the whole authed surface', pageErrors.length === 0, pageErrors.join(' | '))
    await context.close()
  }

  // =========================================================================
  // LEG 7 — the FA/RTL mirror: the FA modal labels + the hero + the chime.
  // =========================================================================
  console.log('\n— leg 7: the FA/RTL mirror')
  {
    probe.lang = 'fa'
    probe.theme = 'claude-dark'
    probe.syncOutcome = { ok: true, uploaded: 1, projects: 1, boards: 1, pulled: 0, at: new Date().toISOString() }
    probe.syncRelease = true
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.addInitScript(AUDIO_INSTRUMENT)
    const { page, pageErrors } = await bootPage(context)
    await page.waitForSelector('.pd-task', { timeout: 10000 })
    await page.click('#db-sync-button')
    await page.waitForSelector('#db-sync-panel:not([hidden])', { timeout: 5000 })
    const faShape = await page.evaluate(() => {
      const hero = document.getElementById('db-sync-hero')
      const title = document.getElementById('db-sync-title')
      const doneBtn = document.getElementById('db-sync-done')
      return {
        lang: document.documentElement.lang,
        dir: getComputedStyle(document.documentElement).direction,
        heroStage: hero ? hero.getAttribute('data-stage') : null,
        heroKind: hero ? hero.getAttribute('data-kind') : null,
        title: title ? title.textContent : null,
        done: doneBtn ? doneBtn.textContent : null,
        audioStarts: window.__audioOps ? window.__audioOps.starts : -1,
      }
    })
    check('the FA boot mirrors the modal (RTL + the FA labels)', faShape.lang === 'fa' && faShape.dir === 'rtl' && /ابر هیبانا/.test(faShape.title || '') && /انجام شد/.test(faShape.done || ''), JSON.stringify(faShape))
    check('the hero settles ok on the FA boot too (the chime fires identically — sounds are language-free)', faShape.heroKind === 'ok' && faShape.audioStarts >= 4, JSON.stringify(faShape))
    await page.screenshot({ path: path.join(args.out, '08-hero-fa-dark.png') })
    check('ZERO page errors on the FA/RTL dark surface', pageErrors.length === 0, pageErrors.join(' | '))
    await context.close()
    probe.lang = 'en'
    probe.theme = null
  }

  // =========================================================================
  // LEG 8 — the motion budget: under prefers-reduced-motion the hero keeps
  // its state legibility but the loop animations go still.
  // =========================================================================
  console.log('\n— leg 8: the reduced-motion budget')
  {
    probe.syncRelease = false
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    await context.addInitScript(AUDIO_INSTRUMENT)
    const { page, pageErrors } = await bootPage(context)
    const settle = () => page.waitForTimeout(400) // the reduced-motion glyph fade is 180ms; settle at 400
    await page.waitForSelector('.pd-task', { timeout: 10000 })
    await page.click('#db-sync-button')
    await page.waitForSelector('#db-sync-dialog[open]', { timeout: 5000 })
    await page.evaluate(() => window.__probeEvents['hibana:sync-progress']({ step: 'connect', state: 'active', detail: 'hibana.ir reached' }))
    await page.evaluate(() => window.__probeEvents['hibana:sync-progress']({ step: 'upload', state: 'active', detail: '1 change(s) uploaded' }))
    await settle()
    const reduced = await page.evaluate(() => {
      const hero = document.getElementById('db-sync-hero')
      const cs = (sel) => { const el = hero.querySelector(sel); return el ? getComputedStyle(el).animationName : null }
      return {
        stage: hero.getAttribute('data-stage'),
        ring: cs('.db-sync-ring'),
        packets: cs('.db-sync-packets span'),
        cloudOpacity: getComputedStyle(hero.querySelector('.db-sync-glyph-connect')).opacity,
        uploadOpacity: getComputedStyle(hero.querySelector('.db-sync-glyph-upload')).opacity,
      }
    })
    check('reduced motion keeps the STATE (the upload glyph still shows)', reduced.stage === 'upload' && Number(reduced.uploadOpacity) >= 0.9 && Number(reduced.cloudOpacity) === 0, JSON.stringify(reduced))
    check('reduced motion stills the loops (no pulse, no rising packets)', reduced.ring === 'none' && reduced.packets === 'none', JSON.stringify({ ring: reduced.ring, packets: reduced.packets }))
    probe.syncRelease = true
    await page.waitForSelector('#db-sync-panel:not([hidden])', { timeout: 5000 })
    const panelShown = await page.evaluate(() => {
      const panel = document.getElementById('db-sync-panel')
      const cs = getComputedStyle(panel)
      return { anim: cs.animationName, shown: !panel.hidden, opacity: cs.opacity }
    })
    check('the verdict panel still shows under reduced motion (a plain appear, no slide)', panelShown.shown && Number(panelShown.opacity) >= 1 && panelShown.anim === 'none', JSON.stringify(panelShown))
    await page.screenshot({ path: path.join(args.out, '09-hero-reduced-motion.png') })
    check('ZERO page errors on the reduced-motion surface', pageErrors.length === 0, pageErrors.join(' | '))
    await context.close()
  }

  await browser.close()
  server.close()

  console.log('')
  if (failures.length) {
    console.error('[probe] ' + failures.length + ' FAILED assertion' + (failures.length === 1 ? '' : 's') + ':\n  - ' + failures.join('\n  - '))
    process.exit(1)
  }
  console.log('[probe] ALL GREEN — screenshots under ' + args.out)
}

main().catch((err) => {
  console.error('[probe] fatal: ' + (err && err.stack ? err.stack : err))
  process.exit(1)
})
