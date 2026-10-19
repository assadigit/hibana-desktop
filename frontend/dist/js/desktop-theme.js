// desktop-theme.js — the desktop theme bootstrap + toggle wiring (v0.1.5 — the
// owner ask: "The app doesnt have darkmode, add dark mode and it's toggle").
// GENERATED FILE — do not hand-edit (guide §3.3.4): emitted by scripts/sync-island.mjs
// into frontend/dist/js/ and checksummed in frontend/island.checksums.json. Loads
// blocking, FIRST in <head> (before desktop-shim.js), BEFORE every deferred island
// script — the pre-paint theme resolution must beat the first render.
//
// WHY THIS FILE EXISTS: the web sets html[data-theme] in boot.js + app.js (S87 —
// exactly two looks: light and claude-dark, a CSS TOKEN swap; claude-dark-theme.css
// + themes.css ship in the island VERBATIM). Both scripts are STRIPPED here (guide
// §3.2), so without this file the desktop rendered the light baseline forever —
// the root cause of "the app doesn't have dark mode". The desktop owns theme
// natively per UI-UX-REPLICATION-SPEC §7.2 + guide §5.6.
//
// THE ONE SOURCE OF TRUTH is Go-side: the mirror meta row ui.theme
// (internal/ui.ThemeMetaKey — 'light' | 'claude-dark' | 'system', default system —
// the web's own default, S87). The Go shell serves the document with
// data-desktop-theme="<pref>" on <html> (internal/ui.InjectShellState); explicit
// prefs ALSO carry data-theme directly (a zero-JS first paint). This file owns:
//   1. PRE-PAINT: resolve 'system' via the OS scheme (WebView2 follows the Windows
//      app mode) — exactly boot.js's S87 block, run synchronously before first render.
//   2. Live OS flips while the pref is 'system' (app.js:235-242 parity).
//   3. The TWO toggle surfaces: the login gate's .theme-floater (the web login
//      page's own affordance, login.html:30 — present pre-login) and the board
//      toolbar's #db-theme-toggle (post-login). Both flip light <-> claude-dark
//      through the Go SetTheme binding (resolved at CLICK time — the v0.1.1
//      parse-time lesson) and paint the web's own SUN/MOON icons (app.js:181-182).
//   4. The hibana:theme event — the Go shell emits it with the new pref (the tray
//      menu's Light / Dark / Follow system picker, internal/tray).
//
// NO localStorage: the desktop pref never forks from the Go meta row (the web's
// 'hibana-theme' key stays web-only; a dead bridge still flips the live document,
// the next boot re-reads the persisted pref).
(function () {
  'use strict'

  var html = document.documentElement
  var DARK = 'claude-dark'
  var LIGHT = 'light'
  // The web's own icons, byte-parity (app.js:181-182). The convention is
  // app.js:213's: the icon mirrors the CURRENT look — SUN in light, MOON in dark.
  var SUN = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
  var MOON = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>'

  function osDark() {
    try { return matchMedia('(prefers-color-scheme: dark)').matches } catch (e) { return false }
  }
  // pref(): the Go-served stored preference (data-desktop-theme on <html>);
  // anything else (a raw serve without the middleware) reads as 'system'.
  function pref() {
    var p = html.getAttribute('data-desktop-theme')
    return p === DARK || p === LIGHT || p === 'system' ? p : 'system'
  }
  function resolve(p) {
    if (p === DARK || p === LIGHT) return p
    return osDark() ? DARK : LIGHT
  }
  function apply(p) {
    html.dataset.theme = resolve(p)
  }
  // paintToggles(): app.js paintThemeButton parity (S93: no hover tooltip — the
  // icon is the label). Both desktop surfaces are icon-only, so only the .icon
  // child swaps; other children (if a future surface adds one) survive.
  function paintToggles() {
    var svg = html.dataset.theme === DARK ? MOON : SUN
    var els = document.querySelectorAll('[data-theme-toggle], .theme-floater')
    for (var i = 0; i < els.length; i++) {
      var b = els[i]
      b.removeAttribute('title')
      b.removeAttribute('data-tooltip')
      var old = b.querySelector('.icon')
      if (old) old.outerHTML = svg
      else b.insertAdjacentHTML('afterbegin', svg)
    }
  }

  // ---- 1. PRE-PAINT: synchronous in <head>, before first render (S87 parity). ----
  apply(pref())

  // ---- 2. live OS flips while 'system' (app.js:235-242 parity) ----
  try {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      if (pref() === 'system') {
        apply('system')
        paintToggles()
      }
    })
  } catch (e) { /* engines without the matchMedia listener resolve per-load only */ }

  // The bridge resolver — the same defensive chain desktop-login.js uses (both
  // files are generated + drift-controlled; the duplication is by design so the
  // theme keeps working even if the shim's internal shape ever evolves).
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
    // ---- 3. the toggle surfaces (the gate floater pre-login, the toolbar button
    //      post-login — the same flip lands on both). Optimistic apply FIRST: the
    //      Go persist can never make the toggle feel broken; a dead bridge keeps
    //      the live document in the chosen look until the next boot. ----
    function flip(ev) {
      if (ev) ev.preventDefault()
      var next = html.dataset.theme === DARK ? LIGHT : DARK
      html.setAttribute('data-desktop-theme', next) // an explicit flip leaves 'system'
      apply(next)
      paintToggles()
      var setTheme = resolveBoundMethod('SetTheme')
      if (setTheme) {
        try { setTheme(next).catch(function () {}) } catch (e) {}
      }
    }
    var buttons = document.querySelectorAll('[data-theme-toggle], .theme-floater')
    for (var i = 0; i < buttons.length; i++) buttons[i].addEventListener('click', flip)

    // ---- 4. tray-driven changes: Go emits hibana:theme with the new pref
    //      (Light / Dark / Follow system — internal/tray's submenu). ----
    if (window.runtime && typeof window.runtime.EventsOn === 'function') {
      window.runtime.EventsOn('hibana:theme', function (payload) {
        var p = payload
        if (p && typeof p === 'object') p = p.pref || ''
        if (p !== DARK && p !== LIGHT && p !== 'system') p = 'system'
        html.setAttribute('data-desktop-theme', p)
        apply(p)
        paintToggles()
      })
    }

    paintToggles()
  })
})()
