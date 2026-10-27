// public/js/sync-state.js — the per-card sync-state tracker.
//
// Spec: hibana-sync-status-spec.md §4 (the four states), §8 (behaviour + timing),
// §9 (the Sync button count), §12 (accessibility), §14 (ONE source of truth).
//
// devboard.js's task mutations (patchTask / deleteTask / reorderTasks / addTaskTag /
// removeTaskTag — the same functions BOTH kanban surfaces call, board.html and
// project.html) report here; nothing else writes state. A server-rendered card is
// server-confirmed, so the implicit state of every card is 'synced' (spec §2:
// "Synced means the server confirmed the write") — the tracker only overrides the
// cards whose edits are in flight or have failed.
//
// Consumers, all derived from this one store:
//   · the per-card badges — chip-render.js's syncBadgeHtml + the paint loop below
//     (a state change repaints ONLY the changed card's badge nodes; the board is
//     never re-rendered — spec §8 "Update only the cards whose state changed")
//   · the Sync button's count badge — subscribe(); hibana-desktop's desktop-sync.js
//     is the header-Sync-button consumer (spec §9: count = Pending + Failed,
//     hidden at zero, same source as the cards)
//   · the polite aria-live region — Synced after a user edit + Failed only
//     (spec §12: never announce background churn)
//
// Timing rules (spec §8): Pending paints the moment the mutation starts (optimistic
// — never wait for the network). Syncing appears only if the round-trip outlives
// SYNCING_DELAY_MS (~500ms); faster syncs go Pending → Synced with no spinner. A
// newer edit while an older one is syncing wins: the card goes back to Pending and
// the older cycle's verdict is discarded (the seq guard). Offline: a failure keeps
// the card Pending ("Waiting for connection" is a label change, not a state), and
// the 'online' event re-runs every still-pending retry — the same reconnect cue
// queue.js uses.
/* global window, document, navigator */
(function () {
  'use strict'

  const SYNCING_DELAY_MS = 500
  const cards = new Map() // id → { state, retry, timer, seq, syncedAt }
  const listeners = new Set()
  let liveEl = null

  const t = (k, f) => (window.hibanaI18n && window.hibanaI18n.t(k)) || f
  const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false

  function stateOf(id) {
    const c = cards.get(id)
    return c ? c.state : 'synced'
  }

  function syncedAt(id) {
    const c = cards.get(id)
    return (c && c.syncedAt) || null
  }

  // Spec §9: the Sync button count = Pending + Failed, from the same store as the
  // per-card badges (never a second tally).
  function count() {
    let n = 0
    cards.forEach((c) => { if (c.state === 'pending' || c.state === 'failed') n++ })
    return n
  }

  // §9 companion: is ANY card mid-sync right now? (The header Sync button rotates
  // its icon while a sync runs — hibana-desktop's desktop-sync.js consumes this
  // alongside count(); the web board has no header Sync button to drive.)
  function hasSyncing() {
    let any = false
    cards.forEach((c) => { if (c.state === 'syncing') any = true })
    return any
  }

  function notify(changedId) {
    for (const l of listeners) {
      try { l(count(), changedId) } catch { /* a consumer's bug must never break the board */ }
    }
  }

  function nodesFor(id, attr) {
    if (typeof document === 'undefined' || !document.querySelectorAll) return []
    return Array.prototype.slice.call(document.querySelectorAll('[' + attr + '="' + id + '"]'))
  }

  // Repaint ONLY this card's badge nodes (the card badge + any open modal detail
  // badge share the id). outerHTML is safe here: the retry pill is wired by the
  // delegated document click below, so replacing the node drops no listener.
  function repaint(id, pop) {
    const chips = window.HibanaChips
    if (!chips || !chips.syncBadgeHtml) return
    const state = stateOf(id)
    const at = syncedAt(id)
    for (const el of nodesFor(id, 'data-sync-badge')) {
      el.outerHTML = chips.syncBadgeHtml(id, state, pop)
    }
    for (const el of nodesFor(id, 'data-sync-badge-detail')) {
      el.outerHTML = chips.syncBadgeDetailHtml(id, state, pop, at)
    }
  }

  // Spec §12: announce politely, but only what the user caused or must act on.
  function announce(msg) {
    if (typeof document === 'undefined' || !document.createElement || !document.body) return
    if (!liveEl || !document.body.contains(liveEl)) {
      liveEl = document.createElement('div')
      liveEl.className = 'sr-only'
      liveEl.setAttribute('aria-live', 'polite')
      liveEl.id = 'hibana-sync-live'
      document.body.appendChild(liveEl)
    }
    liveEl.textContent = msg // textContent only — never markup
  }

  function armSyncingTimer(card, id) {
    if (card.timer) clearTimeout(card.timer)
    card.timer = setTimeout(() => {
      if (card.state === 'pending') {
        card.state = 'syncing'
        repaint(id)
        notify(id)
      }
    }, SYNCING_DELAY_MS)
  }

  function settle(id, seq, state) {
    const card = cards.get(id)
    if (!card || card.seq !== seq) return // a newer edit owns this card now (spec §8)
    if (card.timer) clearTimeout(card.timer)
    if (state === 'failed' && isOffline()) {
      // Offline, the card STAYS Pending — the label switches to "Waiting for
      // connection" (chip-render reads navigator.onLine); the 'online' listener
      // below resumes the flow.
      card.state = 'pending'
      repaint(id)
      notify(id)
      return
    }
    card.state = state
    if (state === 'synced') card.syncedAt = Date.now()
    repaint(id, state === 'synced')
    notify(id)
    if (state === 'synced') announce(t('sync.synced', 'Synced'))
    if (state === 'failed') announce(t('sync.failed', "Couldn't sync. Retry"))
  }

  // track(id, run): register Pending optimistically, run the mutation, settle on
  // its verdict. The returned promise still REJECTS on failure — the callers'
  // toast contracts (devboard's modal, board-page's catch handlers) stay intact.
  function track(id, run) {
    if (!id || typeof run !== 'function') return Promise.resolve()
    const prev = cards.get(id)
    const card = { state: 'pending', retry: run, timer: null, seq: prev ? prev.seq + 1 : 1, syncedAt: prev ? prev.syncedAt : null }
    cards.set(id, card)
    armSyncingTimer(card, id)
    repaint(id)
    notify(id)
    const seq = card.seq
    return Promise.resolve().then(run).then(
      (val) => { settle(id, seq, 'synced'); return val },
      (err) => { settle(id, seq, 'failed'); throw err },
    )
  }

  // A bulk mutation (reorder) touches many cards with ONE request: all ids go
  // Pending together, the single run executes once, and the verdict settles them
  // together. The retry re-issues the whole bulk (idempotent server contract).
  function trackBulk(ids, run) {
    if (!ids || !ids.length || typeof run !== 'function') return Promise.resolve()
    const seqBase = Math.max(0, ...ids.map((id) => (cards.get(id) ? cards.get(id).seq : 0)))
    ids.forEach((id, i) => {
      const prev = cards.get(id)
      cards.set(id, { state: 'pending', retry: run, timer: null, seq: seqBase + 1, syncedAt: prev ? prev.syncedAt : null })
      armSyncingTimer(cards.get(id), id)
      repaint(id)
    })
    notify(ids[0])
    return Promise.resolve().then(run).then(
      (val) => { ids.forEach((id) => settle(id, seqBase + 1, 'synced')); return val },
      (err) => { ids.forEach((id) => settle(id, seqBase + 1, 'failed')); throw err },
    )
  }

  // Spec §9: pressing the Sync button moves every Pending and Failed card to
  // Syncing together (hibana-desktop's SyncNow round calls this on start).
  function markAllSyncing() {
    cards.forEach((c, id) => {
      if (c.state === 'pending' || c.state === 'failed') {
        if (c.timer) clearTimeout(c.timer)
        c.state = 'syncing'
        repaint(id)
      }
    })
    notify(null)
  }

  function wireDocument() {
    if (typeof document === 'undefined' || !document.addEventListener) return
    if (document.__hibanaSyncWired) return
    document.__hibanaSyncWired = true
    // The failed pill retries ONLY its own card (spec §8): the delegated click
    // re-runs the stored mutation through track() — Syncing, then Synced/Failed.
    document.addEventListener('click', (e) => {
      const pill = e.target && e.target.closest ? e.target.closest('[data-sync-retry]') : null
      if (!pill) return
      const id = pill.getAttribute('data-sync-retry')
      const card = id && cards.get(id)
      if (card && typeof card.retry === 'function') {
        track(id, card.retry).catch(() => { /* the badge already shows the verdict */ })
      }
    })
    // Offline → online (spec §8): the normal flow resumes — every still-pending
    // card re-runs its own retry, the same reconnect cue the offline queue uses.
    window.addEventListener('online', () => {
      const ids = []
      cards.forEach((c, id) => { if (c.state === 'pending' && typeof c.retry === 'function') ids.push(id) })
      ids.forEach((id) => track(id, cards.get(id).retry).catch(() => {}))
    })
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {}
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  wireDocument()

  window.HibanaSyncState = { track, trackBulk, markAllSyncing, stateOf, syncedAt, count, hasSyncing, subscribe }
})()
