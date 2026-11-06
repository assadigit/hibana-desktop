    window.__hibanaPage = window.__hibanaPage || ((d) => (window.__hibanaPageQueue = window.__hibanaPageQueue || []).push(d))
    window.__hibanaPage({
      name: 'sprint',
      mount(ctx) {
        const B = () => window.HibanaBoard
        const qs = new URLSearchParams(location.search)
        const projectId = qs.get('project')
        const loading = document.getElementById('sp-loading')
        const wrap = document.getElementById('sp-wrap')
        const sideEl = document.getElementById('sp-side')
        const tlEl = document.getElementById('sp-timeline')
        const _t = (k, f) => {
          const s = window.hibanaI18n ? window.hibanaI18n.t(k) : null
          return s && s !== k ? s : (window.HibanaBoard ? B().t(k, f) : f)
        }
        if (!projectId) { location.replace('/projects.html'); return }

        // ---- zoom ladder: window (visible days around today) × sub-cell kind -------------
        // d = fine editing (day cells), w1/m1 = day cells, m3/m6 = week cells with REAL
        // week numbers (ISO for en, Jalali week-of-year for fa), y1 = week grid, labels in
        // the month strip only. The px/day scale always makes the window fit the scroll
        // port; content older/newer extends the axis and stays reachable by scrolling.
        const ZOOMS = {
          d: { win: 14, cell: 'day' },
          w1: { win: 7, cell: 'day' },
          m1: { win: 31, cell: 'day' },
          m3: { win: 93, cell: 'week' },
          m6: { win: 183, cell: 'week' },
          y1: { win: 365, cell: 'week0' },
        }
        let zoom = 'm1'
        // Phase 5 item 8 (2026-09-08): TIME PAGING. dayOffset shifts the visible window
        // back in whole days (0 = the today-forward window — the board's home). The ‹
        // button pages one window older, › one window newer (capped at 0). While browsing
        // the past the axis is EXACTLY the window (no future overflow, no scroll); at
        // dayOffset 0 future data may still extend the axis — scroll only appears when
        // real data needs it (the old +2-day padding that always forced a scrollbar is
        // gone: an empty board now fits the port with zero horizontal scroll).
        let dayOffset = 0
        let range = { start: 0, end: 1 } // absolute day indexes inclusive
        // S44 (owner: “there must be some space and offset to today's timeline on sprints
        // so you can see the actual point”): the home window LEADS with a small pad of
        // EMPTY days before today — the today line never sits flush at the axis's leading
        // edge (clipped, indistinguishable from the border). The pad rides the fit (part
        // of the px denominator), so a data-free board still fills the port with ZERO
        // horizontal scroll; the 2026-08-30 (e) “never show passed dates” rule keeps its
        // real meaning — no past DATA renders by default, the pad is bare grid context.
        let todayPad = 0
        // S152: the 16 curated fill+ink pairs (radio values carry "fill/ink" — the
        // submit splits them). The tiles' colors come from the --cat-sw-* tokens' same
        // table (src/lib/categories.ts on the server; variables.css on the client).
        const PALETTE = ['#F0CCCC/#682727', '#F0D9CC/#683F27', '#F0E7CC/#685727', '#ECF0CC/#5F6827', '#DEF0CC/#476827', '#D0F0CC/#2F6827', '#CCF0D5/#276837', '#CCF0E2/#27684F', '#CCF0F0/#276868', '#CCE2F0/#274F68', '#CCD5F0/#273768', '#D0CCF0/#2F2768', '#DECCF0/#472768', '#ECCCF0/#5F2768', '#F0CCE7/#682757', '#F0CCD9/#68273F']

        const lang = () => (window.hibanaI18n && window.hibanaI18n.lang ? window.hibanaI18n.lang() : 'en')

        // ---- lane visibility (per-browser UI pref; ● shown / ○ hidden) --------------------
        const HIDE_KEY = 'spHideLanes'
        const hiddenLanes = () => { try { return JSON.parse(localStorage.getItem(HIDE_KEY) || '[]') } catch { return [] } }
        const laneHidden = (id) => hiddenLanes().indexOf(id) >= 0
        const setLaneHidden = (id, on) => {
          const h = hiddenLanes().filter((x) => x !== id)
          if (on) h.push(id)
          localStorage.setItem(HIDE_KEY, JSON.stringify(h))
        }

        // ---- task clip edges: manual trim beats automatic (start_at/end_at override
        // created_at → done_at|today; NULL keeps the automatic behavior) --------------------
        // 2026-08-30 (e) — the axis is TODAY-FORWARD (no passed dates, user rule), so an
        // ongoing task without an end date now renders to the END of the axis: drawing it
        // "until today" would collapse every ongoing task into a sliver at the left edge.
        // tEndFixed returns null for ongoing tasks; tEnd is the rendering-time view.
        const tStart = (x) => {
          if (x.start_at) { const i = B().dayIdx(x.start_at); if (Number.isFinite(i)) return i }
          const i = B().dayIdx(x.created_at)
          return Number.isFinite(i) ? i : null
        }
        const tEndFixed = (x) => {
          if (x.end_at) { const i = B().dayIdx(x.end_at); if (Number.isFinite(i)) return i }
          if (x.status === 'done' && x.done_at) { const i = B().dayIdx(x.done_at); if (Number.isFinite(i)) return i }
          return null // ongoing — no fixed end
        }
        const tEnd = (x) => { const e = tEndFixed(x); return e == null ? range.end : e }

        function computeRange() {
          const S = B().state
          const today = B().todayIdx()
          const win = ZOOMS[zoom].win
          // S44: ~10% of the window leads as empty days before today (min 2). When
          // sprint history reaches further back, it wins — the pad is a floor, not a cap.
          todayPad = dayOffset === 0 ? Math.max(2, Math.round(win * 0.1)) : 0
          // 2026-08-30 (e) user rule: NEVER show a passed date by default — the window
          // starts at TODAY and only ever extends forward (dayOffset < 0 is the explicit
          // "go back in time" page). Past indexes clamp to the window start or drop out
          // entirely at render time, exactly as before.
          let min = today + dayOffset - todayPad
          // S46.12 (owner: "the sprint should only show current month"): the S35 backward
          // extension that showed older sprints (up to 179 days back) is REMOVED — the
          // window stays at the current month (today ± todayPad forward). Older sprints
          // are reachable via the ‹ pager (dayOffset < 0). The timeline is more compact
          // + there's more space for tasks.
          // (The S35 block that was here iterated S.sprints + extended `min` backward
          // to include finished sprints overlapping the last ~6 months — removed.)
          // END-INCLUSIVE window: the home window keeps its full `win` FUTURE days (the
          // pad only adds leading context, it never eats the future); a past-browsing
          // window is exactly `win` days as before. The px scale is avail/(win+pad), so
          // an un-extended axis is EXACTLY the port's width — zero horizontal scroll when
          // the data fits (the old +1/+2 padding always left a sliver of scrollbar, even
          // on an empty board).
          let max = (dayOffset === 0 ? today : min) + win - 1
          if (dayOffset === 0) {
            // The home window: future data (task ends, sprint bounds) may extend the
            // axis — the ONLY source of horizontal scroll, and only when data needs it.
            const idxs = []
            S.tasks.forEach((x) => { const a = tStart(x); if (a != null) idxs.push(a); const b = tEndFixed(x); if (b != null) idxs.push(b) })
            S.sprints.forEach((s) => {
              if (s.is_draft) return // drafts live in the draft panel, never on the axis
              const a = B().dayIdx(s.started_at); if (Number.isFinite(a)) idxs.push(a)
              if (s.ended_at) { const b = B().dayIdx(s.ended_at); if (Number.isFinite(b)) idxs.push(b) }
            })
            idxs.forEach((n) => { if (Number.isFinite(n) && n > max) max = n })
          }
          range = { start: min, end: max }
        }
        const totalDays = () => range.end - range.start + 1
        const pctOf = (i) => ((i - range.start) / totalDays()) * 100
        const clampIdx = (i) => Math.max(range.start, Math.min(range.end, i))

        // ---- real week numbers: ISO 8601 (en) / Jalali week-of-year, Saturday-anchored (fa)
        function isoWeekOf(idx) {
          const d = new Date(idx * B().DAY)
          const thu = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
          thu.setUTCDate(thu.getUTCDate() - ((thu.getUTCDay() + 6) % 7) + 3)
          const jan4 = new Date(Date.UTC(thu.getUTCFullYear(), 0, 4))
          jan4.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + 3)
          return 1 + Math.round((thu.getTime() - jan4.getTime()) / (7 * B().DAY))
        }
        function jalaliWeekOf(idx) {
          if (!window.jalaali) return isoWeekOf(idx)
          const nowruzOf = (jy) => { const g = window.jalaali.toGregorian(jy, 1, 1); return B().dayIdx(Date.UTC(g.gy, g.gm - 1, g.gd)) }
          let jy = B().calOf(idx, 'fa').y
          let start = nowruzOf(jy)
          if (start > idx) { jy -= 1; start = nowruzOf(jy) }
          const off = B().weekdayIdx(start, 'fa') // 0=Sat..6=Fri
          return Math.floor((idx - start + off) / 7) + 1
        }
        const weekNum = (idx, L) => (L === 'fa' ? jalaliWeekOf(idx) : isoWeekOf(idx))

        // pointer x → absolute day (direction-aware: the axis runs inline-start→inline-end)
        function xToDay(clientX) {
          const r = tlEl.getBoundingClientRect()
          const rtl = document.documentElement.dir === 'rtl'
          const frac = rtl ? (r.right - clientX) / r.width : (clientX - r.left) / r.width
          return range.start + frac * totalDays()
        }
        const dayIso = (idx) => new Date(Math.round(idx) * B().DAY).toISOString()
        // dark/light bar text by fill luminance
        const darkText = (hex) => {
          const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''))
          if (!m) return true
          const n = parseInt(m[1], 16)
          return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 > 0.62
        }

        // S45/S7: the no-sprints lane speaks the app's empty-state language — a dashed
        // card with a ◆ tile, a one-line hint, and a CTA that opens the SAME define
        // popover as the toolbar (data-sp-empty-define → #sp-new-sprint). Replaces the
        // old bare span — which was also permanently ENGLISH (its `lang === 'fa'`
        // ternary compared the lang FUNCTION to a string: always false). Render-time
        // _t(), same law as the S1 popover fix.
        const sprintEmptyHtml = () =>
          '<div class="sp-empty">' +
            '<span class="sp-empty-icon" aria-hidden="true">◆</span>' +
            '<span class="sp-empty-body">' +
              '<span class="sp-empty-title">' + B().esc(_t('db.noSprintsYet', 'No sprints yet — create one')) + '</span>' +
              '<span class="sp-empty-hint">' + B().esc(_t('sp.emptyHint', 'Define it, add items, start it — it runs here as a strip.')) + '</span>' +
            '</span>' +
            '<button type="button" class="btn small sp-empty-cta" data-sp-empty-define>◆ ' + B().esc(_t('db.defineSprintOk', 'Define')) + '</button>' +
          '</div>'

        // sidebar ----------------------------------------------------------------
        function renderSide() {
          const S = B().state
          const groups = S.categories.filter((c) => !c.is_archived).map((c) => ({ cat: c, tasks: S.tasks.filter((x) => x.category_id === c.id) })) // S152: archived leaves the grouping
          const uncategorized = S.tasks.filter((x) => !x.category_id || !B().findCategory(x.category_id))
          groups.push({ cat: null, tasks: uncategorized })
          sideEl.innerHTML =
            // S45/S1: injected DOM is never re-scanned by i18n.js's static apply()
            // pass — translate AT RENDER via _t() (boot already awaits
            // hibanaI18n.ready, so the FA dictionary has landed by now).
            '<div class="sp-side-head">' + B().esc(_t('db.categories', 'Categories')) + '</div>' +
            groups.map((g) => {
              const color = g.cat ? g.cat.color_fill : '#CCD5F0'
              const ink = g.cat ? g.cat.color_text : '#273768'
              const name = g.cat ? g.cat.name : _t('db.uncategorized', 'Uncategorized')
              const gid = g.cat ? g.cat.id : 'none'
              const hid = g.cat ? laneHidden(g.cat.id) : false
              return '<div class="sp-cat' + (hid ? ' is-lane-hidden' : '') + '" data-spcat="' + gid + '">' +
                '<div class="sp-cat-head" data-cat-toggle="' + gid + '" data-open="0">' +
                  '<button type="button" class="sp-cat-chevron" tabindex="-1" aria-hidden="true" style="transform:rotate(-90deg)">▾</button>' +
                  '<span class="sp-cat-badge" style="background:' + color + '2E;color:' + ink + '">' + B().esc(name) + '</span>' +
                  '<span class="detail-tab-count">' + B().faDig(g.tasks.length) + '</span>' +
                  (g.cat
                    ? '<span class="sp-cat-tools">' +
                        '<button type="button" class="ghost small" data-cat-eye="' + gid + '" title="' + B().esc(_t(hid ? 'db.showLane' : 'db.hideLane', hid ? 'Show on timeline' : 'Hide on timeline')) + '" aria-label="' + B().esc(_t(hid ? 'db.showLane' : 'db.hideLane', hid ? 'Show on timeline' : 'Hide on timeline')) + '">' + (hid ? '○' : '●') + '</button>' +
                        '<button type="button" class="ghost small" data-cat-edit="' + gid + '" aria-label="' + B().esc(_t('db.editCategory', 'Edit category')) + '" title="' + B().esc(_t('db.editCategory', 'Edit category')) + '">✎</button>' +
                        '<button type="button" class="ghost small sp-cat-del" data-cat-del="' + gid + '" aria-label="' + B().esc(_t('common.delete', 'Delete')) + '" title="' + B().esc(_t('common.delete', 'Delete')) + '">✕</button>' +
                      '</span>'
                    : '') +
                '</div>' +
                '<ul class="sp-cat-tasks is-collapsed">' +
                  g.tasks.map((task) =>
                    '<li class="sp-task" draggable="true" data-sptask="' + task.id + '" data-task="' + task.id + '">' +
                      '<span class="sp-task-st st-' + task.status + '"></span>' +
                      '<span class="sp-task-title">' + B().esc(task.title) + '</span>' +
                      (task.sprint_id && B().findSprint(task.sprint_id) ? '<span class="db-sprint-badge">◆</span>' : '') +
                    '</li>').join('') +
                  '<li class="sp-task-addrow"><input maxlength="300" dir="auto" data-quickadd="' + gid + '" placeholder="' + B().esc(_t('db.quickAdd', '+ task')) + '"></li>' +
                '</ul>' +
              '</div>'
            }).join('') +
            '<div class="sp-side-foot"><button type="button" class="db-add" data-new-category>＋ ' + B().esc(_t('db.newCategory', 'New category…')) + '</button>' +
            '<form class="pd-tag-pop sp-cat-pop" data-cat-form hidden>' +
              '<input name="name" maxlength="80" dir="auto" placeholder="' + B().esc(_t('db.categoryName', 'Category name (Feature Development…)')) + '" required>' +
              '<div class="pd-tag-colors">' + PALETTE.map((c, i) => {
                const pr = c.split('/')
                return '<label class="pd-swatch"><input type="radio" name="catcolor" value="' + c + '" ' + (i === 0 ? 'checked' : '') + '><span style="background:' + pr[0] + ';color:' + pr[1] + '"><b aria-hidden="true">Aa</b></span></label>'
              }).join('') + '</div>' +
              '<div class="row"><button type="button" class="ghost small" data-cat-cancel>' + B().esc(_t('common.cancel', 'Cancel')) + '</button><button type="submit" class="small">' + B().esc(_t('common.add', 'Add')) + '</button></div>' +
            '</form></div>'
        }

        // timeline ----------------------------------------------------------------
        function sprintGeom() {
          const S = B().state
          return S.sprints
            .filter((s) => !s.is_draft) // Phase 5: drafts are panel-rendered, never axis-rendered
            .slice()
            .sort((a, b) => B().dayIdx(a.started_at) - B().dayIdx(b.started_at))
            .map((s) => {
              const s0raw = B().dayIdx(s.started_at)
              const open = !s.ended_at
              const s1raw = open ? null : B().dayIdx(s.ended_at)
              // WINDOW-relative (Phase 5 item 8): a sprint that ended before the visible
              // window's start drops off — paging back with ‹ brings it back (that is
              // exactly the "go back in time and see previous sprints" affordance). At
              // the home window (dayOffset 0) the window starts at today, so finished
              // sprints keep dropping exactly like the 2026-08-30 (e) rule requires.
              if (!open && Number.isFinite(s1raw) && s1raw < range.start) return null
              // a sprint starting beyond the axis end has nothing to show either
              if (Number.isFinite(s0raw) && s0raw > range.end) return null
              const s0 = Math.max(s0raw, range.start)
              const s1 = open ? range.end : (Number.isFinite(s1raw) ? Math.max(s1raw, range.start) : range.start)
              return { s, s0, s1, open }
            })
            .filter(Boolean)
        }

        // S35: the strip's progress is built from the same truth the board uses —
        // dev_tasks ASSIGNED to the sprint (the fill ratio) + every task DONE inside the
        // sprint's date window (ticks, one per day with ≥1 done: the «انجام شده» column
        // and anything checked done) + the plan doc's own [x] checkboxes (S34 editor).
        function sprintStats(s) {
          const S = B().state
          const assigned = S.tasks.filter((t) => t.sprint_id === s.id)
          const done = assigned.filter((t) => t.status === 'done')
          const s0r = B().dayIdx(s.started_at)
          const s1r = s.ended_at ? B().dayIdx(s.ended_at) : B().todayIdx()
          const days = new Map()
          S.tasks.forEach((t) => {
            if (t.status !== 'done' || !t.done_at) return
            const i = B().dayIdx(t.done_at)
            if (!Number.isFinite(i) || i < s0r || i > s1r) return
            const list = days.get(i)
            if (list) list.push(t.title)
            else days.set(i, [t.title])
          })
          const docChecked = (String(s.description || '').match(/^- \[x\] /gm) || []).length
          // S48p: category breakdown — count tasks per category in this sprint
          const catMap = new Map()
          assigned.forEach((t) => {
            if (!t.category_id) return
            const cat = S.categories.find((c) => c.id === t.category_id)
            const name = cat ? cat.name : '—'
            catMap.set(name, (catMap.get(name) || 0) + 1)
          })
          const categories = Array.from(catMap.entries()).map(([name, count]) => ({ name, count }))
          return { assigned: assigned.length, done: done.length, days, docChecked, categories }
        }

        // strip extent as a % of the sprint container: open sprints run to TODAY (the
        // clip "drags" along like footage being recorded), finished ones to their end.
        const clipPctOf = (g) => {
          const today = B().todayIdx()
          const span = Math.max(g.s1 - g.s0, 0.001)
          const end = g.open ? Math.max(Math.min(today, g.s1), g.s0) : g.s1
          return Math.max(Math.min(((end - g.s0) / span) * 100, 100), 1)
        }

        function renderTimeline() {
          const S = B().state
          const L = lang()
          const total = totalDays()
          // window-fit scale: the zoom window always fills the scroll port; older/newer
          // content extends the axis (scrollable). One shared px/day for cells + bars.
          const scEl = document.getElementById('sp-scroll')
          const avail = Math.max(280, (scEl ? scEl.clientWidth : 800) - 2)
          // S44: the pad days are part of the fit — the window + leading context fill
          // the port together, keeping the zero-scroll property for a data-free board.
          const px = Math.max(0.5, avail / (ZOOMS[zoom].win + todayPad))
          const width = Math.round(total * px)
          tlEl.style.setProperty('--sp-width', width + 'px')

          // month strip (all zooms — merges across sub-cell kinds)
          let monthsHtml = ''
          let mStart = range.start
          while (mStart <= range.end) {
            const label = B().monthLabel(mStart, L)
            let mEnd = mStart
            while (mEnd + 1 <= range.end && B().monthLabel(mEnd + 1, L) === label) mEnd++
            monthsHtml += '<div class="sp-month" style="inline-size:' + ((mEnd - mStart + 1) * px).toFixed(2) + 'px">' + B().esc(label) + (L === 'fa' ? ' ' + B().faDig(B().calOf(mStart, L).y) : '') + '</div>'
            mStart = mEnd + 1
          }

          // sub-cells: day numbers / week numbers / silent week grid at 12M
          const kind = ZOOMS[zoom].cell
          let cellsHtml = ''
          if (kind === 'day') {
            for (let i = range.start; i <= range.end; i++) {
              cellsHtml += '<div class="sp-cell' + (i === B().todayIdx() ? ' is-today' : '') + '" style="inline-size:' + px.toFixed(2) + 'px">' + B().dayLabel(i, L) + '</div>'
            }
          } else {
            const anchor = L === 'fa' ? 0 : 1 // fa week starts Saturday; en Monday
            let i = range.start
            while (i <= range.end) {
              if (B().weekdayIdx(i, L) === anchor || i === range.start) {
                let j = i
                let guard = 0
                while (j + 1 <= range.end && guard < 8) {
                  if (B().weekdayIdx(j + 1, L) === anchor) break
                  j++; guard++
                }
                const w = ((j - i + 1) * px).toFixed(2)
                if (kind === 'week') {
                  const wn = B().faDig(weekNum(i, L))
                  const tip = B().esc(_t('db.weekNum', 'Week {n}').replace('{n}', wn) + ' · ' + B().fullLabel(i, L))
                  cellsHtml += '<div class="sp-cell sp-cell-week" style="inline-size:' + w + 'px" title="' + tip + '">' + wn + '</div>'
                } else {
                  cellsHtml += '<div class="sp-cell sp-cell-week" style="inline-size:' + w + 'px"></div>'
                }
                i = j + 1
              } else i++
            }
          }

          // sprint geometry: zebra bands + draggable boundary lines + lane chips
          const geom = sprintGeom()
          let bgHtml = ''
          geom.forEach((g, gi) => {
            const left = pctOf(g.s0)
            const w = Math.max(pctOf(g.s1) - left, 0.8)
            // S243 (spec §5.5 — the paused render): a PAUSED sprint keeps its open
            // window on the axis (assumption 7 — it never blocks anything) but
            // reads DISTINCTLY: the band wears the paused hatch, the chip a ⏸ mark.
            const paused = B().sprintStatusOf(g.s) === 'paused'
            bgHtml += '<div class="sp-band' + (gi % 2 ? ' is-alt' : '') + (g.open ? ' is-open-band' : '') + (paused ? ' is-paused-band' : '') + '" data-band="' + g.s.id + '" style="inset-inline-start:' + left + '%;inline-size:' + w + '%"></div>'
            bgHtml += '<div class="sp-bound' + (paused ? ' is-paused-bound' : '') + '" data-bound="' + g.s.id + '" data-edge="start" style="inset-inline-start:' + left + '%"><i class="sp-bound-grip" aria-hidden="true"></i></div>'
            bgHtml += '<div class="sp-bound' + (g.open ? ' is-open-bound' : '') + (paused ? ' is-paused-bound' : '') + '" data-bound="' + g.s.id + '" data-edge="end" style="inset-inline-start:' + pctOf(g.s1) + '%"><i class="sp-bound-grip" aria-hidden="true"></i></div>'
          })
          // S48k: position the today line at the CENTER of today's cell (was: left edge =
          // the boundary between yesterday + today, which read as "off by one"). Half a
          // cell width = 100 / totalDays / 2 percent.
          const todayPct = pctOf(B().todayIdx()) + (100 / totalDays() / 2)
          const todayLine = '<div class="sp-today-line" style="inset-inline-start:' + todayPct + '%">' +
            '<span class="sp-today-flag" dir="auto">' + B().esc(_t('db.today', 'Today')) + '</span>' +
          '</div>'

          let sprintLane = ''
          geom.forEach((g) => {
            const left = pctOf(g.s0)
            const w = Math.max(pctOf(g.s1) - left, 1.2)
            const paused = B().sprintStatusOf(g.s) === 'paused' // S243: the distinct paused render
            // S35 (the video-editing strip): [●start-dot ▶ strip …live-edge●] — the chip
            // carries name + duration + done stats; the strip itself is the sprint's
            // lifetime (open → grows to today, finished → frozen at its end) with a
            // progress fill (assigned tasks done) and a tick for every day that closed
            // at least one task. Bidi law: the chip's stats span is dir="auto".
            const st = sprintStats(g.s)
            const L2 = lang()
            const s0raw = B().dayIdx(g.s.started_at)
            const s1raw = g.s.ended_at ? B().dayIdx(g.s.ended_at) : B().todayIdx()
            const dur = Math.max(s1raw - s0raw + 1, 1)
            const durTxt = g.open
              ? _t('db.sprintDay', 'Day {n}').replace('{n}', B().faDig(dur))
              : _t('db.sprintDays', '{n} days').replace('{n}', B().faDig(dur))
            const statsTxt = (st.assigned
              ? '✓ ' + B().faDig(st.done) + '/' + B().faDig(st.assigned)
              : '✓ ' + B().faDig(st.done)) + (st.docChecked ? ' · ☑ ' + B().faDig(st.docChecked) : '')
            const chipStats = '<span class="sp-chip-stats" dir="auto">' + (paused ? '⏸ · ' : '') + ' · ' + B().esc(durTxt) + ' · ' + B().esc(statsTxt) + '</span>'
            const clipPct = clipPctOf(g)
            const fillPct = st.assigned ? Math.round((st.done / st.assigned) * 100) : 0
            let ticksHtml = ''
            const clipEndIdx = g.open ? Math.max(Math.min(B().todayIdx(), g.s1), g.s0) : g.s1
            const clipSpan = Math.max(clipEndIdx - g.s0, 0.001)
            Array.from(st.days.keys())
              .filter((i) => i >= g.s0 && i <= clipEndIdx)
              .sort((a, b) => a - b)
              .forEach((i) => {
                const p = Math.max(Math.min(((i - g.s0) / clipSpan) * 100, 100), 0)
                const titles = (st.days.get(i) || []).join(' · ')
                ticksHtml += '<i class="sp-clip-tick" style="inset-inline-start:' + p.toFixed(2) + '%" title="' +
                  B().esc(B().fullLabel(i, L2) + ' — ' + titles) + '" aria-hidden="true"></i>'
              })
            sprintLane += '<div class="sp-sprint' + (g.open ? ' is-open' : '') + (paused ? ' is-paused' : '') + '" data-sprint="' + g.s.id + '" data-bandmove="' + g.s.id + '" style="inset-inline-start:' + left + '%;inline-size:' + w + '%">' +
              '<button type="button" class="sp-sprint-chip" data-sprint-menu="' + g.s.id + '" title="' + B().esc((paused ? '⏸ ' : '') + g.s.name + ' · ' + durTxt + ' · ' + statsTxt) + '">' +
                '<span class="sp-diamond">◆</span><span dir="auto">' + B().esc(g.s.name) + '</span>' + chipStats +
              '</button>' +
              '<i class="sp-startdot" aria-hidden="true"></i>' +
              '<div class="sp-clip' + (g.open ? ' is-open-clip' : '') + '" style="inline-size:' + clipPct.toFixed(2) + '%">' +
                '<div class="sp-clip-fill" style="inline-size:' + fillPct + '%"></div>' +
                ticksHtml +
              '</div>' +
              (g.open ? '' : '<i class="sp-enddot" aria-hidden="true"></i>') +
            '</div>'
          })

          // category lanes (hidden lanes simply not rendered). Bars whose fixed end is
          // before the visible window have nothing to show — dropped (2026-08-30 (e) for
          // the today window; Phase 5 item 8 keeps the rule window-relative so paging
          // back resurrects past bars); ongoing tasks extend to the axis end via tEnd().
          // While BROWSING THE PAST a bar that starts after the window end (future work)
          // is dropped too — the window is the focus, not the future.
          const hide = hiddenLanes()
          const groups = S.categories.filter((c) => hide.indexOf(c.id) < 0 && !c.is_archived) // S152: archived leaves the lanes
            .map((c) => ({ cat: c, tasks: S.tasks.filter((x) => x.category_id === c.id) }))
          groups.push({ cat: null, tasks: S.tasks.filter((x) => !x.category_id || !B().findCategory(x.category_id)) })
          const lanesHtml = groups.map((g) => {
            const color = g.cat ? g.cat.color_fill : '#CCD5F0'
            const visTasks = g.tasks.filter((task) => {
              const b = tEndFixed(task)
              if (b != null && b < range.start) return false // ended before the window
              const a = tStart(task)
              if (dayOffset < 0 && a != null && a > range.end) return false // future work while browsing the past
              return b == null || b >= range.start // ongoing, or ends inside/after the window
            })
            const laneH = Math.max(visTasks.length, 1) * 28 + 10
            // S48k: show ALL tasks on the timeline (was: only in_progress + done). Tasks
            // with other statuses (idea/planned/bug) appear as muted dots so the user
            // sees their planned work alongside active work. The status class on the dot
            // controls the color: st-active (teal), st-done (green + ✓), st-planned (grey).
            const dotStatusClass = (st) => st === 'done' ? 'st-done' : st === 'in_progress' ? 'st-active' : 'st-planned'
            const bars = visTasks.map((task, ti) => {
              const a0 = tStart(task)
              const t0 = clampIdx(a0 == null ? range.start : a0)
              // S48m: position the dot at the CENTER of its day cell (was: LEFT edge).
              // The today line is at the CENTER of today's cell. A task created today
              // should have its dot AT the today line, not past it (the 20px dot extended
              // to the right of the LEFT edge, reading as "past the line").
              const left = pctOf(t0) + (100 / totalDays() / 2)
              const txt = darkText(color) ? '#20242c' : '#ffffff'
              const isDone = task.status === 'done'
              const dotClass = 'sp-dot ' + dotStatusClass(task.status)
              return '<div class="' + dotClass + '" draggable="true" data-bar="' + task.id + '" data-task="' + task.id + '" ' +
                'style="inset-inline-start:' + left + '%;inset-block-start:' + (4 + ti * 24) + 'px" ' +
                'title="' + B().esc(task.title) + ' · ' + B().esc(B().prioLabel(task.priority)) + '">' +
                '<span class="sp-dot-prio prio-' + task.priority + '" title="' + B().esc(B().prioLabel(task.priority)) + '" aria-label="' + B().esc(B().prioLabel(task.priority)) + '"></span>' +
                (isDone ? '<span class="sp-dot-check">✓</span>' : '') +
              '</div>'
            }).join('')
            // Also render the full bars for ALL tasks but HIDDEN (opacity:0, pointer-events:none)
            // — they're still draggable/editable via the sidebar. The visible graph is circles only.
            const hiddenBars = visTasks.map((task, ti) => {
              const a0 = tStart(task)
              const t0 = clampIdx(a0 == null ? range.start : a0)
              const t1 = clampIdx(tEnd(task))
              const left = pctOf(t0)
              const w = Math.max(pctOf(t1) - left, 0.8)
              const cls = 'sp-bar st-' + task.status
              return '<div class="' + cls + '" draggable="true" data-bar="' + task.id + '" data-task="' + task.id + '" ' +
                'style="--bar-c:' + color + ';inset-inline-start:' + left + '%;inline-size:' + w + '%;inset-block-start:' + (5 + ti * 28) + 'px;opacity:0;pointer-events:none;height:0;overflow:hidden">' +
                '<span class="sp-bar-title">' + B().esc(task.title) + '</span>' +
              '</div>'
            }).join('')
            return '<div class="sp-lane" data-lane="' + (g.cat ? g.cat.id : 'none') + '" style="min-block-size:' + laneH + 'px">' + bars + hiddenBars + '</div>'
          }).join('')

          tlEl.innerHTML =
            '<div class="sp-head" style="--sp-width:' + width + 'px">' +
              '<div class="sp-months">' + monthsHtml + '</div>' +
              '<div class="sp-cells">' + cellsHtml + '</div>' +
            '</div>' +
            '<div class="sp-body" style="--sp-width:' + width + 'px">' +
              '<div class="sp-bg">' + bgHtml + todayLine + '</div>' +
              '<div class="sp-sprint-lane">' + (sprintLane || sprintEmptyHtml()) + '</div>' +
              lanesHtml +
            '</div>'

          // center today on first render / zoom change — with the today-forward axis
          // (2026-08-30 (e)) today IS the leading edge, so this settles at scroll 0
          // (or the far end in RTL) and the board always opens on the current day.
          const sc = document.getElementById('sp-scroll')
          if (!sc.dataset.scrolled) {
            sc.dataset.scrolled = '1'
            const px2 = width / total
            const before = Math.max(0, B().todayIdx() - range.start) * px2
            if (lang() === 'fa' || document.documentElement.dir === 'rtl') {
              sc.scrollLeft = sc.scrollWidth - sc.clientWidth - Math.max(0, before - sc.clientWidth * 0.4)
            } else {
              sc.scrollLeft = Math.max(0, before - sc.clientWidth * 0.4)
            }
          }
        }

        const render = () => { computeRange(); renderSide(); renderTimeline(); renderDraft(); renderTimeNav(); renderFinishBtn(); renderSprintsList(); wrap.hidden = false; if (loading) loading.hidden = true }
        const reload = async () => { await B().load(projectId); render() }

        // ---- Phase 5 item 7: the DRAFT sprint panel ---------------------------------
        // A defined-but-not-started sprint (started_at NULL) renders HERE — name (inline
        // editable), item count, Start/Delete buttons, and a DROP TARGET: dragging a
        // timeline bar or a sidebar task onto the card assigns it to the draft sprint.
        // Quick-added items join the draft automatically (server-side preference).
        function renderDraft() {
          const el = document.getElementById('sp-draft')
          if (!el) return
          const S = B().state
          const draft = S.sprints.find((s) => s.is_draft) || null
          if (!draft) { el.hidden = true; el.textContent = ''; return }
          const items = S.tasks.filter((t) => t.sprint_id === draft.id)
          el.hidden = false
          el.innerHTML =
            '<div class="sp-draft-card" data-sp-draft-card="' + draft.id + '">' +
              '<div class="sp-draft-head">' +
                '<span class="sp-diamond">◆</span>' +
                '<input class="sp-draft-name" data-sp-draft-name maxlength="80" dir="auto" value="' + B().esc(draft.name) + '" aria-label="' + B().esc(_t('db.sprintName', 'Sprint name')) + '">' +
                '<span class="detail-tab-count">' + B().faDig(items.length) + '</span>' +
              '</div>' +
              '<p class="sp-draft-hint muted small">' + B().esc(_t('db.draftHint', 'Add items in the sidebar or drag them here — they join this sprint. Start it when ready.')) + '</p>' +
              '<div class="row sp-draft-actions">' +
                '<button type="button" class="btn small" data-sp-draft-start>▸ ' + B().esc(_t('db.startSprint', 'Start sprint')) + '</button>' +
                // S33: the draft's plan doc — deep-links into the project page's
                // full-screen sprint editor (?sprint= opens it directly).
                '<a class="btn ghost small" href="/project.html?id=' + encodeURIComponent(projectId) + '&sprint=' + encodeURIComponent(draft.id) + '" title="' + B().esc(_t('sprint.openDoc', 'Open the sprint plan — the full-screen editor')) + '">' + B().esc(_t('sprint.plan', 'Plan')) + '</a>' +
                '<button type="button" class="btn ghost danger small" data-sp-draft-del>' + B().esc(_t('common.delete', 'Delete')) + '</button>' +
              '</div>' +
            '</div>'
          const nameIn = el.querySelector('[data-sp-draft-name]')
          nameIn.addEventListener('change', async () => {
            const name = nameIn.value.trim()
            if (!name || name === draft.name) return
            try { await B().renameSprint(draft.id, name); await reload() }
            catch { window.hibana && window.hibana.toast(_t('sparks.saveFailed', "Couldn't save"), 'err') }
          })
          el.querySelector('[data-sp-draft-start]').onclick = async () => {
            // S243 (spec §5.2 + Screen H1): the one-active conflict resolves through
            // the shared flow — a planned draft starts through /start, and another
            // active sprint opens the H1 modal (pause-or-finish current & start).
            try {
              await B().startSprintWithConflict(draft.id, { onDone: () => { dayOffset = 0; reload() } })
            } catch { window.hibana && window.hibana.toast(_t('sparks.saveFailed', "Couldn't save"), 'err') }
          }
          el.querySelector('[data-sp-draft-del]').onclick = async () => {
            // S243 (spec §6 + Screen I): the plain db.delSprintConfirm confirm is
            // replaced by the exact-counts delete modal (planned = deletable; the
            // archived-with-snapshot count rides the lazy archives list).
            try { await B().openSprintDelete(draft, { projectId: projectId, onDone: reload }) }
            catch { window.hibana && window.hibana.toast(_t('sparks.saveFailed', "Couldn't save"), 'err') }
          }
        }

        // ---- Phase 5 item 8: the time-nav (‹ older · label · newer ›) ----------------
        // Prev pages one window older (disabled when no data exists before the window);
        // Next pages newer, capped at the today window (offset 0). The label shows the
        // visible range; at home it reads «الان» + the range.
        function renderTimeNav() {
          const prev = document.getElementById('sp-time-prev')
          const next = document.getElementById('sp-time-next')
          const lbl = document.getElementById('sp-timerange')
          if (!prev || !next || !lbl) return
          const L = lang()
          // earliest data anywhere (tasks' starts + started sprints) — nothing older to see?
          const S = B().state
          let earliest = Infinity
          S.tasks.forEach((x) => { const a = tStart(x); if (a != null && a < earliest) earliest = a })
          S.sprints.forEach((s) => { if (!s.is_draft) { const a = B().dayIdx(s.started_at); if (Number.isFinite(a) && a < earliest) earliest = a } })
          prev.disabled = !Number.isFinite(earliest) || earliest >= range.start
          next.disabled = dayOffset >= 0
          // S35: the home window extends back over sprint history, so the label shows
          // the ACTUAL axis span (not the nominal zoom window).
          const w0 = range.start
          const w1 = range.end
          const rangeTxt = B().fullLabel(w0, L) + ' — ' + B().fullLabel(w1, L)
          lbl.textContent = (dayOffset === 0 ? _t('sp.now', 'Now') + ' · ' : '') + rangeTxt
          lbl.title = rangeTxt
        }

        // ---- Phase 5 item 7: the prominent FINISH button (toolbar) ------------------
        function renderFinishBtn() {
          const btn = document.getElementById('sp-finish-btn')
          const lbl = document.getElementById('sp-finish-lbl')
          const nameEl = document.getElementById('sp-finish-name')
          if (!btn || !lbl) return
          const S = B().state
          const open = S.sprints.find((s) => !s.is_draft && !s.ended_at) || null
          // S46.12 (owner: "this button still doesn't work at all, either when there is a
          // sprint active or there is no sprint at all"): the button is ALWAYS VISIBLE now
          // (was: btn.hidden = !open → hidden when no active sprint). When no open sprint,
          // it's disabled (greyed out) with a "no active sprint" tooltip. When there IS an
          // open sprint, it's enabled + carries the sprint name + the finish hint.
          btn.hidden = false
          if (open) {
            btn.disabled = false
            lbl.textContent = _t('db.finishSprint', 'Finish sprint')
            if (nameEl) {
              if (open.name) { nameEl.hidden = false; nameEl.textContent = '· ' + open.name }
              else nameEl.hidden = true
            }
            btn.title = _t('db.finishSprintHint', 'Finish this sprint — its window closes and the next one can be defined') + (open.name ? ' — ' + open.name : '')
            btn.setAttribute('aria-label', btn.title)
          } else {
            btn.disabled = true
            lbl.textContent = _t('db.finishSprint', 'Finish sprint')
            if (nameEl) nameEl.hidden = true
            btn.title = _t('sp.noActiveSprint', 'No active sprint to finish')
            btn.setAttribute('aria-label', btn.title)
          }
        }

        // S46.10 (owner: "see the sprints in a list — Sprint A, Sprint B. Create this
        // section below the sprint timeline as a separate section.") — S243 (spec §7.3
        // + Screen E — D5): the flat list became the lifecycle-grouped OVERVIEW —
        // Active / Planned / Paused / Completed history. Each row: the identity glyph,
        // name, lifecycle badge, dates, REAL task count (the s206 fix) + the due date
        // when present. The row opens the Settings/Tasks detail panel (Screen F); the
        // ⋯ button keeps the quick-action popover (data-sprint-menu — the timeline
        // chip's twin). The timeline above STAYS (spec §7.3: the list is an addition,
        // never a replacement).
        function renderSprintsList() {
          const section = document.getElementById('sp-sprints-list-section')
          const list = document.getElementById('sp-sprints-list')
          if (!section || !list) return
          const S = B().state
          const all = [...(S.sprints || [])].sort((a, b) => {
            const da = a.started_at || a.created_at || ''
            const db = b.started_at || b.created_at || ''
            return db.localeCompare(da)
          })
          section.hidden = !all.length
          if (!all.length) { list.innerHTML = ''; return }
          const esc = B().esc
          // S243: the four lifecycle groups, in reading order (Active first — the
          // day-to-day sprint; Completed history last, its rows NOT deletable).
          const groups = [
            { key: 'active', label: _t('sp.sectionActive', 'Active') },
            { key: 'planned', label: _t('sp.sectionPlanned', 'Planned') },
            { key: 'paused', label: _t('sp.sectionPaused', 'Paused') },
            { key: 'completed', label: _t('sp.sectionCompleted', 'Completed history') },
          ]
          const byGroup = { active: [], planned: [], paused: [], completed: [] }
          for (const s of all) {
            const stx = B().sprintStatusOf(s)
            ;(byGroup[stx] || byGroup.planned).push(s)
          }
          const statusBadge = (s, stx) => {
            const map = {
              active: ['sp-st-active', _t('db.sprintSt.active', 'Active')],
              planned: ['sp-st-planned', _t('db.sprintSt.planned', 'Planned')],
              paused: ['sp-st-paused', _t('db.sprintSt.paused', 'Paused')],
              completed: ['sp-st-completed', _t('db.sprintSt.completed', 'Completed')],
            }
            const m = map[stx] || map.planned
            return '<span class="sp-list-badge ' + m[0] + '">' + esc(m[1]) + '</span>'
          }
          const fmtDate = (d) => {
            if (!d) return '—'
            // S206: UTC rendering — the timeline axis is UTC-day based, and the browser's
            // local calendar (Tehran +03:30) read an 23:59:59Z end date as the NEXT day,
            // so the list disagreed with the band by one day. timeZone: 'UTC' pins the
            // list to the same days the axis draws (Jalali calendar still applies for fa).
            try { return new Date(d).toLocaleDateString(document.documentElement.lang === 'fa' ? 'fa-IR' : 'en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) } catch { return String(d).slice(0, 10) }
          }
          list.innerHTML = groups.map((g) => {
            const rows = byGroup[g.key]
            if (!rows.length) return ''
            return '<div class="sp-list-group" data-sp-group="' + g.key + '">' +
              '<h4 class="sp-list-group-title muted">' + esc(g.label) + '<span class="detail-tab-count">' + B().faDig(rows.length) + '</span></h4>' +
              rows.map((s) => {
                const stx = B().sprintStatusOf(s)
                // S206 (owner: "the sprint system is buggy" — probe-confirmed): the count
                // used to read (s.items || []).length — the devboard payload NEVER carries
                // an items field on sprint rows (SELECT * FROM sprints), so every row read
                // "0 items" forever. The truth is the task pool: tasks whose sprint_id is
                // this sprint (the same source sprintStats/chips use).
                const itemCount = S.tasks.filter((t) => t.sprint_id === s.id).length
                const dateTxt = s.started_at
                  ? (s.ended_at ? fmtDate(s.started_at) + ' → ' + fmtDate(s.ended_at) : fmtDate(s.started_at) + ' → ' + _t('sp.now', 'now'))
                  : _t('sp.notStarted', 'not started')
                // S243 (spec §7.3/Screen E): the due date rides the row when present —
                // read-only this phase (Phase 5 swaps in the shared date control).
                const dueTxt = s.due_at
                  ? '<span class="sp-list-due muted small">' + esc(_t('db.dueDate', 'Due date')) + ' · ' + esc(fmtDate(s.due_at)) + '</span>'
                  : ''
                return '<div class="sp-list-row" data-sp-open="' + esc(s.id) + '" role="button" tabindex="0" title="' + esc(_t('sp.openSettings', 'Open this sprint\'s settings and tasks')) + '">' +
                  '<span class="sp-list-ident" aria-hidden="true">' + esc(B().sprintGlyph(s)) + '</span>' +
                  '<span class="sp-list-name">' + esc(s.name || _t('sp.untitled', 'Untitled')) + '</span>' +
                  statusBadge(s, stx) +
                  '<span class="sp-list-dates muted small">' + esc(dateTxt) + '</span>' +
                  dueTxt +
                  '<span class="sp-list-items muted small">' + esc(String(itemCount)) + ' ' + _t('sp.items', 'items') + '</span>' +
                  '<button type="button" class="ghost small sp-list-more" data-sprint-menu="' + esc(s.id) + '" aria-label="' + esc(_t('sp.quickActions', 'Quick actions')) + '" title="' + esc(_t('sp.quickActions', 'Quick actions')) + '">⋯</button>' +
                '</div>'
              }).join('') +
            '</div>'
          }).join('')
        }

        // ---- S243 (spec §7.3 + Screen F — D5): the sprint DETAIL panel --------------
        // Settings + Tasks, the two clear sections the spec asks for. A .db-modal
        // dialog (z-95, the S242 quick-create grammar): Settings = name, version,
        // emoji (the shared picker), the read-only due date (Phase 5 swaps in the
        // shared control) + the rich description stays with the S33/S34 full-screen
        // plan editor (extend, never duplicate — a Plan link); Tasks = the five-lane
        // count fold (§12.5 — client-derived, total only) + the task rows grouped by
        // lane; a completed sprint additionally lists the tasks archived at finish
        // (the lazy archives list — sprint_history's "including archived tasks").
        let sprintDetailEl = null
        let sprintDetailCtx = null
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape' && sprintDetailEl && !sprintDetailEl.hidden) {
            e.preventDefault()
            e.stopPropagation()
            closeSprintDetail()
          }
        }, true)
        function closeSprintDetail() {
          if (!sprintDetailEl) return
          sprintDetailCtx = null
          sprintDetailEl.hidden = true
        }
        function laneTable(s) {
          const S = B().state
          const fold = B().sprintLaneCounts(s.id)
          const rows = B().STATUSES.map((st) => {
            const items = S.tasks.filter((t) => t.sprint_id === s.id && t.status === st)
            const rowHtml = items.length
              ? '<div class="sp-detail-lane" data-sp-detail-lane="' + st + '">' +
                  '<span class="sp-detail-lane-head"><span class="sp-detail-lane-name">' + B().esc(B().statusLabel(st)) + '</span><span class="detail-tab-count">' + B().faDig(items.length) + '</span></span>' +
                  '<ul class="sp-detail-tasks">' + items.map((t) =>
                    '<li class="sp-detail-task" role="button" tabindex="0" data-task="' + B().esc(t.id) + '" data-sp-detail-open-task="' + B().esc(t.id) + '">' +
                      '<span class="sp-task-st st-' + B().esc(t.status) + '"></span>' +
                      '<span class="sp-detail-task-title" dir="auto">' + B().esc(t.title) + '</span>' +
                    '</li>').join('') + '</ul>' +
                '</div>'
              : '<div class="sp-detail-lane" data-sp-detail-lane="' + st + '">' +
                  '<span class="sp-detail-lane-head"><span class="sp-detail-lane-name">' + B().esc(B().statusLabel(st)) + '</span><span class="detail-tab-count">' + B().faDig(0) + '</span></span>' +
                '</div>'
            return rowHtml
          }).join('')
          return '<div class="sp-detail-total"><span>' + B().esc(_t('db.ov.total', 'Total')) + '</span><span class="detail-tab-count">' + B().faDig(fold.total) + '</span></div>' + rows
        }
        async function archivedSection(s) {
          // only a completed sprint's history needs the archive (spec §7.3); the
          // lazy list rides the shared api() wrapper — no new fetch site.
          try {
            const r = await B().api('/api/projects/' + encodeURIComponent(projectId) + '/archives')
            const rows = ((r && r.archives) || []).filter((a) => a && a.sprint_id === s.id)
            if (!rows.length) return ''
            return '<div class="sp-detail-archived">' +
              '<h4 class="sp-detail-archived-title muted">' + B().esc(_t('sp.archivedWhenFinished', 'Archived when finished')) + '<span class="detail-tab-count">' + B().faDig(rows.length) + '</span></h4>' +
              '<ul class="sp-detail-tasks">' + rows.map((a) =>
                '<li class="sp-detail-task"><span class="sp-task-st st-done"></span>' +
                '<span class="sp-detail-task-title" dir="auto">' + B().esc(a.title) + '</span></li>').join('') +
              '</ul></div>'
          } catch { return '' } // the archive list is a bonus — its failure never blocks the panel
        }
        function renderSprintDetailTabs(s, tab) {
          const body = sprintDetailEl.querySelector('[data-sd-body]')
          const sTab = sprintDetailEl.querySelector('[data-sd-tab-settings]')
          const tTab = sprintDetailEl.querySelector('[data-sd-tab-tasks]')
          if (!body || !sTab || !tTab) return
          sTab.setAttribute('aria-selected', tab === 'settings' ? 'true' : 'false')
          tTab.setAttribute('aria-selected', tab === 'tasks' ? 'true' : 'false')
          sTab.classList.toggle('is-on', tab === 'settings')
          tTab.classList.toggle('is-on', tab === 'tasks')
          if (tab === 'settings') {
            body.innerHTML =
              '<div class="db-field"><span>' + B().esc(_t('db.sprintName', 'Sprint name')) + '</span>' +
                '<input data-sd-name maxlength="80" dir="auto" value="' + B().esc(s.name || '') + '"></div>' +
              '<div class="db-field"><span>' + B().esc(_t('sp.version', 'Version')) + '</span>' +
                '<input data-sd-version maxlength="80" dir="auto" value="' + B().esc(s.version || '') + '"></div>' +
              '<div class="db-field"><span>' + B().esc(_t('db.sq.emoji', 'Emoji (optional)')) + '</span>' +
                '<div class="row db-sq-emoji-row">' +
                  '<button type="button" class="ghost db-sq-emoji-btn" data-sd-emoji-btn><span class="db-sq-emoji-cur" data-sd-emoji-cur aria-hidden="true">' + B().esc(B().sprintGlyph(s)) + '</span> <span data-sd-emoji-label>' + B().esc(s.emoji ? _t('db.sq.changeEmoji', 'Change') : _t('db.sq.chooseEmoji', 'Choose emoji')) + '</span></button>' +
                  (s.emoji ? '<button type="button" class="ghost danger db-sq-emoji-clear" data-sd-emoji-clear aria-label="' + B().esc(_t('db.sq.clearEmoji', 'Back to the default icon')) + '" title="' + B().esc(_t('db.sq.clearEmoji', 'Back to the default icon')) + '">✕</button>' : '') +
                '</div></div>' +
              // S244 (spec §9.2 + Phase 5's D6 round): the read-only due-date line
              // becomes the SHARED control behind a Set due date toggle (the
              // kickoff's Phase-4 boundary resolved) — ON carries the sprint's
              // saved value; PATCH due_at rides the Save (explicit: value→value
              // preserves due_origin_at server-side — an edit is not a re-assignment,
              // contract §12.1; OFF sends null which clears both).
              '<div class="db-field"><span>' + B().esc(_t('db.dueDate', 'Due date')) + '</span>' +
                '<label class="db-sq-toggle"><input type="checkbox" data-sd-due-toggle' + (s.due_at ? ' checked' : '') + '><span>' + B().esc(_t('db.sq.setDue', 'Set due date')) + '</span></label>' +
                '<div class="db-sd-due-mount" data-sd-due-mount' + (s.due_at ? '' : ' hidden') + '></div>' +
                '<p class="sp-detail-due muted small" data-sd-due-ro>' + (s.due_at
                  ? B().esc(_t('db.ov.due', 'Due {d}').replace('{d}', new Date(s.due_at).toLocaleDateString(document.documentElement.lang === 'fa' ? 'fa-IR' : 'en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })))
                  : B().esc(_t('sp.noDue', 'No due date yet.'))) + '</p>' +
                // S245 (Screen J1 — the settings seat): the Extend… link beside
                // the due control opens the J1 dialog (the quick preset
                // shortcuts over the manual control edit; the control stays the
                // free-form editor). Only when a deadline exists.
                (s.due_at ? '<button type="button" class="ghost small db-due-ext-link" data-sd-extend>' + B().esc(_t('db.extendSprint', 'Extend') + '…') + '</button>' : '') + '</div>' +
              '<a class="btn ghost small sp-detail-plan" href="/project.html?id=' + encodeURIComponent(projectId) + '&sprint=' + encodeURIComponent(s.id) + '">' + B().esc(_t('sprint.plan', 'Plan')) + ' — ' + B().esc(_t('sp.openPlanEditor', 'the full-screen plan editor')) + '</a>' +
              '<p class="muted small sp-detail-plan-note">' + B().esc(_t('sp.planNote', 'The rich description lives in the plan editor.')) + '</p>' +
              '<p class="sp-detail-err" data-sd-error role="alert" hidden></p>' +
              '<div class="row" style="justify-content:flex-end"><button type="button" class="btn small" data-sd-save>' + B().esc(_t('common.save', 'Save')) + '</button></div>'
            let emoji = s.emoji || ''
            const paintEmoji = () => {
              body.querySelector('[data-sd-emoji-cur]').textContent = emoji || '◆'
              body.querySelector('[data-sd-emoji-label]').textContent = emoji ? _t('db.sq.changeEmoji', 'Change') : _t('db.sq.chooseEmoji', 'Choose emoji')
              const clear = body.querySelector('[data-sd-emoji-clear]')
              if (clear) clear.hidden = !emoji
            }
            body.querySelector('[data-sd-emoji-btn]').onclick = (ev) => {
              const picker = window.hibanaEmojiPicker
              if (!picker) return
              picker.open({ anchor: ev.currentTarget, current: emoji, onPick: (e2) => { emoji = String(e2 || ''); paintEmoji() } })
            }
            const clearBtn = body.querySelector('[data-sd-emoji-clear]')
            if (clearBtn) clearBtn.onclick = () => { emoji = ''; paintEmoji() }
            // S244 (D6): the shared control behind the sprint's Set due date toggle
            // — mounted when the sprint carries a due date (or on first reveal),
            // the saved value loads into it. The read-only line hides while the
            // control is up (the control carries the value); it shows the SAVED
            // state whenever the toggle is OFF.
            const dueToggle = body.querySelector('[data-sd-due-toggle]')
            const dueMount = body.querySelector('[data-sd-due-mount]')
            const dueRo = body.querySelector('[data-sd-due-ro]')
            let sdDueCtl = null
            if (dueToggle && dueMount && s.due_at && window.HibanaDueControl && window.HibanaDueControl.create) {
              sdDueCtl = window.HibanaDueControl.create({ value: s.due_at })
              dueMount.textContent = ''
              dueMount.appendChild(sdDueCtl.el)
            }
            if (dueToggle && dueMount) {
              if (dueRo) dueRo.hidden = dueToggle.checked && !!sdDueCtl
              dueToggle.onchange = () => {
                if (dueToggle.checked && !sdDueCtl && window.HibanaDueControl && window.HibanaDueControl.create) {
                  sdDueCtl = window.HibanaDueControl.create({ value: null })
                  dueMount.textContent = ''
                  dueMount.appendChild(sdDueCtl.el)
                }
                dueMount.hidden = !dueToggle.checked
                if (dueRo) dueRo.hidden = dueToggle.checked && !!sdDueCtl
              }
            }
            const errEl = body.querySelector('[data-sd-error]')
            // S245 (Screen J1): the settings panel's Extend… link — closes the
            // detail panel first (its form state is a settings-edit draft, not an
            // extension), then hands the sprint row to the shared J1 dialog
            // (onDone = the page's reload).
            const sdExtBtn = body.querySelector('[data-sd-extend]')
            if (sdExtBtn) {
              sdExtBtn.onclick = () => {
                const row = B().findSprint(s.id) || s
                closeSprintDetail()
                if (B().openSprintDeadlineExtend) B().openSprintDeadlineExtend(row, { onDone: reload })
              }
            }
            const saveBtn = body.querySelector('[data-sd-save]')
            saveBtn.onclick = async () => {
              const nameVal = (body.querySelector('[data-sd-name]').value || '').trim()
              if (!nameVal) { errEl.textContent = _t('db.sq.nameRequired', 'Enter a name for the sprint.'); errEl.hidden = false; return }
              const dueVal = sdDueCtl ? sdDueCtl.value() : null
              if (dueToggle && dueToggle.checked && !dueVal) {
                errEl.textContent = _t('db.due.required', 'Pick a date for the deadline, or turn it off.')
                errEl.hidden = false
                return
              }
              const verVal = (body.querySelector('[data-sd-version]').value || '').trim()
              // S244 (contract §12.1 origin rules): due_at rides EXPLICITLY —
              // value→value PRESERVES due_origin_at server-side (an edit is not a
              // re-assignment — §13's extension semantics), null clears both.
              const patchBody = { name: nameVal, version: verVal ? verVal : null, emoji: emoji ? emoji : null }
              if (dueToggle) patchBody.due_at = dueToggle.checked ? dueVal : null
              saveBtn.disabled = true
              try {
                await B().patchSprint(s.id, patchBody)
                window.hibana && window.hibana.toast(_t('sp.settingsSaved', 'Sprint settings saved'), 'ok')
                const reopenId = sprintDetailCtx
                closeSprintDetail()
                await reload()
                if (reopenId) openSprintDetail(reopenId, 'settings')
              } catch (err) {
                saveBtn.disabled = false
                if (err && err.code === 'duplicate') {
                  errEl.textContent = _t('db.sq.dupErr', 'A sprint with this name already exists in this project — names are case-insensitive.')
                  errEl.hidden = false
                } else {
                  window.hibana && window.hibana.toast(_t('sparks.saveFailed', "Couldn't save"), 'err')
                }
              }
            }
            body.querySelector('[data-sd-name]').focus()
          } else {
            const stx = B().sprintStatusOf(s)
            const html = laneTable(s)
            const archivePromise = stx === 'completed' ? archivedSection(s) : Promise.resolve('')
            body.innerHTML = '<div class="sp-detail-lanes">' + html + '</div>'
            archivePromise.then((arch) => { if (arch && sprintDetailCtx === s.id) body.insertAdjacentHTML('beforeend', arch) })
          }
        }
        function openSprintDetail(id, tab) {
          const s = B().findSprint(id)
          if (!s) return
          const lang = window.hibanaI18n && window.hibanaI18n.lang ? window.hibanaI18n.lang() : 'en'
          if (!sprintDetailEl) {
            sprintDetailEl = document.createElement('div')
            sprintDetailEl.className = 'db-modal db-sprintdetail'
            sprintDetailEl.setAttribute('role', 'dialog')
            sprintDetailEl.setAttribute('aria-modal', 'true')
            sprintDetailEl.hidden = true
            document.body.appendChild(sprintDetailEl)
            sprintDetailEl.addEventListener('click', (e) => { if (e.target === sprintDetailEl) closeSprintDetail() })
          }
          sprintDetailCtx = s.id
          const stx = B().sprintStatusOf(s)
          const badgeMap = {
            active: _t('db.sprintSt.active', 'Active'),
            planned: _t('db.sprintSt.planned', 'Planned'),
            paused: _t('db.sprintSt.paused', 'Paused'),
            completed: _t('db.sprintSt.completed', 'Completed'),
          }
          sprintDetailEl.innerHTML =
            '<div class="db-modal-card db-sprintdetail-card" dir="' + (lang === 'fa' ? 'rtl' : 'auto') + '">' +
              '<div class="row spread db-modal-head">' +
                '<h3 class="sp-detail-title"><span class="sp-detail-glyph" aria-hidden="true">' + B().esc(B().sprintGlyph(s)) + '</span> <span dir="auto">' + B().esc(s.name || '') + '</span>' +
                  ' <span class="sp-list-badge sp-st-' + stx + '">' + B().esc(badgeMap[stx]) + '</span></h3>' +
                '<button type="button" class="ghost" data-sd-close aria-label="' + B().esc(_t('common.close', 'Close')) + '">✕</button>' +
              '</div>' +
              '<div class="row sp-detail-tabs" role="tablist">' +
                '<button type="button" class="sp-detail-tab" role="tab" data-sd-tab-settings aria-selected="false">' + B().esc(_t('sp.settingsTab', 'Settings')) + '</button>' +
                '<button type="button" class="sp-detail-tab" role="tab" data-sd-tab-tasks aria-selected="false">' + B().esc(_t('sp.tasksTab', 'Tasks')) + '</button>' +
              '</div>' +
              '<div class="db-modal-body" data-sd-body></div>' +
              '<div class="row spread db-modal-foot">' +
                '<div class="row" style="gap:.5rem">' +
                  (stx === 'planned' ? '<button type="button" class="btn small" data-sd-start>▸ ' + B().esc(_t('db.startSprint', 'Start sprint')) + '</button>' : '') +
                  (stx === 'active' ? '<button type="button" class="btn ghost small" data-sd-pause>⏸ ' + B().esc(_t('db.pauseSprint', 'Pause sprint')) + '</button>' +
                    '<button type="button" class="btn ghost small" data-sd-finish>⏹ ' + B().esc(_t('db.finishSprint', 'Finish sprint')) + '</button>' : '') +
                  (stx === 'paused' ? '<button type="button" class="btn small" data-sd-resume>▸ ' + B().esc(_t('db.resumeSprint', 'Resume')) + '</button>' : '') +
                  (stx === 'completed' ? '<button type="button" class="btn ghost small" data-sd-reopen>' + B().esc(_t('db.reopenSprint', 'Reopen')) + '</button>' : '') +
                '</div>' +
                '<div class="row" style="gap:.5rem">' +
                  ((stx === 'planned' || stx === 'paused') ? '<button type="button" class="ghost danger small" data-sd-del>' + B().esc(_t('common.delete', 'Delete')) + '</button>' : '') +
                  '<button type="button" class="ghost" data-sd-cancel>' + B().esc(_t('common.close', 'Close')) + '</button>' +
                '</div>' +
              '</div>' +
            '</div>'
          sprintDetailEl.hidden = false
          sprintDetailEl.querySelector('[data-sd-close]').onclick = closeSprintDetail
          sprintDetailEl.querySelector('[data-sd-cancel]').onclick = closeSprintDetail
          sprintDetailEl.querySelector('[data-sd-tab-settings]').onclick = () => renderSprintDetailTabs(s, 'settings')
          sprintDetailEl.querySelector('[data-sd-tab-tasks]').onclick = () => renderSprintDetailTabs(s, 'tasks')
          const startBtn = sprintDetailEl.querySelector('[data-sd-start]')
          if (startBtn) startBtn.onclick = () => { closeSprintDetail(); B().startSprintWithConflict(s.id, { onDone: reload }) }
          const pauseBtn = sprintDetailEl.querySelector('[data-sd-pause]')
          if (pauseBtn) pauseBtn.onclick = () => { closeSprintDetail(); B().confirmSprintPause(s, { onDone: reload }) }
          const finBtn = sprintDetailEl.querySelector('[data-sd-finish]')
          if (finBtn) finBtn.onclick = () => { closeSprintDetail(); B().openSprintFinish(s, { onDone: reload }) }
          const resBtn = sprintDetailEl.querySelector('[data-sd-resume]')
          if (resBtn) resBtn.onclick = () => { closeSprintDetail(); B().startSprintWithConflict(s.id, { onDone: reload }) }
          const reoBtn = sprintDetailEl.querySelector('[data-sd-reopen]')
          if (reoBtn) reoBtn.onclick = () => { closeSprintDetail(); B().reopenSprintFlow(s.id, { onDone: reload }) }
          const delBtn = sprintDetailEl.querySelector('[data-sd-del]')
          if (delBtn) delBtn.onclick = () => { closeSprintDetail(); B().openSprintDelete(s, { projectId: projectId, onDone: reload }) }
          renderSprintDetailTabs(s, tab || 'settings')
        }
        // the row click opens the detail panel (Screen E/F: settings + tasks); the
        // ⋯ popover button stops the propagation so the panel never opens under it.
        ctx.on('click', (e) => {
          const row = e.target.closest('[data-sp-open]')
          if (row && !e.target.closest('[data-sprint-menu]')) openSprintDetail(row.dataset.spOpen)
        })
        ctx.on('keydown', (e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          const row = e.target.closest ? e.target.closest('[data-sp-open]') : null
          if (!row || e.target.closest('[data-sprint-menu]')) return
          e.preventDefault()
          openSprintDetail(row.dataset.spOpen)
        })
        // a task row inside the Tasks tab opens the shared editor (onSaved re-renders)
        ctx.on('click', (e) => {
          const t = e.target.closest('[data-sp-detail-open-task]')
          if (!t) return
          B().openEditor(t.dataset.task, { onSaved: () => { const id = sprintDetailCtx; closeSprintDetail(); reload().then(() => { if (id) openSprintDetail(id, 'tasks') }) } })
        })

        // ---- floating date tooltip shared by every drag -----------------------------
        let tipEl = null
        const tipShow = (txt, x, y) => {
          if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'sp-drag-tip'; document.body.appendChild(tipEl) }
          tipEl.textContent = txt
          tipEl.hidden = false
          const tw = tipEl.offsetWidth || 90
          tipEl.style.left = Math.max(8, Math.min(x - tw / 2, window.innerWidth - tw - 8)) + 'px'
          tipEl.style.top = Math.max(6, y - 40) + 'px'
        }
        const tipHide = () => { if (tipEl) tipEl.hidden = true }

        // live-update a sprint's band + boundary + lane chip positions
        function paintSprint(id, a, b, open) {
          const band = tlEl.querySelector('[data-band="' + id + '"]')
          const lane = tlEl.querySelector('[data-sprint="' + id + '"]')
          const b0 = tlEl.querySelector('[data-bound="' + id + '"][data-edge="start"]')
          const b1 = tlEl.querySelector('[data-bound="' + id + '"][data-edge="end"]')
          const left = pctOf(a)
          const w = Math.max(pctOf(b) - left, 0.8)
          if (band) { band.style.insetInlineStart = left + '%'; band.style.inlineSize = w + '%' }
          if (lane) {
            lane.style.insetInlineStart = left + '%'
            lane.style.inlineSize = Math.max(pctOf(b) - left, 1.2) + '%'
            // S35: the strip follows the drag — open sprints still end at TODAY,
            // finished ones at their (dragged) end.
            const clip = lane.querySelector('.sp-clip')
            if (clip) {
              const today = B().todayIdx()
              const span = Math.max(b - a, 0.001)
              const end = open ? Math.max(Math.min(today, b), a) : b
              clip.style.inlineSize = Math.max(Math.min(((end - a) / span) * 100, 100), 1) + '%'
            }
          }
          if (b0) b0.style.insetInlineStart = left + '%'
          if (b1) b1.style.insetInlineStart = pctOf(b) + '%'
        }
        function paintBar(bar, a, b) {
          bar.style.insetInlineStart = pctOf(a) + '%'
          bar.style.inlineSize = Math.max(pctOf(b) - pctOf(a), 0.8) + '%'
        }

        // ---- pointer drags: clip trim · sprint boundaries · sprint band move ----------
        let activeDrag = null
        ctx.on('pointerdown', (e) => {
          if (e.button !== 0) return
          const trim = e.target.closest('[data-trim]')
          const bound = e.target.closest('[data-bound]')
          let band = e.target.closest('[data-bandmove]')
          if (band && e.target.closest('[data-sprint-menu], .sp-sprint-pop')) band = null // chip = popover, not a move
          if (!trim && !bound && !band) return
          e.preventDefault()
          const grabEl = trim || bound || band
          try { grabEl.setPointerCapture(e.pointerId) } catch { /* ignore */ }
          document.body.classList.add('sp-dragging')
          const L = lang()
          const startClientX = e.clientX
          const startDay = Math.round(xToDay(e.clientX))
          let moved = false
          let cancelled = false
          const geom = sprintGeom()
          const today = B().todayIdx()

          if (trim) {
            const bar = trim.closest('[data-bar]')
            const task = bar ? B().findTask(bar.dataset.task) : null
            if (!bar || !task) { document.body.classList.remove('sp-dragging'); return }
            const edge = trim.dataset.trim
            const oA = tStart(task) == null ? range.start : clampIdx(tStart(task))
            const oB = clampIdx(tEnd(task))
            const createdDay = (() => { const i = B().dayIdx(task.created_at); return Number.isFinite(i) ? i : null })()
            let cur = edge === 'a' ? oA : oB
            const orig = cur
            activeDrag = {
              move: (ev) => {
                if (cancelled) return
                const d = Math.round(xToDay(ev.clientX))
                if (Math.abs(ev.clientX - startClientX) > 3) moved = true
                cur = edge === 'a' ? Math.max(range.start, Math.min(d, oB)) : Math.min(range.end, Math.max(d, oA))
                paintBar(bar, edge === 'a' ? cur : oA, edge === 'b' ? cur : oB)
                tipShow(B().fullLabel(clampIdx(cur), L), ev.clientX, ev.clientY)
              },
              cancel: () => { cancelled = true },
              finish: async () => {
                tipHide()
                if (cancelled) { await reload(); return }
                if (!moved || cur === orig) return // no-op — nothing changed
                try {
                  if (edge === 'a') {
                    const body = (createdDay != null && cur <= createdDay) ? { start_at: null } : { start_at: dayIso(cur) }
                    await B().patchTask(task.id, body)
                  } else {
                    const body = (cur >= today && task.status !== 'done') ? { end_at: null } : { end_at: dayIso(cur) }
                    await B().patchTask(task.id, body)
                  }
                  await reload()
                } catch { window.hibana && window.hibana.toast(_t('sparks.saveFailed', "Couldn't save"), 'err'); await reload() }
              },
            }
          } else if (bound) {
            const id = bound.dataset.bound
            const edge = bound.dataset.edge
            const gi = geom.findIndex((g) => g.s.id === id)
            if (gi < 0) { document.body.classList.remove('sp-dragging'); return }
            const g = geom[gi]
            const prev = geom[gi - 1] || null
            const next = geom[gi + 1] || null
            const prevEnd = prev ? (prev.open ? range.end : prev.s1) : null // open sprints run to the axis end now
            const nextStart = next ? next.s0 : null
            let cur = edge === 'start' ? g.s0 : g.s1
            const orig = cur
            const paint = () => paintSprint(id, edge === 'start' ? cur : g.s0, edge === 'end' ? cur : g.s1, g.open)
            activeDrag = {
              move: (ev) => {
                if (cancelled) return
                const d = Math.round(xToDay(ev.clientX))
                if (Math.abs(ev.clientX - startClientX) > 3) moved = true
                if (edge === 'start') {
                  const lo = prev == null ? range.start : prevEnd + 1
                  const hi = g.open ? range.end : Math.min(g.s1 - 1, next == null ? range.end : nextStart - 1)
                  cur = Math.max(lo, Math.min(d, hi))
                } else {
                  const lo = g.s0 + 1
                  const hi = next == null ? range.end : nextStart - 1
                  cur = Math.max(lo, Math.min(d, hi))
                }
                paint()
                tipShow(B().fullLabel(clampIdx(cur), L), ev.clientX, ev.clientY)
              },
              cancel: () => { cancelled = true },
              finish: async () => {
                tipHide()
                if (cancelled) { await reload(); return }
                if (!moved || cur === orig) return
                try {
                  const body = edge === 'start' ? { started_at: dayIso(cur) } : { ended_at: dayIso(cur) }
                  await B().patchSprint(id, body)
                  await reload()
                } catch { window.hibana && window.hibana.toast(_t('sparks.saveFailed', "Couldn't save"), 'err'); await reload() }
              },
            }
          } else {
            // band move: slide the whole sprint (open sprint: its START moves, end stays open)
            const id = band.dataset.bandmove
            const gi = geom.findIndex((g) => g.s.id === id)
            if (gi < 0) { document.body.classList.remove('sp-dragging'); return }
            const g = geom[gi]
            const prev = geom[gi - 1] || null
            const next = geom[gi + 1] || null
            const prevEnd = prev ? (prev.open ? range.end : prev.s1) : null // open sprints run to the axis end now
            const nextStart = next ? next.s0 : null
            const len = Math.max(0, g.s1 - g.s0)
            const origS0 = g.s0
            let ns = origS0
            activeDrag = {
              move: (ev) => {
                if (cancelled) return
                const d = Math.round(xToDay(ev.clientX))
                if (Math.abs(ev.clientX - startClientX) > 3) moved = true
                const shift = d - startDay
                const lo = prev == null ? range.start : prevEnd + 1
                const hi = (next == null ? range.end : nextStart - 1) - len
                ns = Math.max(lo, Math.min(origS0 + shift, hi))
                paintSprint(id, ns, ns + len, g.open)
                tipShow(B().fullLabel(clampIdx(ns), L) + ' → ' + B().fullLabel(clampIdx(ns + len), L), ev.clientX, ev.clientY)
              },
              cancel: () => { cancelled = true },
              finish: async () => {
                tipHide()
                if (cancelled) { await reload(); return }
                if (!moved || ns === origS0) return
                try {
                  const body = { started_at: dayIso(ns) }
                  if (!g.open) body.ended_at = dayIso(ns + len)
                  await B().patchSprint(id, body)
                  await reload()
                } catch { window.hibana && window.hibana.toast(_t('sparks.saveFailed', "Couldn't save"), 'err'); await reload() }
              },
            }
          }

          const onMove = (ev) => { if (activeDrag) activeDrag.move(ev) }
          const onUp = async () => {
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp)
            window.removeEventListener('pointercancel', onCancel)
            const d = activeDrag
            activeDrag = null
            document.body.classList.remove('sp-dragging')
            if (d) await d.finish()
          }
          // the browser taking over (touch scroll, palm…) must not leave a stuck drag
          const onCancel = () => { if (activeDrag) activeDrag.cancel() }
          window.addEventListener('pointermove', onMove)
          window.addEventListener('pointerup', onUp)
          window.addEventListener('pointercancel', onCancel)
        })

        ctx.on('keydown', (e) => {
          if (e.key === 'Escape' && activeDrag) { activeDrag.cancel(); return }
          if (e.key === 'Enter' && catPop && e.target.closest('[data-ce-name]')) {
            e.preventDefault()
            catPop.querySelector('[data-ce-save]').click()
          }
          if (e.key === 'Escape' && catPop) closeCatPop()
          if (e.key === 'Enter' && sprintPop && e.target.matches('[data-sp-rename]')) {
            e.preventDefault()
            sprintPop.querySelector('[data-sp-save]').click()
          }
          if (e.key === 'Escape' && sprintPop) closeSprintPop()
        }, true)

        // ---- sprint chip popover (rename / lifecycle actions / delete) ------------
        // S243 (spec pack §5 — the lifecycle): the actions follow the sprint's REAL
        // status now (active → Pause + Finish + Extend; paused → Resume; completed →
        // Reopen; planned → the draft card's Start). Finish opens the H2 count
        // confirmation, Pause the H3 lightweight confirm, Reopen/Resume the shared
        // conflict-aware flows, Delete the Screen-I exact-counts modal.
        let sprintPop = null
        const closeSprintPop = () => { if (sprintPop) { sprintPop.remove(); sprintPop = null } }
        ctx.on('click', async (e) => {
          const chip = e.target.closest('[data-sprint-menu]')
          if (chip) {
            e.stopPropagation()
            closeSprintPop()
            const s = B().findSprint(chip.dataset.sprintMenu)
            if (!s) return
            sprintPop = document.createElement('div')
            sprintPop.className = 'sp-sprint-pop'
            sprintPop.dataset.spSprintId = s.id // S46.11: so the action handler finds the id even for list-row popovers (appended to body, not .sp-sprint)
            const open = !s.ended_at
            const stx = B().sprintStatusOf(s) // S243: the lifecycle-aware action set
            // S35: the strip's story in numbers — dates, duration, done works (dev tasks
            // done in the window + the plan doc's checked items), + the plan doc link.
            const L = lang()
            const st = sprintStats(s)
            const s0i = B().dayIdx(s.started_at)
            const s1i = s.ended_at ? B().dayIdx(s.ended_at) : B().todayIdx()
            const dur = Math.max(s1i - s0i + 1, 1)
            const durTxt = open
              ? _t('db.sprintDay', 'Day {n}').replace('{n}', B().faDig(dur))
              : _t('db.sprintDays', '{n} days').replace('{n}', B().faDig(dur))
            const rangeTxt = B().fullLabel(s0i, L) + (s.ended_at
              ? ' ' + _t('db.sprintTo', 'to') + ' ' + B().fullLabel(s1i, L)
              : ' · ' + _t('sp.now', 'Now'))
            const doneDays = st.days.size
            const statsHtml =
              '<div class="sp-pop-stats" dir="auto">' +
                '<span class="sp-pop-dates">' + B().esc(rangeTxt) + '</span>' +
                '<span>' + B().esc(durTxt) + '</span>' +
                '<span>' + B().esc(_t('db.sprintDoneTasks', '{n} done').replace('{n}', B().faDig(st.done) + '/' + B().faDig(st.assigned))) + '</span>' +
                (doneDays ? '<span>' + B().esc(_t('db.sprintDoneDays', '{n} active days').replace('{n}', B().faDig(doneDays))) + '</span>' : '') +
                (st.docChecked ? '<span>' + B().esc(_t('db.sprintDocChecked', '{n} checked in plan').replace('{n}', B().faDig(st.docChecked))) + '</span>' : '') +
              '</div>'
            sprintPop.innerHTML =
              statsHtml +
              '<input value="' + B().esc(s.name) + '" maxlength="80" dir="auto" data-sp-rename>' +
              '<div class="row">' +
                '<button type="button" class="btn small" data-sp-save>' + B().esc(_t('common.save', 'Save')) + '</button>' +
                (stx === 'active'
                  ? '<button type="button" class="btn ghost small" data-sp-pause>' + B().esc(_t('db.pauseSprint', 'Pause sprint')) + '</button>' +
                    '<button type="button" class="btn ghost small" data-sp-finish>' + B().esc(_t('db.finishSprint', 'Finish sprint')) + '</button>'
                  : '') +
                // S245 (spec pack Phase 6 — §13.2 + Screen J1): the popover's
                // Extend label now wires to the J1 DEADLINE extension dialog
                // (the S48p window.prompt ended_at flow is RETIRED — the same
                // supersession treatment the S244 round gave the interim UTC
                // parse). Shown for a NON-COMPLETED sprint carrying a due date;
                // a sprint without a deadline has nothing to extend (the
                // settings panel owns setting one).
                ((stx === 'active' || stx === 'paused') && s.due_at
                  ? '<button type="button" class="btn ghost small" data-sp-extend>' + B().esc(_t('db.extendSprint', 'Extend')) + '</button>'
                  : '') +
                (stx === 'paused'
                  ? '<button type="button" class="btn ghost small" data-sp-resume>' + B().esc(_t('db.resumeSprint', 'Resume')) + '</button>'
                  : '') +
                (stx === 'completed'
                  ? '<button type="button" class="btn ghost small" data-sp-reopen>' + B().esc(_t('db.reopenSprint', 'Reopen')) + '</button>'
                  : '') +
                '<button type="button" class="btn ghost danger small" data-sp-del>' + B().esc(_t('common.delete', 'Delete')) + '</button>' +
              '</div>' +
              // S48p: sprint log — task count + category breakdown
              '<div class="sp-pop-log" dir="auto">' +
                '<div class="sp-pop-lab">' + B().esc(_t('db.sprintLog', 'Sprint log')) + '</div>' +
                '<div class="sp-pop-log-row"><span>' + B().esc(_t('db.sprintTotalTasks', 'Total tasks')) + '</span><span>' + B().faDig(st.assigned) + '</span></div>' +
                '<div class="sp-pop-log-row"><span>' + B().esc(_t('db.sprintDoneTasks', '{n} done').replace('{n}', '')) + '</span><span>' + B().faDig(st.done) + '</span></div>' +
                (st.categories && st.categories.length
                  ? st.categories.map((c) => '<div class="sp-pop-log-row"><span>' + B().esc(c.name) + '</span><span>' + B().faDig(c.count) + '</span></div>').join('')
                  : '') +
              '</div>' +
              '<a class="btn ghost small sp-pop-plan" href="/project.html?id=' + encodeURIComponent(projectId) + '&sprint=' + encodeURIComponent(s.id) + '">' +
                B().esc(_t('sprint.plan', 'Plan')) + '</a>'
            chip.closest('.sp-sprint')?.appendChild(sprintPop) || document.body.appendChild(sprintPop)
            // S48k: CSS centers the modal (position:fixed + transform:translate(-50%,-50%)).
            // No manual positioning needed (was: fixed inline positioning for the popover).
            sprintPop.querySelector('[data-sp-rename]').focus()
            return
          }
          if (sprintPop && !e.target.closest('.sp-sprint-pop')) { closeSprintPop(); return }
          const spBtn = e.target.closest('[data-sp-save],[data-sp-finish],[data-sp-reopen],[data-sp-del],[data-sp-extend],[data-sp-pause],[data-sp-resume]')
          if (!spBtn || !sprintPop) return
          // S46.11: the popover may be appended to .sp-sprint (timeline chip) OR
          // document.body (list row) — check both for the sprint id.
          const spEl = sprintPop.closest('.sp-sprint')
          const id = spEl ? spEl.dataset.sprint : (sprintPop.dataset.spSprintId || null)
          if (!id) return
          // S243: the confirmation-dialog actions (finish/pause/resume/reopen/delete)
          // hand over to the shared devboard.js lifecycle stack and close the
          // popover — the dialog's onDone reloads AFTER its mutation lands. The
          // direct actions (save/extend) keep the popover's own try/catch + reload.
          if (spBtn.matches('[data-sp-finish]')) {
            const s = B().findSprint(id)
            closeSprintPop()
            if (s) B().openSprintFinish(s, { onDone: reload })
            return
          }
          if (spBtn.matches('[data-sp-pause]')) {
            const s = B().findSprint(id)
            closeSprintPop()
            if (s) B().confirmSprintPause(s, { onDone: reload })
            return
          }
          if (spBtn.matches('[data-sp-resume]')) {
            closeSprintPop()
            B().startSprintWithConflict(id, { onDone: reload })
            return
          }
          if (spBtn.matches('[data-sp-reopen]')) {
            closeSprintPop()
            B().reopenSprintFlow(id, { onDone: reload })
            return
          }
          if (spBtn.matches('[data-sp-del]')) {
            const s = B().findSprint(id)
            closeSprintPop()
            if (s) B().openSprintDelete(s, { projectId: projectId, onDone: reload })
            return
          }
          // S245 (Screen J1): Extend now opens the shared sprint-DEADLINE extension
          // dialog (identity + current deadline + the four §13.1 choices + the
          // BEFORE-confirmation impact counts); the presets add to the EXISTING
          // deadline and the PATCH preserves due_origin_at (value→value — §13.2).
          if (spBtn.matches('[data-sp-extend]')) {
            const s = B().findSprint(id)
            closeSprintPop()
            if (s && B().openSprintDeadlineExtend) B().openSprintDeadlineExtend(s, { onDone: reload })
            return
          }
          try {
            if (spBtn.matches('[data-sp-save]')) await B().renameSprint(id, sprintPop.querySelector('[data-sp-rename]').value.trim())
            closeSprintPop()
            await reload()
          } catch { window.hibana && window.hibana.toast(_t('sparks.saveFailed', "Couldn't save"), 'err') }
        })

        // ---- category edit popover (rename + RECOLOR → PATCH /api/categories/:id) -----
        let catPop = null
        const closeCatPop = () => { if (catPop) { catPop.remove(); catPop = null } }
        const openCatPop = (btn) => {
          closeCatPop()
          const cat = B().findCategory(btn.dataset.catEdit)
          if (!cat) return
          catPop = document.createElement('div')
          catPop.className = 'sp-sprint-pop sp-cat-edit-pop'
          catPop.dataset.catId = cat.id
          const cur = String(cat.color_fill || '').toUpperCase() + '/' + String(cat.color_text || '').toUpperCase()
          catPop.innerHTML =
            '<div class="sp-pop-lab">' + B().esc(_t('db.renameCategory', 'Rename category')) + '</div>' +
            '<input value="' + B().esc(cat.name) + '" maxlength="80" dir="auto" data-ce-name>' +
            '<div class="sp-pop-lab">' + B().esc(_t('db.categoryColor', 'Color')) + '</div>' +
            '<div class="pd-tag-colors">' + PALETTE.map((c) => {
              const pr = c.split('/')
              return '<label class="pd-swatch"><input type="radio" name="cecolor" value="' + c + '" ' + (c.toUpperCase() === cur ? 'checked' : '') + '><span style="background:' + pr[0] + ';color:' + pr[1] + '"><b aria-hidden="true">Aa</b></span></label>'
            }).join('') + '</div>' +
            '<div class="row">' +
              '<button type="button" class="btn small" data-ce-save>' + B().esc(_t('common.save', 'Save')) + '</button>' +
              '<button type="button" class="ghost small" data-ce-cancel>' + B().esc(_t('common.cancel', 'Cancel')) + '</button>' +
            '</div>'
          document.body.appendChild(catPop)
          const r = btn.getBoundingClientRect()
          const pr = catPop.getBoundingClientRect()
          if (document.documentElement.dir === 'rtl') catPop.style.right = Math.max(8, Math.min(r.right - pr.width, window.innerWidth - pr.width - 8)) + 'px'
          else catPop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pr.width - 8)) + 'px'
          catPop.style.top = Math.min(r.bottom + 6, Math.max(8, window.innerHeight - pr.height - 8)) + 'px'
          const nameIn = catPop.querySelector('[data-ce-name]')
          nameIn.focus(); nameIn.select()
          catPop.querySelector('[data-ce-cancel]').onclick = closeCatPop
          catPop.querySelector('[data-ce-save]').onclick = async () => {
            const live = B().findCategory(catPop.dataset.catId)
            if (!live) return closeCatPop()
            const name = nameIn.value.trim()
            const pair = ((catPop.querySelector('input[name=cecolor]:checked') || {}).value || '').split('/')
            const body = {}
            if (name && name !== live.name) body.name = name
            if (pair.length === 2 && (pair[0].toUpperCase() !== String(live.color_fill || '').toUpperCase() || pair[1].toUpperCase() !== String(live.color_text || '').toUpperCase())) {
              body.color_fill = pair[0]
              body.color_text = pair[1]
            }
            if (!body.name && !body.color_fill) return closeCatPop()
            try {
              await B().patchCategory(live.id, body)
              closeCatPop()
              await reload()
            } catch { window.hibana && window.hibana.toast(_t('sparks.saveFailed', "Couldn't save"), 'err') }
          }
        }

        // ---- interactions ------------------------------------------------------
        ctx.on('click', async (e) => {
          // S45/S7: the empty-state CTA opens the SAME define popover as the toolbar's
          // ◆ button — one code path (draft-exists 409 handling included).
          if (e.target.closest('[data-sp-empty-define]')) {
            openDefinePop()
            return
          }
          if (catPop && !e.target.closest('.sp-cat-edit-pop')) closeCatPop()
          const eye = e.target.closest('[data-cat-eye]')
          if (eye) {
            const id = eye.dataset.catEye
            if (id !== 'none') { setLaneHidden(id, !laneHidden(id)); render() }
            return
          }
          const del = e.target.closest('[data-cat-del]')
          if (del) {
            const cat = B().findCategory(del.dataset.catDel)
            if (!cat) return
            // S152 (block 8): archive, not hard delete — rows stay, tasks keep the category.
            if (!await window.hibana.confirm(_t('db.archiveCatConfirm', 'Archive this category? Its tasks keep it — it just leaves the pickers and toggles.'), { title: 'Archive category', confirmLabel: 'Archive' })) return
            B().deleteCategory(cat.id).then(reload).catch(() => window.hibana && window.hibana.toast(_t('sparks.saveFailed', "Couldn't save"), 'err'))
            return
          }
          const toggle = e.target.closest('[data-cat-toggle]')
          if (toggle && !e.target.closest('[data-cat-edit],[data-cat-eye],[data-cat-del]')) {
            const open = toggle.dataset.open === '1'
            toggle.dataset.open = open ? '0' : '1'
            const ul = toggle.parentElement.querySelector('.sp-cat-tasks')
            if (ul) ul.classList.toggle('is-collapsed', !open ? false : true)
            toggle.querySelector('.sp-cat-chevron').style.transform = open ? 'rotate(-90deg)' : ''
            return
          }
          const edit = e.target.closest('[data-cat-edit]')
          if (edit) { openCatPop(edit); return }
          const bar = e.target.closest('[data-bar],[data-sptask]')
          if (bar && !e.target.closest('[data-trim]')) B().openEditor(bar.dataset.task, { onSaved: reload })
          const newCat = e.target.closest('[data-new-category]')
          if (newCat) {
            const form = document.querySelector('[data-cat-form]')
            if (form) { form.hidden = !form.hidden; if (!form.hidden) form.querySelector('input[name=name]').focus() }
          }
          const cancel = e.target.closest('[data-cat-cancel]')
          if (cancel) { const form = document.querySelector('[data-cat-form]'); if (form) form.hidden = true }
        })

        ctx.on('submit', async (e) => {
          const form = e.target.closest('[data-cat-form]')
          if (!form) return
          e.preventDefault()
          const name = form.querySelector('input[name=name]').value.trim()
          const pair = (form.querySelector('input[name=catcolor]:checked')?.value || '').split('/')
          if (!name || pair.length !== 2) return
          try {
            await B().createCategory(name, pair[0], pair[1])
            await reload()
          } catch { window.hibana && window.hibana.toast(_t('sparks.saveFailed', "Couldn't save"), 'err') }
        })

        // quick-add a task inside a sidebar category (server auto-joins the open sprint)
        ctx.on('keydown', async (e) => {
          if (e.key !== 'Enter' || e.isComposing) return
          const input = e.target.closest('[data-quickadd]')
          if (!input) return
          e.preventDefault()
          const title = input.value.trim()
          if (!title) return
          const catId = input.dataset.quickadd
          try {
            await B().createTask({ title, status: 'idea', category_id: catId === 'none' ? undefined : catId })
            await reload()
          } catch { window.hibana && window.hibana.toast(_t('sparks.saveFailed', "Couldn't save"), 'err') }
        })

        // ---- Phase 5 item 7: DEFINE a new sprint (dialog) ---------------------------
        // The ◆ button opens a small popover with a NAME field — creating a DRAFT (not
        // started). Items/categories are added next (quick-add joins the draft
        // automatically; bars can be dragged onto the draft card), and the START button
        // puts it on the board. A second define while a draft exists surfaces the
        // 'draft_exists' message instead of silently stacking drafts.
        let definePop = null
        const closeDefinePop = () => { if (definePop) { definePop.remove(); definePop = null } }
        // S45/S7: named (not just onclick-assigned) so the empty-state CTA opens the
        // SAME popover directly — a synthetic #sp-new-sprint.click() would nest a
        // second bubbling event inside the CTA's own, and the outside-click guard
        // (below) would close the popover in the same tick it opened.
        const openDefinePop = () => {
          if (definePop) { closeDefinePop(); return }
          definePop = document.createElement('div')
          definePop.className = 'sp-sprint-pop sp-define-pop'
          // S48n: added date inputs (start/end) + preset buttons (24h/48h/72h/1w/2w/1m).
          // If dates are provided, the sprint is created as STARTED immediately.
          // Presets compute end = now + duration; start = now.
          // S49 FIX (CI-red e2e catch, sprint-ux S7): the start input used to be
          // PRE-FILLED with today — which made the "No start date → create as DRAFT"
          // branch in commit() unreachable, silently killing the S33/S35 draft flow
          // ("Sprint defined — add items, then start it"). The start input now opens
          // EMPTY: name-only + Define = draft (the original contract); picking a start
          // date (or a preset, which fills BOTH start and end) = started sprint.
          const now = new Date()
          const todayStr = now.toISOString().slice(0, 10)
          const presets = [
            { label: '۲۴ ساعت', en: '24h', ms: 86400000 },
            { label: '۴۸ ساعت', en: '48h', ms: 86400000 * 2 },
            { label: '۷۲ ساعت', en: '72h', ms: 86400000 * 3 },
            { label: 'یک هفته', en: '1 week', ms: 86400000 * 7 },
            { label: 'دو هفته', en: '2 weeks', ms: 86400000 * 14 },
            { label: 'یک ماه', en: '1 month', ms: 86400000 * 30 },
          ]
          const L = lang()
          // S48o: warn the user if a sprint is already active — creating a new one
          // with dates will auto-close it (the "only 1 active sprint" rule).
          const activeSprint = B().state.sprints.find((s) => !s.is_draft && !s.ended_at)
          const activeWarn = activeSprint
            ? '<div class="sp-define-warn">' + B().esc(_t('db.sprintReplaceWarn', 'This will end the current sprint: {name}').replace('{name}', activeSprint.name)) + '</div>'
            : ''
          definePop.innerHTML =
            '<div class="sp-pop-lab">' + B().esc(_t('db.defineSprint', 'Define a new sprint')) + '</div>' +
            activeWarn +
            '<input maxlength="80" dir="auto" data-sp-define-name placeholder="' + B().esc(_t('db.sprintNamePh', 'Sprint 2 — auth module…')) + '">' +
            '<div class="sp-define-dates">' +
              '<label class="sp-date-label">' + B().esc(_t('db.startDate', 'Start date')) + ' <input type="date" data-sp-define-start></label>' +
              '<label class="sp-date-label">' + B().esc(_t('db.endDate', 'End date')) + ' <input type="date" data-sp-define-end></label>' +
            '</div>' +
            '<div class="sp-define-presets">' +
              presets.map((p) => '<button type="button" class="chip" data-sp-preset="' + p.ms + '">' + (L === 'fa' ? p.label : p.en) + '</button>').join('') +
            '</div>' +
            '<div class="row">' +
              '<button type="button" class="btn small" data-sp-define-ok>' + B().esc(_t('db.defineSprintOk', 'Define')) + '</button>' +
              '<button type="button" class="ghost small" data-sp-define-cancel>' + B().esc(_t('common.cancel', 'Cancel')) + '</button>' +
            '</div>'
          // S48k: CSS centers the modal — no manual positioning needed.
          document.body.appendChild(definePop)
          const nameIn = definePop.querySelector('[data-sp-define-name]')
          const startIn = definePop.querySelector('[data-sp-define-start]')
          const endIn = definePop.querySelector('[data-sp-define-end]')
          nameIn.focus()
          // Preset buttons: set start (defaults to today when empty) + end = start + duration.
          // S49: the preset ALSO writes the start input — a picked preset always means
          // "start a dated sprint now", so commit() must see a non-empty startVal.
          // S206: start parses at UTC MIDNIGHT ('T00:00:00Z') — the timeline axis is
          // UTC-day based (dayIdx = Math.floor(ms/86400000)), so a local-midnight parse
          // (the old 'T00:00:00') landed a picked day one CELL EARLY for every non-UTC
          // user (the owner is UTC+03:30: a "today → +3d" sprint rendered 5 days wide,
          // starting yesterday). UTC parse = the picked date lands exactly on its cell.
          definePop.querySelectorAll('[data-sp-preset]').forEach((btn) => {
            btn.onclick = () => {
              const ms = parseInt(btn.dataset.spPreset, 10)
              const startVal = startIn.value || todayStr
              startIn.value = startVal
              const startDate = new Date(startVal + 'T00:00:00Z')
              const endDate = new Date(startDate.getTime() + ms)
              endIn.value = endDate.toISOString().slice(0, 10)
            }
          })
          const commit = async () => {
            const name = nameIn.value.trim()
            const startVal = startIn.value
            const endVal = endIn.value
            // If start date is provided, create as STARTED with dates
            // S206: UTC-midnight parse (the presets' twin fix) — see the preset note above.
            if (startVal) {
              const startedAt = new Date(startVal + 'T00:00:00Z').toISOString()
              const endedAt = endVal ? new Date(endVal + 'T23:59:59Z').toISOString() : null
              try {
                await B().createSprint(name || undefined, startedAt, endedAt)
                closeDefinePop()
                window.hibana && window.hibana.toast(_t('db.sprintStarted', 'Sprint started'))
                dayOffset = 0
                await reload()
              } catch (err) {
                if (err && err.status === 409) {
                  window.hibana && window.hibana.toast(_t('db.draftExists', 'A sprint is already being defined — start it or delete it first'), 'err')
                } else {
                  window.hibana && window.hibana.toast(_t('sparks.saveFailed', "Couldn't save"), 'err')
                }
              }
              return
            }
            // No start date — create as DRAFT (original behavior)
            try {
              await B().createSprint(name || undefined)
              closeDefinePop()
              window.hibana && window.hibana.toast(_t('db.sprintDefined', 'Sprint defined — add items, then start it'))
              dayOffset = 0
              await reload()
            } catch (err) {
              if (err && err.status === 409) {
                window.hibana && window.hibana.toast(_t('db.draftExists', 'A sprint is already being defined — start it or delete it first'), 'err')
                const card = document.querySelector('[data-sp-draft-card]')
                if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' })
              } else {
                window.hibana && window.hibana.toast(_t('sparks.saveFailed', "Couldn't save"), 'err')
              }
            }
          }
          definePop.querySelector('[data-sp-define-ok]').onclick = commit
          definePop.querySelector('[data-sp-define-cancel]').onclick = closeDefinePop
          nameIn.onkeydown = (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); commit() }
            if (ev.key === 'Escape') closeDefinePop()
          }
        }
        document.getElementById('sp-new-sprint').onclick = openDefinePop
        ctx.on('click', (e) => { if (definePop && !e.target.closest('.sp-define-pop') && !e.target.closest('#sp-new-sprint') && !e.target.closest('[data-sp-empty-define]')) closeDefinePop() })

        // ---- Phase 5: toolbar FINISH button (the running sprint's big red button) ---
        document.getElementById('sp-finish-btn').onclick = async () => {
          const S = B().state
          const open = S.sprints.find((s) => !s.is_draft && !s.ended_at) || null
          if (!open) { window.hibana && window.hibana.toast(_t('sp.noActiveSprint', 'No active sprint to finish'), 'info'); return }
          // S243 (spec §5.3 + Screen H2): the finish CONFIRMATION — identity, the
          // Implemented count that will be archived, the unfinished-stay-put count,
          // "No tasks will be deleted."; the toast then quotes the SERVER's count.
          B().openSprintFinish(open, { onDone: reload })
        }

        // ---- Phase 5 item 8: time-nav paging -----------------------------------------
        document.getElementById('sp-time-prev').onclick = () => {
          dayOffset -= ZOOMS[zoom].win
          const sc = document.getElementById('sp-scroll')
          delete sc.dataset.scrolled
          render()
        }
        document.getElementById('sp-time-next').onclick = () => {
          if (dayOffset >= 0) return
          dayOffset = Math.min(0, dayOffset + ZOOMS[zoom].win)
          const sc = document.getElementById('sp-scroll')
          delete sc.dataset.scrolled
          render()
        }

        // ---- DnD: sidebar reorder (categories & tasks) + bar → sprint/lane ------------
        let dragKind = null // 'cat' | 'side-task' | 'bar'
        let dragEl = null
        let dragTaskId = null
        let dropTarget = null
        const clearDropUi = () => {
          document.querySelectorAll('.sp-cat.is-target, .sp-lane.is-target, .sp-sprint.is-target, .sp-draft-card.is-target').forEach((x) => x.classList.remove('is-target'))
          dropTarget = null
        }
        ctx.on('dragstart', (e) => {
          if (e.target.closest('input, textarea, select')) return // native text drags stay native
          const task = e.target.closest('[data-sptask]')
          const bar = e.target.closest('[data-bar]')
          const cat = e.target.closest('.sp-cat')
          if (task) { dragKind = 'side-task'; dragEl = task; dragTaskId = task.dataset.task }
          else if (bar) { dragKind = 'bar'; dragEl = bar; dragTaskId = bar.dataset.task }
          else if (cat && cat.dataset.spcat !== 'none') { dragKind = 'cat'; dragEl = cat; dragTaskId = null }
          else return
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', dragTaskId || dragEl.dataset.spcat)
          dragEl.classList.add('dragging')
        })
        ctx.on('dragover', (e) => {
          if (!dragEl) return
          if (dragKind === 'cat') {
            const over = e.target.closest('.sp-cat')
            if (!over || over === dragEl || over.dataset.spcat === 'none') return
            e.preventDefault()
            const r = over.getBoundingClientRect()
            const after = e.clientY > r.top + r.height / 2
            over.parentElement.insertBefore(dragEl, after ? over.nextSibling : over)
          } else if (dragKind === 'side-task') {
            const list = e.target.closest('.sp-cat-tasks')
            if (list) {
              // the sidebar's own lists: the reorder/move-across-categories path
              e.preventDefault()
              const target = e.target.closest('[data-sptask]')
              const addRow = list.querySelector('.sp-task-addrow')
              if (target && target !== dragEl) {
                const r = target.getBoundingClientRect()
                const after = e.clientY > r.top + r.height / 2
                list.insertBefore(dragEl, after ? target.nextSibling : target)
              } else if (addRow) {
                list.insertBefore(dragEl, addRow)
              }
              return
            }
            // S206 (owner: "the sprint system is buggy" — probe-confirmed): a sidebar
            // task dragged over the TIMELINE (a sprint strip, the draft card, a category
            // lane) used to die silently — dragover never called preventDefault outside
            // the sidebar lists, so the browser REFUSED the drop (the draft card's
            // "drag them here" hint advertised exactly this). Same targets the timeline
            // bars accept, same is-target cues; the drop branch below assigns.
            const sprintEl = e.target.closest('.sp-sprint')
            const draftCard = e.target.closest('[data-sp-draft-card]')
            const lane = e.target.closest('.sp-lane')
            if (draftCard || sprintEl || lane) {
              e.preventDefault()
              clearDropUi()
              if (draftCard) { draftCard.classList.add('is-target'); dropTarget = { kind: 'sprint', id: draftCard.dataset.spDraftCard } }
              else if (sprintEl) { sprintEl.classList.add('is-target'); dropTarget = { kind: 'sprint', id: sprintEl.dataset.sprint } }
              else if (lane) { lane.classList.add('is-target'); dropTarget = { kind: 'category', id: lane.dataset.lane } }
            }
          } else {
            const sprintEl = e.target.closest('.sp-sprint')
            const draftCard = e.target.closest('[data-sp-draft-card]')
            const lane = e.target.closest('.sp-lane')
            e.preventDefault()
            clearDropUi()
            if (draftCard) { draftCard.classList.add('is-target'); dropTarget = { kind: 'sprint', id: draftCard.dataset.spDraftCard } }
            else if (sprintEl) { sprintEl.classList.add('is-target'); dropTarget = { kind: 'sprint', id: sprintEl.dataset.sprint } }
            else if (lane) { lane.classList.add('is-target'); dropTarget = { kind: 'category', id: lane.dataset.lane } }
          }
        })
        ctx.on('drop', async (e) => {
          if (!dragEl) return
          e.preventDefault()
          const kind = dragKind
          const el = dragEl
          const taskId = dragTaskId
          dragKind = null; dragEl = null; dragTaskId = null
          el.classList.remove('dragging')
          const target = dropTarget
          clearDropUi()
          try {
            if (kind === 'cat') {
              // S152: the library reads name-ordered — the per-project reorder retired
              // with the global category system.
              await reload()
            } else if (kind === 'side-task') {
              // S206: dropped on a TIMELINE target (sprint strip / draft card /
              // category lane) → the ASSIGNMENT path (the bar drag's contract,
              // now shared by sidebar tasks). A sidebar drop (target null) keeps
              // the reorder/move-category path below.
              if (target && taskId) {
                const task = B().findTask(taskId)
                if (task) {
                  try {
                    if (target.kind === 'sprint') {
                      if (task.sprint_id !== target.id) {
                        await B().patchTask(task.id, { sprint_id: target.id })
                        window.hibana && window.hibana.toast(_t('db.movedToSprint', 'Moved to sprint'))
                      }
                    } else if (target.kind === 'category') {
                      const catId = target.id === 'none' ? null : target.id
                      if (task.category_id !== catId) await B().patchTask(task.id, { category_id: catId })
                    }
                  } finally { await reload() }
                  return
                }
              }
              const task = taskId ? B().findTask(taskId) : null
              if (task) {
                const host = el.closest('.sp-cat')
                const newCat = host ? (host.dataset.spcat === 'none' ? null : host.dataset.spcat) : undefined
                if (newCat !== undefined && (newCat === null || newCat !== task.category_id)) {
                  await B().patchTask(task.id, { category_id: newCat })
                }
              }
              const ids = [...sideEl.querySelectorAll('[data-sptask]')].map((x) => x.dataset.sptask)
              if (ids.length > 1) await B().reorderTasks(ids)
              await reload()
            } else if (kind === 'bar' && target && taskId) {
              const task = B().findTask(taskId)
              if (task) {
                if (target.kind === 'sprint') {
                  if (task.sprint_id !== target.id) {
                    await B().patchTask(task.id, { sprint_id: target.id })
                    window.hibana && window.hibana.toast(_t('db.movedToSprint', 'Moved to sprint'))
                  }
                } else if (target.kind === 'category') {
                  const catId = target.id === 'none' ? null : target.id
                  if (task.category_id !== catId) await B().patchTask(task.id, { category_id: catId })
                }
                await reload()
              }
            }
          } catch { window.hibana && window.hibana.toast(_t('sparks.saveFailed', "Couldn't save"), 'err'); await reload() }
        })
        ctx.on('dragend', () => {
          if (dragEl) dragEl.classList.remove('dragging')
          dragKind = null; dragEl = null; dragTaskId = null
          clearDropUi()
        })

        const zoomSel = document.getElementById('sp-zoom-sel')
        zoomSel.addEventListener('change', () => {
          zoom = zoomSel.value
          const sc = document.getElementById('sp-scroll')
          delete sc.dataset.scrolled
          dayOffset = 0 // a zoom change returns to the today window (the home view)
          computeRange() // the window (and thus the axis span) depends on the zoom level
          renderTimeline()
          renderTimeNav()
        })

        // Refit the timeline when the viewport changes (the window-fit scale depends on it).
        let spResizeT = null
        ctx.on('resize', () => {
          clearTimeout(spResizeT)
          spResizeT = setTimeout(renderTimeline, 150)
        })

        // ---- boot ---------------------------------------------------------------
        const ensureLib = () => new Promise((resolve) => {
          if (window.HibanaBoard) return resolve(true)
          let waited = 0
          let injected = false
          const inject = (src) => {
            const el = document.createElement('script')
            el.src = src
            document.head.appendChild(el)
          }
          const tick = () => {
            if (window.HibanaBoard) return resolve(true)
            if (!injected && waited >= 1200) {
              injected = true
              inject('/js/devboard.js?v=36') // keep in sync with the <head> tag + sw SHELL
              if (!window.jalaali) inject('/vendor/jalaali.min.js') // Jalali timeline for FA
            }
            if (waited >= 9000) return resolve(false)
            waited += 150
            setTimeout(tick, 150)
          }
          tick()
        })
        const escS = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
        const fail = () => {
          wrap.hidden = true
          loading.hidden = false
          loading.innerHTML = '<span>' + escS(_t('db.loadFailed', "Couldn't load")) + '</span> <button type="button" class="btn small" id="sp-retry">' + escS(_t('db.retry', 'Try again')) + '</button>'
        }
        const gone = () => {
          wrap.hidden = true
          loading.hidden = false
          loading.innerHTML = '<span>' + escS(_t('db.projectGone', "This project doesn't exist or was deleted")) + '</span> <a class="btn small" href="/projects.html">' + escS(_t('db.backToProjects', 'Back to projects')) + '</a>'
        }
        ctx.on('click', (e) => {
          if (!e.target.closest('#sp-retry')) return
          loading.innerHTML = '<span>' + escS(_t('db.loading', 'Loading…')) + '</span>'
          boot()
        })
        const boot = async () => {
          document.querySelector('[data-back-link]').href = '/project.html?id=' + projectId
          // S209 (kanban 1:1 parity): Board → the CANONICAL /kanban entry (both hosts
          // serve it — the same Worker route), not the legacy /board.html spelling.
          document.getElementById('sp-board-link').href = '/kanban?project=' + projectId
          document.title = 'Sprints — Hibana'
          const ok = await ensureLib()
          if (!ok) return fail()
          try {
            await reload()
            document.getElementById('sp-title').textContent = B().state.project ? B().state.project.title : ''
            // S243 (Screen G's Settings entry): ?sprint=<id> deep-links the detail
            // panel open (the Kanban compact overview's Settings action targets it).
            const deep = qs.get('sprint')
            if (deep && B().findSprint(deep)) openSprintDetail(deep, 'settings')
          } catch (err) {
            if (err && err.status === 404) return gone()
            fail()
          }
        }
        // S30 batch 5 (FA-guard find): `ready` is a PROMISE (always truthy) — the old
        // truthy-check booted BEFORE apply() resolved the language, so FA users got an
        // English first render. Await it: it resolves AFTER the lazy FA dictionary
        // lands (i18n.js's apply awaits ensureFaDict before resolving).
        if (window.hibanaI18n && window.hibanaI18n.ready) window.hibanaI18n.ready.then(boot).catch(boot)
        else document.addEventListener('hibana:i18n', boot, { once: true })
      },
    })
