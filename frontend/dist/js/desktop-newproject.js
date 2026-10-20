// desktop-newproject.js — the new-project round (v0.1.11 — the owner ask:
// "Add ability to define a new project, and get a kanban for it as well. this
// project then will be updated in hibana's cloudflare as a new project.").
// GENERATED FILE — do not hand-edit (guide §3.3.4): emitted by scripts/sync-island.mjs
// into frontend/dist/js/ and checksummed in frontend/island.checksums.json. Loads
// blocking, right after desktop-logout.js, BEFORE every deferred island script.
//
// WHAT THIS FILE OWNS: the ability to DEFINE a project on the desktop and get
// its kanban — a LIVE cloud create, not a local stub:
//   1. THREE entry points: the switcher popup's "New project" row (injected by
//      the MutationObserver the moment board-page.js's openSwitch builds the
//      popup at runtime), and EVERY dead /projects.html link on the board
//      surface (the no-projects empty-state CTA, board-page.js:466; the fail
//      state, :920) — intercepted into the dialog because the embedded server
//      serves no projects page; the switcher list IS it. The popup's own
//      "All projects →" link (:371) is css-hidden (desktop-newproject.css).
//   2. THE CREATE: mint a client UUID v4 -> POST /api/projects {id, title,
//      description?, status:'planning'} through window.hibanaFetch — the
//      shim's fetch-compatible seam into the bridge's ONE Request transport
//      (the Go client stamps the Origin + the session cookie; the T6 write
//      gate passes) — the web API's own idempotent-by-client-id contract
//      (201 {ok,id} / 200 {ok,duplicate}: both mean the project EXISTS on
//      the Hibana cloud; routes/projects/index.ts:389).
//   3. THE KANBAN: on the ok resolve, location.assign the island's OWN
//      /kanban?project=<id> deep link — the boot loads the fresh board (GET
//      /api/projects/:id/devboard: the project + its empty columns), and the
//      island's own boot->recordBoard() writes hibana-kanban-last; THIS FILE
//      never touches storage (the island's code does, exactly as on the web).
//   4. status:'planning' — NOT the createProjectSchema's 'spark' default: the
//      switcher's list (GET /api/projects?sort=recent) EXCLUDES sparks
//      (routes/projects/index.ts:66), so a spark would never appear in the
//      very switcher it was created from; 'planning' is the first ACTIVE
//      stage — it lands in the list AND owns its kanban.
//
// WHAT IT MUST NEVER OWN: no cookie/token handling, no storage of any kind,
// no offline queueing (the outbox's project.create entity is M3's scope — a
// create that LOOKS queued but is not would be a lie; offline surfaces the
// unreachable line honestly).
(function () {
  'use strict'

  var STR = {
    en: {
      body: 'Name the project — it is created on the Hibana cloud (hibana.ir) and its Kanban board opens right here.',
      busy: 'Creating on hibana.ir…',
      notWired: 'The desktop bridge is not wired — restart the app.',
      unreachable: 'Cannot reach hibana.ir — check your connection and try again.',
      session: 'Your session expired — sign in again, then retry.',
      rate: 'Too many attempts — wait a minute and try again.',
      refused: 'hibana.ir refused the create — check the name and try again.',
      conflict: 'That project id already exists — try again.',
      emptyTitle: 'Give the project a name first.'
    },
    fa: {
      body: 'نام پروژه را وارد کنید — روی ابر هیبانا (hibana.ir) ساخته می‌شود و برد کانبانش همین‌جا باز می‌شود.',
      busy: 'در حال ساخت روی hibana.ir…',
      notWired: 'پل دسکتاپ وصل نیست — برنامه را دوباره باز کنید.',
      unreachable: 'اتصال به hibana.ir ممکن نیست — اتصال خود را بررسی کنید.',
      session: 'نشست شما منقضی شده — دوباره وارد شوید و تلاش کنید.',
      rate: 'تلاش‌های شما زیاد بوده — کمی صبر کنید و دوباره تلاش کنید.',
      refused: 'hibana.ir ساخت پروژه را نپذیرفت — نام را بررسی کنید و دوباره تلاش کنید.',
      conflict: 'پروژه‌ای با این شناسه موجود است — دوباره تلاش کنید.',
      emptyTitle: 'اول یک نام برای پروژه وارد کنید.'
    }
  }

  function lang() { return document.documentElement.lang === 'fa' ? 'fa' : 'en' }
  function t(key) { return (STR[lang()] && STR[lang()][key]) || STR.en[key] || key }

  // The pin's own dictionaries carry every dialog label (cmdk.newProject /
  // sparks.title / sparks.description / cat.quickAdd / common.cancel — EN + FA
  // @ pin). Resolve at CALL time, never a parse-time snapshot (the v0.1.1
  // lesson) — the switcher row is runtime-injected, so data-i18n cannot own it.
  function pin(key, fallback) {
    var s = window.hibanaI18n ? window.hibanaI18n.t(key) : null
    return s && s !== key ? s : fallback
  }

  // The client-minted id — the create's idempotency key (the server re-validates
  // the uuid shape; a replay of the same id answers {ok,duplicate} 200 — the
  // offline-replay-safety contract the web quick-add itself rides).
  function uuid() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID()
    } catch (e) { /* fall through to the v4 shim */ }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0
      var v = c === 'x' ? r : (r & 0x3) | 0x8
      return v.toString(16)
    })
  }

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn)
    else fn()
  }

  ready(function () {
    var dlg = document.getElementById('db-newproject-dialog')
    if (!dlg || typeof dlg.showModal !== 'function') return

    var titleInput = document.getElementById('db-newproject-title-input')
    var descInput = document.getElementById('db-newproject-description')
    var body = document.getElementById('db-newproject-body')
    var errEl = document.getElementById('db-newproject-error')
    var createBtn = document.getElementById('db-newproject-create')
    var cancelBtn = document.getElementById('db-newproject-cancel')
    var busy = false

    function authed() {
      // The login gate owns an unauthenticated surface (the shell serves
      // data-desktop-authed on <html> at every paint — the first-paint rule).
      return document.documentElement.getAttribute('data-desktop-authed') !== 'false'
    }

    function fail(msg) {
      if (!errEl) return
      errEl.textContent = msg
      errEl.hidden = false
    }

    function reset() {
      busy = false
      if (createBtn) { createBtn.disabled = false; createBtn.textContent = pin('cat.quickAdd', 'Create') }
      if (cancelBtn) cancelBtn.disabled = false
    }

    function localize() {
      if (body) body.textContent = t('body')
      // The runtime-injected switcher row's label — the pin's own
      // cmdk.newProject (EN 'New project' / FA 'پروژهٔ جدید').
      var rowLabel = document.getElementById('db-switch-new-label')
      if (rowLabel) rowLabel.textContent = pin('cmdk.newProject', 'New project')
      var row = document.getElementById('db-switch-new')
      if (row) {
        var lbl = pin('cmdk.newProject', 'New project')
        row.setAttribute('title', lbl)
        row.setAttribute('aria-label', lbl)
      }
    }

    function open() {
      if (busy || !authed()) return
      if (titleInput) titleInput.value = ''
      if (descInput) descInput.value = ''
      if (errEl) errEl.hidden = true
      if (createBtn) { createBtn.disabled = false; createBtn.textContent = pin('cat.quickAdd', 'Create') }
      if (cancelBtn) cancelBtn.disabled = false
      localize()
      dlg.showModal()
      if (titleInput) titleInput.focus()
    }

    function create() {
      if (busy) return
      var title = titleInput ? String(titleInput.value || '').trim() : ''
      if (!title) { fail(t('emptyTitle')); if (titleInput) titleInput.focus(); return }
      if (typeof window.hibanaFetch !== 'function') { fail(t('notWired')); return }
      var id = uuid()
      var payload = { id: id, title: title, status: 'planning' }
      var desc = descInput ? String(descInput.value || '').trim() : ''
      if (desc) payload.description = desc
      busy = true
      if (createBtn) { createBtn.disabled = true; createBtn.textContent = t('busy') }
      if (cancelBtn) cancelBtn.disabled = true
      if (errEl) errEl.hidden = true
      // POST /api/projects — the LIVE Hibana-cloud create through the shim's
      // fetch seam (the bridge's ONE Request transport: Origin + cookie are
      // stamped Go-side). 201 {ok,id} / 200 {ok,duplicate} both mean the
      // project EXISTS on the cloud — navigate the island's own deep link.
      window.hibanaFetch('/api/projects', { method: 'POST', body: JSON.stringify(payload) })
        .then(function (r) {
          if (r.ok) {
            return r.json().catch(function () { return {} }).then(function (b) {
              var pid = (b && b.id) || id
              // The project is on the Hibana cloud — boot its kanban via the
              // island's own deep-link path (recordBoard runs island-side).
              location.assign('/kanban?project=' + encodeURIComponent(pid))
            })
          }
          reset()
          // 401: the bridge already reopened the login card Go-side
          // (NotifyAuthLost); the session line explains the retry.
          if (r.status === 401) { fail(t('session')); return }
          if (r.status === 429) { fail(t('rate')); return }
          if (r.status === 409) { fail(t('conflict')); return }
          fail(t('refused'))
        })
        .catch(function () { reset(); fail(t('unreachable')) })
    }

    if (createBtn) createBtn.addEventListener('click', function (e) { e.preventDefault(); create() })
    if (cancelBtn) cancelBtn.addEventListener('click', function () { if (!busy) dlg.close() })
    var form = document.getElementById('db-newproject-form')
    if (form) form.addEventListener('submit', function (e) { e.preventDefault(); create() })
    // Esc cannot drop an in-flight create — the POST's outcome is unknown until
    // it resolves (the honest-transport rule; the dialog re-opens on reset).
    dlg.addEventListener('cancel', function (e) { if (busy) e.preventDefault() })
    dlg.addEventListener('close', reset)

    // The dead /projects.html links — the embedded server serves no projects
    // page; the empty state's "Go to projects" CTA (board-page.js:466) and the
    // fail state's link (:920) both become the create dialog, the desktop's
    // honest affordance (the empty state's own copy says "Create your first
    // project" — now the desktop actually can).
    document.addEventListener('click', function (e) {
      if (!e.target || !e.target.closest) return
      var a = e.target.closest('a[href="/projects.html"]')
      if (!a) return
      e.preventDefault()
      open()
    })

    // The switcher popup's New project row — board-page.js builds the popup
    // lazily at RUNTIME (openSwitch appends it to <body>), so the row joins via
    // MutationObserver the moment the popup is born. Appended as a POPUP
    // SIBLING after the list div: renderSwitchRows rewrites #db-switch-list's
    // innerHTML on every list update, but this row survives every re-render —
    // and the popup stays OPEN under the modal's backdrop, so board-page.js's
    // own switchOpen state is never desynced (closeSwitch stays consistent).
    function injectRow() {
      var pop = document.getElementById('db-switch-pop')
      if (!pop || document.getElementById('db-switch-new')) return
      var row = document.createElement('button')
      row.type = 'button'
      row.id = 'db-switch-new'
      row.className = 'db-switch-row db-switch-new'
      row.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span class="db-switch-name" id="db-switch-new-label"></span>'
      row.addEventListener('click', function (e) { e.preventDefault(); open() })
      pop.appendChild(row)
      localize()
    }
    injectRow()
    try {
      new MutationObserver(injectRow).observe(document.body, { childList: true, subtree: true })
    } catch (e) { /* no observer — the row injects on the ready pass only */ }

    // Live language flips (i18n.js owns html[lang]) — relabel the body line +
    // the runtime-injected row.
    localize()
    try {
      new MutationObserver(localize).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
    } catch (e) { /* no observer — the labels stay at the open-time language */ }
  })
})()
