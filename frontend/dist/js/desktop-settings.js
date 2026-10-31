// desktop-settings.js — the settings page controller (v0.1.17 + the
// v0.1.18 GitHub-access row + the v0.1.19 test-connection round — the owner
// asks: "Plan for a settings page for hibana's desktop" with four sections:
// 1. Sync 2. Update app ("check the latest release of github, if there were
// newer version. update.") 3. Login/logout 4. fa/en + dark mode/light mode).
// The settings page is a COMPOSITION: one wide native dialog opened from the
// toolbar's gear, whose sections delegate to the live, proven rounds. This
// controller owns: the gear → showModal wiring, the live facts (AppInfo's
// version line, AuthState's account line, GithubTokenState's hint line), the
// manual Check-for-updates verdict paint, the GitHub-access row (v0.1.18 —
// Save/Remove over SetGithubToken, Enter-to-save, the connect-now re-check;
// v0.1.19 — the Test button over TestGithubConnection: verify the typed
// candidate / the stored token / the anonymous round, nothing written),
// the two segmented controls (Language through the Go SetLanguage binding;
// Theme through the existing SetTheme with the tray's full 3-state
// vocabulary), the delegation clicks (Sync now / Update now / Sign out → the
// toolbar buttons' own flows, this sheet closing FIRST so the modals never
// stack), and the hibana:lang / hibana:theme / hibana:update-available event
// listeners so the tray, the toolbar, and this sheet always agree.
// GENERATED FILE — do not hand-edit (guide §3.3.4): emitted by scripts/sync-island.mjs
// into frontend/dist/js/ and checksummed in frontend/island.checksums.json.
// Loads blocking, right after desktop-update.js, BEFORE every deferred island
// script.
(function () {
  'use strict'

  // The sealed pin's package version (the sync script interpolates it at emit
  // time — the AppInfo binding carries version + webRef, and the island's own
  // package version rides the web-ref.json the script already knows).
  var PIN_PACKAGE_VERSION = '0.4.1.38'

  // The desktop-owned strings. The title rides the pin's own nav.settings key
  // and Sign out rides nav.signout (both in the markup via data-i18n); every
  // other label is this round's own EN/FA pair (the desktop-update.js STR
  // pattern — the pin's dictionaries carry no desktop-settings keys beyond
  // nav.settings, verified @ the pin).
  var STR = {
    en: {
      btn: 'Settings',
      syncHeading: 'Sync',
      syncBody: "Boards sync on launch and every 5 minutes. A manual round uploads local changes first, then pulls the cloud's truth.",
      syncNow: 'Sync now',
      updateHeading: 'Update app',
      versionLine: 'Hibana {version} · island {ref} (v{pin})',
      statusLatest: "You're on the latest version.",
      statusAvailable: 'Hibana {cur} → {new} is available ({size}).',
      checkBtn: 'Check for updates',
      checkBusy: 'Checking…',
      updateNow: 'Update now',
      statusBusy: 'An update is already in progress.',
      statusUnreachable: "Couldn't reach GitHub — check your connection.",
      notWired: 'The desktop bridge is not wired — restart the app.',
      // v0.1.18 — the GitHub-access row (the owner ask: "hibana desktop
      // might be a private repo so in setting, add a github credentials
      // so it can connect to the private repo").
      tokenLabel: 'GitHub access',
      tokenPlaceholder: 'ghp_… (optional)',
      tokenSave: 'Save',
      tokenRemove: 'Remove',
      tokenSaving: 'Verifying…',
      tokenNone: 'No token — anonymous GitHub access (fine for public repos).',
      tokenSaved: 'Token saved ({hint}) — release checks use it.',
      tokenSavedUnverified: 'Saved ({hint}) — GitHub was unreachable to verify; the next check uses it.',
      tokenRejected: 'GitHub rejected the token — nothing was saved.',
      tokenNoAccess: 'The token cannot see this repository — nothing was saved.',
      tokenCleared: 'Token removed — release checks are anonymous again.',
      tokenInvalid: 'That does not look like a GitHub token (ghp_…).',
      tokenSaveFailed: "Couldn't save the token — try again.",
      // v0.1.19 — the TEST-CONNECTION row (the owner ask: "Yes add a test
      // connection"): one cheap GET /repos/<repo> through the Go
      // TestGithubConnection binding — the typed candidate, the stored
      // token, or the honest anonymous round — with NOTHING written. The
      // using field on the resolve picks the line.
      tokenTest: 'Test',
      tokenTesting: 'Testing…',
      testOkTyped: 'GitHub accepted the token — the repository is visible.',
      testOkSaved: 'The saved token works — GitHub sees the repository.',
      testOkAnon: 'GitHub is reachable and the repository is public — no token needed.',
      testInvalidTyped: 'GitHub rejected this token.',
      testInvalidSaved: 'GitHub rejected the saved token — remove it or paste a new one.',
      testNoAccessToken: 'The token cannot see this repository — check its repository access.',
      testNoAccessAnon: "GitHub can't see the repository without credentials — if it's private, save a token with access.",
      testUnreachable: "Couldn't reach GitHub — check your connection and try again.",
      accountHeading: 'Account',
      accountBody: 'Your boards live safe on the Hibana cloud — sign in again any time.',
      appearanceHeading: 'Appearance',
      langLabel: 'Language',
      langEn: 'English',
      langFa: 'فارسی',
      themeLabel: 'Theme',
      themeLight: 'Light',
      themeDark: 'Dark',
      themeSystem: 'System',
      langUnreachable: "Couldn't reach hibana.ir — the language is unchanged.",
      langSession: 'Your session expired — sign in again.',
      done: 'Done'
    },
    fa: {
      btn: 'تنظیمات',
      syncHeading: 'همگام‌سازی',
      syncBody: 'تخته‌ها هنگام اجرا و هر ۵ دقیقه همگام می‌شوند. یک دور دستی ابتدا تغییرات محلی را بارگذاری می‌کند و سپس حقیقت ابر را می‌گیرد.',
      syncNow: 'همگام‌سازی کن',
      updateHeading: 'بروزرسانی برنامه',
      versionLine: 'هیبانا {version} · جزیره {ref} (v{pin})',
      statusLatest: 'شما روی آخرین نسخه هستید.',
      statusAvailable: 'هیبانا {cur} → {new} در دسترس است ({size}).',
      checkBtn: 'بررسی بروزرسانی',
      checkBusy: 'در حال بررسی…',
      updateNow: 'بروزرسانی کن',
      statusBusy: 'یک بروزرسانی دیگر در جریان است.',
      statusUnreachable: 'اتصال به گیت‌هاب برقرار نشد — اینترنت خود را بررسی کنید.',
      notWired: 'پل دسکتاپ وصل نیست — برنامه را دوباره باز کنید.',
      // v0.1.18 — the GitHub-access row's FA twins.
      tokenLabel: 'دسترسی گیت‌هاب',
      tokenPlaceholder: 'ghp_… (اختیاری)',
      tokenSave: 'ذخیره',
      tokenRemove: 'حذف',
      tokenSaving: 'در حال بررسی…',
      tokenNone: 'توکنی ذخیره نشده — دسترسی ناشناس به گیت‌هاب (برای مخازن عمومی کافی است).',
      tokenSaved: 'توکن ذخیره شد ({hint}) — بررسی بروزرسانی از آن استفاده می‌کند.',
      tokenSavedUnverified: 'ذخیره شد ({hint}) — گیت‌هاب برای تأیید در دسترس نبود؛ بررسی بعدی از آن استفاده می‌کند.',
      tokenRejected: 'گیت‌هاب این توکن را نپذیرفت — چیزی ذخیره نشد.',
      tokenNoAccess: 'این توکن به این مخزن دسترسی ندارد — چیزی ذخیره نشد.',
      tokenCleared: 'توکن حذف شد — بررسی بروزرسانی دوباره ناشناس است.',
      tokenInvalid: 'این شبیه توکن گیت‌هاب نیست (ghp_…).',
      tokenSaveFailed: 'ذخیره توکن ممکن نشد — دوباره تلاش کنید.',
      // v0.1.19 — the TEST-CONNECTION row's FA twins.
      tokenTest: 'تست',
      tokenTesting: 'در حال تست…',
      testOkTyped: 'گیت‌هاب این توکن را پذیرفت — مخزن قابل مشاهده است.',
      testOkSaved: 'توکن ذخیره‌شده کار می‌کند — گیت‌هاب مخزن را می‌بیند.',
      testOkAnon: 'گیت‌هاب در دسترس است و مخزن عمومی است — نیازی به توکن نیست.',
      testInvalidTyped: 'گیت‌هاب این توکن را نپذیرفت.',
      testInvalidSaved: 'گیت‌هاب توکن ذخیره‌شده را نپذیرفت — حذفش کنید یا توکن جدیدی جای آن بگذارید.',
      testNoAccessToken: 'این توکن به این مخزن دسترسی ندارد — دسترسی مخزن آن را بررسی کنید.',
      testNoAccessAnon: 'گیت‌هاب بدون اعتبارنامه مخزن را نمی‌بیند — اگر خصوصی است، توکنی با دسترسی ذخیره کنید.',
      testUnreachable: 'اتصال به گیت‌هاب برقرار نشد — اینترنت خود را بررسی کنید و دوباره تلاش کنید.',
      accountHeading: 'حساب',
      accountBody: 'تخته‌های شما در ابر هیبانا امن هستند — هر وقت خواستید دوباره وارد شوید.',
      appearanceHeading: 'ظاهر',
      langLabel: 'زبان',
      langEn: 'English',
      langFa: 'فارسی',
      themeLabel: 'پوسته',
      themeLight: 'روشن',
      themeDark: 'تیره',
      themeSystem: 'سیستم',
      langUnreachable: 'اتصال به hibana.ir برقرار نشد — زبان تغییر نکرد.',
      langSession: 'نشست شما منقضی شده — دوباره وارد شوید.',
      done: 'انجام شد'
    }
  }

  function lang() { return document.documentElement.lang === 'fa' ? 'fa' : 'en' }
  function t(key) { return (STR[lang()] && STR[lang()][key]) || STR.en[key] || key }
  function fmt(key, map) {
    var s = t(key)
    for (var k in map) s = s.split('{' + k + '}').join(String(map[k]))
    return s
  }

  // The bridge resolver — the same defensive chain desktop-update.js /
  // desktop-sync.js / desktop-theme.js use (all generated + drift-controlled;
  // the duplication is by design).
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

  // fmtSize — the update modal's own honest MB round (under 10: one decimal).
  function fmtSize(bytes) {
    var n = Number(bytes)
    if (!(n > 0)) return ''
    var mb = n / (1024 * 1024)
    return (mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10) + ' MB'
  }

  ready(function () {
    var gear = document.getElementById('db-settings-button')
    var dlg = document.getElementById('db-settings-dialog')
    if (!gear || !dlg || typeof dlg.showModal !== 'function') return

    var els = {
      version: document.getElementById('db-settings-version'),
      updateStatus: document.getElementById('db-settings-update-status'),
      updateError: document.getElementById('db-settings-update-error'),
      updateNow: document.getElementById('db-settings-update-now'),
      check: document.getElementById('db-settings-check'),
      tokenInput: document.getElementById('db-settings-token-input'),
      tokenTest: document.getElementById('db-settings-token-test'),
      tokenSave: document.getElementById('db-settings-token-save'),
      tokenRemove: document.getElementById('db-settings-token-clear'),
      tokenStatus: document.getElementById('db-settings-token-status'),
      tokenError: document.getElementById('db-settings-token-error'),
      account: document.getElementById('db-settings-account'),
      langError: document.getElementById('db-settings-lang-error'),
      langEn: document.getElementById('db-settings-lang-en'),
      langFa: document.getElementById('db-settings-lang-fa'),
      themeLight: document.getElementById('db-settings-theme-light'),
      themeDark: document.getElementById('db-settings-theme-claude-dark'),
      themeSystem: document.getElementById('db-settings-theme-system')
    }

    // The Go shell's last check verdict (display state — the Update-now
    // delegation re-earns everything in the proven modal). null = no check
    // has landed this boot: the status line claims NOTHING (an unchecked app
    // is not "latest" — the auto-update honesty rule).
    var updateVerdict = null
    var checking = false
    var langFlipping = false

    // v0.1.18 — the GitHub-access row's own state: null = the GithubTokenState
    // round has not landed (the same claim-nothing honesty); {set, hint}
    // after it does. The token VALUE never lives here — it crosses the
    // bridge inside the Save click and dies with it.
    var tokenState = null
    var tokenBusy = false

    function setText(id, text) { var el = document.getElementById(id); if (el) el.textContent = text }

    // ---- localization (every label this controller owns; the title, the
    //      gear's aria/title, and Sign out ride the pin's own keys) ----
    function localize() {
      gear.setAttribute('aria-label', t('btn'))
      gear.setAttribute('title', t('btn'))
      setText('db-settings-sync-heading', t('syncHeading'))
      setText('db-settings-sync-body', t('syncBody'))
      setText('db-settings-sync-now-label', t('syncNow'))
      setText('db-settings-update-heading', t('updateHeading'))
      setText('db-settings-check-label', t('checkBtn'))
      setText('db-settings-update-now-label', t('updateNow'))
      setText('db-settings-token-label', t('tokenLabel'))
      setText('db-settings-token-save-label', t('tokenSave'))
      setText('db-settings-token-test-label', t('tokenTest'))
      setText('db-settings-token-clear-label', t('tokenRemove'))
      if (els.tokenInput) {
        els.tokenInput.setAttribute('placeholder', t('tokenPlaceholder'))
        els.tokenInput.setAttribute('aria-label', t('tokenLabel'))
      }
      setText('db-settings-account-heading', t('accountHeading'))
      setText('db-settings-account-body', t('accountBody'))
      setText('db-settings-appearance-heading', t('appearanceHeading'))
      setText('db-settings-lang-label', t('langLabel'))
      setText('db-settings-theme-label', t('themeLabel'))
      if (els.langEn) els.langEn.textContent = t('langEn')
      if (els.langFa) els.langFa.textContent = t('langFa')
      if (els.themeLight) els.themeLight.textContent = t('themeLight')
      if (els.themeDark) els.themeDark.textContent = t('themeDark')
      if (els.themeSystem) els.themeSystem.textContent = t('themeSystem')
      setText('db-settings-done-label', t('done'))
      if (versionInfo) paintVersion()
      if (accountInfo) paintAccount()
    }

    // ---- the live facts (resolved at OPEN time — the v0.1.1 parse-time
    //      snapshot lesson) ----
    var versionInfo = null
    var accountInfo = null

    function paintVersion() {
      if (!versionInfo || !els.version) return
      els.version.textContent = fmt('versionLine', {
        version: String(versionInfo.version || ''),
        ref: String(versionInfo.webRef || ''),
        pin: PIN_PACKAGE_VERSION
      })
    }

    function paintAccount() {
      if (!els.account || !accountInfo) return
      var name = String(accountInfo.username || '')
      var email = String(accountInfo.email || '')
      els.account.textContent = name && name !== email ? name + ' · ' + email : email
    }

    function resolveLive() {
      var appInfo = resolveBoundMethod('AppInfo')
      if (appInfo) {
        try {
          Promise.resolve(appInfo()).then(function (info) {
            versionInfo = info && typeof info === 'object' ? info : null
            paintVersion()
          }, function () {})
        } catch (e) {}
      }
      var authState = resolveBoundMethod('AuthState')
      if (authState) {
        try {
          Promise.resolve(authState()).then(function (st) {
            accountInfo = st && st.authenticated && st.user ? st.user : null
            paintAccount()
          }, function () {})
        } catch (e) {}
      }
      // v0.1.18 — the GitHub-access row's display state ({set, hint}); the
      // verdict's own copy rides the Save resolve.
      resolveTokenState()
    }

    // ---- SECTION 2's status line + the Update-now reveal ----
    function paintUpdateStatus() {
      if (els.updateStatus) {
        if (updateVerdict && updateVerdict.available) {
          els.updateStatus.textContent = fmt('statusAvailable', {
            cur: String(updateVerdict.current || ''),
            new: String(updateVerdict.latest || ''),
            size: fmtSize(updateVerdict.size)
          })
        } else if (updateVerdict) {
          els.updateStatus.textContent = t('statusLatest')
        } else {
          els.updateStatus.textContent = ''
        }
      }
      if (els.updateNow) els.updateNow.hidden = !(updateVerdict && updateVerdict.available)
    }

    function showUpdateError(msg) {
      if (els.updateError) { els.updateError.textContent = msg; els.updateError.hidden = false }
    }
    function hideUpdateError() { if (els.updateError) els.updateError.hidden = true }
    function showLangError(msg) {
      if (els.langError) { els.langError.textContent = msg; els.langError.hidden = false }
    }
    function hideLangError() { if (els.langError) els.langError.hidden = true }

    // ---- THE DELEGATION (the plan §1.3): this sheet closes FIRST, then the
    //      proven toolbar button's own click handler opens its modal — the
    //      modals never stack, zero new flows. ----
    function delegate(id) {
      if (dlg.open) dlg.close()
      var el = document.getElementById(id)
      if (el) el.click()
    }

    var syncNowBtn = document.getElementById('db-settings-sync-now')
    if (syncNowBtn) syncNowBtn.addEventListener('click', function () { delegate('db-sync-button') })
    if (els.updateNow) els.updateNow.addEventListener('click', function () { delegate('db-update-button') })
    var signoutBtn = document.getElementById('db-settings-signout')
    if (signoutBtn) signoutBtn.addEventListener('click', function () { delegate('db-logout-button') })
    var doneBtn = document.getElementById('db-settings-done')
    if (doneBtn) doneBtn.addEventListener('click', function () { dlg.close() })

    // ---- SECTION 2's manual check (the auto-update loop keeps its boot+2h
    //      cadence untouched; this row is the manual trigger + the idle-time
    //      surface the owner asked for). The honest verdicts: available /
    //      latest / busy / unreachable — never a claim that was not earned. ----
    function onCheckDone(res) {
      checking = false
      if (els.check) els.check.disabled = false
      if (!res || typeof res !== 'object') res = {}
      updateVerdict = res
      hideUpdateError()
      paintUpdateStatus()
    }

    function onCheckFail(err) {
      checking = false
      if (els.check) els.check.disabled = false
      updateVerdict = null
      if (els.updateStatus) els.updateStatus.textContent = ''
      var msg = (err && (err.message || String(err))) || ''
      // The busy guard rejects with "already running" — the honest busy line,
      // never the can't-reach line (a check DID happen; it was refused).
      if (/already running|already in progress/i.test(msg)) showUpdateError(t('statusBusy'))
      else showUpdateError(t('statusUnreachable'))
    }

    if (els.check) els.check.addEventListener('click', function () {
      if (checking) return
      var check = resolveBoundMethod('CheckForUpdates')
      hideUpdateError()
      if (!check) { showUpdateError(t('notWired')); return }
      checking = true
      els.check.disabled = true
      if (els.updateStatus) els.updateStatus.textContent = t('checkBusy')
      try {
        Promise.resolve(check()).then(onCheckDone, onCheckFail)
      } catch (e) { onCheckFail(e) }
    })

    // ---- SECTION 2's GitHub-access row (v0.1.18 — the owner ask: "hibana
    //      desktop might be a private repo so in setting, add a github
    //      credentials so it can connect to the private repo"). The row is
    //      a PASSWORD input + Save/Remove over the Go SetGithubToken /
    //      GithubTokenState bindings: the token crosses the bridge ONCE
    //      (the login password's discipline — never stored JS-side, never
    //      in localStorage, the field cleared on every resolve); only the
    //      ghp_…ABCD hint ever crosses back. A SAVED token immediately
    //      re-checks (the row's whole point — connect now), riding the
    //      manual-check flow above through its own click handler. ----
    function showTokenError(msg) {
      if (els.tokenError) { els.tokenError.textContent = msg; els.tokenError.hidden = false }
    }
    function hideTokenError() { if (els.tokenError) els.tokenError.hidden = true }

    function paintToken() {
      if (els.tokenStatus) {
        if (tokenState == null) els.tokenStatus.textContent = ''
        else if (tokenState.set) els.tokenStatus.textContent = fmt('tokenSaved', { hint: String(tokenState.hint || '') })
        else els.tokenStatus.textContent = t('tokenNone')
      }
      if (els.tokenRemove) els.tokenRemove.hidden = !(tokenState && tokenState.set)
    }

    function resolveTokenState(after) {
      var state = resolveBoundMethod('GithubTokenState')
      if (!state) { if (after) after(); return }
      try {
        Promise.resolve(state()).then(function (s) {
          tokenState = s && typeof s === 'object' && s.set
            ? { set: true, hint: String(s.hint || '') }
            : { set: false, hint: '' }
          paintToken()
          if (after) after()
        }, function () { if (after) after() })
      } catch (e) { if (after) after() }
    }

    function setTokenBusy(on) {
      tokenBusy = on
      if (els.tokenTest) els.tokenTest.disabled = on
      if (els.tokenSave) els.tokenSave.disabled = on
      if (els.tokenRemove) els.tokenRemove.disabled = on
    }

    function onTokenSaveDone(res) {
      setTokenBusy(false)
      hideTokenError()
      if (!res || typeof res !== 'object') res = {}
      if (res.cleared) {
        if (els.tokenInput) els.tokenInput.value = ''
        tokenState = { set: false, hint: '' }
        paintToken()
        if (els.tokenStatus) els.tokenStatus.textContent = t('tokenCleared')
        return
      }
      if (res.ok && res.saved) {
        // The field never keeps the secret — the value lives Go-side only.
        if (els.tokenInput) els.tokenInput.value = ''
        var unverified = !res.verified
        resolveTokenState(function () {
          if (unverified && tokenState && tokenState.set && els.tokenStatus) {
            els.tokenStatus.textContent = fmt('tokenSavedUnverified', { hint: String(tokenState.hint || '') })
          } else {
            paintToken()
          }
        })
        // THE CONNECT-NOW REFLEX — the row's whole point: a saved token is
        // used by the very next check, so fire one immediately through the
        // manual-check flow's own handler (busy/disable/verdict paint all
        // reused; a check already in flight is simply left alone).
        if (els.check && !checking) { try { els.check.click() } catch (e) {} }
        return
      }
      var code = String(res.code || '')
      // The verdict's failure paths RESTORE the status line to the stored
      // state's truth (the probe caught the stuck "Verifying…" — a refused
      // save must never leave the busy line on screen).
      paintToken()
      if (code === 'invalid') showTokenError(t('tokenRejected'))
      else if (code === 'no_access') showTokenError(t('tokenNoAccess'))
      else if (code === 'not_wired') showTokenError(t('notWired'))
      else showTokenError(t('tokenSaveFailed'))
    }

    // The ONLY rejected promise this binding returns is the malformed-shape
    // refusal (errBadGithubToken) — the catch paints the shape line. The
    // status line restores the stored truth (nothing was saved).
    function onTokenSaveFail() {
      setTokenBusy(false)
      hideTokenError()
      paintToken()
      showTokenError(t('tokenInvalid'))
    }

    if (els.tokenSave) els.tokenSave.addEventListener('click', function () {
      if (tokenBusy) return
      var value = els.tokenInput ? String(els.tokenInput.value || '') : ''
      hideTokenError()
      if (!value) return // nothing to save — Remove is the clear path
      var save = resolveBoundMethod('SetGithubToken')
      if (!save) { showTokenError(t('notWired')); return }
      setTokenBusy(true)
      if (els.tokenStatus) els.tokenStatus.textContent = t('tokenSaving')
      try {
        Promise.resolve(save(value)).then(onTokenSaveDone, onTokenSaveFail)
      } catch (e) { onTokenSaveFail() }
    })

    if (els.tokenRemove) els.tokenRemove.addEventListener('click', function () {
      if (tokenBusy) return
      var save = resolveBoundMethod('SetGithubToken')
      if (!save) { showTokenError(t('notWired')); return }
      hideTokenError()
      if (els.tokenInput) els.tokenInput.value = ''
      setTokenBusy(true)
      if (els.tokenStatus) els.tokenStatus.textContent = t('tokenSaving')
      try {
        Promise.resolve(save('')).then(onTokenSaveDone, onTokenSaveFail) // "" = the Go clear contract
      } catch (e) { onTokenSaveFail() }
    })

    // ---- THE TEST-CONNECTION ROUND (v0.1.19 — the owner ask: "Yes add a
    //      test connection"). One cheap GET /repos/<repo> through the Go
    //      TestGithubConnection binding: the FIELD's value when one is
    //      typed (verify-before-save — nothing is written), else the
    //      STORED token, else the honest anonymous round — the exact
    //      credential mix the next release check would ride. The field is
    //      NEVER cleared by a test (only Save clears it — the value stays
    //      for the Save click the verdict invites); no connect-now re-check
    //      either (a test changes no state). The resolve's using field
    //      picks the line: typed / saved / anonymous. ----
    function onTestDone(res) {
      setTokenBusy(false)
      hideTokenError()
      if (!res || typeof res !== 'object') res = {}
      var using = String(res.using || (tokenState && tokenState.set ? 'saved' : 'anonymous'))
      if (res.ok) {
        if (els.tokenStatus) {
          els.tokenStatus.textContent = using === 'typed' ? t('testOkTyped')
            : using === 'saved' ? t('testOkSaved')
            : t('testOkAnon')
        }
        return
      }
      // The failure verdicts: the stored truth restores on the status line
      // (a test never changed it) and the error line carries the verdict.
      paintToken()
      var code = String(res.code || '')
      if (code === 'invalid') showTokenError(using === 'saved' ? t('testInvalidSaved') : t('testInvalidTyped'))
      else if (code === 'no_access') showTokenError(using === 'anonymous' ? t('testNoAccessAnon') : t('testNoAccessToken'))
      else if (code === 'not_wired') showTokenError(t('notWired'))
      else showTokenError(t('testUnreachable'))
    }

    // The only rejected promise is the malformed-shape refusal — the catch
    // paints the shape line (the SetGithubToken discipline).
    function onTestFail() {
      setTokenBusy(false)
      hideTokenError()
      paintToken()
      showTokenError(t('tokenInvalid'))
    }

    if (els.tokenTest) els.tokenTest.addEventListener('click', function () {
      if (tokenBusy) return
      var test = resolveBoundMethod('TestGithubConnection')
      if (!test) { showTokenError(t('notWired')); return }
      hideTokenError()
      var value = els.tokenInput ? String(els.tokenInput.value || '') : ''
      setTokenBusy(true)
      if (els.tokenStatus) els.tokenStatus.textContent = t('tokenTesting')
      try {
        Promise.resolve(test(value)).then(onTestDone, onTestFail)
      } catch (e) { onTestFail() }
    })

    // Enter in the field SAVES — a method="dialog" form would otherwise
    // swallow the keypress as a submit (closing the sheet mid-save).
    if (els.tokenInput) els.tokenInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault()
        if (els.tokenSave && !tokenBusy) els.tokenSave.click()
      }
    })

    // ---- SECTION 4's segmented controls ----
    function currentLang() {
      var l = document.documentElement.getAttribute('data-desktop-lang')
      if (l !== 'en' && l !== 'fa') l = document.documentElement.lang === 'fa' ? 'fa' : 'en'
      return l
    }

    function currentTheme() {
      var p = document.documentElement.getAttribute('data-desktop-theme')
      return p === 'light' || p === 'claude-dark' || p === 'system' ? p : 'system'
    }

    // The tray-radio grammar: the active state IS aria-pressed (css/
    // desktop-settings.css branches on it).
    function setSeg(btn, active) {
      if (!btn) return
      btn.setAttribute('aria-pressed', active ? 'true' : 'false')
    }

    function paintLangSeg() {
      var cur = currentLang()
      setSeg(els.langEn, cur === 'en')
      setSeg(els.langFa, cur === 'fa')
    }

    function paintThemeSeg() {
      var cur = currentTheme()
      setSeg(els.themeLight, cur === 'light')
      setSeg(els.themeDark, cur === 'claude-dark')
      setSeg(els.themeSystem, cur === 'system')
    }

    // THE LANGUAGE FLIP (the plan §2.3 — the round's one new capability):
    // on {ok:true} the chrome flips LIVE for immediate feedback (html[lang]/
    // [dir], then hibanaI18n.apply() re-reads the Go-side un-staled
    // __hibanaMe, lazy-loads the FA dict, injects Vazir, and sweeps
    // [data-i18n]), the sheet closes, and the ~700ms reload re-renders the
    // BOARD in the new language (i18n.js's dynamic-markup law — a live-only
    // flip would leave the rendered board behind). On failure the control
    // STAYS PUT (the server never moved) and the line says why.
    function onLangDone(res, next) {
      langFlipping = false
      if (res && res.ok) {
        document.documentElement.setAttribute('data-desktop-lang', next)
        document.documentElement.setAttribute('lang', next)
        document.documentElement.setAttribute('dir', next === 'fa' ? 'rtl' : 'ltr')
        if (window.hibanaI18n && typeof window.hibanaI18n.apply === 'function') {
          try { window.hibanaI18n.apply() } catch (e) {}
        }
        paintLangSeg()
        if (dlg.open) dlg.close() // the reload lands on the board, not a modal
        setTimeout(function () { location.reload() }, 700)
        return
      }
      var msg = res && res.message ? String(res.message) : ''
      if (msg.indexOf('session expired') !== -1) showLangError(t('langSession'))
      else showLangError(t('langUnreachable'))
      paintLangSeg()
    }

    function onLangPick(ev) {
      var btn = ev.currentTarget
      var next = btn.getAttribute('data-seg-lang')
      if (!next || (next !== 'en' && next !== 'fa') || next === currentLang() || langFlipping) return
      hideLangError()
      var setLanguage = resolveBoundMethod('SetLanguage')
      if (!setLanguage) { showLangError(t('notWired')); return }
      langFlipping = true
      try {
        Promise.resolve(setLanguage(next)).then(function (res) { onLangDone(res, next) }, function () { onLangDone(null, next) })
      } catch (e) { onLangDone(null, next) }
    }

    if (els.langEn) els.langEn.addEventListener('click', onLangPick)
    if (els.langFa) els.langFa.addEventListener('click', onLangPick)

    // The theme flip — desktop-theme.js's own optimistic discipline: the live
    // document flips FIRST (the Go persist can never make the toggle feel
    // broken), the segmented state follows, and the SetTheme resolve is
    // belt-only. 'system' resolves the OS scheme exactly the way the boot
    // bootstrap does.
    function resolveTheme(p) {
      if (p === 'light' || p === 'claude-dark') return p
      try { return matchMedia('(prefers-color-scheme: dark)').matches ? 'claude-dark' : 'light' } catch (e) { return 'light' }
    }

    function onThemePick(ev) {
      var btn = ev.currentTarget
      var next = btn.getAttribute('data-seg-theme')
      if (!next || (next !== 'light' && next !== 'claude-dark' && next !== 'system') || next === currentTheme()) return
      document.documentElement.setAttribute('data-desktop-theme', next)
      document.documentElement.dataset.theme = resolveTheme(next)
      paintThemeSeg()
      var setTheme = resolveBoundMethod('SetTheme')
      if (setTheme) {
        try { setTheme(next).catch(function () {}) } catch (e) {}
      }
    }

    if (els.themeLight) els.themeLight.addEventListener('click', onThemePick)
    if (els.themeDark) els.themeDark.addEventListener('click', onThemePick)
    if (els.themeSystem) els.themeSystem.addEventListener('click', onThemePick)

    // ---- THE GO SHELL'S RELAYS (main.go's emit wiring): the tray and this
    //      sheet must agree on both segmented controls, and the update loop's
    //      verdict reaches the status line the same way the pill does. ----
    if (window.runtime && typeof window.runtime.EventsOn === 'function') {
      window.runtime.EventsOn('hibana:theme', function (payload) {
        var p = payload
        if (p && typeof p === 'object') p = p.pref || ''
        if (p !== 'light' && p !== 'claude-dark' && p !== 'system') p = 'system'
        document.documentElement.setAttribute('data-desktop-theme', p)
        paintThemeSeg()
      })
      window.runtime.EventsOn('hibana:lang', function (payload) {
        var l = payload
        if (l && typeof l === 'object') l = l.lang || ''
        if (l !== 'en' && l !== 'fa') return
        document.documentElement.setAttribute('data-desktop-lang', l)
        paintLangSeg()
      })
      window.runtime.EventsOn('hibana:update-available', function (payload) {
        if (!payload || typeof payload !== 'object') return
        updateVerdict = payload
        paintUpdateStatus()
      })
    }

    // ---- the gear ----
    function openSheet() {
      localize()
      paintUpdateStatus()
      paintLangSeg()
      paintThemeSeg()
      resolveLive()
      dlg.showModal()
    }
    gear.addEventListener('click', openSheet)

    // Live language flips (i18n.js owns html[lang]) — relabel the surfaces.
    localize()
    paintLangSeg()
    paintThemeSeg()
    try {
      new MutationObserver(localize).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
    } catch (e) { /* no observer — the labels stay at the boot language */ }
  })
})()
