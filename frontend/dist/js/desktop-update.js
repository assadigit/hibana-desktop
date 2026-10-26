// desktop-update.js — the auto-update round (v0.1.14 — the owner ask: "Add an
// auto update for the app. when the new version releases in the github, app
// syncs with the internet and github, and if new version, whether portable
// or installer released, show a button for update. it must update from
// github and replace without losing data or needing user to re login.").
// The Go shell checks github.com/assadigit/hibana-desktop/releases/latest at
// boot + every 2h (main.go updateLoop); THIS controller is the island half:
// the toolbar Update pill (HIDDEN until a newer release exists — the
// hibana:update-available event) + the update modal (version line, the
// asset kind + size, the live progress bar on hibana:update-progress, and
// the restarting panel on {ok:true} — the app quits ~1.5s after that resolve,
// so NO reload here: the Go process restarts the whole island instead).
// GENERATED FILE — do not hand-edit (guide §3.3.4): emitted by scripts/sync-island.mjs
// into frontend/dist/js/ and checksummed in frontend/island.checksums.json. Loads
// blocking, right after desktop-refresh.js, BEFORE every deferred island script.
(function () {
  'use strict'

  // The desktop-owned strings. The pin's dictionaries carry no update key
  // (verified @ the pin), so this EN/FA pair is the round's own; i18n.js
  // owns html[lang], and localize() reads it live.
  var STR = {
    en: {
      btn: 'Update Hibana now',
      label: 'Update',
      title: 'A new version is available',
      version: 'Hibana {cur} → {new}',
      kindPortable: 'Portable update — {size} from GitHub',
      kindInstaller: 'Installer update — {size} from GitHub',
      dataNote: 'Your boards and your sign-in stay exactly as they are — Hibana just restarts into the new version.',
      download: 'Downloading — {pct}%',
      verify: 'Verifying the download…',
      restartingTitle: 'Update ready — restarting…',
      restartingBody: 'Hibana {v} is installed. The app restarts in a moment — your boards and your sign-in stay as they are.',
      later: 'Later',
      go: 'Update now',
      errTitle: 'Update failed',
      notWired: 'The desktop bridge is not wired — restart the app.',
      busy: 'An update is already in progress.',
      noUpdate: 'No update is available right now.',
      // v0.1.19 — the manual-fallback note (the owner ask: "auto-open
      // release page when an apply fails"): the Go bridge opened the
      // release's human page in the system browser and flagged the resolve
      // {pageOpened:true}; this line says so, and paints ONLY on that flag.
      pageOpened: 'The release page opened in your browser — you can download and install this version by hand.'
    },
    fa: {
      btn: 'بروزرسانی هیبانا',
      label: 'نسخهٔ جدید',
      title: 'نسخهٔ جدید در دسترس است',
      version: 'هیبانا {cur} → {new}',
      kindPortable: 'بروزرسانی پرتابل — {size} از گیت‌هاب',
      kindInstaller: 'بروزرسانی نصبی — {size} از گیت‌هاب',
      dataNote: 'تخته‌ها و نشست شما دقیقاً همان‌طور می‌مانند — هیبانا فقط به نسخهٔ جدید بازراه‌اندازی می‌شود.',
      download: 'در حال دانلود — {pct}٪',
      verify: 'در حال بررسی دانلود…',
      restartingTitle: 'بروزرسانی آماده است — در حال بازراه‌اندازی…',
      restartingBody: 'هیبانا {v} نصب شد. برنامه یک لحظه دیگر دوباره باز می‌شود — تخته‌ها و نشست شما همان‌طور می‌مانند.',
      later: 'بعداً',
      go: 'بروزرسانی کن',
      errTitle: 'بروزرسانی ناموفق بود',
      notWired: 'پل دسکتاپ وصل نیست — برنامه را دوباره باز کنید.',
      busy: 'یک بروزرسانی دیگر در جریان است.',
      noUpdate: 'در حال حاضر بروزرسانی‌ای در دسترس نیست.',
      // v0.1.19 — the manual-fallback note's FA twin.
      pageOpened: 'صفحهٔ انتشار در مرورگر شما باز شد — می‌توانید این نسخه را دستی دانلود و نصب کنید.'
    }
  }

  function lang() { return document.documentElement.lang === 'fa' ? 'fa' : 'en' }
  function t(key) { return (STR[lang()] && STR[lang()][key]) || STR.en[key] || key }
  function fmt(key, map) {
    var s = t(key)
    for (var k in map) s = s.split('{' + k + '}').join(String(map[k]))
    return s
  }

  // The bridge resolver — the same defensive chain desktop-sync.js/-theme.js
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

  // fmtSize paints the release asset size the way the island paints counts —
  // honest MB with one decimal under 10.
  function fmtSize(bytes) {
    var n = Number(bytes)
    if (!(n > 0)) return ''
    var mb = n / (1024 * 1024)
    return (mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10) + ' MB'
  }

  ready(function () {
    var btn = document.getElementById('db-update-button')
    var dlg = document.getElementById('db-update-dialog')
    if (!btn || !dlg || typeof dlg.showModal !== 'function') return

    var btnLabel = document.getElementById('db-update-btn-label')
    var versionEl = document.getElementById('db-update-version')
    var kindEl = document.getElementById('db-update-kind')
    var bodyEl = document.getElementById('db-update-body')
    var progress = document.getElementById('db-update-progress')
    var fill = document.getElementById('db-update-fill')
    var note = document.getElementById('db-update-note')
    var panel = document.getElementById('db-update-panel')
    var panelTitle = document.getElementById('db-update-panel-title')
    var panelBody = document.getElementById('db-update-panel-body')
    var errEl = document.getElementById('db-update-error')
    // v0.1.19 — the manual-fallback line under the error (the release page
    // the Go bridge opened in the browser on a failed apply).
    var fallEl = document.getElementById('db-update-fallback')
    var laterBtn = document.getElementById('db-update-later')
    var goBtn = document.getElementById('db-update-go')

    // The Go shell's last check verdict — set by hibana:update-available,
    // consumed by the modal intro. null = no update exists yet (the pill
    // stays hidden; the modal is unreachable — there is nothing to offer).
    var info = null
    var applying = false

    function localize() {
      btn.setAttribute('aria-label', t('btn'))
      btn.setAttribute('title', t('btn'))
      if (btnLabel) btnLabel.textContent = t('label')
      setText('db-update-title', t('title'))
      if (laterBtn) laterBtn.textContent = t('later')
      if (goBtn) goBtn.textContent = t('go')
      if (info) paintIntro()
    }

    function setText(id, text) { var el = document.getElementById(id); if (el) el.textContent = text }

    function paintIntro() {
      if (!info) return
      if (versionEl) versionEl.textContent = fmt('version', { cur: info.current, new: info.latest })
      if (kindEl) {
        var size = fmtSize(info.size)
        kindEl.textContent = info.kind === 'installer'
          ? fmt('kindInstaller', { size: size })
          : fmt('kindPortable', { size: size })
      }
      if (bodyEl) bodyEl.textContent = t('dataNote')
      if (progress) progress.hidden = true
      if (panel) panel.hidden = true
      if (errEl) errEl.hidden = true
      if (fallEl) fallEl.hidden = true // a fresh intro never carries a stale fallback note
      if (laterBtn) laterBtn.hidden = false
      if (goBtn) { goBtn.hidden = false; goBtn.disabled = false }
    }

    function showPill() { btn.hidden = false }

    function openModal() {
      localize() // the FA/RTL flip lands before the intro paints
      paintIntro()
      dlg.showModal()
    }

    // The live bar: stage download paints the fill + the honest percent;
    // verify pins 100% + the verifying note. The fill sizes via the PHYSICAL
    // width (the probe's own lesson: a Chromium fill driven through the
    // logical inline-size never renders — width does); the LOGICAL anchor
    // keeps the RTL mirror correct. An indeterminate server (no
    // Content-Length) sends pct 0 — the note stays honest at 0% while the
    // bytes count Go-side.
    function setStage(stage, pct) {
      if (!progress || !fill || !note) return
      progress.hidden = false
      progress.setAttribute('data-stage', stage)
      if (stage === 'verify') {
        fill.style.width = '100%'
        note.textContent = t('verify')
      } else {
        var p = Math.max(0, Math.min(100, pct))
        fill.style.width = p + '%'
        note.textContent = fmt('download', { pct: p })
      }
    }

    function showError(msg, pageOpened) {
      if (progress) progress.hidden = true
      if (errEl) { errEl.textContent = t('errTitle') + ' — ' + msg; errEl.hidden = false }
      // The fallback note paints ONLY on the resolve's own pageOpened flag —
      // a machine where the open could not happen never hears that it did.
      if (fallEl) {
        if (pageOpened) { fallEl.textContent = t('pageOpened'); fallEl.hidden = false }
        else fallEl.hidden = true
      }
      if (laterBtn) laterBtn.hidden = false
      if (goBtn) { goBtn.hidden = false; goBtn.disabled = false }
    }

    function onDone(out) {
      applying = false
      if (!out || typeof out !== 'object') out = {}
      if (out.ok) {
        // The helper is spawned Go-side; the app quits ~1.5s after this
        // resolve. The panel is the last thing on screen — and NO reload
        // here: the whole island restarts with the new exe, and the data
        // dir (session + mirror) rides through untouched.
        if (progress) progress.hidden = true
        if (errEl) errEl.hidden = true
        if (fallEl) fallEl.hidden = true
        if (laterBtn) laterBtn.hidden = true
        if (goBtn) goBtn.hidden = true
        if (panel) {
          panel.setAttribute('data-kind', 'ok')
          if (panelTitle) panelTitle.textContent = t('restartingTitle')
          if (panelBody) panelBody.textContent = fmt('restartingBody', { v: info ? info.latest : '' })
          panel.hidden = false
        }
        return
      }
      // The honest verdicts: busy / no-update / a real Go error message.
      // A FAILURE carries the Go resolve's own pageOpened flag (v0.1.19 —
      // the bridge opened the release page in the browser; the note says
      // so), while busy and no-update resolve Go-side without the flag and
      // never paint it.
      var msg = out.message || ''
      if (msg === 'busy') msg = t('busy')
      else if (msg.indexOf('no update') === 0) msg = t('noUpdate')
      else if (!msg) msg = t('notWired')
      showError(msg, !!(out && out.pageOpened))
    }

    function onReject() {
      applying = false
      showError(t('notWired'), false)
    }

    function run() {
      if (applying) return
      applying = true
      if (errEl) errEl.hidden = true
      if (fallEl) fallEl.hidden = true // every fresh round starts with a clean slate
      if (laterBtn) laterBtn.hidden = false
      if (goBtn) goBtn.disabled = true
      setStage('download', 0) // visible from the first frame of the round
      var apply = resolveBoundMethod('ApplyUpdate')
      if (!apply) { onReject(); return }
      try {
        Promise.resolve(apply()).then(onDone, onReject)
      } catch (e) { onReject() }
    }

    btn.addEventListener('click', openModal)
    if (goBtn) goBtn.addEventListener('click', run)
    if (laterBtn) laterBtn.addEventListener('click', function () { dlg.close() })

    // THE GO SHELL'S RELAYS (main.go SetUpdateEmit → EventsEmit):
    // hibana:update-available reveals the pill (and repaints an open modal's
    // intro with the fresh facts); hibana:update-progress paints the bar —
    // only while the modal is open (a stale tick after Later closes is a
    // no-op; the round finishes Go-side and the staged bytes clean
    // themselves on the next round).
    if (window.runtime && typeof window.runtime.EventsOn === 'function') {
      window.runtime.EventsOn('hibana:update-available', function (payload) {
        if (!payload || typeof payload !== 'object') return
        info = {
          current: String(payload.current || ''),
          latest: String(payload.latest || ''),
          kind: String(payload.kind || 'portable'),
          size: Number(payload.size) || 0,
          notes: String(payload.notes || ''),
          url: String(payload.url || '')
        }
        showPill()
        if (dlg.open) paintIntro()
      })
      window.runtime.EventsOn('hibana:update-progress', function (payload) {
        if (!payload || typeof payload !== 'object' || !dlg.open) return
        var stage = String(payload.stage || 'download')
        var pct = Math.max(0, Math.min(100, Number(payload.pct) || 0))
        setStage(stage, pct)
      })
    }

    // Live language flips (i18n.js owns html[lang]) — relabel the surfaces.
    localize()
    try {
      new MutationObserver(localize).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
    } catch (e) { /* no observer — the labels stay at the boot language */ }
  })
})()
