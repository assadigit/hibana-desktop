// desktop-refresh.js — the refresh round (v0.1.12 — the owner ask: "I tried
// something, deleted something from hibana, clicked sync on the app, but it
// didn't got deleted. it seems we need a refresh button"). The sync round
// PULLS the boards into the Go mirror, but the island's own DOM keeps the
// boot-time render — a deletion made on hibana.ir stayed on screen even after
// a green sync. This button is the explicit pull-to-screen: one click re-boots
// the island (location.reload — board-page.js pushState'd ?project= so a
// refresh re-enters the SAME board), and the boot fetches ride the bridge's
// always-fresh interactive transport (never the conditional poll), so the
// cloud's truth — the deletion included — paints. The sync modal grew the
// same reflex for its own round (desktop-sync.js v0.1.12: an ok outcome with
// pulled boards reloads on close); this button is the always-there affordance.
// GENERATED FILE — do not hand-edit (guide §3.3.4): emitted by scripts/sync-island.mjs
// into frontend/dist/js/ and checksummed in frontend/island.checksums.json. Loads
// blocking, right after desktop-newproject.js, BEFORE every deferred island script.
(function () {
  'use strict'

  // The desktop-owned strings. The pin's dictionaries carry no refresh key
  // (verified @ the pin), so this EN/FA pair is the button's own; i18n.js
  // owns html[lang], and localize() reads it live.
  var STR = {
    en: { btn: 'Refresh board', label: 'Refresh' },
    fa: { btn: 'به‌روزرسانی تخته', label: 'به‌روزرسانی' }
  }

  function lang() { return document.documentElement.lang === 'fa' ? 'fa' : 'en' }
  function t(key) { return (STR[lang()] && STR[lang()][key]) || STR.en[key] || key }

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn)
    else fn()
  }

  ready(function () {
    var btn = document.getElementById('db-refresh-button')
    if (!btn) return
    var label = document.getElementById('db-refresh-btn-label')
    var busy = false

    function localize() {
      btn.setAttribute('aria-label', t('btn'))
      btn.setAttribute('title', t('btn'))
      if (label) label.textContent = t('label')
    }

    // One guard: a second click while the reload is pending must not
    // double-schedule — the first reload already owns the document. The
    // data-busy attribute spins the glyph (desktop-refresh.css) for the
    // frame(s) before the unload; a re-boot always follows on a live click.
    btn.addEventListener('click', function () {
      if (busy) return
      busy = true
      btn.setAttribute('data-busy', 'true')
      btn.setAttribute('aria-busy', 'true')
      location.reload()
    })

    // Live language flips (i18n.js owns html[lang]) — relabel the surfaces.
    localize()
    try {
      new MutationObserver(localize).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
    } catch (e) { /* no observer — the label stays at the boot language */ }
  })
})()
