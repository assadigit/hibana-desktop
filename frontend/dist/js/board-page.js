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
        const filterSearchTimer = { t: null }

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
          const done = S.tasks.filter((x) => x.status === 'done').length
          document.getElementById('db-counts').textContent = _t('db.counts', '{n} of {m} done')
            .replace('{n}', B().faDig(done)).replace('{m}', B().faDig(S.tasks.length))

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
            return true
          }
          const shownCount = S.tasks.filter(taskMatches).length
          const anyFilter = filterPrios.size > 0 || filterTags.size > 0 || filterQuery !== ''
          const filterBarHtml = S.tasks.length ? '<div class="db-filter" data-db-filter role="toolbar" aria-label="' + B().esc(_t('db.filterAria', 'Filter tasks')) + '">' +
            // S136: the search input FIRST — the exact structure + classes of the
            // project page's bar (project-page.js pdFilterBuild; .db-filter-search
            // styles ship in devboard.css and were already shared).
            '<input type="search" class="db-filter-search" data-db-filter-q placeholder="' + B().esc(_t('db.filterSearchPh', 'Search tasks…')) + '" aria-label="' + B().esc(_t('db.filterSearchPh', 'Search tasks…')) + '" autocomplete="off" spellcheck="false" dir="auto" value="' + B().esc(filterQuery) + '">' +
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
          root.innerHTML = filterBarHtml + filterEmptyHtml + '<div class="db-cols">' + B().STATUSES.map((st) => {
            const items = S.tasks.filter((x) => x.status === st && taskMatches(x))
            const isDone = st === 'done'
            // Done column gets TWO extra buttons: Archive (moves done → project_archives,
            // viewable + restorable) + Clear (hard-deletes, no archive). Only shown when
            // there are done tasks. (The old .db-col-done tint retired with the db column
            // styles — the pd board paints every column identically.)
            const doneActions = isDone && items.length > 0
              ? '<button type="button" class="ghost small" data-db-archive-done title="' + B().esc(_t('pd.archiveDone', 'Archive done tasks')) + '">' + I_ARCHIVE + '</button>' +
                '<button type="button" class="ghost small danger" data-db-clear-done title="' + B().esc(_t('pd.clearDone', 'Clear done (delete)')) + '">' + I_TRASH + '</button>'
              : ''
            return '<section class="pd-col" data-status="' + st + '">' +
              '<header class="pd-col-head"><span class="pd-col-title">' + B().esc(B().statusLabel(st)) + '</span>' +
              '<span class="detail-tab-count">' + B().faDig(items.length) + '</span>' +
              '<span class="pd-col-actions">' +
                doneActions +
                '<button type="button" class="ghost small" data-db-copy="' + st + '" title="' + B().esc(_t('pd.quickCopy', 'Quick copy')) + '">' + I_CLIPBOARD + '</button>' +
                '<button type="button" class="ghost small" data-db-export="' + st + '" title="' + B().esc(_t('pd.exportMd', 'Export Markdown')) + '">' + I_DOWNLOAD + '</button>' +
              '</span></header>' +
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
                  const chipsHtml = (tags.length || sprint
                    ? '<span class="pd-task-tags">' +
                      // S30 batch 2: label chips are FILTER toggles (GitHub behavior) —
                      // S136: rendered as the project page's .pd-tag spans (data-pd-tag-name
                      // carries the match key; the colored .pd-tag-dot replaces the ● text).
                      tags.map((tg) => '<span dir="auto" class="pd-tag" data-pd-tag-name="' + B().esc(tg.name.toLowerCase()) + '" title="' + B().esc(_t('db.filterTagHint', 'Click to filter by this label')) + '"><i class="pd-tag-dot" style="background:' + B().esc(tg.color) + '"></i>' + B().esc(tg.name) + '</span>').join('') +
                      (sprint ? '<span class="db-sprint-badge">◆ ' + B().esc(sprint.name) + '</span>' : '') +
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
                '<button type="button" class="pd-task-add" data-add="' + st + '">' + I_PLUS + ' <span>' + B().esc(_t('db.addTask', 'Add task')) + '</span></button>' +
              '</div>' +
            '</section>'
          }).join('') + '</div>'
          root.hidden = false
          if (loading) loading.hidden = true
          // S78 parity: the miss state syncs AFTER the paint (anyFilter + shownCount).
          const emptyEl = document.querySelector('[data-db-filter-empty]')
          if (emptyEl) emptyEl.hidden = !(anyFilter && shownCount === 0)
          // Inject the ⋯ menu content into each .db-card-menu (the cards re-render on
          // every load(), so we fill the menu placeholders + attach handlers here).
          injectDbCardMenus()
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
          filterPrios.clear(); filterTags.clear(); filterQuery = ''
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
        document.addEventListener('click', (e) => {
          if (!e.target.closest('.db-card-menu')) closeAllDbMenus()
        })
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllDbMenus() })

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
                '<h3>' + B().esc(_t('db.delConfirm', 'Delete this task?')) + '</h3>' +
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
        ctx.on('click', (e) => {
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
            filterPrios.clear(); filterTags.clear(); filterQuery = ''
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
          const add = e.target.closest('[data-add]')
          if (add) {
            B().openEditor(null, { defaults: { status: add.dataset.add }, onSaved: reload })
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
          const card = e.target.closest('[data-task-card]')
          // S30 batch 2: never open the editor from the prio dot / label chips / the ⋯
          // menu (they are actions of their own — cycling, filtering, edit/delete).
          // S208: the pin badge joins the exclusion list (its own dialog, above).
          if (card && !e.target.closest('[data-task-read-more]') && !e.target.closest('[data-db-cycle-prio]') && !e.target.closest('.pd-tag') && !e.target.closest('.db-card-menu') && !e.target.closest('[data-db-shots-dialog]')) B().openEditor(card.dataset.taskCard, { onSaved: reload })

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
            const col = document.querySelector('.pd-col[data-status="done"]')
            const count = col ? col.querySelectorAll('.pd-task-wrap').length : 0
            if (count === 0) return
            const msg = _t('pd.archiveDoneConfirm', 'Archive all {n} done tasks? They move to the project archives (restorable).').replace('{n}', B().faDig(count))
            if (!confirm(msg)) return
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
            const col = document.querySelector('.pd-col[data-status="done"]')
            const count = col ? col.querySelectorAll('.pd-task-wrap').length : 0
            if (count === 0) return
            const msg = _t('pd.clearDoneConfirm', 'PERMANENTLY delete all {n} done tasks? This cannot be undone. Use "Archive" to keep them.').replace('{n}', B().faDig(count))
            if (!confirm(msg)) return
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
        ctx.on('dragstart', (e) => {
          const card = e.target.closest('[data-task-card]')
          if (!card) return
          drag = card
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', card.dataset.taskCard)
          card.classList.add('dragging')
        })
        ctx.on('dragover', (e) => {
          if (!drag) return
          e.preventDefault()
          // S136: the drop CUE is the COLUMN (.pd-col.drag-over — the pd recipe,
          // project-header.css), not a dashed body outline; the live-reorder still
          // inserts inside the column's .pd-tasks list.
          const col = e.target.closest('.pd-col')
          if (!col) return
          const list = col.querySelector('.pd-tasks')
          if (!list) return
          clearOver()
          over = col
          col.classList.add('drag-over')
          // live-reorder inside the column for visual feedback
          const target = e.target.closest('[data-task-card]')
          const addBtn = list.querySelector('.pd-task-add')
          if (target && target !== drag) {
            const r = target.getBoundingClientRect()
            const after = e.clientY > r.top + r.height / 2
            list.insertBefore(drag, after ? target.nextSibling : target)
          } else if (!target && addBtn) {
            list.insertBefore(drag, addBtn)
          }
        })
        ctx.on('drop', async (e) => {
          if (!drag) return
          e.preventDefault()
          const id = drag.dataset.taskCard
          const list = drag.closest('[data-pd-tasks]')
          const newStatus = list ? list.dataset.pdTasks : null
          const task = B().findTask(id)
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

        // S136: keyboard parity with the project page — the card is role="button" +
        // tabindex=0 now, so Enter/Space open the editor (when the CARD itself is
        // focused; inner buttons keep their own keys).
        ctx.on('keydown', (e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          if (!(e.target instanceof Element) || !e.target.classList.contains('pd-task')) return
          const wrap = e.target.closest('[data-task-card]')
          if (!wrap) return
          e.preventDefault()
          B().openEditor(wrap.dataset.taskCard, { onSaved: reload })
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
              inject('/js/devboard.js?v=29') // keep in sync with the <head> tag + sw SHELL
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
          if (openTask && B().findTask(openTask)) B().openEditor(openTask, { onSaved: reload })
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
        return () => { if (switchPop) switchPop.remove() }
      },
    })
