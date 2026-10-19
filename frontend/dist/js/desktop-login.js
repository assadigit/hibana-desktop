// desktop-login.js — the login gate controller (GO-DESKTOP-IMPLEMENTATION-GUIDE.md
// §5.5 — the M2 pick: the island-rendered login card).
// GENERATED FILE — do not hand-edit (guide §3.3.4): emitted by scripts/sync-island.mjs
// into frontend/dist/js/ and checksummed in frontend/island.checksums.json. Loads
// blocking, right after desktop-shim.js, BEFORE every deferred island script.
//
// WHAT THIS FILE OWNS:
//   1. The gate's form flow: submit → the Go Login binding (internal/ui.API.Login —
//      POST /api/auth/login happens Go-SIDE; the session cookie NEVER crosses back
//      into JS, it lands in the Go cookie jar + the DPAPI-at-M5 store) → on ok a
//      location.reload() so the island boots with a live session and the kanban
//      loads. Auth failures resolve {ok:false, code, message} so the card branches
//      wrong-password vs suspended vs rate-limited; transport trouble rejects and
//      the card reports it cannot reach hibana.ir.
//   2. window.__hibanaMe — the async identity hook i18n.js:69-77 ALREADY prefers:
//      the island's language resolution goes through the Go bridge (AuthState) —
//      FA users get the FA dictionary + RTL with ZERO island network (the M3 note
//      in desktop-shim.js's header, pulled forward because login now exists).
//   3. Session-expiry recovery (guide §5.5: "401 mid-session → the session-expiry
//      dialog → re-POST → the failing op retries once"): the Go side emits
//      hibana:auth-required (a 401 crossing the bridge, the pull loop, or the
//      outbox drain); the gate reopens with the expiry note; a successful sign-in
//      reloads, and Go wakes the outbox's retry-once.
//
// WHAT IT MUST NEVER OWN: no cookie/token handling, no storage of credentials, no
// Origin forging, no theme bootstrap, no caching — all Go-side or island-owned.
(function () {
  'use strict'

  // The bridge resolver — the same defensive chain desktop-shim.js uses (both files
  // are generated + drift-controlled; the duplication is by design so the login
  // gate keeps working even if the shim's internal shape ever evolves).
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

  var bridgeLogin = resolveBoundMethod('Login')
  var bridgeAuthState = resolveBoundMethod('AuthState')

  // ---- language resolution (i18n.js:69-77): the hook wins, no island network ----
  if (bridgeAuthState) {
    window.__hibanaMe = async function () {
      try {
        const st = await bridgeAuthState()
        if (st && st.authenticated && st.user) return { ok: true, body: { user: st.user } }
        return { ok: false, body: null }
      } catch (e) {
        return { ok: false, body: null }
      }
    }
  }

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn)
    else fn()
  }

  ready(function () {
    var gate = document.getElementById('login-gate')
    var form = document.getElementById('login-gate-form')
    var loginInput = document.getElementById('login-gate-login')
    var passInput = document.getElementById('login-gate-password')
    var submit = document.getElementById('login-gate-submit')
    var spinner = document.getElementById('login-spinner')
    var errEl = document.getElementById('login-error')
    var sub = document.getElementById('login-gate-sub')
    if (!gate || !form) return

    var authedAtBoot = document.documentElement.getAttribute('data-desktop-authed') === 'true'

    function busy(on) {
      if (submit) submit.disabled = on
      if (spinner) spinner.classList.toggle('busy', on)
    }
    function fail(msg) {
      if (!errEl) return
      errEl.textContent = msg
      errEl.hidden = false
    }
    function openGate(reason) {
      document.documentElement.setAttribute('data-desktop-authed', 'false')
      if (reason === 'expired' && sub) sub.textContent = 'Your session expired — sign in again to reconnect and load your boards.'
      if (errEl) errEl.hidden = true
      if (loginInput) loginInput.value = ''
      if (passInput) passInput.value = ''
      if (loginInput) loginInput.focus()
    }

    // The form is wired even while the gate is hidden — the expiry event can
    // reopen it long after boot.
    form.addEventListener('submit', function (ev) {
      ev.preventDefault()
      if (errEl) errEl.hidden = true
      var login = loginInput ? String(loginInput.value || '').trim() : ''
      var password = passInput ? String(passInput.value || '') : ''
      if (!login || !password) {
        fail('Enter your email and password.')
        return
      }
      if (!bridgeLogin) {
        fail('The desktop bridge is not wired — restart the app.')
        return
      }
      busy(true)
      bridgeLogin(login, password).then(
        function (res) {
          busy(false)
          if (res && res.ok) {
            // Reload with the live session: the Go shell now serves this
            // document with data-desktop-authed="true", the card never
            // appears, and the island boots straight into the boards.
            location.reload()
            return
          }
          fail((res && res.message) || 'Sign-in failed — try again.')
        },
        function () {
          busy(false)
          fail('Cannot reach hibana.ir — check your connection and try again.')
        }
      )
    })

    if (!authedAtBoot && loginInput) loginInput.focus()

    // Session expiry mid-session (guide §5.5) — emitted by the Go shell when a
    // 401 crosses the bridge, the pull loop, or the outbox drain.
    if (window.runtime && typeof window.runtime.EventsOn === 'function') {
      window.runtime.EventsOn('hibana:auth-required', function () {
        openGate('expired')
      })
    }
  })
})()
