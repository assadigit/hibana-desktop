// desktop-sync.js — the manual sync button + its proof modal (v0.1.6 — the
// owner ask: the physical, visible sync button whose modal proves the round:
// connecting to the Cloudflare server > upload > sync > the success panel —
// the user is 100% sure the boards are synced and will not vanish).
// v0.1.8 — the owner ask: "next to sprints and labels, but colored (fill
// colored)": the button is now the LABELED fill-colored CTA pill after Labels
// (this file also paints its visible label per language, like the aria).
// GENERATED FILE — do not hand-edit (guide §3.3.4): emitted by scripts/sync-island.mjs
// into frontend/dist/js/ and checksummed in frontend/island.checksums.json.
(function () {
  'use strict'

  // The desktop-owned strings. The island's dictionaries are pin-verbatim copies
  // (they carry no sync keys — verified @ the pin), so this EN/FA pair is the
  // modal's own; i18n.js owns html[lang], and localize() reads it live.
  var STR = {
    en: {
      btn: 'Sync now',
      btnLabel: 'Sync',
      title: 'Sync with Hibana cloud',
      connect: 'Connecting to Cloudflare server',
      upload: 'Uploading changes',
      sync: 'Syncing boards',
      okTitle: 'Everything synced',
      okBody: 'Your boards are saved on the Hibana cloud — they will not vanish.',
      uploaded: '{u} change(s) uploaded',
      noneWaiting: 'no changes were waiting — every edit saves live',
      projectsNote: '{p} project(s) · {b} board(s) checked',
      okTime: 'last synced {t}',
      warnTitle: 'Synced — some changes still uploading',
      busyTitle: 'A sync is already running.',
      sessionTitle: 'Your session expired — sign in again.',
      unreachableTitle: 'Cannot reach hibana.ir — check your connection.',
      errTitle: 'Sync failed',
      notWired: 'The desktop bridge is not wired — restart the app.',
      retry: 'Try again',
      done: 'Done',
      close: 'Close'
    },
    fa: {
      btn: 'همگام‌سازی',
      btnLabel: 'همگام‌سازی',
      title: 'همگام‌سازی با ابر هیبانا',
      connect: 'اتصال به سرور Cloudflare',
      upload: 'بارگذاری تغییرات',
      sync: 'همگام‌سازی تخته‌ها',
      okTitle: 'همه‌چیز همگام شد',
      okBody: 'تخته‌های شما در ابر هیبانا ذخیره شده‌اند — از بین نمی‌روند.',
      uploaded: '{u} تغییر بارگذاری شد',
      noneWaiting: 'تغییر منتظری نبود — هر ویرایش زنده ذخیره می‌شود',
      projectsNote: '{p} پروژه · {b} تخته بررسی شد',
      okTime: 'آخرین همگام‌سازی {t}',
      warnTitle: 'همگام شد — چند تغییر هنوز در حال بارگذاری است',
      busyTitle: 'یک همگام‌سازی دیگر در جریان است.',
      sessionTitle: 'نشست شما منقضی شد — دوباره وارد شوید.',
      unreachableTitle: 'اتصال به hibana.ir ممکن نیست — اتصال خود را بررسی کنید.',
      errTitle: 'همگام‌سازی ناموفق بود',
      notWired: 'پل دسکتاپ وصل نیست — برنامه را دوباره باز کنید.',
      retry: 'تلاش دوباره',
      done: 'انجام شد',
      close: 'بستن'
    }
  }

  function lang() { return document.documentElement.lang === 'fa' ? 'fa' : 'en' }
  function t(key) { return (STR[lang()] && STR[lang()][key]) || STR.en[key] || key }
  function fmt(key, map) {
    var s = t(key)
    for (var k in map) s = s.split('{' + k + '}').join(String(map[k]))
    return s
  }

  // The step marks: the small ring while active, check/cross at the ends.
  var SPIN = '<span class="db-sync-spin" aria-hidden="true"></span>'
  var CHECK = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>'
  var CROSS = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>'
  var REFRESH = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/></svg>'

  // The bridge resolver — the same defensive chain desktop-login.js/-theme.js
  // use (all generated + drift-controlled; the duplication is by design).
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
    var btn = document.getElementById('db-sync-button')
    var dlg = document.getElementById('db-sync-dialog')
    if (!btn || !dlg || typeof dlg.showModal !== 'function') return

    var stepsEl = document.getElementById('db-sync-steps')
    var btnLabel = document.getElementById('db-sync-btn-label')
    var panel = document.getElementById('db-sync-panel')
    var panelIcon = panel ? panel.querySelector('.icon') : null
    var panelTitle = document.getElementById('db-sync-panel-title')
    var panelBody = document.getElementById('db-sync-panel-body')
    var closeBtn = document.getElementById('db-sync-close')
    var retryBtn = document.getElementById('db-sync-retry')
    var doneBtn = document.getElementById('db-sync-done')
    var syncing = false

    function setText(id, text) { var el = document.getElementById(id); if (el) el.textContent = text }

    function localize() {
      btn.setAttribute('aria-label', t('btn'))
      btn.setAttribute('title', t('btn'))
      if (btnLabel) btnLabel.textContent = t('btnLabel')
      setText('db-sync-title', t('title'))
      var rows = stepsEl ? stepsEl.querySelectorAll('li[data-step]') : []
      for (var i = 0; i < rows.length; i++) {
        var label = rows[i].querySelector('.db-sync-label')
        var key = rows[i].getAttribute('data-step')
        if (label && key) label.textContent = t(key)
      }
      if (closeBtn) closeBtn.textContent = t('close')
      if (retryBtn) retryBtn.textContent = t('retry')
      if (doneBtn) doneBtn.textContent = t('done')
    }

    function setStep(name, state, note) {
      if (!stepsEl) return
      var li = stepsEl.querySelector('li[data-step="' + name + '"]')
      if (!li) return
      li.setAttribute('data-state', state)
      var mark = li.querySelector('.db-sync-mark')
      if (mark) {
        if (state === 'active') mark.innerHTML = SPIN
        else if (state === 'done') mark.innerHTML = CHECK
        else if (state === 'failed') mark.innerHTML = CROSS
        else mark.innerHTML = ''
      }
      // The server-minted detail lines ride under the step row (English by
      // nature — they are live facts, not UI chrome). An UNDEFINED note keeps
      // the existing one (the success belt only refreshes the states — it must
      // never wipe the details the events painted); an EMPTY string hides it
      // (an active step carries no fact yet).
      var noteEl = li.querySelector('.db-sync-note')
      if (!noteEl) {
        noteEl = document.createElement('span')
        noteEl.className = 'db-sync-note'
        li.appendChild(noteEl)
      }
      if (typeof note === 'undefined') {
        // keep the painted note (state-only refresh)
      } else if (note) { noteEl.textContent = note; noteEl.hidden = false }
      else noteEl.hidden = true
    }

    function showPanel(kind, title, body, retryable) {
      if (!panel) return
      if (kind === 'ok' && panelIcon) panelIcon.outerHTML = CHECK
      else if (kind === 'warn' && panelIcon) panelIcon.outerHTML = REFRESH
      else if (kind === 'err' && panelIcon) panelIcon.outerHTML = CROSS
      panelIcon = panel ? panel.querySelector('.icon') : null
      panel.setAttribute('data-kind', kind)
      if (panelTitle) panelTitle.textContent = title
      if (panelBody) panelBody.textContent = body || ''
      panel.hidden = false
      if (retryBtn) retryBtn.hidden = !retryable
      if (doneBtn) doneBtn.hidden = kind !== 'ok'
      if (closeBtn) closeBtn.hidden = kind === 'ok'
    }

    function timeStr(iso) {
      var d = iso ? new Date(iso) : new Date()
      if (isNaN(d.getTime())) d = new Date()
      try { return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) } catch (e) { return d.toString() }
    }

    function onDone(out) {
      syncing = false
      if (!out || typeof out !== 'object') out = {}
      if (out.ok) {
        // Belt: the events may lag the promise (the same IPC, different lanes) —
        // a success verdict paints ALL steps done.
        setStep('connect', 'done')
        setStep('upload', 'done')
        setStep('sync', 'done')
        var note = out.uploaded > 0 ? fmt('uploaded', { u: out.uploaded }) : t('noneWaiting')
        var counts = fmt('projectsNote', { p: out.projects, b: out.boards })
        var when = fmt('okTime', { t: timeStr(out.at) })
        showPanel('ok', t('okTitle'), t('okBody') + ' ' + note + ' · ' + counts + ' · ' + when, false)
        return
      }
      if (out.code === 'busy') { showPanel('err', t('busyTitle'), '', false); return }
      if (out.code === 'session') { showPanel('err', t('sessionTitle'), '', false); return }
      if (out.code === 'unreachable') { showPanel('err', t('unreachableTitle'), '', true); return }
      if (out.code === 'pending') { showPanel('warn', t('warnTitle'), out.message || '', true); return }
      showPanel('err', t('errTitle'), out.message || '', true)
    }

    function onReject() {
      syncing = false
      showPanel('err', t('errTitle'), t('notWired'), false)
    }

    function run() {
      syncing = true
      var syncNow = resolveBoundMethod('SyncNow')
      if (!syncNow) { onReject(); return }
      try {
        Promise.resolve(syncNow()).then(onDone, onReject)
      } catch (e) { onReject() }
    }

    function openSync() {
      localize()
      if (syncing) { dlg.showModal(); return } // reopen mid-round: the steps are live
      syncing = true
      if (panel) panel.hidden = true
      if (retryBtn) retryBtn.hidden = true
      if (doneBtn) doneBtn.hidden = true
      if (closeBtn) closeBtn.hidden = false
      setStep('connect', 'pending')
      setStep('upload', 'pending')
      setStep('sync', 'pending')
      dlg.showModal()
      run()
    }

    btn.addEventListener('click', openSync)
    if (closeBtn) closeBtn.addEventListener('click', function () { dlg.close() })
    if (doneBtn) doneBtn.addEventListener('click', function () { dlg.close() })
    if (retryBtn) retryBtn.addEventListener('click', function () {
      if (panel) panel.hidden = true
      if (retryBtn) retryBtn.hidden = true
      if (doneBtn) doneBtn.hidden = true
      if (closeBtn) closeBtn.hidden = false
      setStep('connect', 'pending')
      setStep('upload', 'pending')
      setStep('sync', 'pending')
      run()
    })

    // The Go shell's live step relay (main.go SetSyncEmit → EventsEmit
    // hibana:sync-progress {step, state, detail} — round.go's choreography).
    if (window.runtime && typeof window.runtime.EventsOn === 'function') {
      window.runtime.EventsOn('hibana:sync-progress', function (payload) {
        if (!payload || typeof payload !== 'object') return
        if (!dlg.open) return // a stale event after the modal closed — the round still finishes Go-side
        setStep(payload.step, payload.state, payload.detail || '')
      })
    }

    // Live language flips (i18n.js owns html[lang]) — relabel the surfaces.
    localize()
    try {
      new MutationObserver(localize).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
    } catch (e) { /* no observer — the labels stay at the open-time language */ }
  })
})()
