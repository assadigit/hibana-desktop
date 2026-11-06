// Full-library emoji picker (Phase 6 item 2). Consumes /js/emoji-data.js and renders a
// popup dialog: search field (English + Farsi keywords), the nine standard category
// tabs, a scrollable grid, and a "recent" row (last 12 picks, localStorage).
//
// API (framework-free, one picker per page):
//   window.hibanaEmojiPicker.open({ anchor?, current?, onPick })  — anchor positions the
//     popup next to the element (falls back to viewport center); `current` preselects the
//     emoji's category. onPick(emoji) fires on every choice; the picker closes itself.
//   window.hibanaEmojiPicker.close()
//
// Styling lives in app.css (.emoji-pop-*). ESC and the backdrop close it. On small
// screens (< 640px) it docks as a bottom sheet via CSS, so anchoring is ignored there.

const escE = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
;(() => {
  const RECENT_KEY = 'hibana-emoji-recent'
  const _t = (k, fa, en) => (window.hibanaI18n && window.hibanaI18n.t(k)) || (document.documentElement.dir === 'rtl' ? fa : en)

  // M7 fix (2026-09-10): lazy-load emoji-data.js (49KB) only when the picker first opens.
  // Was loaded eagerly on every dashboard/sadhana/to-do-list page load even though most
  // users never open the picker. The script sets window.hibanaEmojiData; we cache the
  // load promise so subsequent opens are instant.
  let dataPromise = null
  function ensureEmojiData() {
    if (window.hibanaEmojiData) return Promise.resolve()
    if (!dataPromise) {
      dataPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script')
        s.src = '/js/emoji-data.js?v=1'
        s.onload = resolve
        s.onerror = () => { dataPromise = null; reject(new Error('emoji-data load failed')) }
        document.head.appendChild(s)
      })
    }
    return dataPromise
  }

  let root = null // .emoji-pop-wrap
  let backdrop = null
  let state = null // { onPick, activeGroup, term }
  let gridEl = null
  let searchEl = null
  let tabsEl = null

  // S41: registered ONCE at module scope — ensureDom() may REBUILD root after its host
  // dialog was torn down (sparks-page.js removes its dialogs on unmount), and a
  // listener bound inside ensureDom would reference the dead node.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && root && root.classList.contains('open')) {
      // preventDefault: when the picker opened FROM a native <dialog>, Escape must
      // close ONLY the sheet — the dialog's own cancel event fires otherwise too.
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }, true)

  function recent() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter((x) => typeof x === 'string').slice(0, 12) } catch { return [] }
  }
  function pushRecent(emoji) {
    const list = [emoji, ...recent().filter((e) => e !== emoji)].slice(0, 12)
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)) } catch { /* private mode */ }
  }

  function ensureDom() {
    // S41: the picker can outlive its host — sparks-page.js tears its dialogs down on
    // unmount, taking re-parented picker nodes with them. A detached root renders
    // nowhere; rebuild rather than trust a stale reference.
    if (root && root.isConnected) return
    if (root) { root.remove(); if (backdrop) backdrop.remove() }
    backdrop = document.createElement('div')
    backdrop.className = 'emoji-pop-backdrop'
    backdrop.addEventListener('click', () => close())
    root = document.createElement('div')
    root.className = 'emoji-pop'
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-modal', 'false')
    root.innerHTML =
      '<div class="emoji-pop-srch">' +
        '<input type="search" id="emoji-pop-q" autocomplete="off" placeholder="🔍 ' + _t('sadhana.emojiSearch', 'جستجوی ایموجی…', 'Search emoji…') + '">' +
      '</div>' +
      '<div class="emoji-pop-cats" id="emoji-pop-cats" role="tablist"></div>' +
      '<div class="emoji-pop-grid" id="emoji-pop-grid" role="grid"></div>' +
      '<div class="emoji-pop-foot"><span class="emoji-pop-hint"></span></div>'
    document.body.append(backdrop, root)
    gridEl = root.querySelector('#emoji-pop-grid')
    searchEl = root.querySelector('#emoji-pop-q')
    tabsEl = root.querySelector('#emoji-pop-cats')

    searchEl.addEventListener('input', () => {
      state.term = searchEl.value
      renderGrid()
    })
    searchEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close() }
    })
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('.emoji-pop-em')
      if (!btn || !state) return
      pick(btn.dataset.emoji)
    })
  }

  function renderTabs() {
    const data = window.hibanaEmojiData
    if (!data || !tabsEl) return
    tabsEl.innerHTML = data.groups.map((g) =>
      `<button type="button" class="emoji-pop-cat${state.activeGroup === g.id ? ' active' : ''}" role="tab" aria-selected="${state.activeGroup === g.id}" data-cat="${g.id}" title="${escE(g.fa)} · ${escE(g.en)}">${g.icon}</button>`,
    ).join('')
    tabsEl.querySelectorAll('[data-cat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.activeGroup = btn.dataset.cat
        state.term = ''
        searchEl.value = ''
        renderTabs()
        renderGrid()
      })
    })
  }

  function gridButtons(entries) {
    return entries.map((e) =>
      `<button type="button" class="emoji-pop-em" role="gridcell" data-emoji="${e.emoji}" title="${e.kw.split(' ').slice(0, 4).join(' ')}">${e.emoji}</button>`,
    ).join('')
  }

  function renderGrid() {
    const data = window.hibanaEmojiData
    if (!data || !gridEl || !state) return
    // search overrides the category
    if (state.term.trim()) {
      gridEl.innerHTML = gridButtons(data.search(state.term)) || `<div class="emoji-pop-empty">${_t('emojiPicker.noResults', 'چیزی پیدا نشد', 'Nothing found')}</div>`
      return
    }
    const rec = recent()
    const recRow = rec.length && state.activeGroup === null
      ? `<div class="emoji-pop-rec" role="row">${gridButtons(rec.map((e) => ({ emoji: e, kw: '' })))}</div><div class="emoji-pop-sep"></div>`
      : ''
    const entries = state.activeGroup ? data.byGroup(state.activeGroup) : data.all()
    gridEl.innerHTML = recRow + gridButtons(entries)
    // remember scroll position per open; new open starts at top
    gridEl.scrollTop = 0
  }

  function pick(emoji) {
    if (!state || !emoji) return
    pushRecent(emoji)
    try { state.onPick && state.onPick(emoji) } catch { /* consumer error must not wedge the picker */ }
    close()
  }

  async function open(opts = {}) {
    // M7 fix: ensure emoji-data.js is loaded before rendering. First open takes ~50ms
    // (one script fetch); subsequent opens are instant (promise cached).
    try { await ensureEmojiData() } catch { return }
    const data = window.hibanaEmojiData
    if (!data) return
    ensureDom()
    state = { onPick: opts.onPick, activeGroup: null, term: '' }
    // Preselect the current emoji's category when it maps to one
    if (opts.current) {
      const g = data.groupOf(opts.current)
      if (g) state.activeGroup = g
    }
    searchEl.value = ''
    renderTabs()
    renderGrid()
    // S41 TOP-LAYER FIX: a native <dialog> opened with showModal() lives in the top
    // layer — no z-index can ever paint above it, so a picker opened from inside one
    // (the sparks folder dialog's icon button) rendered BEHIND it: visible but
    // unclickable (real pointer clicks landed on the dialog; Playwright exposed it).
    // Re-parent both layers into the OPEN dialog: children ride its top-layer slot
    // and paint above the page, while position:fixed still resolves to the viewport
    // (dialog.dialog carries no transform/filter containing block). No dialog open
    // → the body, exactly as before (dashboard/sadhana behavior unchanged).
    const hostDlg = document.querySelector('dialog[open]')
    ;(hostDlg || document.body).append(backdrop, root)
    root.classList.add('open')
    backdrop.classList.add('open')
    root.setAttribute('aria-label', _t('emojiPicker.label', 'انتخاب ایموجی', 'Emoji picker'))
    // Anchor near the caller (desktop only — CSS docks the sheet on mobile)
    const anchor = opts.anchor instanceof Element ? opts.anchor : null
    if (anchor && window.innerWidth >= 640) {
      const r = anchor.getBoundingClientRect()
      const W = 328
      const H = 386
      let left = r.left + r.width / 2 - W / 2
      left = Math.max(8, Math.min(left, window.innerWidth - W - 8))
      let top = r.bottom + 8
      if (top + H > window.innerHeight - 8) top = Math.max(8, r.top - H - 8)
      root.style.left = left + 'px'
      root.style.top = top + 'px'
    } else {
      root.style.left = ''
      root.style.top = ''
    }
    setTimeout(() => searchEl.focus(), 30)
  }

  function close() {
    if (!root) return
    root.classList.remove('open')
    backdrop.classList.remove('open')
    state = null
  }

  window.hibanaEmojiPicker = { open, close, isOpen: () => !!(root && root.classList.contains('open')) }
})()
