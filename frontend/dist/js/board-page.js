    window.__hibanaPage = window.__hibanaPage || ((d) => (window.__hibanaPageQueue = window.__hibanaPageQueue || []).push(d))
    window.__hibanaPage({
      name: 'board',
      mount(ctx) {
        const B = () => window.HibanaBoard
        const qs = new URLSearchParams(location.search)
        // S205: `let` — the project switcher (below) swaps the loaded project in place.
        const openTask = qs.get('task')
        const addStatus = qs.get('add')
        let projectId = qs.get('project')
        const root = document.getElementById('db-board')
        const loading = document.getElementById('db-loading')
        // Translate through hibanaI18n when it's up (FA users must see the FA strings even
        // while HibanaBoard is still missing — the raw English fallback leaked for weeks).
        const _t = (k, f) => {
          const s = window.hibanaI18n ? window.hibanaI18n.t(k) : null
          return s && s !== k ? s : (window.HibanaBoard ? B().t(k, f) : f)
        }
        const escS = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

        // S205 (spec §3.1/§3.2): /kanban is the dedicated entry point and owns the
        // no-project behavior — default-project resolution (last-used board → most-recent
        // accessible project → the no-projects empty state) happens in boot() below. A
        // bare /board.html now redirects THERE (was: /projects.html) — the entry point
        // handles the no-project case far better; every ?project= deep link is untouched.
        // Both spellings checked (live 307s /kanban.html → /kanban; Node serves both —
        // the s158 page-identity lesson).
        const isKanbanEntry = () => location.pathname === '/kanban' || location.pathname === '/kanban.html'
        if (!projectId && !isKanbanEntry()) { location.replace('/kanban'); return }
        // S206 (owner ask 2026-10-18): the dedicated entry drops the "← Back to project"
        // link — there is no "back" context on /kanban (you didn't arrive FROM a
        // project), and the freed toolbar width goes to the project name (the switcher).
        // /board.html?project= keeps the link — it's the project-page context. Navigation
        // from the entry: the edge-hover rail, the switcher, g k / the go-to palette.
        if (isKanbanEntry()) {
          const backLink = document.querySelector('[data-back-link]')
          if (backLink) backLink.hidden = true
        }

        // S30 batch 2: the filter state (module-scope — render() reads it; the toggles
        // mutate + re-render). Names are stored LOWERCASE for case-insensitive matching.
        // S136: the SEARCH INPUT joins the bar — the project page's db-filter twin
        // (project-page.js pdFilterQuery) has had one since S78; the fullscreen board
        // renders the SAME bar now (same classes, same order: search → Priority →
        // Labels). Query matches the raw title, lowercased, like the project page.
        const filterPrios = new Set()
        const filterTags = new Set()
        let filterQuery = ''
        // S242 (spec pack §7.5/Screen A): the fourth filter dimension — the SPRINT
        // view filter. '' = All tasks (the default — today's board behavior);
        // '__none' = No sprint; any other value = a sprint id (ANY lifecycle state
        // — a VIEW filter: a completed sprint's unfinished tasks stay findable).
        // Composes AND with priority × label × search; never mutates assignments.
        let filterSprint = ''
        const filterSearchTimer = { t: null }

        // ---- S237 (Focus Mode) ----------------------------------------------------
        // The PURE decisions live in public/js/focus-core.js (window.HibanaFocusCore —
        // parseToggle / cycleLane / escLayer / autoRestore / resolveFKey, covered by
        // src/tests/focus-mode-s237.test.ts). This block owns the DOM half: the two
        // per-lane head buttons (blur-focus + enlarge), the dim recipe re-applied at
        // every render's tail (innerHTML rebuilds the lanes — the focus must survive
        // task creates/edits/moves), the enlarge sheet (a centered RTL-native dialog
        // over a dimmed-board overlay, sticky auto-focused quick-add, cards cloned
        // from the board lane so the markup can NEVER drift), the F / [ / ] / Esc
        // keyboard layer (capture phase — one Esc peels EXACTLY one layer and a
        // consumed press never reaches zen-mode's own Esc listener), and the
        // hibana:focus-mode listener (both settings surfaces — the web page + the
        // desktop panel — write the SAME localStorage key and dispatch it, so the
        // toggle is live). When the toggle is OFF the board renders byte-identical
        // markup to today's: no buttons, no classes, no CSS effect.
        const FC = () => window.HibanaFocusCore
        const focus = { enabled: false, focusedStatus: null, sheetStatus: null }
        const focusStorage = {
          readToggle() { try { return localStorage.getItem(FC().TOGGLE_KEY) } catch { return null } },
          readLast() { try { return localStorage.getItem(FC().LAST_KEY) } catch { return null } },
          writeLast(st) { try { localStorage.setItem(FC().LAST_KEY, st) } catch { /* private mode */ } },
        }
        focus.enabled = FC() ? FC().parseToggle(focusStorage.readToggle()) : false
        let hoverLane = null
        // <800px (spec §1.6): the two head buttons hide via CSS and the F/[/]
        // shortcuts go quiet. prefers-reduced-motion is handled ENTIRELY in CSS
        // (the transition is declared in devboard.css + killed by the media query).
        const narrowBoard = () => !!(window.matchMedia && window.matchMedia('(max-width: 799px)').matches)

        // The two head-button glyphs (target + expand) — inline SVG, board style.
        const I_TARGET = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>'
        const I_EXPAND = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>'

        // The dim recipe — ONE class per lane container (never per-card work, no
        // layout shift). Called at render's tail + by the focus mutators (class-level
        // only — a full re-render would rebuild the DOM and skip the ~150ms beat).
        const syncFocusBtns = () => {
          root.querySelectorAll('.db-focus-btn').forEach((btn) => {
            const on = btn.getAttribute('data-db-focus') === focus.focusedStatus
            btn.setAttribute('aria-pressed', on ? 'true' : 'false')
            btn.classList.toggle('is-active', on)
            btn.setAttribute('title', on ? _t('db.focus.exit', 'Exit focus (Esc)') : _t('db.focus.toggle', 'Focus this column'))
          })
        }
        const applyFocus = () => {
          const colsEl = root.querySelector('.db-cols')
          if (!colsEl) return
          if (focus.enabled && focus.focusedStatus) colsEl.setAttribute('data-focus-active', '')
          else colsEl.removeAttribute('data-focus-active')
          root.querySelectorAll('.db-cols > .pd-col').forEach((col) => {
            col.classList.toggle('db-dim', !!(focus.enabled && focus.focusedStatus && col.getAttribute('data-status') !== focus.focusedStatus))
          })
          syncFocusBtns()
        }
        const setFocus = (st) => {
          if (!focus.enabled || !FC() || !FC().validStatus(st)) return
          focus.focusedStatus = st
          focusStorage.writeLast(st) // hibana-focus-last remembers the lane (spec §1.5)
          applyFocus()
        }
        const clearFocus = () => {
          if (!focus.focusedStatus) return
          focus.focusedStatus = null // the LAST key stays — it remembers the lane
          applyFocus()
        }

        // ---- the enlarge sheet (spec §1.3) ---------------------------------------
        // A centered modal over a dimmed-board overlay: its own internal scroll, the
        // S233 close grammar (title row + corner ✕ on the inline end — RTL mirrors),
        // a sticky auto-focused quick-add whose Enter creates through the SAME
        // devboard createTask call the editor uses (no duplicated POST logic; the
        // desktop's S234 audio classifier sees the create cue), and the lane's cards
        // CLONED from the board lane's .pd-tasks (byte-identical markup + the same
        // filter view — the sheet is the lane's mirror, enlarged). Drag/drop is
        // disabled inside it (v1 — reading/adding/editing; cross-lane moves happen
        // on the board). One sheet at a time; opening another lane replaces it.
        // Sheets are ALWAYS transient — never restored on load.
        let sheetEl = null
        let sheetReturnBtn = null
        const laneTitleOf = (st) => {
          const lane = root.querySelector('.db-cols > .pd-col[data-status="' + st + '"]')
          const el = lane ? lane.querySelector('.pd-col-title') : null
          return el ? el.textContent.trim() : B().statusLabel(st)
        }
        const laneCountOf = (st) => {
          const lane = root.querySelector('.db-cols > .pd-col[data-status="' + st + '"]')
          const el = lane ? lane.querySelector('.detail-tab-count') : null
          const n = el ? parseInt(String(el.textContent).replace(/[^0-9]/g, ''), 10) : NaN
          return Number.isFinite(n) ? n : B().state.tasks.filter((x) => x.status === st).length
        }
        const refreshSheet = () => {
          if (!sheetEl || !focus.sheetStatus) return
          const st = focus.sheetStatus
          const lane = root.querySelector('.db-cols > .pd-col[data-status="' + st + '"]')
          const laneBody = lane ? lane.querySelector('.pd-tasks') : null
          const laneEl = sheetEl.querySelector('[data-sheet-lane]')
          const countEl = sheetEl.querySelector('[data-sheet-count]')
          if (laneEl) laneEl.textContent = laneTitleOf(st)
          if (countEl) countEl.textContent = B().faDig(laneCountOf(st))
          const dialog = sheetEl.querySelector('.db-focus-sheet')
          if (dialog) {
            dialog.setAttribute('aria-label', _t('db.focus.sheetTitle', '{lane} — {n} tasks')
              .replace('{lane}', laneTitleOf(st)).replace('{n}', String(laneCountOf(st))))
          }
          const input = sheetEl.querySelector('[data-db-focus-quick]')
          if (input) input.setAttribute('placeholder', _t('db.focus.sheetAdd', 'Add a task to this column…'))
          const cardsEl = sheetEl.querySelector('[data-sheet-cards]')
          if (cardsEl && laneBody) {
            // The lane's exact inner markup — cards AND the empty-state group —
            // cloned so the sheet can never drift from the board lane.
            cardsEl.innerHTML = laneBody.innerHTML
            // v1: no drag from the sheet — the markup is shared verbatim, so the
            // switch happens post-render (plus the dragstart guard below).
            cardsEl.querySelectorAll('.pd-task').forEach((el) => el.setAttribute('draggable', 'false'))
            // S238: the cloned ⋯ menus arrive data-ok (copied off the ARMED board
            // menus) — the marker makes injectDbCardMenus skip them, so the
            // sheet's Copy/Edit/Delete were dead UI. Strip it: the injector
            // re-arms the clones (fresh innerHTML + live handlers — the sheet's
            // rows work exactly like the lane's own).
            cardsEl.querySelectorAll('.db-card-menu[data-ok]').forEach((el) => el.removeAttribute('data-ok'))
            injectDbCardMenus()
            // S238: the one-tap COPY button on every row (the owner's ask: copy a
            // single task without opening the ⋯ menu).
            injectSheetCopyRows(cardsEl)
          }
        }
        const onSheetQuickAdd = async (e) => {
          e.preventDefault()
          if (!focus.sheetStatus) return
          const input = e.currentTarget.querySelector('[data-db-focus-quick]')
          const title = String(input.value || '').trim()
          if (!title) { input.focus(); return }
          input.disabled = true
          try {
            // The SAME creation call the board's editor path uses (devboard.js's
            // createTask → POST /api/projects/:id/devtasks through the one api()
            // choke point) — the quick-add never rolls its own POST.
            await B().createTask({ title, status: focus.sheetStatus, priority: 'medium' })
            window.hibana?.toast(_t('db.taskAdded', 'Task added'), 'ok')
            input.value = '' // cleared + kept open for rapid entry (spec §1.3)
            await reload() // reload → render → refreshSheet: count + cards update
          } catch {
            window.hibana?.toast(_t('sparks.saveFailed', "Couldn't save"), 'err')
          }
          input.disabled = false
          const fresh = sheetEl ? sheetEl.querySelector('[data-db-focus-quick]') : null
          if (fresh) fresh.focus()
        }
        const ensureSheet = () => {
          if (sheetEl) return sheetEl
          sheetEl = document.createElement('div')
          sheetEl.id = 'db-focus-overlay'
          sheetEl.className = 'db-focus-overlay'
          sheetEl.hidden = true
          sheetEl.innerHTML =
            '<div class="db-focus-sheet" role="dialog" aria-modal="true" aria-labelledby="db-focus-sheet-title">' +
              '<div class="row spread db-focus-sheet-head">' +
                '<h3 id="db-focus-sheet-title"><span class="db-focus-sheet-lane" data-sheet-lane></span> <span class="detail-tab-count" data-sheet-count></span></h3>' +
                '<button type="button" class="ghost" data-db-focus-sheet-x aria-label="' + B().esc(_t('common.close', 'Close')) + '" title="' + B().esc(_t('common.close', 'Close')) + '">✕</button>' +
              '</div>' +
              '<form class="db-focus-quick" autocomplete="off">' +
                '<input type="text" class="db-focus-quick-input" data-db-focus-quick dir="auto" maxlength="150" aria-label="' + B().esc(_t('db.focus.sheetAdd', 'Add a task to this column…')) + '">' +
              '</form>' +
              '<div class="db-focus-cards db-cols" data-sheet-cards></div>' +
            '</div>'
          document.body.appendChild(sheetEl)
          // Backdrop click closes (the delete-confirm's own grammar).
          sheetEl.addEventListener('click', (e) => { if (e.target === sheetEl) closeSheet() })
          sheetEl.querySelector('[data-db-focus-sheet-x]').addEventListener('click', closeSheet)
          sheetEl.querySelector('form.db-focus-quick').addEventListener('submit', onSheetQuickAdd)
          return sheetEl
        }
        const openSheet = (st) => {
          if (!focus.enabled || !FC() || !FC().validStatus(st)) return
          ensureSheet()
          focus.sheetStatus = st // one sheet at a time — a second open replaces it
          refreshSheet()
          sheetReturnBtn = document.querySelector('.db-focus-enlarge[data-db-focus-sheet="' + st + '"]')
          sheetEl.hidden = false
          const input = sheetEl.querySelector('[data-db-focus-quick]')
          if (input) input.focus() // sticky auto-focus: ready to type immediately
        }
        const closeSheet = () => {
          if (!sheetEl || focus.sheetStatus == null) return
          focus.sheetStatus = null
          sheetEl.hidden = true
          if (sheetReturnBtn && document.contains(sheetReturnBtn)) sheetReturnBtn.focus()
          sheetReturnBtn = null
        }

        // ---- S238: the task VIEW modal ----------------------------------------
        // A card click (Enter/Space on a focused card, and a ?task= deep link)
        // now OPENS THE TASK — a centered READ-ONLY dialog over the same blurred,
        // color-drained backdrop the enlarge sheet wears — instead of the editor.
        // The editor opens ONLY from the ⋯ menu's Edit (the board card's menu, the
        // armed clone inside the sheet, or the view's own Edit button — the project
        // page's S149 contract, brought to the board). It sits BETWEEN the sheet
        // (z 80) and the task editor (z 90): a view opened from a sheet row stacks
        // above it, and its Edit hands off to the real editor after closing. Esc
        // peels it FIRST (view → sheet → focus — focus-core.js's escPeel); when a
        // native <dialog> (the delete confirm / the shots viewer / the shot-note
        // editor) or the task editor sits ABOVE it, the Esc is theirs, never ours.
        // Data comes from the LOADED state (B().findTask — zero new fetch; the
        // island's seam count stays exactly four).
        let taskViewEl = null
        let taskViewTask = null
        let taskViewReturn = null
        const viewIsOpen = () => !!(taskViewEl && !taskViewEl.hidden)
        const VIEW_PIN_ICON = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17v4M8.5 3.5h7l-.8 7.2 2.8 2.8v1.5H6.5v-1.5l2.8-2.8-.8-7.2Z"/></svg>'
        const renderTaskView = (task) => {
          const lang = window.hibanaI18n && window.hibanaI18n.lang ? window.hibanaI18n.lang() : 'en'
          const chips = () => window.HibanaChips || null
          const md = (raw) => (chips() && chips().renderTitle ? chips().renderTitle(String(raw == null ? '' : raw)) : B().esc(String(raw == null ? '' : raw)))
          const metaDate = (iso, done) => (chips() && chips().metaDateHtml ? chips().metaDateHtml(iso, done, lang) : B().esc(String(iso || '')))
          const prioLong = (p) => (chips() ? chips().prioLabel(p, lang) : B().prioLabel(p))
          const prio = task.priority || 'medium'
          const cat = task.category_id ? B().findCategory(task.category_id) : null
          const sprint = task.sprint_id ? B().findSprint(task.sprint_id) : null
          const tags = (task.tags || []).map((id) => B().tagById(id)).filter(Boolean)
          // the banner twin — same classes, NO cycle button (the view is read-only)
          const bannerHtml = '<span class="prio-banner prio-' + prio + ' db-view-prio"><span class="prio-banner-label">' + B().esc(prioLong(prio)) + '</span></span>'
          const catHtml = cat ? '<span class="cat-chip" style="background:' + B().esc(cat.color_fill) + ';color:' + B().esc(cat.color_text) + '">' + B().esc(cat.name) + '</span>' : ''
          // the FULL definition — first line = the heading, the rest = the body (the
          // editor's own split), both through the SAME markdown-lite renderer
          const s = String(task.title || '')
          const nl = s.indexOf('\n')
          const titlePart = nl >= 0 ? s.slice(0, nl) : s
          const contentPart = nl >= 0 ? s.slice(nl + 1) : ''
          // inert tag chips — no data-pd-tag-name: the view never toggles filters.
          // S242: the sprint chip wears the sprint's emoji (else the default ◆) —
          // every sprint-identity surface reads the same glyph (spec §4.2).
          const chipsHtml = (tags.length || sprint)
            ? '<span class="pd-task-tags">' + tags.map((tg) => '<span dir="auto" class="pd-tag"><i class="pd-tag-dot" style="background:' + B().esc(tg.color) + '"></i>' + B().esc(tg.name) + '</span>').join('') +
                (sprint ? '<span class="db-sprint-badge">' + B().esc((sprint.emoji ? sprint.emoji + ' ' : '◆ ') + sprint.name) + '</span>' : '') + '</span>'
            : ''
          const shotsN = Number(task.shot_count || 0)
          const shotsHtml = shotsN
            ? '<button type="button" class="pd-task-shots" data-db-shots-dialog="' + B().esc(task.id) + '" title="' + B().esc(_t('db.taskShotsHint', 'Pinned pictures — note + proof stuck to this item')) + '" aria-label="' + B().esc(_t('db.taskShotsBadge', 'Pinned pictures ({n})').replace('{n}', String(shotsN))) + '">' + VIEW_PIN_ICON + ' ' + B().faDig(shotsN) + '</button>'
            : ''
          const metaHtml = '<div class="db-view-meta">' +
              '<span>' + B().esc(_t('db.view.created', 'Created')) + ' ' + metaDate(task.created_at, task.status === 'done') + '</span>' +
              (task.updated_at && task.updated_at !== task.created_at ? '<span>' + B().esc(_t('db.view.updated', 'Updated')) + ' ' + metaDate(task.updated_at, false) + '</span>' : '') +
              (task.status === 'done' && task.done_at ? '<span>✓ ' + B().esc(_t('db.view.doneAt', 'Done')) + ' ' + metaDate(task.done_at, false) + '</span>' : '') +
              // S244 (spec §12.3/§12.4): the read-only view's meta rows join the
              // deadline display — the same row grammar (icon + the threshold
              // word; a done task reads neutral with the Done indication).
              (B().deadlineViewHtml ? B().deadlineViewHtml(task, lang) : '') +
              // S246 (spec §16): the view is the DETAILS surface — the dep rows
              // join the meta stack through the row-only twin, which carries the
              // blocker NAMES ("detailed blocker names belong in task details or
              // the Edit Task modal, not in long card text").
              (B().depViewHtml ? B().depViewHtml(task, null, null, lang) : '') +
              (shotsHtml || '') +
            '</div>'
          const head = taskViewEl.querySelector('.db-view-head h3')
          if (head) head.textContent = B().statusLabel(task.status) // the lane this task lives in
          const body = taskViewEl.querySelector('.db-view-body')
          if (body) {
            body.innerHTML = bannerHtml + catHtml +
              '<h4 class="db-view-task-title" dir="auto">' + md(titlePart) + '</h4>' +
              (contentPart ? '<div class="db-view-task-content" dir="auto">' + md(contentPart) + '</div>' : '') +
              chipsHtml + metaHtml
          }
        }
        const ensureTaskView = () => {
          if (taskViewEl) return taskViewEl
          taskViewEl = document.createElement('div')
          taskViewEl.id = 'db-view-overlay'
          taskViewEl.className = 'db-view-overlay'
          taskViewEl.hidden = true
          taskViewEl.innerHTML =
            '<div class="db-view-card" role="dialog" aria-modal="true" aria-label="' + B().esc(_t('db.view.title', 'Task details')) + '">' +
              '<div class="row spread db-view-head">' +
                '<h3></h3>' +
                '<button type="button" class="ghost" data-db-view-x aria-label="' + B().esc(_t('common.close', 'Close')) + '" title="' + B().esc(_t('common.close', 'Close')) + '">✕</button>' +
              '</div>' +
              '<div class="db-view-body"></div>' +
              '<div class="db-view-foot">' +
                '<button type="button" class="ghost" data-db-view-copy aria-label="' + B().esc(_t('db.view.copyTask', 'Copy task')) + '" title="' + B().esc(_t('db.view.copyTask', 'Copy task')) + '">' + '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' + '<span>' + B().esc(_t('common.copy', 'Copy')) + '</span></button>' +
                '<button type="button" class="btn" data-db-view-edit>' + '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>' + '<span>' + B().esc(_t('common.edit', 'Edit')) + '</span></button>' +
              '</div>' +
            '</div>'
          document.body.appendChild(taskViewEl)
          // backdrop click closes (the sheet's own grammar)
          taskViewEl.addEventListener('click', (e) => { if (e.target === taskViewEl) closeTaskView() })
          taskViewEl.querySelector('[data-db-view-x]').addEventListener('click', closeTaskView)
          // the one-tap copy — the RAW full definition (data-raw-title's twin)
          taskViewEl.querySelector('[data-db-view-copy]').addEventListener('click', async () => {
            const text = taskViewTask ? String(taskViewTask.title || '') : ''
            try {
              await navigator.clipboard.writeText(text)
              window.hibana?.toast(_t('common.copied', 'Copied to clipboard'), 'ok')
            } catch { window.hibana?.toast(_t('sparks.saveFailed', "Couldn't copy"), 'err') }
          })
          // Edit: the view closes, the REAL editor opens (the project detail's handoff)
          taskViewEl.querySelector('[data-db-view-edit]').addEventListener('click', () => {
            const id = taskViewTask ? taskViewTask.id : null
            closeTaskView()
            if (id) B().openEditor(id, { onSaved: reload })
          })
          return taskViewEl
        }
        const openTaskView = (taskId, returnEl) => {
          const task = taskId ? B().findTask(taskId) : null
          if (!task) { window.hibana?.toast(_t('db.view.gone', 'This task no longer exists.'), 'err'); return }
          ensureTaskView()
          taskViewTask = task
          renderTaskView(task)
          taskViewReturn = (returnEl instanceof Element && document.contains(returnEl)) ? returnEl : null
          taskViewEl.hidden = false
          const x = taskViewEl.querySelector('[data-db-view-x]')
          if (x) x.focus() // the escape hatch is the tab root while the view is open
        }
        const closeTaskView = () => {
          if (!taskViewEl || taskViewEl.hidden) return
          taskViewEl.hidden = true
          taskViewTask = null
          if (taskViewReturn && document.contains(taskViewReturn)) taskViewReturn.focus()
          taskViewReturn = null
        }

        // ---- the keyboard layer (F / [ / ] / Esc — toggle-gated, spec §1.4) ------
        // Esc registers on the CAPTURE phase + stopImmediatePropagation when
        // consumed: one press peels EXACTLY one layer (view → sheet → focus —
        // S238 grew the stack inward) and never double-fires zen-mode's own
        // (web-only) Esc listener in the same press. When no focus layer is ours
        // the press is left alone — menus, dialogs and zen keep their own Esc
        // contracts.
        const isTyping = (e) => {
          const t = e.target
          if (!(t instanceof Element) || !t.closest) return false
          return !!t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
        }
        ctx.on('keydown', (e) => {
          if (e.ctrlKey || e.metaKey || e.altKey) return
          if (e.key === 'Escape') {
            // S238: the FULL peel — the task VIEW is the innermost layer, focus
            // mode or not. When a native <dialog> (the delete confirm / the shots
            // viewer / the shot-note editor) or the task editor sits ABOVE it,
            // the Esc is theirs — the press falls through untouched.
            const peel = FC() ? FC().escPeel({ viewOpen: viewIsOpen(), sheetStatus: focus.sheetStatus, focusedStatus: focus.focusedStatus }) : (viewIsOpen() ? 'view' : null)
            if (peel === 'view') {
              if (document.querySelector('dialog[open]') || document.querySelector('.db-modal:not([hidden])')) return
              e.stopImmediatePropagation()
              closeTaskView()
              return
            }
            if (!focus.enabled || !FC()) return
            const layer = FC().escLayer(focus)
            if (layer === 'sheet') { e.stopImmediatePropagation(); closeSheet() }
            else if (layer === 'focus') { e.stopImmediatePropagation(); clearFocus() }
            return
          }
          if (!focus.enabled || !FC()) return
          if (narrowBoard()) return // <800px the F/[/] shortcuts go quiet (spec §1.6)
          if (isTyping(e)) return // never steal keys from a field
          if (e.key === 'f' || e.key === 'F') {
            const target = FC().resolveFKey(hoverLane, focusStorage.readLast())
            if (!target) return // no hover, no last lane — F never guesses
            e.preventDefault()
            if (target === focus.focusedStatus) clearFocus() // natural toggle — the button's twin
            else setFocus(target)
            return
          }
          if ((e.key === '[' || e.key === ']') && focus.focusedStatus) {
            e.preventDefault()
            setFocus(FC().cycleLane(focus.focusedStatus, e.key === ']' ? 1 : -1))
          }
        }, true) // CAPTURE — see the block comment above
        // The F target: the lane under the cursor (mouseover bubbles through the
        // delegated layer; the last hovered lane sticks once the pointer leaves).
        ctx.on('mouseover', (e) => {
          const t = e.target instanceof Element ? e.target : null
          const col = t && t.closest ? t.closest('.db-cols > .pd-col') : null
          if (col) hoverLane = col.getAttribute('data-status')
        })
        // Both settings surfaces (the web settings page + the desktop panel) write
        // the key then dispatch hibana:focus-mode — re-read + re-render so the
        // toggle is LIVE (no reload; the desktop island ships this same controller).
        ctx.on('hibana:focus-mode', () => {
          const next = FC() ? FC().parseToggle(focusStorage.readToggle()) : false
          if (next === focus.enabled) return
          focus.enabled = next
          if (!next) { clearFocus(); closeSheet() }
          render()
        })

        const render = () => {
          const S = B().state
          const titleEl = document.getElementById('db-title')
          titleEl.textContent = S.project ? S.project.title : ''
          // S206: the name ELLIPSIZES to one line now (devboard.css) — the full name
          // rides the span's title so a hover always reveals it.
          titleEl.setAttribute('title', S.project ? S.project.title : '')
          // S64 convention (the project page): the tab title carries the project's OWN
          // name (language-neutral user content), not a generic "Board".
          if (S.project && S.project.title) document.title = S.project.title + ' — Hibana'
          document.getElementById('db-sprint-link').href = '/sprint.html?project=' + projectId
          // UI-redesign: the Project Progress summary (the "{n} of {m} done" completed/
          // total card) is removed from the toolbar per spec §3.2. The #db-counts span
          // stays in the markup (the sync's kept-markup check expects the toolbar ids)
          // but is emptied + hidden so no summary renders. Reclaim the space for the board.
          const countsEl = document.getElementById('db-counts')
          if (countsEl) { countsEl.textContent = ''; countsEl.hidden = true }

          const lang = window.hibanaI18n && window.hibanaI18n.lang ? window.hibanaI18n.lang() : 'en'
          // S30 batch 2 (user request): the FILTER BAR — priority toggles + label
          // toggles above the columns. Empty selection = show everything (the default);
          // each group is an OR within itself, the two groups AND together ("only 🔴
          // urgent × #Security"). A task's label names resolve through tagById (the
          // API carries tag ids on the task rows + the tag table in state).
          const usedTags = []
          const seenTag = new Set()
          for (const task of S.tasks) {
            for (const id of (task.tags || [])) {
              const tg = B().tagById(id)
              if (tg && !seenTag.has(tg.name.toLowerCase())) { seenTag.add(tg.name.toLowerCase()); usedTags.push(tg) }
            }
          }
          usedTags.sort((a, b) => a.name.localeCompare(b.name))
          const taskMatches = (task) => {
            if (filterPrios.size && !filterPrios.has(task.priority || 'medium')) return false
            if (filterTags.size) {
              const names = (task.tags || []).map((id) => { const tg = B().tagById(id); return tg ? tg.name.toLowerCase() : '' }).filter(Boolean)
              if (!names.some((n) => filterTags.has(n))) return false
            }
            if (filterQuery) {
              if (!String(task.title || '').toLowerCase().includes(filterQuery)) return false
            }
            // S242: the sprint view filter — '__none' shows unassigned tasks only.
            if (filterSprint) {
              if (filterSprint === '__none' ? !!task.sprint_id : task.sprint_id !== filterSprint) return false
            }
            return true
          }
          const shownCount = S.tasks.filter(taskMatches).length
          const anyFilter = filterPrios.size > 0 || filterTags.size > 0 || filterQuery !== '' || filterSprint !== ''
          const filterBarHtml = S.tasks.length ? '<div class="db-filter" data-db-filter role="toolbar" aria-label="' + B().esc(_t('db.filterAria', 'Filter tasks')) + '">' +
            // S136: the search input FIRST — the exact structure + classes of the
            // project page's bar (project-page.js pdFilterBuild; .db-filter-search
            // styles ship in devboard.css and were already shared).
            '<input type="search" class="db-filter-search" data-db-filter-q placeholder="' + B().esc(_t('db.filterSearchPh', 'Search tasks…')) + '" aria-label="' + B().esc(_t('db.filterSearchPh', 'Search tasks…')) + '" autocomplete="off" spellcheck="false" dir="auto" value="' + B().esc(filterQuery) + '">' +
            // S242 (spec §7.5/Screen A): the compact SPRINT filter — default
            // "All tasks"; every project sprint (any lifecycle state) with its
            // emoji-or-default glyph + name, plus "No sprint". The is-on tint
            // marks an active (non-All) filter (devboard.css).
            '<select class="db-filter-sprint' + (filterSprint ? ' is-on' : '') + '" data-db-filter-sprint aria-label="' + B().esc(_t('db.filterSprint', 'Sprint filter')) + '" title="' + B().esc(_t('db.filterSprint', 'Sprint filter')) + '">' +
              '<option value="">' + B().esc(_t('db.filterSprintAll', 'All tasks')) + '</option>' +
              '<option value="__none"' + (filterSprint === '__none' ? ' selected' : '') + '>' + B().esc(_t('db.noSprint', 'No sprint')) + '</option>' +
              S.sprints.map((s) => '<option value="' + B().esc(s.id) + '"' + (filterSprint === s.id ? ' selected' : '') + '>' + B().esc((s.emoji ? s.emoji + ' ' : '◆ ') + s.name) + '</option>').join('') +
            '</select>' +
            '<span class="db-filter-label muted small">' + B().esc(_t('db.filterPrio', 'Priority')) + '</span>' +
            B().PRIORITIES.slice().reverse().map((p) =>
              '<button type="button" class="chip db-filter-prio prio-' + p + '" data-fp="' + p + '" aria-pressed="' + (filterPrios.has(p) ? 'true' : 'false') + '" title="' + B().esc(_t('db.filterPrioHint', 'Show only {p} tasks').replace('{p}', B().prioLabel(p))) + '"><span class="prio-dot prio-' + p + '"></span>' + B().esc(B().prioLabel(p)) + '</button>'
            ).join('') +
            (usedTags.length ? '<span class="db-filter-label muted small">' + B().esc(_t('db.filterLabels', 'Labels')) + '</span>' +
              usedTags.map((tg) =>
                '<button type="button" dir="auto" class="chip db-filter-tag" data-ft="' + B().esc(tg.name.toLowerCase()) + '" style="color:' + B().esc(tg.color) + '" aria-pressed="' + (filterTags.has(tg.name.toLowerCase()) ? 'true' : 'false') + '" title="' + B().esc(_t('db.filterTagHint', 'Click to filter by this label')) + '"><span style="color:' + B().esc(tg.color) + '">●</span> ' + B().esc(tg.name) + '</button>'
              ).join('') : '') +
            (anyFilter ? '<button type="button" class="chip db-filter-clear" data-db-filter-clear>✕ ' + B().esc(_t('db.filterClear', 'Clear filter')) + '</button><span class="muted small db-filter-shown">' + _t('db.filterShown', '{n} of {m} shown').replace('{n}', B().faDig(shownCount)).replace('{m}', B().faDig(S.tasks.length)) + '</span>' : '') +
            '</div>' : ''
          // S78 parity: the miss state under the bar — the SAME skeleton the project
          // page mounts for an honest zero-match (devboard.css .db-filter-empty + the
          // pg-filter-empty polish are already shared sheets on this page).
          const filterEmptyHtml = S.tasks.length ? '<div class="empty-state empty pg-filter-empty db-filter-empty" data-db-filter-empty hidden>' +
            '<span class="empty-state-icon" aria-hidden="true"><svg class="icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg></span>' +
            '<p class="empty-state-title">' + B().esc(_t('db.filterEmpty', 'No tasks match your filters')) + '</p>' +
            '<p class="empty-state-text">' + B().esc(_t('db.filterEmptyText', 'Try another word, or clear the filters to see every task.')) + '</p>' +
            '<button type="button" class="empty-state-cta btn ghost" data-db-filter-empty-clear>' + B().esc(_t('db.filterClear', 'Clear filter')) + '</button>' +
          '</div>' : ''
          // S243 (spec §7.4 + Screen G — the compact sprint overview): selecting a
          // NAMED sprint in the view filter mounts its overview panel under the bar —
          // identity + lifecycle state, the five lane counts + total (the §12.5
          // CLIENT fold over the loaded payload — ZERO new fetches), and the
          // lifecycle actions the state permits (Start/Resume, Pause, Finish) +
          // Settings (deep-links the Sprints page's detail panel). No percentages,
          // no analytics — the restrained distribution the spec pins.
          let sprintOvHtml = ''
          const ovSprint = filterSprint && filterSprint !== '__none' ? B().findSprint(filterSprint) : null
          if (ovSprint) {
            const ovSt = B().sprintStatusOf(ovSprint)
            const fold = B().sprintLaneCounts(ovSprint.id)
            const badgeMap = {
              active: ['sp-st-active', _t('db.sprintSt.active', 'Active')],
              planned: ['sp-st-planned', _t('db.sprintSt.planned', 'Planned')],
              paused: ['sp-st-paused', _t('db.sprintSt.paused', 'Paused')],
              completed: ['sp-st-completed', _t('db.sprintSt.completed', 'Completed')],
            }
            const bm = badgeMap[ovSt] || badgeMap.planned
            const dueTxt = ovSprint.due_at
              ? '<span class="db-sprint-ov-due muted small">' + B().esc(_t('db.ov.due', 'Due {d}').replace('{d}', new Date(ovSprint.due_at).toLocaleDateString(document.documentElement.lang === 'fa' ? 'fa-IR' : 'en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }))) + '</span>'
              : ''
            const acts = []
            if (ovSt === 'planned') acts.push('<button type="button" class="btn small" data-db-ov-start>▸ ' + B().esc(_t('db.startSprint', 'Start sprint')) + '</button>')
            if (ovSt === 'paused') acts.push('<button type="button" class="btn small" data-db-ov-resume>▸ ' + B().esc(_t('db.resumeSprint', 'Resume')) + '</button>')
            if (ovSt === 'active') {
              acts.push('<button type="button" class="btn ghost small" data-db-ov-pause>⏸ ' + B().esc(_t('db.pauseSprint', 'Pause sprint')) + '</button>')
              acts.push('<button type="button" class="btn ghost small" data-db-ov-finish>⏹ ' + B().esc(_t('db.finishSprint', 'Finish sprint')) + '</button>')
            }
            // S245 (spec pack Phase 6 — §13.2 + Screen J1): the overview's Extend
            // affordance — any NON-COMPLETED sprint carrying a deadline (a
            // completed sprint's deadline is historical, §10.3 — no extension).
            // Opens the shared J1 dialog (identity + current deadline + the four
            // choices + the BEFORE-confirmation impact counts).
            if (ovSt !== 'completed' && ovSprint.due_at) {
              acts.push('<button type="button" class="btn ghost small" data-db-ov-extend>⏱ ' + B().esc(_t('db.extendSprint', 'Extend')) + '</button>')
            }
            acts.push('<a class="btn ghost small" data-db-ov-settings href="/sprint.html?project=' + encodeURIComponent(projectId) + '&sprint=' + encodeURIComponent(ovSprint.id) + '">⚙ ' + B().esc(_t('db.ov.settings', 'Settings')) + '</a>')
            sprintOvHtml =
              '<div class="db-sprint-ov" data-db-sprint-ov data-sprint-id="' + B().esc(ovSprint.id) + '">' +
                '<div class="row db-sprint-ov-head">' +
                  '<span class="db-sprint-ov-glyph" aria-hidden="true">' + B().esc(B().sprintGlyph(ovSprint)) + '</span>' +
                  '<span class="db-sprint-ov-name" dir="auto">' + B().esc(ovSprint.name || '') + '</span>' +
                  '<span class="sp-list-badge ' + bm[0] + '">' + B().esc(bm[1]) + '</span>' +
                  dueTxt +
                  '<span class="db-flex-gap"></span>' +
                  '<div class="row db-sprint-ov-actions">' + acts.join('') + '</div>' +
                '</div>' +
                '<div class="db-sprint-ov-counts" role="table" aria-label="' + B().esc(_t('db.ov.counts', 'Task counts by Kanban column')) + '">' +
                  B().STATUSES.map((st) =>
                    '<span class="db-sprint-ov-count" role="row"><span class="db-sprint-ov-lane" role="cell">' + B().esc(B().statusLabel(st)) + '</span><b role="cell">' + B().faDig(fold.counts[st] || 0) + '</b></span>').join('') +
                  '<span class="db-sprint-ov-count db-sprint-ov-total" role="row"><span class="db-sprint-ov-lane" role="cell">' + B().esc(_t('db.ov.total', 'Total')) + '</span><b role="cell">' + B().faDig(fold.total) + '</b></span>' +
                '</div>' +
              '</div>'
          }
          // Session 22 (user request): unlimited task titles clamp at 150 CHARS — same
          // recipe as the project page's progress boxes: first 150 chars visible, the
          // rest in a hidden .pd-title-rest span INSIDE the title element (so
          // textContent keeps reading the FULL title — copy/export, delete-confirm,
          // the wand all consume it), + a read-more button. The two boards read as ONE
          // system now.
          const TITLE_CLAMP = 150
          // Session 23 (user request): titles may carry fenced ``` CODE blocks, **bold**
          // and manual line breaks — SAME renderer as project.html / routes/projects.ts:
          // fence lines open/close a <code class="t-code" dir="ltr"> mono container with
          // the fence LINES kept in <span hidden class="t-fence"> markers INSIDE it, so
          // textContent round-trips the RAW title exactly (copy/export/delete/wand all
          // consume textContent). Prose lines get **pair** → <strong>. Unclosed fences
          // render as code till end (self-healing).
          // S105 (owner: "the fullscreen Project Progress box appears different from
          //   the projects-page one — bullet placement wrong, heading not bold"): the
          //   board's LOCAL, outdated title renderer is RETIRED. It knew nothing of
          //   bullets/ordered lists/underline/strike/alignment and never split the
          //   first line (S48j), so fullscreen cards drifted from the project page's.
          //   chip-render.js (window.HibanaChips) is ALREADY loaded by board.html —
          //   the exact same renderer the project page delegates to (project-page.js
          //   does the same). Fullscreen now inherits EVERY rendering decision:
          //   bullets, ordered lists, bold/underline/strike, fences, first-line-only
          //   titles (titleHtml), the read-more clamp, the content PREVIEW line
          //   (previewHtml — S86), and data-raw-title for the editor round-trip.
          const CH = () => window.HibanaChips || null
          const renderTitle = (raw) => (CH() ? CH().renderTitle(raw) : B().esc(raw))
          const titleHtml = (title) => (CH() ? CH().titleHtml(title) : B().esc(title))
          const titleAttrs = (title) => (CH() ? CH().titleAttrs(title) : '')
          const readMoreBtn = (title) => (CH() ? CH().readMoreBtn(title) : '')
          const previewHtml = (title) => (CH() ? CH().previewHtml(title) : '')
          // Item 8: inline SVG icons for the export/copy buttons (board.html has no P_ICON)
          const I_CLIPBOARD = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3.5A.5.5 0 0 1 9.5 3h5a.5.5 0 0 1 .5.5V4M9 9.5h6M9 13.5h6M9 17.5h4"/></svg>'
          const I_DOWNLOAD = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"/></svg>'
          const I_ARCHIVE = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/></svg>'
          const I_TRASH = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
          const I_PLUS = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>'
          // UI-redesign: the column ellipsis (⋯) menu button — consolidates the always-
          // visible Copy/Export (+ Archive/Clear for the Done column) into ONE overflow
          // menu per lane (spec §4). The existing data-db-copy/data-db-export/data-db-
          // archive-done/data-db-clear-done attributes are preserved verbatim inside the
          // menu items so the delegated handlers (board-page.js:714/724/743/761) keep
          // working unchanged.
          const I_ELLIPSIS = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="19" cy="12" r="1.7" fill="currentColor"/></svg>'
          const I_INFO = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>'
          // Per-lane empty-state asset + i18n key map (spec §5.1). The PNGs ship at
          // /icons/empty-state/<name>.png (320×320 RGBA transparent → displayed ~112px).
          const EMPTY_ICON = { idea: 'new-ideas-lamp', bug: 'problems-warning', planned: 'plans-checklist', in_progress: 'in-progress-play', done: 'implemented-check' }
          const EMPTY_TITLE = { idea: 'db.empty.idea.title', bug: 'db.empty.bug.title', planned: 'db.empty.planned.title', in_progress: 'db.empty.inprog.title', done: 'db.empty.done.title' }
          const EMPTY_TEXT = { idea: 'db.empty.idea.text', bug: 'db.empty.bug.text', planned: 'db.empty.planned.text', in_progress: 'db.empty.inprog.text', done: 'db.empty.done.text' }
          // S230 completion: inline EN fallbacks for every empty-state string (the _t
          // convention — every call carries its fallback; a dictionary that fails to
          // load must never render an EMPTY line under the heading).
          const EMPTY_FALLBACK = {
            idea: ['No ideas yet', 'Capture new ideas and potential improvements.'],
            bug: ['No problems yet', 'Track issues and blockers here.'],
            planned: ['No plans yet', 'Plan upcoming work and define next steps.'],
            in_progress: ['Nothing in progress', 'Move tasks here when you start working.'],
            done: ['No completed tasks', 'Completed tasks will appear here.'],
          }
          // S136 (owner report: the fullscreen board's cards, columns and filter bar
          // don't match the project page's .pd-board): the board now renders the EXACT
          // anatomy of the project page's kanban (routes/projects/detail-helpers.ts) —
          // .pd-col[data-status] columns with the TINTED .pd-col-head strip (colored
          // dot via ::before + the dark .detail-tab-count badge), .pd-task-wrap >
          // .pd-task cards (.pd-task-body > .pd-task-title-row carrying the DOT-ONLY
          // priority indicator — the left-border accent lives on the WRAP via the
          // shared polish-batch recipe, not the card), the chip-render preview +
          // .pd-read-more, .pd-task-tags label chips and the .pd-task-meta line.
          // devboard.css's duplicate .db-card / .db-col / .db-add rules are RETIRED —
          // project-header.css + polish-batch.css style both surfaces from one place,
          // so they can never drift again. Board-only affordances survive:
          // data-task-card (drag/drop + editor), the ⋯ menu (anchored to the wrap,
          // the quicknotes.css project recipe), Archive/Clear/Copy/Export in
          // .pd-col-actions, and .db-cat-chip / .db-sprint-badge (no pd counterpart).
          root.innerHTML = filterBarHtml + filterEmptyHtml + sprintOvHtml + '<div class="db-cols">' + B().STATUSES.map((st) => {
            const items = S.tasks.filter((x) => x.status === st && taskMatches(x))
            const isDone = st === 'done'
            // UI-redesign (spec §4): ONE ellipsis menu per lane replaces the always-
            // visible Copy/Export (+ Archive/Clear for Done). The underlying actions are
            // preserved verbatim inside the menu (same data-* attrs + i18n labels) so the
            // delegated handlers + the existing behavior are untouched. Archive/Clear
            // only appear when the Done lane actually has tasks (the original guard).
            const colMenuLabel = _t('db.colMenu', 'Column actions')
            const menuItems = []
            if (isDone && items.length > 0) {
              menuItems.push('<button type="button" role="menuitem" class="db-col-menu-item" data-db-archive-done>' + I_ARCHIVE + '<span>' + B().esc(_t('pd.archiveDone', 'Archive done tasks')) + '</span></button>')
              menuItems.push('<button type="button" role="menuitem" class="db-col-menu-item danger" data-db-clear-done>' + I_TRASH + '<span>' + B().esc(_t('pd.clearDone', 'Clear done (delete)')) + '</span></button>')
            }
            menuItems.push('<button type="button" role="menuitem" class="db-col-menu-item" data-db-copy="' + st + '">' + I_CLIPBOARD + '<span>' + B().esc(_t('pd.quickCopy', 'Quick copy')) + '</span></button>')
            menuItems.push('<button type="button" role="menuitem" class="db-col-menu-item" data-db-export="' + st + '">' + I_DOWNLOAD + '<span>' + B().esc(_t('pd.exportMd', 'Export Markdown')) + '</span></button>')
            // S237 (Focus Mode): when the toggle is on, the two per-lane head buttons
            // ride INSIDE the ⋯ wrap, BEFORE the ellipsis button — the wrap already
            // owns the header's inline-end grouping + the menu anchor, so the
            // existing grammar is untouched (ghost .db-col-menu-btn metrics). Off →
            // the markup is byte-identical to today's board.
            const focusHeadHtml = focus.enabled
              ? '<button type="button" class="ghost small db-col-menu-btn db-focus-btn' + (focus.focusedStatus === st ? ' is-active' : '') + '" data-db-focus="' + st + '" aria-pressed="' + (focus.focusedStatus === st ? 'true' : 'false') + '" aria-label="' + B().esc(_t('db.focus.toggle', 'Focus this column')) + '" title="' + B().esc(focus.focusedStatus === st ? _t('db.focus.exit', 'Exit focus (Esc)') : _t('db.focus.toggle', 'Focus this column')) + '">' + I_TARGET + '</button>' +
                '<button type="button" class="ghost small db-col-menu-btn db-focus-enlarge" data-db-focus-sheet="' + st + '" aria-label="' + B().esc(_t('db.focus.enlarge', 'Enlarge this column')) + '" title="' + B().esc(_t('db.focus.enlarge', 'Enlarge this column')) + '">' + I_EXPAND + '</button>'
              : ''
            const colActionsHtml = '<span class="db-col-menu-wrap">' + focusHeadHtml +
              '<button type="button" class="ghost small db-col-menu-btn" data-db-col-menu aria-haspopup="true" aria-expanded="false" aria-label="' + B().esc(colMenuLabel) + '" title="' + B().esc(colMenuLabel) + '">' + I_ELLIPSIS + '</button>' +
              '<div class="db-col-menu" role="menu" aria-label="' + B().esc(colMenuLabel) + '" hidden>' + menuItems.join('') + '</div>' +
            '</span>'
            // UI-redesign (spec §5): the per-lane empty-state group — shown ONLY when the
            // lane has no tasks AND no filter is hiding them (the filter-miss banner owns
            // the filtered-empty case). illustration → heading → copy → lane-colored
            // outlined Add task (the same data-add contract the bottom .pd-task-add uses).
            const laneIsEmpty = items.length === 0 && !anyFilter
            const emptyGroupHtml = laneIsEmpty
              ? '<div class="pd-empty" data-pd-empty>' +
                  '<img class="pd-empty-icon" src="/icons/empty-state/' + EMPTY_ICON[st] + '.png" alt="" width="112" height="112" loading="lazy" decoding="async" />' +
                  '<p class="pd-empty-title">' + B().esc(_t(EMPTY_TITLE[st], EMPTY_FALLBACK[st][0])) + '</p>' +
                  '<p class="pd-empty-text">' + B().esc(_t(EMPTY_TEXT[st], EMPTY_FALLBACK[st][1])) + '</p>' +
                  '<button type="button" class="pd-empty-add" data-add="' + st + '">' + I_PLUS + ' <span>' + B().esc(_t('db.addTask', 'Add task')) + '</span></button>' +
                '</div>'
              : ''
            return '<section class="pd-col" data-status="' + st + '">' +
              '<header class="pd-col-head"><span class="pd-col-title">' + B().esc(B().statusLabel(st)) + '</span>' +
              '<span class="detail-tab-count">' + B().faDig(items.length) + '</span>' +
              colActionsHtml +
              '</header>' +
              // The pd column body: same container class + attr the server renders
              // (drag-over now rides the COLUMN via .pd-col.drag-over, the pd recipe).
              '<div class="pd-tasks" data-pd-tasks="' + st + '">' +
                items.map((task) => {
                  const cat = task.category_id ? B().findCategory(task.category_id) : null
                  const sprint = task.sprint_id ? B().findSprint(task.sprint_id) : null
                  const tags = (task.tags || []).map((id) => B().tagById(id)).filter(Boolean)
                  // S144 (owner: the priority banner): the colored strip fused across the
                  // card's TOP carries the label — and IS the cycle affordance (the old
                  // dot's data-db-cycle-prio contract: title/aria hint + click cycles
                  // low → medium → high → urgent via the delegated handler below).
                  // The LABEL uses the LONG priority names (chip-render's prioLabel —
                  // "High Priority", the server twin's wording) so the banner reads
                  // identically on both surfaces; the HINT keeps the board's short
                  // B().prioLabel ("Priority: Low — click to change"). Screenshot style:
                  // "MODERATE PRIORITY".
                  const prioLong = (p) => (CH() ? CH().prioLabel(p, lang) : B().prioLabel(p))
                  const prioHint = B().esc(_t('db.cyclePrio', 'Priority: {p} — click to change').replace('{p}', B().prioLabel(task.priority || 'medium')))
                  const prioBanner =
                    '<button type="button" class="prio-banner prio-' + (task.priority || 'medium') + '" data-db-cycle-prio="' + task.id + '" title="' + prioHint + '" aria-label="' + prioHint + '"><span class="prio-banner-label">' + B().esc(prioLong(task.priority || 'medium')) + '</span></button>'
                  // S152 (block 6): the category chip moved ABOVE the title row (the
                  // owner's placement spec) and wears the curated fill+ink pair.
                  const catChipHtml = cat ? '<span class="cat-chip" style="background:' + B().esc(cat.color_fill) + ';color:' + B().esc(cat.color_text) + '">' + B().esc(cat.name) + '</span>' : ''
                  // S242 (spec pack §3.2/Screen A — card sprint identity): the
                  // sprint's OWN compact row — its emoji (or the default ◆ glyph)
                  // + name — directly under the description/preview, BEFORE the
                  // label chips and the timestamp area (the Phase 5 deadline row
                  // slots in right after this seam). Identical markup renders on
                  // the embedded board (detail-helpers.ts sprintBadgeHtml) — the
                  // S209 1:1 parity contract.
                  const sprintRowHtml = sprint
                    ? '<span class="db-sprint-badge">' + B().esc((sprint.emoji ? sprint.emoji + ' ' : '◆ ') + sprint.name) + '</span>'
                    : ''
                  // S244 (spec pack §12 + Screen A — the deadline row + the thin
                  // progress bar): the Phase 3 seam — directly under the sprint
                  // row, above the tags/meta area. The shared devboard.js render
                  // stack (B().deadlineRowHtml) consumes the payload's
                  // server-computed effective_* triple (S241): the §12.3 threshold
                  // WORD carries the meaning (never color alone) and the bar's fill
                  // is the §12.2 ELAPSED-time ratio from effective_due_origin_at —
                  // never completion, never a client re-derivation. Renders '' when
                  // the triple is null (no row, no bar).
                  const deadlineHtml = B().deadlineRowHtml ? B().deadlineRowHtml(task, lang) : ''
                  // S246 (spec pack §16 + Screen L/M-6/7 — the compact dep
                  // badges): their OWN row in the Phase 3 seam family — right
                  // after the deadline row (+bar), before the tags — rendered by
                  // the SHARED devboard.js fold (B().depBadgeHtml) over the
                  // payload's task_deps edges. Blocked (optionally · N) /
                  // Blocks N / Ready render ONLY when the relationships exist;
                  // fully independent of the priority ribbon AND the deadline
                  // display (§16: "keep dependency status separate"; §23: the
                  // ribbon stays unchanged). SOFT indicators — never a gate.
                  const depHtml = B().depBadgeHtml ? B().depBadgeHtml(task, null, null, lang) : ''
                  const chipsHtml = (tags.length
                    ? '<span class="pd-task-tags">' +
                      // S30 batch 2: label chips are FILTER toggles (GitHub behavior) —
                      // S136: rendered as the project page's .pd-tag spans (data-pd-tag-name
                      // carries the match key; the colored .pd-tag-dot replaces the ● text).
                      tags.map((tg) => '<span dir="auto" class="pd-tag" data-pd-tag-name="' + B().esc(tg.name.toLowerCase()) + '" title="' + B().esc(_t('db.filterTagHint', 'Click to filter by this label')) + '"><i class="pd-tag-dot" style="background:' + B().esc(tg.color) + '"></i>' + B().esc(tg.name) + '</span>').join('') +
                    '</span>'
                    : '')
                  // S110 (v0.3.43.0): the meta line mirrors the project page's progress
                  // box — S144: the priority LABEL moved to the banner, so the footer
                  // keeps the shared date + clock (metaDateHtml — both surfaces changed
                  // together, the s110 parity pin holds).
                  // S208 (kanban task-option parity): the PIN BADGE joins the meta line —
                  // the same .pd-task-shots button the project page's cards carry
                  // (detail-helpers.ts), fed by the devboard payload's per-task
                  // shot_count. Click opens the pinned-pictures dialog (zoom + unpin);
                  // unpin reloads so the count stays true.
                  const I_PIN = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17v4M8.5 3.5h7l-.8 7.2 2.8 2.8v1.5H6.5v-1.5l2.8-2.8-.8-7.2Z"/></svg>'
                  const shotsN = Number(task.shot_count || 0)
                  const shotsBadgeHtml = shotsN
                    ? '<button type="button" class="pd-task-shots" data-db-shots-dialog="' + task.id + '" title="' + B().esc(_t('db.taskShotsHint', 'Pinned pictures — note + proof stuck to this item')) + '" aria-label="' + B().esc(_t('db.taskShotsBadge', 'Pinned pictures ({n})').replace('{n}', String(shotsN))) + '">' + I_PIN + ' ' + B().faDig(shotsN) + '</button>'
                    : ''
                  // hibana-sync-status-spec §5: the sync badge is the LAST child of
                  // the meta row, pushed to the inline-end (ms-auto in CSS) so every
                  // column keeps one vertical scan line even when a card carries the
                  // pin chip. Fresh renders are 'synced' (server-confirmed); edits go
                  // Pending → Syncing → Synced/Failed through sync-state.js, which
                  // repaints only the changed card's badge.
                  const syncBadge = (CH() && CH().syncBadgeHtml && window.HibanaSyncState)
                    ? CH().syncBadgeHtml(task.id, window.HibanaSyncState.stateOf(task.id))
                    : (CH() && CH().syncBadgeHtml ? CH().syncBadgeHtml(task.id, 'synced') : '')
                  const metaHtml = '<span class="pd-task-meta">' + (CH() ? CH().metaDateHtml(task.created_at, task.status === 'done', lang) : B().esc((task.status === 'done' && task.done_at ? '✓ ' : '') + B().fullLabel(B().dayIdx(task.created_at), lang))) + (shotsBadgeHtml ? ' · ' + shotsBadgeHtml : '') + syncBadge + '</span>'
                  return '<div class="pd-task-wrap" data-task-card="' + task.id + '" data-priority="' + (task.priority || 'medium') + '">' + prioBanner +
                    '<div class="pd-task st-' + task.status + '" draggable="true" role="button" tabindex="0" aria-label="' + B().esc(task.title) + '">' +
                      '<span class="pd-task-body">' +
                        catChipHtml +
                        '<span class="pd-task-title-row" dir="auto">' +
                          '<span class="pd-task-title"' + titleAttrs(task.title) + '>' + titleHtml(task.title) + '</span>' +
                        '</span>' +
                        previewHtml(task.title) +
                        readMoreBtn(task.title) +
                        sprintRowHtml +
                        deadlineHtml +
                        depHtml +
                        chipsHtml +
                        metaHtml +
                      '</span>' +
                      // ⋯ hover menu (Edit + Delete) — injected client-side after render so
                      // it survives every reload(). S136: INSIDE the card as the project
                      // page injects it (project-page.js task.appendChild) — the base
                      // .spark-menu rules + the .pd-task:hover reveal then style it with
                      // zero board-specific CSS.
                      '<div class="spark-menu db-card-menu" hidden></div>' +
                    '</div>' +
                  '</div>'
                }).join('') +
                (laneIsEmpty
                  ? emptyGroupHtml
                  : '<button type="button" class="pd-task-add" data-add="' + st + '">' + I_PLUS + ' <span>' + B().esc(_t('db.addTask', 'Add task')) + '</span></button>') +
              '</div>' +
            '</section>'
          }).join('') + '</div>' +
          // UI-redesign (spec §7): the bottom board helper hint — monochrome, low
          // emphasis, never in a colored pill. A quiet persistent nudge below the lanes.
          '<p class="db-hint" role="note">' + I_INFO + '<span>' + B().esc(_t('db.helperHint', 'Start by adding a task to move your work forward.')) + '</span></p>'
          root.hidden = false
          if (loading) loading.hidden = true
          // S78 parity: the miss state syncs AFTER the paint (anyFilter + shownCount).
          const emptyEl = document.querySelector('[data-db-filter-empty]')
          if (emptyEl) emptyEl.hidden = !(anyFilter && shownCount === 0)
          // Inject the ⋯ menu content into each .db-card-menu (the cards re-render on
          // every load(), so we fill the menu placeholders + attach handlers here).
          injectDbCardMenus()
          // S237: the focus tail — the dim recipe re-applies after every rebuild
          // (the blur focus survives re-renders) and an open enlarge sheet
          // refreshes its mirror (every mutation funnels through render()).
          applyFocus()
          refreshSheet()
        }

        const reload = async () => { await B().load(projectId); render() }

        // ---- S205 (spec §3.2): the PROJECT SWITCHER ----
        // One click from the toolbar: a searchable list of every project the user can
        // access (GET /api/projects?sort=recent — the same user-scoped list the projects
        // page renders, non-spark + non-archived), rendered as the command palette's
        // input+list popover anchored under the title. Switching is IN-PLACE (B().load +
        // render — the same reload() primitive every board mutation already uses; no
        // page reload), the URL's ?project= is pushState'd so refresh/back/forward keep
        // the board, and hibana-kanban-last remembers it for the next bare /kanban visit.
        // Keyboard: ↑/↓ move, Enter opens, Esc closes; the current row is marked
        // aria-current. Placement is direction-aware (RTL anchors the start edge).
        const SWITCH_CACHE_MS = 60000
        let switchCache = { at: 0, list: null }
        const fetchProjects = async (force) => {
          if (!force && switchCache.list && Date.now() - switchCache.at < SWITCH_CACHE_MS) return switchCache.list
          const r = await window.hibanaFetch('/api/projects?sort=recent')
          if (r.status === 401) { if (window.hibana && window.hibana.handle401) window.hibana.handle401(r); throw new Error('unauthorized') }
          if (!r.ok) throw new Error('projects list failed')
          const body = await r.json()
          switchCache = { at: Date.now(), list: (body && body.projects) || [] }
          return switchCache.list
        }
        const recordLastBoard = (id, title, status) => {
          try { localStorage.setItem('hibana-kanban-last', id) } catch {}
          // the palette's Recent section (the same record project.html does on every visit)
          if (window.hibanaCmdK && window.hibanaCmdK.recordRecent) window.hibanaCmdK.recordRecent(id, title, status || '')
        }
        const recordBoard = () => {
          const S = B().state
          if (S.project && S.project.title && projectId) recordLastBoard(projectId, S.project.title, S.project.status)
        }

        let switchPop = null
        let switchSearch = null
        let switchList = null
        let switchBtn = null
        let switchOpen = false
        const SWITCH_STATUS = {
          spark: ['cmdk.statusSpark', 'Idea'],
          planning: ['cmdk.statusPlanning', 'Planning'],
          queued: ['cmdk.statusQueued', 'Up Next'],
          developing: ['cmdk.statusDeveloping', 'Developing'],
          awaiting_dev: ['cmdk.statusAwaitingDev', 'On Hold'],
          operational: ['cmdk.statusOperational', 'Operational'],
        }
        const renderSwitchRows = (list, query) => {
          const q = String(query || '').trim().toLowerCase()
          const items = (list || []).filter((p) => !q || String(p.title || '').toLowerCase().includes(q))
          if (!items.length) {
            switchList.innerHTML = '<p class="db-switch-empty muted small">' + escS(_t('db.switchEmpty', 'No projects found')) + '</p>'
            return
          }
          switchList.innerHTML = items.map((p) => {
            const cur = p.id === projectId
            const lbl = SWITCH_STATUS[p.status]
            const badge = lbl ? '<span class="badge badge-' + p.status + '">' + escS(_t(lbl[0], lbl[1])) + '</span>' : ''
            return '<button type="button" class="db-switch-row' + (cur ? ' current' : '') + '" data-switch-id="' + escS(p.id) + '"' + (cur ? ' aria-current="true"' : '') + ' dir="auto">' +
              badge + '<span class="db-switch-name">' + escS(p.title) + '</span>' +
              (cur ? '<span class="db-switch-cur muted small">' + escS(_t('db.switchCurrent', 'Current')) + '</span>' : '') +
            '</button>'
          }).join('')
        }
        const positionSwitch = () => {
          if (!switchBtn || !switchPop) return
          const r = switchBtn.getBoundingClientRect()
          const rtl = (document.documentElement.dir || 'ltr') === 'rtl'
          switchPop.style.top = (r.bottom + 6) + 'px'
          if (rtl) switchPop.style.right = Math.max(8, window.innerWidth - r.right) + 'px'
          else switchPop.style.left = Math.max(8, r.left) + 'px'
          // clamp inside the viewport after measuring (long titles + narrow screens)
          const pw = switchPop.offsetWidth
          if (rtl) {
            const right = parseInt(switchPop.style.right, 10) || 0
            if (right + pw > window.innerWidth - 8) switchPop.style.right = Math.max(8, window.innerWidth - 8 - pw) + 'px'
          } else {
            const left = parseInt(switchPop.style.left, 10) || 0
            if (left + pw > window.innerWidth - 8) switchPop.style.left = Math.max(8, window.innerWidth - 8 - pw) + 'px'
          }
        }
        const closeSwitch = () => {
          if (!switchPop) return
          switchOpen = false
          switchPop.hidden = true
          if (switchBtn) switchBtn.setAttribute('aria-expanded', 'false')
        }
        const openSwitch = async () => {
          if (!switchPop) {
            switchBtn = document.getElementById('db-project-switch')
            switchPop = document.createElement('div')
            switchPop.id = 'db-switch-pop'
            switchPop.className = 'db-switch-pop'
            switchPop.setAttribute('role', 'dialog')
            switchPop.setAttribute('aria-label', _t('db.switchProject', 'Switch project'))
            switchPop.hidden = true
            switchPop.innerHTML =
              '<div class="db-switch-head">' +
                '<input type="search" id="db-switch-q" class="db-switch-search" placeholder="' + escS(_t('db.switchSearch', 'Search projects…')) + '" aria-label="' + escS(_t('db.switchSearch', 'Search projects…')) + '" autocomplete="off" spellcheck="false" dir="auto">' +
              '</div>' +
              '<div class="db-switch-list" id="db-switch-list"></div>' +
              '<a class="db-switch-all" href="/projects.html">' + escS(_t('db.switchAll', 'All projects →')) + '</a>'
            document.body.appendChild(switchPop)
            switchSearch = switchPop.querySelector('#db-switch-q')
            switchList = switchPop.querySelector('#db-switch-list')
            switchSearch.addEventListener('input', () => renderSwitchRows(switchCache.list, switchSearch.value))
            switchSearch.addEventListener('keydown', (e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                const first = switchList.querySelector('.db-switch-row')
                if (first) first.focus()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                closeSwitch()
                if (switchBtn) switchBtn.focus()
              }
            })
            switchList.addEventListener('keydown', (e) => {
              if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
              e.preventDefault()
              const rows = Array.from(switchList.querySelectorAll('.db-switch-row'))
              const i = rows.indexOf(e.target)
              const next = rows[i + (e.key === 'ArrowDown' ? 1 : -1)]
              if (next) next.focus()
            })
          }
          switchOpen = true
          switchPop.hidden = false
          if (switchBtn) switchBtn.setAttribute('aria-expanded', 'true')
          positionSwitch()
          switchList.innerHTML = '<p class="db-switch-empty muted small">' + escS(_t('db.switchLoading', 'Loading projects…')) + '</p>'
          renderSwitchRows(switchCache.list, '')
          if (switchSearch) { switchSearch.value = ''; switchSearch.focus() }
          try {
            const list = await fetchProjects()
            if (switchOpen) renderSwitchRows(list, switchSearch ? switchSearch.value : '')
          } catch {
            if (switchOpen) switchList.innerHTML = '<p class="db-switch-empty muted small">' + escS(_t('sparks.saveFailed', "Couldn't load")) + '</p>'
          }
        }
        const switchProject = async (id) => {
          if (!id || id === projectId) { closeSwitch(); return }
          closeSwitch()
          closeAllDbMenus()
          // per-board filter state resets with the board (predictable switching)
          filterPrios.clear(); filterTags.clear(); filterQuery = ''; filterSprint = ''
          projectId = id
          // URL: SAME pathname (works on /kanban and /board.html alike), the new project,
          // the old board's deep-link params dropped; pushState so Back returns to the
          // previous board (nav.js's popstate soft-reloads the page for back/forward).
          const u = new URL(location.href)
          u.searchParams.set('project', id)
          u.searchParams.delete('task')
          u.searchParams.delete('add')
          history.pushState({ hibanaKanban: id }, '', u)
          root.hidden = true
          if (loading) {
            loading.hidden = false
            loading.innerHTML = '<span class="hibana-spinner" aria-hidden="true"></span><span>' + escS(_t('db.loading', 'Loading…')) + '</span>'
          }
          try {
            await reload()
            recordBoard()
          } catch (err) {
            if (err && err.status === 404) return gone()
            return fail()
          }
        }
        // the switcher toolbar button + row activation + outside-click close
        ctx.on('click', (e) => {
          if (e.target.closest('#db-project-switch')) {
            e.preventDefault()
            if (switchOpen) { closeSwitch(); if (switchBtn) switchBtn.focus() }
            else openSwitch()
            return
          }
          const row = e.target.closest('[data-switch-id]')
          if (row) { e.preventDefault(); switchProject(row.dataset.switchId); return }
          if (switchOpen && switchPop && !e.target.closest('#db-switch-pop')) closeSwitch()
        })
        ctx.on('keydown', (e) => {
          if (e.key === 'Escape' && switchOpen) { closeSwitch(); if (switchBtn) switchBtn.focus() }
        })

        // S205: the no-projects empty state (spec §3.2: "If no accessible project exists,
        // show a helpful empty state and the existing affordance for creating one") —
        // the projects page owns creation (its FAB quick-add); this points there.
        const renderNoProjects = () => {
          root.hidden = false
          if (loading) loading.hidden = true
          document.getElementById('db-title').textContent = _t('db.board', 'Board')
          document.getElementById('db-counts').textContent = ''
          root.innerHTML = '<div class="empty-state empty db-noprojects">' +
            '<span class="empty-state-icon" aria-hidden="true"><svg class="icon" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/></svg></span>' +
            '<p class="empty-state-title">' + escS(_t('db.noProjects', 'No projects yet')) + '</p>' +
            '<p class="empty-state-text">' + escS(_t('db.noProjectsText', 'Create your first project to start working with its Kanban board.')) + '</p>' +
            '<a class="empty-state-cta btn" href="/projects.html">' + escS(_t('db.noProjectsCta', 'Go to projects')) + '</a>' +
          '</div>'
        }

        // S30 batch 4: the LABEL MANAGER — rename/merge/recolor/delete-unused, opened
        // from the toolbar. Every change reloads the board (labels ride the cards).
        ctx.on('click', (e) => {
          if (!e.target.closest('#db-labels-btn')) return
          e.preventDefault()
          B().openLabels({ onChanged: reload })
        })

        // ⋯ hover menu on each .pd-task card — Edit opens the existing modal (no refresh),
        // Delete shows a confirm modal (no refresh). Re-injected after every render().
        // S136: the menu lives INSIDE the card (the project-page.js recipe), so
        // closest('.pd-task-wrap') still resolves the task id from within it.
        const I_MENU_DOTS = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="19" cy="12" r="1.7" fill="currentColor"/></svg>'
        const I_EDIT = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>'
        const I_TRASH = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
        const I_COPY = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
        function injectDbCardMenus() {
          document.querySelectorAll('.db-card-menu:not([data-ok])').forEach((menu) => {
            const card = menu.closest('.pd-task-wrap')
            if (!card) return
            const tid = card.dataset.taskCard
            if (!tid) return
            menu.innerHTML =
              '<button type="button" data-menu-open aria-haspopup="true" aria-label="' + B().esc(_t('sparks.more', 'More actions')) + '">' + I_MENU_DOTS + '</button>' +
              '<div class="spark-menu-pop" hidden>' +
                // S208: Copy joins the card menu (the project page's ⋯ Edit/Copy/
                // Delete contract — copies the RAW title, data-raw-title first).
                '<button type="button" data-db-copy-card="' + tid + '">' + I_COPY + '<span>' + B().esc(_t('common.copy', 'Copy')) + '</span></button>' +
                '<button type="button" data-db-edit-card="' + tid + '">' + I_EDIT + '<span>' + B().esc(_t('common.edit', 'Edit')) + '</span></button>' +
                '<button type="button" class="danger" data-db-del-card="' + tid + '">' + I_TRASH + '<span>' + B().esc(_t('common.delete', 'Delete')) + '</span></button>' +
              '</div>'
            menu.hidden = false
            menu.setAttribute('data-ok', '')
            // Direct handlers (the card is draggable + the menu is inside it — preventDefault
            // stops drag + any parent navigation)
            const openBtn = menu.querySelector('[data-menu-open]')
            openBtn.addEventListener('click', (ev) => {
              ev.preventDefault(); ev.stopPropagation()
              const pop = menu.querySelector('.spark-menu-pop')
              if (!pop) return
              const willOpen = pop.hidden
              closeAllDbMenus()
              pop.hidden = !willOpen
              if (willOpen) openBtn.setAttribute('data-open', '')
              else openBtn.removeAttribute('data-open')
            })
            // S208 (S48p parity): Copy the RAW title (data-raw-title first — the
            // full multi-line definition), textContent as the belt.
            menu.querySelector('[data-db-copy-card]').addEventListener('click', async (ev) => {
              ev.preventDefault(); ev.stopPropagation()
              closeAllDbMenus()
              const titleEl = card.querySelector('.pd-task-title')
              const raw = titleEl ? titleEl.getAttribute('data-raw-title') : null
              const text = raw || (titleEl ? titleEl.textContent : '')
              try {
                await navigator.clipboard.writeText(text)
                window.hibana && window.hibana.toast(_t('common.copied', 'Copied to clipboard'), 'ok')
              } catch { window.hibana && window.hibana.toast(_t('sparks.saveFailed', "Couldn't copy"), 'err') }
            })
            menu.querySelector('[data-db-edit-card]').addEventListener('click', (ev) => {
              ev.preventDefault(); ev.stopPropagation()
              closeAllDbMenus()
              B().openEditor(tid, { onSaved: reload })
            })
            menu.querySelector('[data-db-del-card]').addEventListener('click', (ev) => {
              ev.preventDefault(); ev.stopPropagation()
              closeAllDbMenus()
              showDeleteConfirm(tid, card.querySelector('.pd-task-title')?.textContent || '')
            })
          })
        }
        function closeAllDbMenus() {
          document.querySelectorAll('.db-card-menu .spark-menu-pop:not([hidden])').forEach((pop) => {
            pop.hidden = true
            const btn = pop.parentElement.querySelector('[data-menu-open]')
            if (btn) btn.removeAttribute('data-open')
          })
        }
        // S238: the sheet's one-tap COPY row button — rides the ⋯ menu cluster's
        // inline start (the card's corner), always visible (the ⋯ itself reveals
        // on hover — the owner wanted a copy affordance with NO menu). Clicked →
        // the delegated [data-db-sheet-copy] branch copies the RAW title. Board
        // cards keep their ⋯-only corner (the menu already carries Copy there).
        function injectSheetCopyRows(scope) {
          scope.querySelectorAll('.db-card-menu').forEach((menu) => {
            if (menu.querySelector('.db-sheet-copy')) return
            const wrap = menu.closest('.pd-task-wrap')
            if (!wrap || !wrap.dataset.taskCard) return
            const btn = document.createElement('button')
            btn.type = 'button'
            btn.className = 'db-sheet-copy'
            btn.setAttribute('data-db-sheet-copy', wrap.dataset.taskCard)
            const lbl = _t('db.view.copyTask', 'Copy task')
            btn.setAttribute('aria-label', lbl)
            btn.setAttribute('title', lbl)
            btn.innerHTML = I_COPY
            menu.insertBefore(btn, menu.firstChild)
          })
        }
        // UI-redesign: the column ellipsis (⋯) menu — open/close state. Mirrors the
        // card-menu discipline: one open menu at a time, Escape + outside-click close,
        // and every menu-item action closes it (the delegated handlers below call
        // closeAllColMenus() before their work so the menu never lingers open over a
        // toast/dialog). RTL-aware: the menu anchors under its button on the inline-end.
        function closeAllColMenus() {
          document.querySelectorAll('.db-col-menu:not([hidden])').forEach((m) => {
            m.hidden = true
            const btn = m.parentElement && m.parentElement.querySelector('[data-db-col-menu]')
            if (btn) btn.setAttribute('aria-expanded', 'false')
          })
        }
        document.addEventListener('click', (e) => {
          if (!e.target.closest('.db-card-menu')) closeAllDbMenus()
          // Close column menus on outside click (the toggle button keeps its menu open;
          // its own handler flips the state). A click on a menu item is handled by the
          // delegated action branches which call closeAllColMenus() themselves.
          if (!e.target.closest('.db-col-menu-wrap')) closeAllColMenus()
        })
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeAllDbMenus(); closeAllColMenus() } })


        // Delete confirm modal — a native <dialog> (no page refresh). "Are you sure?" +
        // Confirm/Cancel. On confirm → DELETE /api/devtasks/:id → reload().
        let delConfirmDlg = null
        function showDeleteConfirm(tid, title) {
          if (!delConfirmDlg) {
            delConfirmDlg = document.createElement('dialog')
            delConfirmDlg.id = 'db-del-confirm'
            delConfirmDlg.className = 'dialog'
            delConfirmDlg.innerHTML =
              '<form class="modal" method="dialog">' +
                // S233 (every modal carries a close on its top right): the title
                // row joins the task editor / labels / pinned-pictures grammar —
                // h3 on the inline start, the ✕ on the inline end (the Cancel twin).
                '<div class="row spread"><h3>' + B().esc(_t('db.delConfirm', 'Delete this task?')) + '</h3>' +
                '<button type="button" class="ghost" id="db-del-x" aria-label="' + B().esc(_t('common.close', 'Close')) + '">✕</button></div>' +
                '<p class="muted small" id="db-del-title"></p>' +
                '<p class="muted small">' + B().esc(_t('db.delConfirmHint', 'This cannot be undone.')) + '</p>' +
                '<div class="row" style="justify-content:flex-end;gap:.5rem;margin-top:1rem">' +
                  '<button type="button" class="ghost" id="db-del-cancel">' + B().esc(_t('common.cancel', 'Cancel')) + '</button>' +
                  '<button type="button" class="btn danger" id="db-del-ok">' + B().esc(_t('common.delete', 'Delete')) + '</button>' +
                '</div>' +
              '</form>'
            document.body.appendChild(delConfirmDlg)
            delConfirmDlg.addEventListener('click', (e) => { if (e.target === delConfirmDlg) delConfirmDlg.close() })
            delConfirmDlg.querySelector('#db-del-cancel').onclick = () => delConfirmDlg.close()
            delConfirmDlg.querySelector('#db-del-x').onclick = () => delConfirmDlg.close()
            delConfirmDlg.querySelector('#db-del-ok').onclick = async () => {
              const id = delConfirmDlg.dataset.tid
              if (!id) return
              delConfirmDlg.querySelector('#db-del-ok').disabled = true
              try {
                const r = await window.hibanaFetch('/api/devtasks/' + id, { method: 'DELETE' })
                if (!r.ok) throw new Error('delete failed')
                window.hibana?.toast(B().esc(_t('db.taskDeleted', 'Task deleted')), 'ok')
                delConfirmDlg.close()
                reload()
              } catch {
                window.hibana?.toast(B().esc(_t('notes.deleteFailed', "Couldn't delete")), 'err')
                delConfirmDlg.querySelector('#db-del-ok').disabled = false
              }
            }
          }
          delConfirmDlg.dataset.tid = tid
          delConfirmDlg.querySelector('#db-del-title').textContent = title
          delConfirmDlg.querySelector('#db-del-ok').disabled = false
          delConfirmDlg.showModal()
        }

        // ---- interactions (delegated once — render() only rebuilds innerHTML) ----
        ctx.on('click', async (e) => {
          if (e.target.closest('#db-retry')) {
            loading.innerHTML = '<span>' + String(_t('db.loading', 'Loading board…')).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]) + '</span>'
            boot()
            return
          }
          // S30 batch 2 — the FILTER BAR toggles (priority × label, clear).
          const fp = e.target.closest('[data-fp]')
          if (fp) {
            const p = fp.dataset.fp
            if (filterPrios.has(p)) filterPrios.delete(p); else filterPrios.add(p)
            render()
            return
          }
          const ft = e.target.closest('[data-ft]')
          if (ft) {
            const n = ft.dataset.ft
            if (filterTags.has(n)) filterTags.delete(n); else filterTags.add(n)
            render()
            return
          }
          if (e.target.closest('[data-db-filter-clear]') || e.target.closest('[data-db-filter-empty-clear]')) {
            filterPrios.clear(); filterTags.clear(); filterQuery = ''; filterSprint = ''
            render()
            return
          }
          // S30 batch 2 — clicking a card's LABEL chip toggles that label's filter
          // (GitHub behavior). Runs before the card-open branch below; the card-open
          // branch also guards on .pd-tag (ctx.on handlers are independent
          // document listeners — stopPropagation can't cross them). S136: the chips
          // are the project page's .pd-tag spans now (data-pd-tag-name).
          const chip = e.target.closest('.pd-tag[data-pd-tag-name]')
          if (chip) {
            e.preventDefault()
            const n = chip.dataset.pdTagName
            if (filterTags.has(n)) filterTags.delete(n); else filterTags.add(n)
            render()
            return
          }
          // S30 batch 2 — click the priority dot: cycle low → medium → high → urgent
          // without opening the editor. PATCH + optimistic state mutation + re-render
          // (the re-render re-sorts the column for free).
          const cycleDot = e.target.closest('[data-db-cycle-prio]')
          if (cycleDot) {
            e.preventDefault()
            const tid = cycleDot.dataset.dbCyclePrio
            const task = B().findTask(tid)
            if (!task) return
            const next = B().cyclePriority(task.priority)
            task.priority = next
            render()
            B().patchTask(tid, { priority: next }).catch(() => {
              window.hibana?.toast(_t('sparks.saveFailed', "Couldn't save"), 'err')
              reload()
            })
            return
          }
          // S237 (Focus Mode): the two per-lane head buttons (focus toggle + enlarge).
          const focusBtn = e.target.closest('[data-db-focus]')
          if (focusBtn) {
            e.preventDefault()
            const st = focusBtn.getAttribute('data-db-focus')
            if (focus.focusedStatus === st) clearFocus() // same-lane press = exit (natural toggle)
            else setFocus(st)
            return
          }
          const enlargeBtn = e.target.closest('[data-db-focus-sheet]')
          if (enlargeBtn) {
            e.preventDefault()
            openSheet(enlargeBtn.getAttribute('data-db-focus-sheet'))
            return
          }
          const add = e.target.closest('[data-add]')
          if (add) {
            B().openEditor(null, { defaults: { status: add.dataset.add }, onSaved: reload })
            return
          }
          // UI-redesign: the column ellipsis (⋯) toggle. One menu open at a time;
          // clicking the button again closes it. The menu items themselves carry the
          // existing data-db-copy/export/archive/clear attrs, so the branches below this
          // (which call closeAllColMenus() first) handle the actions + close the menu.
          const colMenuBtn = e.target.closest('[data-db-col-menu]')
          if (colMenuBtn) {
            e.preventDefault()
            const menu = colMenuBtn.parentElement && colMenuBtn.parentElement.querySelector('.db-col-menu')
            if (!menu) return
            const willOpen = menu.hidden
            closeAllColMenus()
            menu.hidden = !willOpen
            colMenuBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false')
            return
          }
          // Session 22: read-more / read-less toggle — must run BEFORE the card branch
          // (the button lives INSIDE [data-task-card], and ctx.on handlers are separate
          // document-level listeners — stopPropagation can't stop the card branch).
          const moreBtn = e.target.closest('[data-task-read-more]')
          if (moreBtn) {
            e.preventDefault()
            const card = moreBtn.closest('.pd-task-wrap')
            const title = card ? card.querySelector('.pd-task-title') : null
            const rest = title ? title.querySelector('.pd-title-rest') : null
            if (title && rest) {
              if (rest.hidden) {
                rest.hidden = false
                title.removeAttribute('data-clamped')
                moreBtn.textContent = _t('pd.readLess', 'read less')
                moreBtn.setAttribute('aria-expanded', 'true')
              } else {
                rest.hidden = true
                title.setAttribute('data-clamped', '')
                moreBtn.textContent = _t('pd.readMore', 'read more')
                moreBtn.setAttribute('aria-expanded', 'false')
              }
            }
            return
          }
          // S208: the card's pin badge opens the pinned-pictures dialog (HibanaBoard
          // owns it — zoom + unpin; unpin reloads the board so the count stays true).
          const badge = e.target.closest('[data-db-shots-dialog]')
          if (badge) {
            e.preventDefault(); e.stopPropagation()
            B().openTaskShots(badge.getAttribute('data-db-shots-dialog'), { onChanged: reload })
            return
          }
          // S245 (spec pack Phase 6 — §13 + Screens J2/J3): the deadline row's Extend
          // affordance — the shared stack's ROUTER owns the scope decision (a
          // personal deadline → J2's picker; a sprint-sourced row → J3's CHOICE
          // modal — never a silent sprint change); no effective deadline → nothing.
          // Runs BEFORE the card-click→view branch below (the button lives INSIDE
          // [data-task-card]; ctx.on handlers are separate document-level listeners
          // — an early return is the only shield, the moreBtn badge precedent).
          const extBtn = e.target.closest('[data-db-extend]')
          if (extBtn) {
            e.preventDefault(); e.stopPropagation()
            const task = B().findTask(extBtn.getAttribute('data-db-extend'))
            if (task && B().openTaskDeadlineExtend) B().openTaskDeadlineExtend(task, { onDone: reload })
            return
          }
          // S238: the sheet's one-tap per-row copy — the RAW full definition (the ⋯
          // menu's Copy contract without opening the menu; data-raw-title first,
          // the loaded task as the belt).
          const sheetCopy = e.target.closest('[data-db-sheet-copy]')
          if (sheetCopy) {
            e.preventDefault()
            const wrap = sheetCopy.closest('.pd-task-wrap')
            const titleEl = wrap ? wrap.querySelector('.pd-task-title') : null
            const raw = titleEl ? titleEl.getAttribute('data-raw-title') : null
            const task = B().findTask(sheetCopy.getAttribute('data-db-sheet-copy'))
            const text = raw || (task ? String(task.title || '') : '') || (titleEl ? titleEl.textContent : '')
            try {
              await navigator.clipboard.writeText(text)
              window.hibana?.toast(_t('common.copied', 'Copied to clipboard'), 'ok')
            } catch { window.hibana?.toast(_t('sparks.saveFailed', "Couldn't copy"), 'err') }
            return
          }
          const card = e.target.closest('[data-task-card]')
          // S238: a card click OPENS THE TASK — the read-only view modal. The
          // editor opens only from the ⋯ menu's Edit / the view's Edit button
          // (the project page's S149 contract, brought to the board). The
          // exclusion list keeps its S30/S208/S245 shape: the prio banner cycles,
          // the label chips filter, the ⋯ menu (and the sheet's copy button inside
          // it) own their actions, the pin badge opens its own dialog, the
          // deadline row's Extend affordance routes its own flow — none of them
          // open the view either.
          if (card && !e.target.closest('[data-task-read-more]') && !e.target.closest('[data-db-cycle-prio]') && !e.target.closest('.pd-tag') && !e.target.closest('.db-card-menu') && !e.target.closest('[data-db-shots-dialog]') && !e.target.closest('[data-db-extend]')) openTaskView(card.dataset.taskCard, card.querySelector('.pd-task'))

          // Item 8 + S30 batch 2: per-column Quick Copy + Export Markdown — the bullets
          // now carry priority + labels ("- [URGENT] Fix auth leak #UI/UX #Security") and
          // read from the LOADED STATE, not the DOM (the DOM only shows what the filter
          // lets through; the export stays truthful to the whole column).
          const colLines = (st) => B().state.tasks
            .filter((x) => x.status === st)
            .map((x) => B().mdTaskLine(x, (x.tags || []).map((id) => { const tg = B().tagById(id); return tg ? tg.name : '' }).filter(Boolean)))
            .filter(Boolean)
          const copy = e.target.closest('[data-db-copy]')
          if (copy) {
            closeAllColMenus()
            const st = copy.dataset.dbCopy
            const text = colLines(st).join('\n')
            navigator.clipboard?.writeText(text).then(
              () => window.hibana?.toast(_t('pd.copied', 'Copied to clipboard'), 'ok'),
              () => { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy') } catch {}; ta.remove() }
            )
            return
          }
          const exp = e.target.closest('[data-db-export]')
          if (exp) {
            closeAllColMenus()
            const st = exp.dataset.dbExport
            const col = document.querySelector(`.pd-col[data-status="${st}"]`)
            const label = col ? (col.querySelector('.pd-col-title')?.textContent.trim() || st) : st
            const lines = colLines(st)
            const md = '# ' + label + '\n\n' + (lines.length ? lines.join('\n') : '_(No items)_') + '\n'
            const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = label.replace(/[^a-zA-Z0-9\u0600-\u06FF_-]+/g, '_') + '.md'
            document.body.appendChild(a); a.click(); a.remove()
            URL.revokeObjectURL(url)
            window.hibana?.toast(_t('pd.exported', 'Exported as Markdown'), 'ok')
            return
          }
          // "Archive Done" button — moves done tasks to project_archives (permanent,
          // viewable + restorable). The safe "clear" — nothing is lost.
          const archiveBtn = e.target.closest('[data-db-archive-done]')
          if (archiveBtn) {
            closeAllColMenus()
            const col = document.querySelector('.pd-col[data-status="done"]')
            const count = col ? col.querySelectorAll('.pd-task-wrap').length : 0
            if (count === 0) return
            const msg = _t('pd.archiveDoneConfirm', 'Archive all {n} done tasks? They move to the project archives (restorable).').replace('{n}', B().faDig(count))
            if (!await window.hibana.confirm(msg, { title: _t('pd.archiveDone', 'Archive done tasks'), confirmLabel: _t('pd.archiveDone', 'Archive') })) return
            window.hibanaFetch('/api/projects/' + projectId + '/devtasks/archive-done', { method: 'POST' })
              .then((r) => r.ok ? r.json() : null)
              .then((body) => {
                const n = body && typeof body.archived === 'number' ? body.archived : count
                window.hibana?.toast(_t('pd.archivedDone', '{n} tasks archived').replace('{n}', B().faDig(n)), 'ok')
                reload()
              })
              .catch(() => window.hibana?.toast(_t('notes.deleteFailed', "Couldn't archive"), 'err'))
            return
          }
          // "Clear Done" button — HARD-DELETES done tasks (no archive). Destructive.
          const clearBtn = e.target.closest('[data-db-clear-done]')
          if (clearBtn) {
            closeAllColMenus()
            const col = document.querySelector('.pd-col[data-status="done"]')
            const count = col ? col.querySelectorAll('.pd-task-wrap').length : 0
            if (count === 0) return
            const msg = _t('pd.clearDoneConfirm', 'PERMANENTLY delete all {n} done tasks? This cannot be undone. Use "Archive" to keep them.').replace('{n}', B().faDig(count))
            if (!await window.hibana.confirm(msg, { title: _t('pd.clearDone', 'Clear done (delete)'), danger: true, confirmLabel: _t('pd.clearDone', 'Delete all') })) return
            // Delete each task individually (no bulk-delete endpoint — keeps it simple)
            const ids = Array.from(col.querySelectorAll('.pd-task-wrap')).map((c) => c.dataset.taskCard)
            Promise.all(ids.map((id) => window.hibanaFetch('/api/devtasks/' + id, { method: 'DELETE' })))
              .then(() => {
                window.hibana?.toast(_t('pd.clearedDone', '{n} tasks deleted').replace('{n}', B().faDig(count)), 'ok')
                reload()
              })
              .catch(() => window.hibana?.toast(_t('notes.deleteFailed', "Couldn't clear"), 'err'))
            return
          }
        })

        // ---- drag & drop: within a column reorders, across columns changes status ----
        let drag = null
        let over = null
        const clearOver = () => { if (over) { over.classList.remove('drag-over'); over = null } }
        // S210 (owner: "lower tasks can't be dragged to another section — only the top
        // ones move"): the old drop read the destination from the dragged card's CURRENT
        // parent (after a fragile live-reorder). A pointer over a column's empty lower
        // area — below the last card, on a short column, or on the Add-task strip — never
        // matched a [data-task-card], so the live-reorder skipped it, the card stayed in
        // its origin column, and the drop silently no-oped the status change. The column
        // under the POINTER now names the destination (e.target first, then a real
        // elementFromPoint hit-test for the live mouse drag).
        const colAt = (e) => {
          const t = e.target instanceof Element ? e.target : null
          const direct = t && t.closest ? t.closest('.pd-col') : null
          if (direct) return direct
          // synthetic DnD (the e2e suite) dispatches directly on .pd-col → `direct` is
          // set; the hit-test only runs for a real pointer that landed on empty column
          // space (the column body, not a card).
          if (!Number.isFinite(e.clientX) || !Number.isFinite(e.clientY)) return null
          const hit = document.elementFromPoint(e.clientX, e.clientY)
          return hit && hit.closest ? hit.closest('.pd-col') : null
        }
        // Live-place the dragged card inside a column's list (visual feedback + ensures
        // the drop below reads the destination the pointer named, not the card's origin).
        const placeInList = (col, x, y) => {
          const list = col.querySelector('.pd-tasks')
          if (!list || !drag) return
          const hit = (Number.isFinite(x) && Number.isFinite(y)) ? document.elementFromPoint(x, y) : null
          const target = hit && hit.closest ? hit.closest('[data-task-card]') : null
          const addBtn = list.querySelector('.pd-task-add')
          // guard list.contains(target): elementFromPoint can return a card that lives
          // in a DIFFERENT column (a tall neighbor bleeding into the pointer) —
          // insertBefore would throw NotFoundError. Only place relative to a target that
          // is genuinely a child of THIS list.
          if (target && target !== drag && list.contains(target)) {
            const r = target.getBoundingClientRect()
            const after = y > r.top + r.height / 2
            list.insertBefore(drag, after ? target.nextSibling : target)
          } else if (addBtn) {
            list.insertBefore(drag, addBtn) // append to the end (just above Add task)
          } else {
            list.appendChild(drag)
          }
        }
        ctx.on('dragstart', (e) => {
          const card = e.target.closest('[data-task-card]')
          if (!card) return
          // S237: the enlarge sheet is dragless (v1) — its cards render through the
          // same markup but never start a board drag.
          if (card.closest('.db-focus-sheet')) return
          drag = card
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', card.dataset.taskCard)
          card.classList.add('dragging')
        })
        ctx.on('dragover', (e) => {
          if (!drag) return
          // allow the drop FIRST — the browser refuses drop where dragover didn't
          // preventDefault, and a pointer over a column's empty lower area must still
          // accept the card (the original returned before preventDefault when
          // e.target wasn't inside a .pd-col, so the whole column body below the last
          // card rejected drops).
          e.preventDefault()
          // S136: the drop CUE is the COLUMN (.pd-col.drag-over — the pd recipe,
          // project-header.css), not a dashed body outline; the live-reorder still
          // inserts inside the column's .pd-tasks list.
          const col = colAt(e)
          if (!col) return
          const list = col.querySelector('.pd-tasks')
          if (!list) return
          clearOver()
          over = col
          col.classList.add('drag-over')
          placeInList(col, e.clientX, e.clientY)
        })
        ctx.on('drop', async (e) => {
          if (!drag) return
          e.preventDefault()
          const id = drag.dataset.taskCard
          // The destination is the column under the POINTER (not the dragged card's
          // current parent — the live placement above usually relocates it, but a drop
          // on an area the pointer crossed without a matching .pd-col still needs the
          // right status read). Falls back to the card's own column only when no column
          // can be resolved at all (a drop outside the board).
          const col = colAt(e) || drag.closest('.pd-col')
          const list = (col && col.querySelector('.pd-tasks')) || drag.closest('[data-pd-tasks]')
          const newStatus = list ? list.dataset.pdTasks : null
          const task = B().findTask(id)
          // If the live placement didn't relocate the card into the destination list
          // (a drop straight onto the column body, or an edge the pointer crossed
          // without firing a matching dragover), do it now so the order array below
          // reflects the intended drop position.
          if (list && drag.closest('[data-pd-tasks]') !== list) {
            const hit = (Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) ? document.elementFromPoint(e.clientX, e.clientY) : null
            const target = hit && hit.closest ? hit.closest('[data-task-card]') : null
            if (target && target !== drag && list.contains(target)) {
              const r = target.getBoundingClientRect()
              const after = e.clientY > r.top + r.height / 2
              list.insertBefore(drag, after ? target.nextSibling : target)
            } else {
              const addBtn = list.querySelector('.pd-task-add')
              if (addBtn) list.insertBefore(drag, addBtn)
              else list.appendChild(drag)
            }
          }
          // S30 batch 4 (user request: "drop into the urgent zone of the column"):
          // a SAME-COLUMN drop ADOPTS the priority of the card it landed next to —
          // the columns are priority-sorted, so the neighbor IS the tier zone. The
          // card below the drop point (or the one above when dropping at the end)
          // defines it; a differing tier PATCHes the priority with the move.
          let adoptedPrio = null
          if (task && newStatus === task.status && list) {
            const next = drag.nextElementSibling && drag.nextElementSibling.matches('[data-task-card]') ? drag.nextElementSibling : null
            const prev = drag.previousElementSibling && drag.previousElementSibling.matches('[data-task-card]') ? drag.previousElementSibling : null
            const zone = next || prev
            const zonePrio = zone ? (zone.dataset.priority || 'medium') : null
            if (zonePrio && zonePrio !== (task.priority || 'medium')) adoptedPrio = zonePrio
          }
          clearOver()
          drag.classList.remove('dragging')
          drag = null
          if (!task || !newStatus) return
          try {
            if (newStatus !== task.status) await B().patchTask(id, { status: newStatus })
            if (adoptedPrio) await B().patchTask(id, { priority: adoptedPrio })
            const ids = [...(list ? list.querySelectorAll('[data-task-card]') : [])].map((x) => x.dataset.taskCard)
            if (ids.length > 1) await B().reorderTasks(ids)
            await reload()
          } catch {
            window.hibana && window.hibana.toast(_t('sparks.saveFailed', "Couldn't save"), 'err')
            await reload()
          }
        })
        ctx.on('dragend', () => { clearOver(); if (drag) { drag.classList.remove('dragging'); drag = null } })

        // S136: the SEARCH INPUT — debounced like the project page's (pdFilterSearch
        // timer); a full render keeps ONE filtering model (the bar's value attr carries
        // the query across rebuilds), then focus + caret are restored so typing flows.
        ctx.on('input', (e) => {
          const input = e.target.closest ? e.target.closest('[data-db-filter-q]') : null
          if (!input) return
          clearTimeout(filterSearchTimer.t)
          filterSearchTimer.t = setTimeout(() => {
            filterQuery = String(input.value || '').trim().toLowerCase()
            render()
            const fresh = document.querySelector('[data-db-filter-q]')
            if (fresh) {
              fresh.focus()
              const v = fresh.value
              try { fresh.setSelectionRange(v.length, v.length) } catch { /* type=search may refuse — focus alone is fine */ }
            }
          }, 150)
        })

        // S242 (spec §7.5): the SPRINT FILTER select — one change re-renders with
        // the new view filter (the render carries the selected option + the is-on
        // tint across the rebuild). A select needs no focus/caret restore.
        ctx.on('change', (e) => {
          const sel = e.target.closest ? e.target.closest('[data-db-filter-sprint]') : null
          if (!sel) return
          filterSprint = sel.value
          render()
        })

        // S243 (Screen G): the compact overview's lifecycle actions — the shared
        // devboard.js stack (the H2 finish confirmation, the H3 pause confirm, the
        // H1-aware start/resume). onDone = the page's own reload() — the board
        // re-pulls + re-renders (the panel + the counts follow the fresh state).
        ctx.on('click', (e) => {
          const ov = e.target.closest('[data-db-sprint-ov]')
          if (!ov) return
          const id = ov.dataset.sprintId
          const s = id ? B().findSprint(id) : null
          if (!s) return
          if (e.target.closest('[data-db-ov-start]')) { B().startSprintWithConflict(s.id, { onDone: reload }); return }
          if (e.target.closest('[data-db-ov-resume]')) { B().startSprintWithConflict(s.id, { onDone: reload }); return }
          if (e.target.closest('[data-db-ov-pause]')) { B().confirmSprintPause(s, { onDone: reload }); return }
          if (e.target.closest('[data-db-ov-finish]')) { B().openSprintFinish(s, { onDone: reload }); return }
          // S245 (Screen J1): the overview's Extend action — the shared J1 dialog
          // (the /kanban twin folds state.tasks for the impact preview; the
          // reload re-pulls so the moved deadline + the inheritors re-render).
          if (e.target.closest('[data-db-ov-extend]')) { if (B().openSprintDeadlineExtend) B().openSprintDeadlineExtend(s, { onDone: reload }); return }
          // data-db-ov-settings is an <a href> — the browser navigates; no handler.
        })

        // S136: keyboard parity with the project page — the card is role="button" +
        // tabindex=0 now, so Enter/Space open the task's VIEW (S238 — the click's
        // twin; the editor stays behind the ⋯ menu's Edit / the view's Edit).
        ctx.on('keydown', (e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          if (!(e.target instanceof Element) || !e.target.classList.contains('pd-task')) return
          const wrap = e.target.closest('[data-task-card]')
          if (!wrap) return
          e.preventDefault()
          openTaskView(wrap.dataset.taskCard, e.target)
        })

        // ---- boot ----
        // Self-healing library wait: HibanaBoard can be missing when this page arrives
        // through a soft navigation from a STALE nav.js (deployed before script transport
        // existed — the tag is simply never appended), when devboard.js failed to fetch,
        // or when a slow deferred script hasn't evaluated yet. Give it a moment, then
        // inject the scripts OURSELVES and keep waiting — only give up (with a retry
        // button) after a real timeout. Re-appending the tag re-executes the module,
        // which is idempotent (it only defines window.HibanaBoard).
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
              inject('/js/devboard.js?v=37') // keep in sync with the <head> tag + sw SHELL
              if (!window.HibanaFocusCore) inject('/js/focus-core.js?v=2') // S237/S238: the focus + view decision core — keep in sync with the <head> tag
              if (!window.HibanaChips) inject('/js/chip-render.js?v=13') // S36: was ?v=1 while the HTML tags say v=2 — two cache entries for one file (the cache-bust gate caught it under the sandbox's mode-bit noise). Aligned; local-dev + SW caches now share ONE url per version. S86: v8 — kept in sync with the <head> tag (previewHtml moved in). S176: v11.
              if (!window.jalaali) inject('/vendor/jalaali.min.js') // Jalali dates for FA
            }
            if (waited >= 9000) return resolve(false)
            waited += 150
            setTimeout(tick, 150)
          }
          tick()
        })
        const fail = () => {
          root.hidden = true
          loading.hidden = false
          const msg = String(_t('db.loadFailed', "Couldn't load the board")).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
          const retry = String(_t('db.retry', 'Try again')).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
          loading.innerHTML = '<span>' + msg + '</span> <button type="button" class="btn small" id="db-retry">' + retry + '</button>'
        }
        // 404 = the project doesn't exist (anymore). Retrying can never succeed — say
        // what happened and offer the way back instead of a dead-end error.
        const gone = () => {
          root.hidden = true
          loading.hidden = false
          const msg = String(_t('db.projectGone', "This project doesn't exist or was deleted")).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
          const back = String(_t('db.backToProjects', 'Back to projects')).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
          loading.innerHTML = '<span>' + msg + '</span> <a class="btn small" href="/projects.html">' + back + '</a>'
        }
        const boot = async () => {
          const ok = await ensureLib()
          if (!ok) return fail()
          // S237: the probe surface — window.HibanaBoard.focusState() reports the live
          // { enabled, focusedStatus, sheetStatus } triple (scripts/probe-focus.mjs
          // reads it; the desktop island ships this same controller verbatim).
          // S238: viewTaskId joins the report (the view probe's contract).
          if (window.HibanaBoard) window.HibanaBoard.focusState = () => ({ enabled: focus.enabled, focusedStatus: focus.focusedStatus, sheetStatus: focus.sheetStatus, viewTaskId: taskViewTask ? taskViewTask.id : null })
          // S205 (spec §3.2): the entry point's default-project resolution — the
          // last-used board first (its load doubles as validation: a 404/deleted project
          // falls straight through), else the most-recent accessible project
          // (sort=recent = updated_at DESC — the "never lose your place" convention),
          // else the empty state. ?project= deep links skip all of this.
          let preloaded = false
          if (!projectId) {
            try {
              let last = null
              try { last = localStorage.getItem('hibana-kanban-last') } catch {}
              if (last) {
                try { await B().load(last); projectId = last; preloaded = true }
                catch (err) { if (!err || err.status !== 404) throw err }
              }
              if (!projectId) {
                const list = await fetchProjects()
                if (!list.length) return renderNoProjects()
                projectId = list[0].id
              }
              // Canonicalize the bare entry URL (replaceState — no history entry): a
              // shared/bookmarked /kanban picks up the resolved ?project=.
              const u = new URL(location.href)
              u.searchParams.set('project', projectId)
              history.replaceState(null, '', u)
            } catch {
              return fail()
            }
          }
          document.querySelector('[data-back-link]').href = '/project.html?id=' + projectId
          try {
            if (preloaded) render()
            else await reload()
            recordBoard()
          } catch (err) {
            if (err && err.status === 404) return gone()
            return fail()
          }
          // S237 (spec §1.5 auto-restore): toggle on + a valid remembered lane →
          // re-enter that lane's blur focus immediately (fresh DOM — no animation).
          // The enlarge sheet is ALWAYS transient — never restored.
          {
            const restore = FC() ? FC().autoRestore(focus.enabled, focusStorage.readLast()) : null
            if (restore) { focus.focusedStatus = restore; applyFocus() }
          }
          if (openTask && B().findTask(openTask)) openTaskView(openTask) // S238: the deep link OPENS THE TASK (the view) — the editor stays behind ⋯ > Edit
          else if (addStatus) B().openEditor(null, { defaults: { status: addStatus }, onSaved: reload })
        }
        // S30 batch 5 (FA-guard find): `ready` is a PROMISE (always truthy) — the old
        // truthy-check booted BEFORE apply() resolved the language, so FA users got an
        // English first render. Await it: it resolves AFTER the lazy FA dictionary
        // lands (i18n.js's apply awaits ensureFaDict before resolving).
        if (window.hibanaI18n && window.hibanaI18n.ready) window.hibanaI18n.ready.then(boot).catch(boot)
        else document.addEventListener('hibana:i18n', boot, { once: true })

        // S205: the switcher popover is appended to <body> (positioning + stacking);
        // the page-lifecycle contract calls this on unmount so soft-navigations away
        // never leave a detached popover behind (nav.js applyDef → customUnmount).
        // S237: the sheet + the probe surface leave with the page (soft-nav away
        // never leaks a detached overlay behind). S238: the task view joins them.
        return () => {
          if (switchPop) switchPop.remove()
          if (sheetEl) { sheetEl.remove(); sheetEl = null }
          if (taskViewEl) { taskViewEl.remove(); taskViewEl = null; taskViewTask = null; taskViewReturn = null }
          if (window.HibanaBoard) delete window.HibanaBoard.focusState
        }
      },
    })
