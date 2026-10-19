// i18n + calendar layer (spec §14 — Phase 3/5). Language & calendar prefs live on the user
// record. Server-rendered htmx fragments are already translated server-side (src/lib/i18n.ts);
// this script handles the static chrome (nav, headings, labels, JS-built strings) on the client:
//   - [data-i18n]             text content        e.g. <h1 data-i18n="pages.projects">
//   - [data-i18n-placeholder] placeholder attr     e.g. <input data-i18n-placeholder="filter.search">
//   - [data-i18n-title]       title attr
// Plus Vazir font injection + absolute-date calendar conversion ([data-date], UTC in storage).
// t('key') is the programmatic lookup used by app.js/queue.js/Alpine toasts & the quick-add modal.
// NOTE (S45/S1): apply() scans the STATIC DOM only — dynamically injected markup is
// NEVER re-scanned. JS that builds DOM must translate at RENDER time via t() (the
// sprint page's renderSide/popovers were the bug that proved this law).

window.hibanaI18n = (() => {
  // P2 (Focus 2): dict.fa is loaded lazily — EN users never download i18n-fa.js (17KB gz).
  // When apply() resolves to fa, ensureFaDict() injects /js/i18n-fa.js?v=94 dynamically and
  // awaits it. The build pipeline's fixpoint loop rewrites the path to /dist/i18n-fa.<hash>.js.
  const dict = {
    en: window.__hibanaDictEN,
    fa: window.__hibanaDictFA || null, // null until ensureFaDict() loads it
  }

  let lang = 'en'
  let cal = 'gregorian'
  let tz = 'UTC'
  // Resolves after the first apply() settles (see the tail of apply()).
  let readyResolve
  const ready = new Promise((resolve) => (readyResolve = resolve))

  /** Programmatic lookup — returns the English fallback for unknown keys or when FA dict hasn't loaded yet. */
  function t(key) {
    return (dict[lang] && dict[lang][key]) ?? dict.en[key] ?? key
  }

  // Vazir for Farsi: injected only when fa is active (spec font decision — CLAUDE.md
  // "Manrope + Vazir fonts"), and re-run on language change so it survives client toggling.
  function ensureVazir() {
    if (!(lang === 'fa') || document.querySelector('link[data-vazir]')) return
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.dataset.vazir = '1'
    link.href = '/vendor/vazir/font-face.css'
    document.head.appendChild(link)
  }

  // P2 (Focus 2): lazy-load the FA dictionary. Returns immediately if already loaded.
  // Follows the queue.js injection pattern (app.js:13) — /js/i18n-fa.js?v=94 is rewritten
  // to /dist/i18n-fa.<hash>.js by the build pipeline's fixpoint loop.
  let faDictPromise = null // guards against double-injection if apply() fires twice
  function ensureFaDict() {
    if (dict.fa) return Promise.resolve()
    if (faDictPromise) return faDictPromise
    faDictPromise = new Promise((resolve) => {
      const s = document.createElement('script')
      s.src = '/js/i18n-fa.js?v=94'
      s.onload = () => { dict.fa = window.__hibanaDictFA || {}; resolve() }
      s.onerror = () => { dict.fa = {}; resolve() } // graceful: t() falls back to EN
      document.head.appendChild(s)
    })
    return faDictPromise
  }

  async function apply() {
    let me = null
    try {
      // S75: ride the shared per-page memo (window.__hibanaMe, defined in app.js —
      // every page loads app.js before i18n). Pages without app.js (clip popup) fall
      // back to a direct fetch. Language toggles call the memo's force-refresh BEFORE
      // apply() so the just-PATCHed language_pref is what we read here.
      if (window.__hibanaMe) {
        const env = await window.__hibanaMe()
        me = env && env.ok ? env.body : null
      } else {
        me = await fetch('/api/auth/me').then((r) => (r.ok ? r.json() : null))
      }
    } catch { /* offline / 500 → fall back to English until the next apply */ }
    // P4.2 (F-H3): when the user is NOT logged in (401 → me is null), fall back to
    // navigator.language so the auth pages (login/signup/confirm/reset) render in the
    // browser's language. Was hardcoded 'en' — FA browsers saw English-only auth pages.
    if (me?.user?.language_pref) {
      lang = me.user.language_pref
    } else if (!me) {
      lang = /^fa/i.test(navigator.language) ? 'fa' : 'en'
    } else {
      lang = 'en'
    }
    cal = lang === 'fa' ? 'shamsi' : 'gregorian' // calendar follows the language (2026-08-25)
    tz = me?.user?.timezone ?? 'UTC'

    // P2 (Focus 2): if the resolved language is FA, ensure the FA dictionary is loaded
    // before translating. EN users never trigger this fetch.
    if (lang === 'fa') await ensureFaDict()

    document.documentElement.lang = lang
    document.documentElement.dir = lang === 'fa' ? 'rtl' : 'ltr'
    ensureVazir()
    // M5 fix (2026-09-10): cache the resolved lang/dir so boot.js can apply them
    // SYNCHRONOUSLY before first paint on the next page load. Without this, every page
    // starts as lang=en dir=ltr and flashes to fa/rtl when this async apply() resolves —
    // a visible LTR/English FOUC for Farsi users on every navigation.
    try { localStorage.setItem('hibana-lang', lang) } catch { /* storage unavailable */ }

    // Localized document title (visible in browser chrome / PWA / history — user request
    // 2026-08-29 "every item translated"). Only mapped app pages; login/signup stay EN.
    // S64 additions: /notes.html (the 0057 Vault, S53) and /gallery.html (S39) shipped
    // after this map was last touched — FA users kept seeing English tab titles for them.
    // S71 fix: S70 made extensionless page URLs first-class on BOTH runtimes
    // (/projects serves projects.html on Node since then — CF assets always did).
    // The map's .html-only keys meant every extensionless load kept its EN tab title
    // in FA. Normalize by stripping .html, key the map extensionless only.
    const TITLE_PAGES = {
      '/app': 'nav.dashboard', '/dashboard': 'nav.dashboard',
      '/to-do-list': 'nav.sadhana', '/sadhana': 'nav.sadhana',
      '/projects': 'nav.projects', '/sparks': 'nav.sparks', '/spark': 'nav.sparks',
      '/canvas': 'nav.canvas', '/calendar': 'nav.calendar',
      '/whiteboard': 'nav.whiteboard',
      '/notifications': 'nav.notifications', '/reports': 'nav.reports',
      '/archive': 'nav.archive', '/settings': 'nav.settings',
      '/clients': 'nav.clients', '/gallery': 'nav.gallery',
      '/notes': 'nav.notes',
      '/admin': 'nav.admin', '/404': 'nf.title',
    }
    // S64 bug fix: the branded 404 is served AT the miss URL (app.ts notFoundPage
    // re-serves /404.html's bytes for ANY unknown path), so the '/404' key above
    // almost never matches — an EN user landing on /no-such-page kept the static
    // Persian <title> from 404.html's head. The page itself carries .nf-page on
    // <body>; that marker is the reliable signal, whatever the URL is.
    const is404Page = document.body.classList.contains('nf-page')
    const normalizedPath = location.pathname.replace(/\.html$/i, '')
    const titleKey = TITLE_PAGES[normalizedPath] || (is404Page ? 'nf.title' : null)
    if (titleKey) document.title = `${t(titleKey)} — Hibana`

    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const s = t(el.dataset.i18n)
      if (s !== el.dataset.i18n) {
        // textContent would wipe any nested form control (a <label> wrapping an input/select)
        // — never destroy children; skip so the markup's English fallback stays (2026-08-26).
        if (el.children.length) return
        el.textContent = s
      }
    })
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const s = t(el.dataset.i18nPlaceholder)
      if (s !== el.dataset.i18nPlaceholder) el.placeholder = s
    })
    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const s = t(el.dataset.i18nTitle)
      if (s !== el.dataset.i18nTitle) el.title = s
    })
    // aria-labels (JS-built chrome like the mobile bottom bar — 2026-08-29).
    document.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
      const s = t(el.dataset.i18nAriaLabel)
      if (s !== el.dataset.i18nAriaLabel) el.setAttribute('aria-label', s)
    })
    // R5.1: translate [data-tooltip] via [data-i18n-tooltip] (the CSS-only tooltip component).
    document.querySelectorAll('[data-i18n-tooltip]').forEach((el) => {
      const s = t(el.dataset.i18nTooltip)
      if (s !== el.dataset.i18nTooltip) el.setAttribute('data-tooltip', s)
    })

    // Active-language rows in the user menu (audit 13): highlight + check mark.
    document.querySelectorAll('[data-lang-toggle]').forEach((el) => {
      const active = el.dataset.langToggle === lang
      el.classList.toggle('active', active)
      el.setAttribute('aria-pressed', String(active))
    })

    // Convert displayed absolute dates (data-date) to the chosen calendar + timezone.
    // fa gets Persian digits so the date matches the counters' numeral system (2026-08-25).
    const faNum = (s) => String(s).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[+d])
    document.querySelectorAll('[data-date]').forEach((el) => {
      const iso = el.dataset.date
      if (!iso) return
      const d = new Date(iso)
      let s
      if (cal === 'shamsi' && window.jalaali) {
        const j = window.jalaali.toJalaali(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
        s = `${j.jy}/${j.jm}/${j.jd}`
      } else {
        s = iso.slice(0, 10)
      }
      el.textContent = lang === 'fa' ? faNum(s) : s
    })

    // Resolved once the first apply() has settled the language. Alpine components
    // (settings view options, reports summary, telegram badge) render labels via
    // x-text that evaluates BEFORE this async fetch resolves — they await `ready`
    // and bump a reactive tick so the labels re-render in the right language.
    readyResolve?.()
    // And a DOM event for non-Alpine pages whose mount ran before this script loaded
    // (boot.js mounts page defs on alpine:init, and Alpine loads before i18n.js —
    // so window.hibanaI18n is still undefined at mount time there; those pages
    // can't reach `ready` and listen for this instead). Fired on every apply(),
    // handlers are expected to be idempotent.
    document.dispatchEvent(new CustomEvent('hibana:i18n', { detail: { lang } }))
  }

  return { apply, t, lang: () => lang, tz: () => tz, ready }
})()

document.addEventListener('DOMContentLoaded', () => window.hibanaI18n.apply())
