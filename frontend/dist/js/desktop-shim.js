// desktop-shim.js — the transport + toast + page-lifecycle shim for the embedded island.
// GENERATED FILE — do not hand-edit (guide §3.3.4): emitted by scripts/sync-island.mjs
// into frontend/dist/js/ and checksummed in frontend/island.checksums.json.
//
// WHAT THIS FILE OWNS (GO-DESKTOP-IMPLEMENTATION-GUIDE.md §4.3 — the only NEW island
// file; loads BEFORE devboard.js/board-page.js):
//   1. window.hibanaFetch  — the fetch-compatible transport seam to the Go bridge.
//      The sync rebinds the 12 verified call sites to it (guide §4.1/§4.2):
//      devboard.js api() choke point (devboard.js:33) + 5 label-manager fetches
//      (:1288/:1344/:1360/:1380/:1390) + board-page.js's 4 direct fetches
//      (:287/:579/:741/:761). Response shape mirrors fetch so callers that check
//      err.status keep working (devboard.js:54-63).
//   2. window.hibanaXHR    — the XMLHttpRequest-compatible upload proxy for the S208
//      uploader (devboard.js:337/:367). The Go streaming upload is spec'd in guide
//      §5.4; implemented in M4 — until the Upload bridge exists, send() fails fast
//      and LOUD with a named not-implemented error instead of a silent hang.
//   3. window.hibana.toast — the app.js toast component contract (app.js:243-323 @
//      e6661c8), reimplemented 1:1 as WEB TOASTS (identical in WebView2 —
//      UI-UX-REPLICATION-SPEC.md §7.2). ZERO network use.
//   4. window.__hibanaPage — the minimal page-lifecycle consumer (mount + ctx.on),
//      ported verbatim from nav.js:24-54 + boot.js:185-208, BECAUSE guide §3.2 strips
//      nav.js, boot.js AND vendor/alpine.min.js — the only three owners of that
//      contract in the web app. board-page.js registers its page def through
//      window.__hibanaPage (board-page.js:1-2 self-stubs a queue); without a consumer
//      here the def stays queued forever and the island NEVER BOOTS. This is the one
//      addition beyond the guide's §4.3 skeleton trio, forced by the §3.2 strip list.
//
// WHAT IT MUST NEVER OWN (guide §4.3: "Owns NOTHING else"):
//   - No theme bootstrap (boot.js's job on the web — the desktop shell owns theme
//     natively, UI-UX §7.2 + guide §5.6). No service worker, no soft navigation, no
//     link interception, no command palette, no quick-add, no i18n (the i18n trio
//     carries it unchanged).
//   - No credentials, no cookie jar, no Origin forging, no caching (guide §4.4: the
//     Go side owns all of it; the bound surface stays the ONE Request method + the
//     upload stream; Request validates method + path allow-lists + size caps Go-side).
//   - window.hibana.handle401 is deliberately NOT provided: board-page.js:288 guards
//     it, so a 401 degrades to the caller's error path; M3's login window owns 401
//     recovery (guide §5.5).
(function () {
  'use strict'

  // ------------------------------------------------------------------ bridge
  // Wails v2 generates window.go.<pkg>.<Struct>.<Method> for every bound Go method;
  // the pkg/Struct names belong to internal/ui/bindings.go (M2), so resolve
  // defensively, in this order:
  //   1. window.go.desktop.API.Request  (the primary candidate)
  //   2. window.gohibana.api.Request    (the guide §4.3 fallback name)
  //   3. any window.go.<pkg>.API/api.<Method> (scan — survives the real package name)
  //   4. else null → callers throw a clear "bridge not wired" error.
  function pick(root, keys) {
    let cur = root
    for (let i = 0; i < keys.length; i++) {
      if (cur == null || typeof cur !== 'object') return null
      cur = cur[keys[i]]
    }
    return typeof cur === 'function' ? cur : null
  }
  function resolveBoundMethod(name) {
    let fn = pick(window, ['go', 'desktop', 'API', name])
    if (fn) return fn
    fn = pick(window, ['gohibana', 'api', name])
    if (fn) return fn
    fn = pick(window, ['gohibana', 'API', name])
    if (fn) return fn
    const go = window.go
    if (go && typeof go === 'object') {
      for (const pkg of Object.keys(go)) {
        fn = pick(go[pkg], ['API', name]) || pick(go[pkg], ['api', name])
        if (fn) return fn
      }
    }
    return null
  }

  // ------------------------------------------------------- window.hibanaFetch
  // fetch-compatible async fn (guide §4.3 skeleton, mirrored exactly):
  //   - opts.method defaults to GET, uppercased;
  //   - opts.body: strings pass through (every island call site pre-stringifies via
  //     JSON.stringify); non-strings are stringified — never String()'d into
  //     '[object Object]';
  //   - the caller's AbortController semantics are preserved: an ALREADY-aborted
  //     opts.signal rejects with an AbortError BEFORE the bridge is called
  //     (devboard.js:42 keys its one-retry off e.name === 'AbortError'; devboard.js's
  //     own 3s+retry deadline rides its own controllers around this seam unchanged);
  //   - opts.cache ('no-store') and opts.headers are IGNORED: hibanaFetch is a
  //     function call, not an HTTP dispatch — no CORS, no cookie domain games; the Go
  //     client owns real caching, cookies, the Origin header on writes (the T6 gate
  //     403s headerless writers) and the ETag store (guide §4.5, §5.1);
  //   - returns { ok, status, headers.get('etag'), json(), text() } — the guide's
  //     exact shape, so err.status propagation survives the round-trip.
  window.hibanaFetch = async function (path, opts) {
    opts = opts || {}
    if (opts.signal && opts.signal.aborted) {
      const ab = new Error('The operation was aborted.')
      ab.name = 'AbortError'
      throw ab
    }
    const method = (opts.method || 'GET').toUpperCase()
    let body = null
    if (opts.body != null) body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
    const bridge = resolveBoundMethod('Request')
    if (!bridge) {
      const err = new Error('hibana desktop bridge not wired: window.go.desktop.API.Request / window.gohibana.api.Request are missing. The Go side must bind internal/ui API.Request(method, path, body) (guide §4.4).')
      err.name = 'HibanaBridgeNotWired'
      throw err
    }
    const res = await bridge(method, path, body)
    if (res == null || typeof res.status !== 'number') {
      const err = new Error('hibana desktop bridge returned a malformed response for ' + method + ' ' + path)
      err.name = 'HibanaBridgeMalformed'
      throw err
    }
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      headers: { get: (h) => (String(h).toLowerCase() === 'etag' ? (res.etag || null) : null) },
      json: async () => JSON.parse(res.body),
      text: async () => res.body,
    }
  }

  // --------------------------------------------------------- window.hibanaXHR
  // XMLHttpRequest-compatible upload proxy for devboard.js's uploader (the 2
  // 'new XMLHttpRequest()' sites, devboard.js:337/:367 at the pin). Implements
  // exactly the surface the uploader touches: open/send/setRequestHeader/abort,
  // upload.onprogress, onload/onerror/onabort/onreadystatechange, status,
  // responseText, readyState. The Go streaming upload is spec'd in guide §5.4;
  // implemented in M4. Until the Upload bridge exists, send() fires onerror
  // (async, like a real XHR) with a clearly-NAMED not-implemented error so the
  // uploader's progress rows show a real failure instead of a silent hang.
  function HibanaXHR() {
    this.readyState = 0
    this.status = 0
    this.responseText = ''
    this.onreadystatechange = null
    this.onload = null
    this.onerror = null
    this.onabort = null
    this._method = null
    this._url = null
    this._headers = {}
    this._sent = false
    this._aborted = false
    this.upload = { onprogress: null } // devboard.js sets xhr.upload.onprogress
  }
  HibanaXHR.prototype.open = function (method, url) {
    this._method = method
    this._url = url
    this.readyState = 1
  }
  HibanaXHR.prototype.setRequestHeader = function (k, v) { this._headers[k] = v }
  HibanaXHR.prototype.abort = function () {
    if (this._aborted) return
    this._aborted = true
    this.readyState = 0
    if (typeof this.onabort === 'function') { try { this.onabort({ type: 'abort' }) } catch (e) { /* a handler must never throw back into the uploader */ } }
  }
  HibanaXHR.prototype.send = function (body) {
    if (this._sent) return
    this._sent = true
    const self = this
    if (this._aborted) return
    const bridge = resolveBoundMethod('Upload')
    if (!bridge) {
      // M4 not here yet (guide §5.4). Fire onerror asynchronously, like a real XHR —
      // devboard.js assigns its handlers BEFORE send() but real XHR events are tasks.
      queueMicrotask(function () {
        self.readyState = 4
        self.status = 0
        const err = new Error('hibanaXHR: the streaming upload bridge (window.gohibana.api.Upload — guide §5.4) is not implemented until M4; the desktop board cannot upload attachments yet.')
        err.name = 'NotImplementedUntilM4'
        self._error = err
        if (typeof self.onerror === 'function') { try { self.onerror({ type: 'error', error: err }) } catch (e) { /* ditto */ } }
        if (typeof self.onreadystatechange === 'function') { try { self.onreadystatechange() } catch (e) { /* ditto */ } }
      })
      return
    }
    // M4 path (guide §5.4): upload(method, url, body, headers) → { status, body }.
    // Progress events need the streaming contract M4 will define — extended there.
    Promise.resolve()
      .then(function () { return bridge(self._method || 'POST', self._url, body, self._headers) })
      .then(function (res) {
        if (self._aborted) return
        self.readyState = 4
        self.status = res && typeof res.status === 'number' ? res.status : 0
        self.responseText = res && res.body != null ? String(res.body) : ''
        const good = self.status >= 200 && self.status < 300
        if (good && typeof self.onload === 'function') { try { self.onload({ type: 'load' }) } catch (e) { /* ditto */ } }
        if (!good && typeof self.onerror === 'function') { try { self.onerror({ type: 'error' }) } catch (e) { /* ditto */ } }
        if (typeof self.onreadystatechange === 'function') { try { self.onreadystatechange() } catch (e) { /* ditto */ } }
      })
      .catch(function () {
        if (self._aborted) return
        self.readyState = 4
        self.status = 0
        if (typeof self.onerror === 'function') { try { self.onerror({ type: 'error' }) } catch (e) { /* ditto */ } }
      })
  }
  window.hibanaXHR = HibanaXHR

  // -------------------------------------------------------- window.hibana.toast
  // The app.js toast recipe, ported 1:1 (app.js:243-323 @ e6661c8; guide §4.3 cites
  // app.js:253-317 + app.js:247 for the Undo-must-stay-a-button rule). Contract:
  //   toast(message, kind = 'info', ms, actions = null)
  //   - kind 'ok'   → the S105 pastel-green variant: .toast-msg-row (check glyph +
  //     message + action buttons) + a .toast-x dismiss anchored TOP-RIGHT;
  //   - kind 'err'  → PERSISTENT by default (ms = 0 — stays until dismissed);
  //     other kinds auto-dismiss at 4000ms;
  //   - actions: [{ label, onClick, kind }] — kind 'primary' keeps the solid button,
  //     else .ghost; an Undo stays a REAL BUTTON (UI-UX §7.2), and clicking an action
  //     dismisses the toast after invoking it;
  //   - message renders via innerHTML (app.js's H2 contract — links allowed), so
  //     callers own escaping; the island's call sites esc()/B().esc() their
  //     interpolations (devboard.js:67, board-page.js:581);
  //   - exactly ONE toast at a time (the previous #toast is removed first).
  // Styling ships in the island's CSS manifest (components.css:252-319, polish-ui.css,
  // polish-batch.css) — identical in WebView2. ZERO network use.
  function toast(message, kind, ms, actions) {
    if (kind === undefined || kind === null) kind = 'info'
    if (ms === undefined) ms = kind === 'err' ? 0 : 4000 // errors persist by default
    const old = document.getElementById('toast')
    if (old) old.remove()
    const el = document.createElement('div')
    el.id = 'toast'
    el.className = 'toast ' + kind
    el.setAttribute('role', 'status')
    const makeAction = function (a) {
      const btn = document.createElement('button')
      btn.className = a.kind === 'primary' ? '' : 'ghost'
      btn.textContent = a.label
      btn.addEventListener('click', () => { try { a.onClick?.() } catch (e) { /* the app.js contract: a broken action never blocks dismissal */ } el.remove() })
      return btn
    }
    const makeDismiss = function (className) {
      const d = document.createElement('button')
      d.className = className
      d.setAttribute('aria-label', 'Dismiss')
      d.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'
      d.addEventListener('click', () => el.remove())
      return d
    }
    if (kind === 'ok') {
      const row = document.createElement('div')
      row.className = 'toast-msg-row'
      const check = document.createElement('span')
      check.className = 'toast-check'
      check.setAttribute('aria-hidden', 'true')
      check.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12.5l5 5L19.5 7"/></svg>'
      row.appendChild(check)
      const msg = document.createElement('span')
      msg.className = 'toast-msg'
      msg.innerHTML = message
      row.appendChild(msg)
      if (Array.isArray(actions)) for (const a of actions) row.appendChild(makeAction(a))
      el.appendChild(row)
      el.appendChild(makeDismiss('toast-x'))
    } else {
      const msg = document.createElement('span')
      msg.className = 'toast-msg'
      msg.innerHTML = message
      el.appendChild(msg)
      if (Array.isArray(actions)) for (const a of actions) el.appendChild(makeAction(a))
      el.appendChild(makeDismiss('ghost danger'))
    }
    document.body.appendChild(el)
    if (ms > 0) setTimeout(() => { if (el.parentNode) el.remove() }, ms)
  }
  window.hibana = { toast }

  // ----------------------------------------------------- window.__hibanaPage
  // The minimal mount consumer (see the header WHY). The contract below is nav.js's
  // applyDef/ctx shape VERBATIM (nav.js:24-54) + boot.js's queue drain
  // (boot.js:185-208): ctx.on(type, fn, opts) is a document-level listener tracked
  // for unmount; a second applyDef unmounts the previous page first. It owns NOTHING
  // else — no link interception, no soft navigation (the desktop is single-surface).
  const pageQueue = Array.isArray(window.__hibanaPageQueue) ? window.__hibanaPageQueue : []
  let activePage = null
  const applyDef = function (def) {
    if (!def || typeof def.mount !== 'function') return
    if (window.__hibanaBoot && typeof window.__hibanaBoot.unmount === 'function') {
      window.__hibanaBoot.unmount()
      window.__hibanaBoot = null
    }
    if (activePage) activePage.unmount()
    const listeners = []
    const ctx = {
      on(type, fn, opts) {
        document.addEventListener(type, fn, opts)
        listeners.push([type, fn, opts])
      },
    }
    const customUnmount = def.mount(ctx)
    activePage = {
      name: def.name,
      unmount() {
        for (const item of listeners) document.removeEventListener(item[0], item[1], item[2])
        listeners.length = 0
        if (typeof customUnmount === 'function') customUnmount()
        if (typeof def.unmount === 'function') def.unmount()
      },
    }
  }
  window.__hibanaPage = applyDef
  for (const def of pageQueue) applyDef(def)
  window.__hibanaPageQueue = []
})()
