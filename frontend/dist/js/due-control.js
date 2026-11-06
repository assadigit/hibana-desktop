// due-control.js — S244 (spec pack Phase 5, D6): the ONE shared Gregorian/Jalali
// deadline date control (spec §11 — calendar, time, and presets).
//
// Before this module NO date-picker component existed anywhere in Hibana (D6):
// the only precedent was the sprint define-popover's bare <input type="date">
// (S206, parsed as UTC end-of-day) and the S242 quick-create interim that copied
// it. This module SUPERSEDES both (assumption 10's recorded interim): date-only
// input now resolves to LOCAL 23:59 (spec §11.2), and the calendar selector
// reuses the EXISTING infrastructure — the vendored jalaali (window.jalaali,
// already on board.html + sprint.html) + Hibana's own month/weekday tables.
//
// The control (Screen C grammar):
//   ┌ Gregorian | Jalali ┐  the segmented calendar selector (§11.1 — the default
//   │                     follows the user's calendar_pref, which the server
//   │                     derives from the UI language: fa → shamsi, en →
//   │                     gregorian; src/lib/jalali.ts calendarFor)
//   │ [ date input ]      ONE editable date reflecting ONLY the selected
//   │                     calendar (§11.1: never two conflicting dates). The
//   │                     Gregorian side is a native <input type="date"> (the
//   │                     S206 precedent); the Jalali side is a numeric text
//   │                     input (1405/08/12 — Latin or Persian digits) because
//   │                     no browser ships a Jalali date picker.
//   │ Today 24h 48h 72h This week This month   the six presets (§11.3)
//   │ ☐ Add time (optional)   OFF by default (§11.2); ON reveals HH:MM
//   └ Without a specified time, the deadline is 23:59 on the selected day.
//
// VALUE CONTRACT (the storage rule, unchanged since S240): the value is an
// ISO-8601 UTC instant string (toISOString()) or null — storage stays Gregorian
// UTC (rule 3); the calendar only changes presentation/input (§11's own rule).
//
// Preset semantics (§11.3, EXACT):
//   Today      → today at LOCAL 23:59 (time toggle reads OFF — the date-only
//                sentinel)
//   24h/48h/72h→ exactly now + N hours (an instant WITH a time; the time input
//                reveals it so the control never lies about what was picked)
//   This week  → the selected calendar's week END at LOCAL 23:59. Hibana's
//                convention (calendar-page.js): the Gregorian week is
//                Sunday-first (ends Saturday); the Jalali week is Saturday-first
//                (ends جمعه/Friday).
//   This month → the selected calendar's month END at LOCAL 23:59 (Esfand
//                29/30 included — the jalaali leap rule).
//
// The control is a pure INPUT widget: consumers read .value() at their save
// time (the task modal's Save, the quick-create's Create, the sprint settings'
// Save). No fetches, no state outside its own closure. RTL-safe via logical
// properties; the Jalali text input stays dir="ltr" so 1405/08/12 reads as
// numbers in both directions.
/* global window, document */
(function () {
  'use strict'

  const t = (key, fallback) => (window.hibanaI18n && window.hibanaI18n.t(key)) || fallback
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const DAY = 86400000
  const HOUR = 3600000

  // Persian-digit tolerant numeric parse: '۱۴۰۵/۰۸/۱۲' → [1405, 8, 12]. Latin and
  // Persian digits mix freely (a common real-world typing pattern); the
  // separators may be / - or .
  const FA_DIG = '۰۱۲۳۴۵۶۷۸۹'
  const parseNum = (s) => {
    let out = ''
    for (const ch of String(s || '').trim()) {
      const fi = FA_DIG.indexOf(ch)
      out += fi >= 0 ? String(fi) : ch
    }
    const n = Number(out)
    return Number.isFinite(n) ? n : NaN
  }
  const parseYmd = (raw) => {
    const parts = String(raw || '').trim().split(/[/\-.]+/)
    if (parts.length !== 3) return null
    const y = parseNum(parts[0]); const m = parseNum(parts[1]); const d = parseNum(parts[2])
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null
    return { y, m, d }
  }
  const pad2 = (n) => String(n).padStart(2, '0')

  /** Gregorian y/m/d → the local 23:59:59 instant of that day (§11.2). */
  const dayEndLocal = (y, m, d) => new Date(y, m - 1, d, 23, 59, 59, 999)

  const toJ = (y, m, d) => (window.jalaali ? window.jalaali.toJalaali(y, m, d) : null)
  const toG = (jy, jm, jd) => (window.jalaali ? window.jalaali.toGregorian(jy, jm, jd) : null)
  const jMonthLen = (jy, jm) => {
    // The jalaali table: 1-6 → 31, 7-11 → 30, 12 → 29 (30 on leap years). The
    // leap rule below is the 33-year remainder table jalali.js carries
    // (window.__hibJalali.jalaliLeap); inline so the control stands alone.
    if (jm <= 6) return 31
    if (jm <= 11) return 30
    const r = jy % 33
    return [1, 5, 9, 13, 17, 22, 26, 30].includes(r) ? 30 : 29
  }

  /** The control factory. opts: { value: iso|null } — everything else reads the
   * ambient locale. Returns { el, value(), setCalendar() } — el embeds ONCE. */
  function create(opts) {
    const o = opts || {}
    const lang = window.hibanaI18n && window.hibanaI18n.lang ? window.hibanaI18n.lang() : 'en'
    // §11.1: the user's calendar_pref picks the default — server-derived from the
    // language (fa → shamsi/Jalali, en → gregorian; src/lib/jalali.ts calendarFor).
    let cal = lang === 'fa' ? 'jalali' : 'gregorian'
    // The current deadline instant (a Date) or null. ONE state — both calendar
    // inputs, the time input, and the presets all read/write THIS.
    let val = o.value ? new Date(o.value) : null
    if (val && isNaN(val.getTime())) val = null
    let timeOn = false // §11.2: Add time (optional) — OFF by default
    // The sentinel: a value whose local time is exactly 23:59 reads as date-only
    // (the time toggle reflects OFF). Loading a saved 14:30 deadline shows ON.
    const isDayEnd = (d) => d.getHours() === 23 && d.getMinutes() === 59
    if (val && !isDayEnd(val)) timeOn = true

    const root = document.createElement('div')
    root.className = 'db-due-ctl'
    root.innerHTML =
      // §11.1: the explicit segmented selector — only the selected calendar's
      // date is displayed as editable, never two conflicting dates.
      '<div class="db-seg db-due-cal" data-due-cal role="group" aria-label="' + esc(t('db.due.calLabel', 'Calendar')) + '">' +
        '<button type="button" data-cal="gregorian">' + esc(t('db.due.calG', 'Gregorian')) + '</button>' +
        '<button type="button" data-cal="jalali">' + esc(t('db.due.calJ', 'Jalali')) + '</button>' +
      '</div>' +
      '<div class="db-due-date-row">' +
        '<input type="date" class="db-due-date" data-due-g hidden aria-label="' + esc(t('db.dueDate', 'Due date')) + '">' +
        '<input type="text" class="db-due-date db-due-j" data-due-j hidden dir="ltr" inputmode="numeric" autocomplete="off" placeholder="' + esc(t('db.due.jalaliPh', '1405/08/12')) + '" aria-label="' + esc(t('db.dueDate', 'Due date')) + '">' +
        '<p class="db-due-err" data-due-err role="alert" hidden></p>' +
      '</div>' +
      // §11.3: the six presets — compact chips, the exact semantics above.
      '<div class="db-due-presets" data-due-presets>' +
        '<button type="button" data-due-preset="today">' + esc(t('db.today', 'Today')) + '</button>' +
        '<button type="button" data-due-preset="24h">' + esc(t('db.due.p24', '24 hours')) + '</button>' +
        '<button type="button" data-due-preset="48h">' + esc(t('db.due.p48', '48 hours')) + '</button>' +
        '<button type="button" data-due-preset="72h">' + esc(t('db.due.p72', '72 hours')) + '</button>' +
        '<button type="button" data-due-preset="week">' + esc(t('db.due.pWeek', 'This week')) + '</button>' +
        '<button type="button" data-due-preset="month">' + esc(t('db.due.pMonth', 'This month')) + '</button>' +
      '</div>' +
      // §11.2: the discreet Add time (optional) control — OFF by default.
      '<label class="db-sq-toggle db-due-time-toggle"><input type="checkbox" data-due-time-toggle><span>' + esc(t('db.due.addTime', 'Add time (optional)')) + '</span></label>' +
      '<input type="time" class="db-due-time" data-due-time hidden aria-label="' + esc(t('db.due.timeLabel', 'Time')) + '">' +
      '<p class="db-due-hint muted small" data-due-hint>' + esc(t('db.due.timeHint', 'Without a specified time, the deadline is 23:59 on the selected day.')) + '</p>'

    const gIn = root.querySelector('[data-due-g]')
    const jIn = root.querySelector('[data-due-j]')
    const errEl = root.querySelector('[data-due-err]')
    const timeToggle = root.querySelector('[data-due-time-toggle]')
    const timeIn = root.querySelector('[data-due-time]')
    const hintEl = root.querySelector('[data-due-hint]')
    const calBtns = { gregorian: null, jalali: null }
    root.querySelectorAll('[data-due-cal] button').forEach((b) => { calBtns[b.dataset.cal] = b })

    const showErr = (msg) => { errEl.textContent = msg; errEl.hidden = false; jIn.classList.add('is-invalid') }
    const hideErr = () => { errEl.hidden = true; errEl.textContent = ''; jIn.classList.remove('is-invalid') }

    /** Paint every input from the single val state. */
    const paint = () => {
      calBtns.gregorian.classList.toggle('is-on', cal === 'gregorian')
      calBtns.jalali.classList.toggle('is-on', cal === 'jalali')
      gIn.hidden = cal !== 'gregorian'
      jIn.hidden = cal !== 'jalali'
      if (!val) {
        gIn.value = ''
        jIn.value = ''
      } else if (cal === 'gregorian') {
        gIn.value = val.getFullYear() + '-' + pad2(val.getMonth() + 1) + '-' + pad2(val.getDate())
        jIn.value = ''
      } else {
        const j = toJ(val.getFullYear(), val.getMonth() + 1, val.getDate())
        jIn.value = j ? j.jy + '/' + pad2(j.jm) + '/' + pad2(j.jd) : ''
        gIn.value = ''
      }
      timeToggle.checked = timeOn
      timeIn.hidden = !timeOn
      hintEl.hidden = timeOn
      if (timeOn) timeIn.value = pad2(val ? val.getHours() : 23) + ':' + pad2(val ? val.getMinutes() : 59)
    }

    /** A calendar-day change: keep the instant's time when the time toggle is
     * ON; resolve to the day's LOCAL 23:59 when OFF (§11.2). */
    const setDay = (y, m, d) => {
      if (timeOn && val) val = new Date(y, m - 1, d, val.getHours(), val.getMinutes(), 0, 0)
      else val = dayEndLocal(y, m, d)
      hideErr()
      paint()
    }

    // ---- the calendar segmented selector (§11.1) ----
    calBtns.gregorian.onclick = () => { cal = 'gregorian'; hideErr(); paint() }
    calBtns.jalali.onclick = () => { cal = 'jalali'; hideErr(); paint() }

    // ---- the Gregorian input (native date) ----
    gIn.onchange = () => {
      const p = parseYmd(gIn.value)
      if (!p) { gIn.value = val ? gIn.value : ''; return }
      setDay(p.y, p.m, p.d)
    }

    // ---- the Jalali input (numeric text, Persian-tolerant) ----
    const applyJalali = () => {
      const p = parseYmd(jIn.value)
      if (!p) { showErr(t('db.due.invalid', 'Enter the date as year/month/day, e.g. 1405/08/12.')); return }
      const g = toG(p.y, p.m, p.d)
      if (!g || p.m < 1 || p.m > 12 || p.d < 1 || p.d > 31) { showErr(t('db.due.invalid', 'Enter the date as year/month/day, e.g. 1405/08/12.')); return }
      // Reject a day the month can't hold (e.g. 1405/12/30 on a non-leap year) —
      // the round-trip would silently land on the wrong Gregorian day.
      if (p.d > jMonthLen(p.y, p.m)) { showErr(t('db.due.invalid', 'Enter the date as year/month/day, e.g. 1405/08/12.')); return }
      setDay(g.gy, g.gm, g.gd)
    }
    jIn.onchange = applyJalali
    jIn.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); applyJalali() } }

    // ---- the six presets (§11.3 — exact semantics) ----
    root.querySelector('[data-due-presets]').onclick = (ev) => {
      const btn = ev.target.closest('[data-due-preset]')
      if (!btn) return
      const kind = btn.dataset.duePreset
      const now = new Date()
      if (kind === 'today') {
        val = dayEndLocal(now.getFullYear(), now.getMonth() + 1, now.getDate())
        timeOn = false // today 23:59 IS the date-only sentinel
      } else if (kind === '24h' || kind === '48h' || kind === '72h') {
        // "Exactly N hours from the current moment" — an instant with a time.
        val = new Date(now.getTime() + HOUR * Number(kind.slice(0, -1)))
        timeOn = true
      } else if (kind === 'week') {
        // End of the current calendar week, per the SELECTED calendar's
        // convention: Gregorian Sunday-first → the coming Saturday; Jalali
        // Saturday-first → the coming Friday (calendar-page.js's rule).
        const dow = now.getDay() // 0=Sun … 6=Sat
        const ahead = cal === 'jalali' ? (5 - dow + 7) % 7 : (6 - dow + 7) % 7
        const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead)
        val = dayEndLocal(end.getFullYear(), end.getMonth() + 1, end.getDate())
        timeOn = false
      } else if (kind === 'month') {
        // End of the current calendar month in the SELECTED calendar. Jalali:
        // the month's last day (Esfand 29/30 included) converted back; else the
        // Gregorian month's own last day.
        if (cal === 'jalali') {
          const j = toJ(now.getFullYear(), now.getMonth() + 1, now.getDate())
          const last = jMonthLen(j.jy, j.jm)
          const g = toG(j.jy, j.jm, last)
          val = dayEndLocal(g.gy, g.gm, g.gd)
        } else {
          const last = new Date(now.getFullYear(), now.getMonth() + 1, 0)
          val = dayEndLocal(last.getFullYear(), last.getMonth() + 1, last.getDate())
        }
        timeOn = false
      }
      hideErr()
      paint()
    }

    // ---- Add time (optional) (§11.2) ----
    timeToggle.onchange = () => {
      timeOn = timeToggle.checked
      if (timeOn) {
        // Reveal the current instant's time (or a neutral 23:59 default when no
        // deadline is picked yet — typing a date keeps whatever lands here).
        paint()
      } else {
        // OFF with a date picked → the deadline is 23:59 on that selected day.
        if (val) val = dayEndLocal(val.getFullYear(), val.getMonth() + 1, val.getDate())
        paint()
      }
    }
    timeIn.onchange = () => {
      const p = String(timeIn.value || '').split(':')
      if (p.length !== 2 || !val) return
      const hh = parseNum(p[0]); const mm = parseNum(p[1])
      if (!Number.isFinite(hh) || !Number.isFinite(mm)) return
      val = new Date(val.getFullYear(), val.getMonth(), val.getDate(), hh, mm, 0, 0)
      paint()
    }

    paint()
    return {
      el: root,
      /** ISO-8601 UTC instant or null (the storage contract — unchanged). */
      value() { return val ? val.toISOString() : null },
      /** Force a calendar mode (used when a consumer wants to align the control
       * with its own context; the segmented selector stays user-switchable). */
      setCalendar(c) { if (c === 'gregorian' || c === 'jalali') { cal = c; hideErr(); paint() } },
      /** Load a saved value (the sprint settings panel reuses one control). */
      setValue(iso) {
        val = iso ? new Date(iso) : null
        if (val && isNaN(val.getTime())) val = null
        timeOn = val ? !isDayEnd(val) : false
        hideErr()
        paint()
      },
    }
  }

  window.HibanaDueControl = { create }
})()
