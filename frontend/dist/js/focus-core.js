// focus-core.js — S237 FOCUS MODE: the pure decision core.
//
// The board controller (board-page.js) owns the DOM half; every DECISION this
// feature makes is extracted here so it is testable without a browser
// (src/tests/focus-mode-s237.test.ts + task-view-s238.test.ts evaluate THIS
// file byte-for-byte — the sync-state.js harness doctrine). Zero DOM, zero
// fetch, zero i18n: functions in, decisions out.
//
// The contract (spec S237 §1):
//   - parseToggle:  localStorage 'hibana-focus-mode' is 'on' | 'off' — 'on' is
//                   the ONLY truthy spelling; null/'off'/garbage reads OFF
//                   (the default).
//   - cycleLane:    the [ / ] wrap-around over the five lanes (DOM order:
//                   idea → bug → planned → in_progress → done). In RTL the
//                   lanes render mirrored but DOM order == reading order, so
//                   [ stays "reading-order previous" in BOTH languages — the
//                   decision is recorded in the S237 worklog).
//   - escLayer:     Esc peels EXACTLY one layer, inside-out — the enlarge
//                   sheet first, then the blur focus. null = this Esc is not
//                   ours (menus/dialogs/zen keep their own contracts).
//   - autoRestore:  on board load, restore ONLY when the toggle is on AND
//                   the remembered lane is a valid status key.
//   - resolveFKey:  the F target — the hovered lane wins, else the last
//                   focused lane, else null (F never guesses a lane).
//
// S238 (the task view modal): escPeel extends the SAME inside-out law with
// the read-only task VIEW as the innermost layer — it peels before the sheet
// and the focus, focus mode ON or OFF (a card click opens the view with the
// toggle off too). escLayer keeps the S237 shape untouched (its suite still
// pins it byte-for-byte).
//
// Loaded by board.html only (defer, before devboard.js) — the sprint page and
// the project page's embedded board are out of S237 scope. board-page.js's
// self-healing ensureLib() re-injects it with the same ?v= as the <head> tag.
window.HibanaFocusCore = (() => {
  'use strict'

  // The five swimlanes, DOM order (devboard.js's STATUSES twin — kept in sync
  // deliberately; a drift is caught by the S237 test's STATUSES parity check).
  const STATUSES = ['idea', 'bug', 'planned', 'in_progress', 'done']

  // The two persistence keys (spec §1.5 — written by BOTH settings surfaces,
  // web settings.html and the desktop panel: same keys, different codebases).
  const TOGGLE_KEY = 'hibana-focus-mode'
  const LAST_KEY = 'hibana-focus-last'

  const validStatus = (st) => STATUSES.indexOf(st) !== -1

  // 'on' is the only ON spelling — default OFF, forever.
  const parseToggle = (v) => v === 'on'

  // [ / ]: wrap around the five lanes. dir < 0 = '[', dir > 0 = ']'. An
  // unknown/missing status falls back to the first lane so a stale value can
  // never deadlock the cycle.
  const cycleLane = (st, dir) => {
    const idx = STATUSES.indexOf(st)
    const n = STATUSES.length
    if (idx === -1) return STATUSES[0]
    const step = dir < 0 ? -1 : 1
    return STATUSES[(idx + step + n) % n]
  }

  // Esc layering — one layer per press, innermost first. state is the live
  // { sheetStatus, focusedStatus } pair (null fields = layer closed).
  const escLayer = (state) => {
    if (!state) return null
    if (state.sheetStatus) return 'sheet'
    if (state.focusedStatus) return 'focus'
    return null
  }

  // S238: the FULL board peel — the task VIEW modal (focus-independent: a card
  // click opens it with the mode on OR off) is the innermost layer, then the
  // enlarge sheet, then the blur focus. state is the live
  // { viewOpen, sheetStatus, focusedStatus } triple. null = this Esc is not
  // ours. (The native <dialog> / task-editor cases stay DOM-side guards in
  // board-page.js — environment, not decision.)
  const escPeel = (state) => {
    if (!state) return null
    if (state.viewOpen) return 'view'
    if (state.sheetStatus) return 'sheet'
    if (state.focusedStatus) return 'focus'
    return null
  }

  // Board-load auto-restore: only (toggle ON) × (a valid remembered lane).
  const autoRestore = (enabled, last) => (enabled && validStatus(last) ? last : null)

  // F's target: hovered lane → last focused lane → nothing (never a guess).
  const resolveFKey = (hovered, last) => {
    if (validStatus(hovered)) return hovered
    if (validStatus(last)) return last
    return null
  }

  return { STATUSES, TOGGLE_KEY, LAST_KEY, validStatus, parseToggle, cycleLane, escLayer, escPeel, autoRestore, resolveFKey }
})()
