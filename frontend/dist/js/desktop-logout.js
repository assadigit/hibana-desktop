// desktop-logout.js — the sign-out option + its confirm dialog (v0.1.9 — the
// owner ask: "It must also have option of logout and enter with a new account").
// GENERATED FILE — do not hand-edit (guide §3.3.4): emitted by scripts/sync-island.mjs
// into frontend/dist/js/ and checksummed in frontend/island.checksums.json. Loads
// blocking, right after desktop-sync.js, BEFORE every deferred island script.
//
// WHAT THIS FILE OWNS: the toolbar's #db-logout-button → the #db-logout-dialog
// confirm → the Go Logout binding (internal/ui.API.Logout — POST /api/auth/logout
// happens Go-SIDE, best-effort; then the cookie, the persisted session file, the
// ETag cache and the mirror's account-scoped rows all die Go-side) → on ok a
// location.reload(): the shell serves the document with data-desktop-authed="false",
// the login card opens at first paint, and signing in with the new account boots its
// kanban. The title/confirm/cancel labels ride the pin's own i18n keys
// (nav.signout / common.cancel — data-i18n on the markup, live-flipped by i18n.js);
// only the body copy + the failure lines are this file's own EN/FA pair.
//
// WHAT IT MUST NEVER OWN: no cookie/token handling, no credential storage, no
// storage of any kind — all Go-side.
(function () {
  'use strict'

  var STR = {
    en: {
      body: 'Your boards live safe on the Hibana cloud — sign in again any time to load them back.',
      notWired: 'The desktop bridge is not wired — restart the app.',
      unreachable: 'Cannot reach hibana.ir — check your connection and try again.'
    },
    fa: {
      body: 'تخته‌های شما در ابر هیبانا امن هستند — هر وقت خواستید دوباره وارد شوید و آن‌ها را بارگذاری کنید.',
      notWired: 'پل دسکتاپ وصل نیست — برنامه را دوباره باز کنید.',
      unreachable: 'اتصال به hibana.ir ممکن نیست — اتصال خود را بررسی کنید.'
    }
  }

  function lang() { return document.documentElement.lang === 'fa' ? 'fa' : 'en' }
  function t(key) { return (STR[lang()] && STR[lang()][key]) || STR.en[key] || key }

  // The bridge resolver — the same defensive chain desktop-login.js/-sync.js
  // use (all generated + drift-controlled; the duplication is by design so
  // the sign-out keeps working even if the shim's internal shape ever evolves).
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

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn)
    else fn()
  }

  ready(function () {
    var btn = document.getElementById('db-logout-button')
    var dlg = document.getElementById('db-logout-dialog')
    if (!btn || !dlg || typeof dlg.showModal !== 'function') return

    var body = document.getElementById('db-logout-body')
    var errEl = document.getElementById('db-logout-error')
    var confirmBtn = document.getElementById('db-logout-confirm')
    var cancelBtn = document.getElementById('db-logout-cancel')
    var busy = false

    function localize() {
      // The button/title/cancel/confirm labels ride data-i18n (i18n.js owns
      // them, live-flipped); only the body line is this file's pair.
      if (body) body.textContent = t('body')
    }

    function fail(msg) {
      if (!errEl) return
      errEl.textContent = msg
      errEl.hidden = false
    }

    function reset() {
      busy = false
      if (confirmBtn) confirmBtn.disabled = false
      if (cancelBtn) cancelBtn.disabled = false
      if (errEl) errEl.hidden = true
    }

    confirmBtn.addEventListener('click', function () {
      if (busy) return
      busy = true
      if (confirmBtn) confirmBtn.disabled = true
      if (cancelBtn) cancelBtn.disabled = true
      if (errEl) errEl.hidden = true
      var bridgeLogout = resolveBoundMethod('Logout')
      if (!bridgeLogout) { reset(); fail(t('notWired')); return }
      try {
        Promise.resolve(bridgeLogout()).then(function (res) {
          if (res && res.ok) {
            // The LOCAL account state is gone — reload: the shell serves the
            // document with data-desktop-authed="false", the login card
            // paints at the first frame, and the user signs in with the new
            // account (desktop-login.js → Go Login → reload → the kanban).
            location.reload()
            return
          }
          reset()
          fail(t('unreachable'))
        }, function () {
          reset()
          fail(t('unreachable'))
        })
      } catch (e) { reset(); fail(t('notWired')) }
    })

    if (cancelBtn) cancelBtn.addEventListener('click', function () { if (!busy) dlg.close() })
    btn.addEventListener('click', function () {
      if (busy) return
      localize()
      dlg.showModal()
    })

    // Live language flips (i18n.js owns html[lang]) — relabel the body line.
    localize()
    try {
      new MutationObserver(localize).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
    } catch (e) { /* no observer — the label stays at the open-time language */ }
  })
})()
