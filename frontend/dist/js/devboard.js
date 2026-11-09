// Hibana dev-board shared client (0029 — user design 2026-08-29).
// One task pool per project rendered two ways: the 4-column progress board
// (board.html) and the sprint timeline (sprint.html). This module owns the DATA
// and the task editor modal so both surfaces stay in perfect sync; each page
// only renders its own view of window.HibanaBoard.state.
/* global window, document, fetch */
(function () {
  'use strict'

  const api = (path, opts) => {
    // S206 parts 2+3 (live-probe root causes, 2026-10-18): the fetch layer is
    // hardened against a browser/edge dispatch bug that is REAL on prod and
    // invisible locally. WHAT HAPPENED (probe-prod truth, four reproduction
    // generations): the GET /devboard fired from a mutation's continuation
    // (create/start/finish → reload → the SAME URL) was dispatched by the renderer
    // (requestWillBeSent) but NEVER reached the Worker (wrangler tail: every other
    // invocation visible — the boot GET, the POST, the cleanup DELETE — never the
    // hung GET; all worker-side outcomes ok, single-digit ms) — the request
    // vanished between the browser and the edge, on BOTH hosts, with and without
    // the service worker, regardless of cache mode or a cache-busting unique URL.
    // The page's fetch promise hung FOREVER: every sprint mutation left the
    // timeline stale until a manual refresh — a core "the sprint system is buggy"
    // symptom for the daily user. THE FIX (validated 4/4 on prod, both hosts,
    // retries=0): every GET dispatches with an AbortController signal + a 3s
    // deadline + ONE retry — the signal-wrapped dispatch shape empirically avoids
    // the swallow entirely, and the deadline+retry is belt-and-braces for any
    // residual case (an aborted stuck request re-fetches; the second fetch has
    // always completed in every reproduction). Mutations keep the plain path (they
    // never hung; retrying them would double-write). cache:'no-store' rides along
    // on every call (part 2): the payload is always-fresh-by-design (the server
    // stamps `private, no-cache`), so skipping the revalidation machinery costs
    // nothing.
    const send = (signal) => window.hibanaFetch(path, { ...opts, cache: 'no-store', signal })
    const isMutation = !!(opts && opts.method && opts.method !== 'GET')
    const fetchOnce = isMutation ? send() : new Promise((resolve, reject) => {
      const ctl = new AbortController()
      // S254 (FE-12): the GET first deadline is 8s (was 3s). A 3s abort + retry
      // DOUBLED the felt latency on genuinely slow networks (the first request
      // was usually about to land). The signal-wrapped dispatch stays — that's
      // the actual edge-bug mitigation — and the one retry on abort stays too.
      const timer = setTimeout(() => ctl.abort(), 8000)
      send(ctl.signal).then(
        (r) => { clearTimeout(timer); resolve(r) },
        (e) => {
          clearTimeout(timer)
          if (e && e.name === 'AbortError') {
            // one retry on a FRESH request (the second fetch has always completed)
            const ctl2 = new AbortController()
            const t2 = setTimeout(() => ctl2.abort(), 10000)
            send(ctl2.signal).then(
              (r2) => { clearTimeout(t2); resolve(r2) },
              (e2) => { clearTimeout(t2); reject(e2) },
            )
          } else reject(e)
        },
      )
    })
    return fetchOnce.then(async (r) => {
      if (!r.ok) {
        // Carry the HTTP status on the thrown error so pages can tell a DELETED
        // project (404 — retry will never help) from a transient failure (retry does).
        const err = new Error(r.status + ' ' + path)
        err.status = r.status
        // S242 (spec pack §7.1): best-effort parse of the uniform {error:'<code>'}
        // body — the sprint quick-create dialog needs the 409 code (duplicate /
        // draft_exists) to render its inline errors instead of a generic toast.
        // S243 (spec pack §5.2): the parse now carries the WHOLE body (err.body) —
        // the one-active conflict modal reads active_id from the 409
        // sprint_active_exists payload instead of trusting a stale client state.
        try {
          const b = await r.json()
          if (b && b.error) err.code = b.error
          if (b && typeof b === 'object') err.body = b
        } catch { /* non-JSON body — status alone */ }
        throw err
      }
      return r.status === 204 ? null : r.json()
    })
  }

  // S254 (FE-15): the s !== k guard — hibanaI18n.t() returns the KEY itself when
  // both dictionaries miss it (e.g. the dict script never loaded), which is
  // truthy — the old `|| fallback` shape leaked the raw key ('db.foo') into the
  // UI instead of this library's own English fallback. board-page.js's _t has
  // carried the correct guard since S30 batch 5; the library twins adopt it.
  const t = (key, fallback) => {
    const s = window.hibanaI18n ? window.hibanaI18n.t(key) : null
    return s && s !== key ? s : fallback
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

  // 0031: 'bug' closes the loop — a red Problems column on both boards.
  // Batch (p) 2026-09-06 terminology: planned = برنامه آتی (Upcoming Plan),
  // bug = مشکلات (Problems) — user renamed both terms everywhere.
  // Batch (s) 2026-09-08 position (Ali's 13-item list ⑩): مشکلات sits BETWEEN
  // «ایده‌های جدید» and «برنامه آتی» — second in reading order, not parked at the end.
  const STATUSES = ['idea', 'bug', 'planned', 'in_progress', 'done']
  const PRIORITIES = ['low', 'medium', 'high', 'urgent']
  // S30 batch 2: click-the-dot cycles low → medium → high → urgent → low (the
  // ascending promotion reads naturally — one click = one step up).
  const PRIO_CYCLE = ['low', 'medium', 'high', 'urgent']
  const cyclePriority = (p) => {
    const i = PRIO_CYCLE.indexOf(p)
    return PRIO_CYCLE[(i + 1 + PRIO_CYCLE.length) % PRIO_CYCLE.length] || 'medium'
  }
  // S30 batch 2: the Markdown bullet for a task — "- [URGENT] Fix auth leak #UI/UX
  // #Security" (user's own format). Title whitespace collapses to one space so a
  // multi-line title (fenced code etc.) stays ONE bullet; label spaces hyphenate
  // (GitHub-style). tagNames: the DISPLAY names (board resolves ids, project page
  // resolves its flat join).
  const mdTaskLine = (task, tagNames) => {
    const title = String((task && task.title) || '').replace(/\s+/g, ' ').trim()
    if (!title) return ''
    const prio = String((task && task.priority) || 'medium').toUpperCase()
    const tags = (tagNames || [])
      .map((n) => '#' + String(n || '').trim().replace(/\s+/g, '-'))
      .filter((n) => n.length > 1)
    return '- [' + prio + '] ' + title + (tags.length ? ' ' + tags.join(' ') : '')
  }

  const statusLabel = (s) => ({
    idea: t('db.st.idea', 'New Ideas'),
    planned: t('db.st.planned', 'Plans'),
    in_progress: t('db.st.inprog', 'In Progress'),
    done: t('db.st.done', 'Implemented'),
    bug: t('db.st.bug', 'Problems'),
  })[s] || s
  const prioLabel = (p) => ({
    low: t('db.pr.low', 'Low'),
    medium: t('db.pr.medium', 'Medium'),
    high: t('db.pr.high', 'High'),
    urgent: t('db.pr.urgent', 'Urgent'),
  })[p] || p

  const faDig = (s) => {
    if (!window.hibanaI18n || window.hibanaI18n.lang && window.hibanaI18n.lang() !== 'fa') return String(s)
    return String(s).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)])
  }

  // Date helpers — UTC day math only; Jalali rendering through the vendored jalaali.
  const DAY = 86400000
  const dayIdx = (iso) => Math.floor(new Date(iso).getTime() / DAY)
  const todayIdx = () => Math.floor(Date.now() / DAY)

  const J_MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند']
  const G_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

  /** {y,m,d} of an absolute day index, in the ACTIVE calendar (fa → Jalali). */
  const calOf = (idx, lang) => {
    const d = new Date(idx * DAY)
    const gy = d.getUTCFullYear()
    const gm = d.getUTCMonth() + 1
    const gd = d.getUTCDate()
    if (lang === 'fa' && window.jalaali) {
      const j = window.jalaali.toJalaali(gy, gm, gd)
      return { y: j.jy, m: j.jm, d: j.jd }
    }
    return { y: gy, m: gm, d: gd }
  }
  const monthLabel = (idx, lang) => {
    const c = calOf(idx, lang)
    return lang === 'fa' ? J_MONTHS[c.m - 1] : G_MONTHS[c.m - 1]
  }
  /** day number label (Jalali day-of-month when fa). */
  const dayLabel = (idx, lang) => faDig(calOf(idx, lang).d, lang)
  const fullLabel = (idx, lang) => {
    const c = calOf(idx, lang)
    return lang === 'fa'
      ? faDig(c.d) + ' ' + J_MONTHS[c.m - 1] + ' ' + faDig(c.y)
      : c.d + ' ' + G_MONTHS[c.m - 1] + ' ' + c.y
  }
  /** weekday: 0=Sat..6=Fri in the fa week; 0=Sun..6=Sat raw for en. */
  const weekdayIdx = (idx, lang) => {
    const wd = new Date(idx * DAY).getUTCDay() // 0=Sun
    return lang === 'fa' ? (wd + 1) % 7 : wd
  }

  const state = { projectId: null, project: null, tasks: [], categories: [], sprints: [], tags: [], task_deps: [], strategies: [] }

  async function load(projectId, opts) {
    state.projectId = projectId
    // S255 (BE-3 — AUDIT-REMEDIATION-SPEC §7 step 1): the OPT-IN payload diet.
    // { lean: true } rides ?lean=1 — sprints[].description is omitted and the tiny
    // derived doc_checked rides instead (sprintDocChecked below reads BOTH shapes,
    // so this library works against either payload; the desktop island's bridge
    // fetch and the Go mirror's default-payload sync both stay decode-safe).
    const data = await api('/api/projects/' + projectId + '/devboard' + (opts && opts.lean ? '?lean=1' : ''))
    state.project = data.project
    state.tasks = data.tasks
    state.categories = data.categories
    state.sprints = data.sprints
    state.tags = data.tags
    // S246 (spec pack Phase 7 — contract §12.3): the payload's 7th key, the flat
    // per-project dep edges {blocker_task_id, blocked_task_id}. EVERYTHING the UI
    // folds (Blocked-by lists, the derived reverse Blocks counts, the
    // blocked/ready classification) reads THIS pool — never a second endpoint,
    // never a stored reverse column (spec §15's derived rule + the S241 decision).
    state.task_deps = data.task_deps || []
    // S250 (0066 — STRATEGIES-SPEC §4): the payload's 8th key — the strategy
    // registry, priority-first from the server. The || [] belt covers both a
    // lagging pre-0066 server (the catch→[] payload belt) and any older cached
    // shape — the sprint page renders an empty strategies strip, never a crash.
    state.strategies = data.strategies || []
    return data
  }

  const findTask = (id) => state.tasks.find((x) => x.id === id) || null
  const findCategory = (id) => state.categories.find((x) => x.id === id) || null
  const findSprint = (id) => state.sprints.find((x) => x.id === id) || null
  const tagById = (id) => state.tags.find((x) => x.id === id) || null
  // S250 (0066 — STRATEGIES-SPEC §4): the strategy tier's client lookups. status is
  // NOT NULL at birth server-side (a fresh 0066 table pins its CHECKs); the ||
  // 'active' belt only covers a hypothetical degenerate row, same defensive read
  // as sprintStatusOf's coalescing twin.
  const findStrategy = (id) => (state.strategies || []).find((x) => x.id === id) || null
  const strategyStatusOf = (st) => (st && st.status) || 'active'
  const strategyGlyph = (st) => (st && st.emoji ? String(st.emoji) : '⚑')
  // S242 (spec pack §4.2 — emoji identity): the sprint's identity glyph — the
  // user-picked emoji token, else the default sprint glyph ◆ (the diamond the
  // card badge has always worn; the SVG table's 'diamond' is the nav/icon twin).
  // Shared by the modal dropdown, the toolbar filter and the card sprint row —
  // one helper so every surface reads the same identity.
  const sprintGlyph = (s) => (s && s.emoji ? String(s.emoji) : '◆')
  // S255 (BE-3): the ☑ doc-checked stat reads EITHER payload shape — the lean
  // board's derived doc_checked (the server's exact twin of this fold) or, when
  // the full description rides (the default payload), the island's own grammar.
  // One seam: the sprint chip's "☑ N" stat never depends on which variant booted.
  const sprintDocChecked = (s) => (s && s.doc_checked != null)
    ? Number(s.doc_checked) || 0
    : (String((s && s.description) || '').match(/^- \[x\] /gm) || []).length
  // S255 (BE-3): the doc-fetch affordance — GET /api/sprints/:id/doc, the FULL
  // sprint row (description included), riding the SAME api() choke point (the
  // signal-wrapped GET contract + the desktop bridge seam — zero new fetch sites,
  // the seam count stays 7). Consumers that need the heavy field (a doc preview,
  // the desktop island's later lean adoption) fetch it ON OPEN, never per boot.
  const sprintDoc = (id) => api('/api/sprints/' + id + '/doc')
  // S242 (spec §8/§5.4): completed check for the assignment rules — status is
  // authoritative post-0065; ended_at is the lock-step belt (the invariant keeps
  // ended_at NOT NULL ⇔ completed, so a lagging null-status row still reads right).
  const sprintCompleted = (s) => !!(s && (s.status === 'completed' || s.ended_at))
  // S243 (spec pack §5 — the lifecycle UI): the client twin of the server's
  // sprintStatusOf (src/routes/devboard-helpers.ts): status is authoritative
  // post-0065; a lagging pre-0065 null-status row re-derives from the legacy
  // is_draft/ended_at pair (planned / completed / active — the D1 belt).
  const sprintStatusOf = (s) => {
    if (!s) return 'planned'
    if (s.status) return s.status
    if (s.ended_at) return 'completed'
    return s.is_draft ? 'planned' : 'active'
  }
  // S243 (spec pack §7.4 + contract §12.5 — the CLIENT-DERIVED overview counts):
  // fold the loaded board payload's tasks by sprint + status — five lanes + a
  // total, NOTHING else (no percentages, no analytics; the S241 recorded decision
  // — no /sprints/:sid/overview endpoint exists and none may be added). Every
  // overview surface (the Sprints page detail, the Kanban compact panel, the
  // embedded board's twin) reads THIS one fold; the embedded project page passes
  // its own DOM-derived rows (its truth is server-rendered wraps, not this state).
  const sprintLaneCounts = (sprintId, taskRows) => {
    const rows = taskRows || state.tasks
    const counts = {}
    let total = 0
    for (const st of STATUSES) counts[st] = 0
    for (const task of rows) {
      if (task.sprint_id !== sprintId) continue
      const st = task.status || 'idea'
      if (counts[st] === undefined) counts[st] = 0
      counts[st]++
      total++
    }
    return { counts, total }
  }

  // ---- S254 (FE-1): the client-side state merges for task mutations ----------
  // The per-column repaint (board) and the no-refetch render (sprint) need the
  // PATCH / POST / reorder outcomes folded into state WITHOUT the full board
  // GET. Each helper replicates the SERVER's own field semantics exactly
  // (src/routes/devboard.ts): the done_at stamp rule, due_at's origin rules,
  // the PRIO_ORDER_SQL → sort_order → created_at ORDER BY, and the quick-add
  // draft/open-sprint auto-assign. Pure state work — zero fetches, zero seams.
  const PRIO_RANK = { urgent: 0, high: 1, medium: 2, low: 3 }
  // the board GET's ORDER BY, as a comparator (devboard-helpers.ts PRIO_ORDER_SQL:
  // CASE priority urgent/high/medium/low ELSE 4 — a NULL priority sorts LAST on
  // the server even though every renderer displays it as 'medium')
  const sortTasksLikeServer = () => {
    state.tasks.sort((a, b) => {
      const pa = PRIO_RANK[a.priority] !== undefined ? PRIO_RANK[a.priority] : 4
      const pb = PRIO_RANK[b.priority] !== undefined ? PRIO_RANK[b.priority] : 4
      if (pa !== pb) return pa - pb
      const sa = Number(a.sort_order || 0)
      const sb = Number(b.sort_order || 0)
      if (sa !== sb) return sa - sb
      return String(a.created_at || '').localeCompare(String(b.created_at || ''))
    })
  }
  // effectiveDeadlineOf's client twin (devboard-helpers.ts §10 precedence):
  // personal override → non-completed sprint inheritance → none.
  const recomputeEffectiveDeadline = (task) => {
    const sprint = task.sprint_id != null ? findSprint(task.sprint_id) : null
    if (task.due_at != null) {
      task.effective_due_at = task.due_at
      task.effective_due_source = 'task'
      task.effective_due_origin_at = task.due_origin_at ?? task.due_at
    } else if (sprint && sprint.due_at != null && sprintStatusOf(sprint) !== 'completed') {
      task.effective_due_at = sprint.due_at
      task.effective_due_source = 'sprint'
      task.effective_due_origin_at = sprint.due_origin_at ?? sprint.due_at
    } else {
      task.effective_due_at = null
      task.effective_due_source = null
      task.effective_due_origin_at = null
    }
  }
  // fold a successful PATCH body into the state row (devboard.ts PATCH semantics)
  const mergeTaskPatch = (id, body, res) => {
    const task = findTask(id)
    if (!task || !body) return null
    const now = new Date().toISOString()
    const prevStatus = task.status
    const hadDue = task.due_at != null
    for (const [k, v] of Object.entries(body)) {
      if (k === 'tags' || k === 'due_origin_at') continue // handled below
      if (v === undefined) continue
      task[k] = v
    }
    // the date rule: entering 'done' stamps done_at (only when empty); leaving
    // 'done' clears it; created_at never moves.
    if (body.status && body.status !== prevStatus) {
      if (body.status === 'done' && !task.done_at) task.done_at = now
      else if (body.status !== 'done' && task.done_at) task.done_at = null
    }
    // §13.4's origin rules: null clears both; null→value stamps (the body's
    // ride-along honored); value→value preserves the origin (an edit ≠ a reset).
    if (body.due_at !== undefined) {
      if (body.due_at === null) task.due_origin_at = null
      else if (!hadDue) task.due_origin_at = body.due_origin_at ?? now
    }
    // the labels ride the PATCH as a replace-set; the response carries the FINAL
    // link set (server-assigned palette colors included)
    if (body.tags !== undefined && res && Array.isArray(res.tags)) {
      task.tags = res.tags.map((r) => String(r.id))
      syncTagLibrary(res.tags, now)
    }
    task.updated_at = now
    recomputeEffectiveDeadline(task)
    sortTasksLikeServer()
    return task
  }
  // fold a successful POST ack into state (devboard.ts POST semantics): sort_order
  // 0, stamps now, the draft/open-sprint auto-assign for an undefined sprint_id
  // (the exact sibling ORDER BYs), and the created tags join the local library.
  const mergeCreatedTask = (res, body) => {
    if (!res || !res.id || findTask(res.id)) return null
    const b = body || {}
    const now = new Date().toISOString()
    const status = b.status ?? 'idea'
    let sprintId = b.sprint_id ?? null
    if (b.sprint_id === undefined) {
      const drafts = state.sprints.filter((s) => s.is_draft)
        .sort((a2, b2) => String(b2.created_at || '').localeCompare(String(a2.created_at || '')))
      if (drafts[0]) sprintId = drafts[0].id
      else {
        const open = state.sprints.filter((s) => !s.is_draft && s.ended_at == null)
          .sort((a2, b2) => String(b2.started_at || '').localeCompare(String(a2.started_at || '')))
        if (open[0]) sprintId = open[0].id
      }
    }
    const task = {
      id: res.id,
      project_id: state.projectId,
      title: b.title,
      status,
      priority: b.priority ?? 'medium',
      category_id: b.category_id ?? null,
      sprint_id: sprintId,
      sort_order: 0,
      created_at: now,
      updated_at: now,
      done_at: status === 'done' ? now : null,
      start_at: b.start_at ?? null,
      end_at: b.end_at ?? null,
      due_at: b.due_at ?? null,
      due_origin_at: b.due_at != null ? now : null,
      shot_count: 0,
      tags: (Array.isArray(res.tags) ? res.tags : []).map((r) => String(r.id)),
    }
    if (Array.isArray(res.tags)) syncTagLibrary(res.tags, now)
    state.tasks.push(task)
    recomputeEffectiveDeadline(task)
    sortTasksLikeServer()
    return task
  }
  // link rows the library doesn't know yet (freshly find-or-created tags) — the
  // board's chip lookups (tagById) stay truthful without a re-pull
  const syncTagLibrary = (rows, now) => {
    for (const r of rows || []) {
      if (!r || !r.id || tagById(r.id)) continue
      state.tags.push({ id: r.id, name: r.name, color: r.color, user_id: null, usage_count: 1, created_at: now })
    }
  }
  // the reorder writes sort_order = array index for the listed ids only
  const applyReorder = (ids) => {
    if (!Array.isArray(ids)) return
    const byId = new Map(ids.map((id, i) => [id, i]))
    for (const t of state.tasks) if (byId.has(t.id)) t.sort_order = byId.get(t.id)
    sortTasksLikeServer()
  }
  // a local delete (the board's per-column repaint path) — the SERVER delete
  // already succeeded when this runs
  const removeTaskLocal = (id) => {
    state.tasks = state.tasks.filter((t) => t.id !== id)
  }

  // ---------------------------------------------------------------- deadline render
  // S244 (spec pack Phase 5 — §12 the deadline progress indicator): the shared
  // CLIENT render stack. The RESOLUTION is server-owned (S241's computed triple on
  // every payload task row — spec §18: the client ships ZERO deadline-logic and
  // never re-derives); the only client-side work is RENDERING: classifying
  // now-vs-effective_due_at per §12.3 for the threshold wording/color, and the
  // elapsed-time ratio from effective_due_origin_at per §12.2. One implementation
  // exported on window.HibanaBoard so board-page.js (the /kanban cards + the task
  // view) and project-page.js (the embedded board's repaint twin) render
  // identically — never forked (the S209 parity doctrine).
  const DUE_ICON = '<svg class="icon db-due-ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M8 3v4M16 3v4M3.5 10h17"/><circle cx="12" cy="15.2" r="3.1"/><path d="M12 13.9v1.5l1 .7"/></svg>'
  const H48 = 48 * 3600000
  const D7 = 7 * 86400000
  /** §12.3 thresholds + §12.4 completed-neutrality: classify now vs the payload's
   * effective_due_at. null = no active deadline (no row, no bar — §10.3's
   * completed-sprint neutrality already nulled the triple server-side, so the
   * client just renders null). The exact boundaries: remaining > 7d →
   * comfortable; > 48h and ≤ 7d → approaching; ≤ 48h and not overdue → urgent;
   * passed → overdue (§24 tests the exactly-7d and exactly-48h edges). */
  const deadlineStateOf = (task, nowMs) => {
    const due = task && task.effective_due_at
    if (!due) return null
    if (task.status === 'done') return 'done' // §12.4: no live countdown on a completed task
    const now = nowMs == null ? Date.now() : nowMs
    const rem = Date.parse(due) - now
    if (rem <= 0) return 'overdue'
    if (rem <= H48) return 'urgent'
    if (rem <= D7) return 'approaching'
    return 'comfortable'
  }
  /** §12.2: the ELAPSED-TIME fill — the ratio of time elapsed between the
   * effective_due_origin_at (the payload's server-computed progress START — the
   * winning level's origin stamp, coalesced server-side; NEVER re-derived here)
   * and effective_due_at, clamped 0-100. Elapsed time toward the deadline, NOT
   * task completion. */
  const deadlineElapsedPct = (task, nowMs) => {
    const due = task && task.effective_due_at
    if (!due) return 0
    const now = nowMs == null ? Date.now() : nowMs
    const dueMs = Date.parse(due)
    const originMs = task.effective_due_origin_at ? Date.parse(task.effective_due_origin_at) : dueMs
    if (now >= dueMs) return 100
    if (dueMs <= originMs) return 0 // degenerate coalesced origin — no span to fill
    if (now <= originMs) return 0
    return Math.min(100, Math.max(0, Math.round(((now - originMs) / (dueMs - originMs)) * 100)))
  }
  /** The due day's compact label in the user's LOCAL calendar (§11.4 — local
   * timezone; Jalali month names when fa). 'Nov 21' / '۲۱ آبان'. */
  const dueDayLabel = (ms, lang) => {
    const d = new Date(ms)
    if (lang === 'fa' && window.jalaali) {
      const j = window.jalaali.toJalaali(d.getFullYear(), d.getMonth() + 1, d.getDate())
      return faDig(j.jd) + ' ' + J_MONTHS[j.jm - 1]
    }
    return G_MONTHS[d.getMonth()] + ' ' + d.getDate()
  }
  const localDayIdx = (ms) => { const d = new Date(ms); return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / DAY) }
  /** The §12.3 wording — the WORD carries the meaning, never color alone. The
   * spec's own example vocabulary: 'Due Nov 21 · 16 days left', 'Due tomorrow',
   * 'Due today', 'Overdue by 1 day', 'Sprint deadline · 7 days left' — the
   * today/tomorrow/overdue forms read STANDALONE (no date prefix), the dated
   * forms carry the day label, and the inherited row identifies the source. */
  const deadlineLabel = (task, state, nowMs, lang) => {
    const dueMs = Date.parse(task.effective_due_at)
    const now = nowMs == null ? Date.now() : nowMs
    const sprintSrc = task.effective_due_source === 'sprint'
    if (state === 'done') {
      // §12.4: neutral, a clear Done indication, the date retained — no countdown.
      return sprintSrc
        ? '✓ ' + t('db.due.doneLabel', 'Done') + ' · ' + t('db.due.sprintDue', 'Sprint deadline') + ' · ' + dueDayLabel(dueMs, lang)
        : '✓ ' + t('db.due.doneLabel', 'Done') + ' · ' + t('db.ov.due', 'Due {d}').replace('{d}', dueDayLabel(dueMs, lang))
    }
    let left
    let standalone = false
    if (now >= dueMs) {
      const days = localDayIdx(now) - localDayIdx(dueMs)
      if (days >= 2) left = t('db.due.overdueDays', 'Overdue by {n} days').replace('{n}', faDig(days))
      else if (days === 1) left = t('db.due.overdueDay', 'Overdue by {n} day').replace('{n}', faDig(1))
      else left = t('db.due.overdueHours', 'Overdue by {n}h').replace('{n}', faDig(Math.max(1, Math.round((now - dueMs) / 3600000))))
      standalone = true // the spec's example: 'Overdue by 1 day' reads standalone
    } else {
      const days = localDayIdx(dueMs) - localDayIdx(now)
      if (days === 0) { left = t('db.due.dueToday', 'Due today'); standalone = true }
      else if (days === 1) { left = t('db.due.dueTomorrow', 'Due tomorrow'); standalone = true }
      else left = t('db.due.leftDays', '{n} days left').replace('{n}', faDig(days))
    }
    // §10.1: the inherited row explicitly identifies the source on the card
    // ('Sprint deadline · 7 days left'); a personal deadline reads 'Due <date> · …'
    // (the standalone today/tomorrow/overdue forms skip the redundant date prefix).
    if (sprintSrc) return t('db.due.sprintDue', 'Sprint deadline') + ' · ' + left
    if (standalone) return left
    return t('db.ov.due', 'Due {d}').replace('{d}', dueDayLabel(dueMs, lang)) + ' · ' + left
  }
  /** The Extend affordance's glyph — the same stroke grammar as DUE_ICON: an
   * outward arrow over a panel edge ("push the deadline out"). Sits at the
   * deadline row's inline end, hover-revealed (S245 — Screen J). */
  const EXT_ICON = '<svg class="icon db-due-ext-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>'
  /** Screen A's card grammar — the row + the thin bar. Renders '' when the triple
   * is null (no deadline row, no bar — spec §10's no-deadline scenario). The row
   * carries the calendar-clock icon + the threshold WORD; the bar is decorative
   * (aria-hidden) and direction-locked LTR (§17: time progression stays
   * left-to-right even in RTL — the CSS owns the exception). S245 (§13): the
   * row's inline end carries the compact Extend affordance (hover-revealed,
   * keyboard-focusable — data-db-extend; the delegated board handlers route it
   * personal → J2, sprint-sourced → J3 — never a silent sprint change). */
  const deadlineRowHtml = (task, lang, nowMs) => {
    const state = deadlineStateOf(task, nowMs)
    if (!state) return ''
    const pct = deadlineElapsedPct(task, nowMs)
    const label = deadlineLabel(task, state, nowMs, lang)
    const extHint = t('db.ext.extendHint', 'Extend deadline')
    return '<span class="db-due-row st-' + state + '">' + DUE_ICON + '<span class="db-due-txt" dir="auto">' + esc(label) + '</span>' +
      (task && task.id ? '<button type="button" class="db-due-ext" data-db-extend="' + esc(task.id) + '" title="' + esc(extHint) + '" aria-label="' + esc(extHint) + '">' + EXT_ICON + '</button>' : '') + '</span>' +
      '<span class="db-due-bar" aria-hidden="true"><span class="db-due-fill st-' + state + '" style="width:' + pct + '%"></span></span>'
  }
  /** The row-ONLY variant (no bar) — the S238 read-only task view's meta rows join
   * the deadline display with the same row grammar, compact for the meta stack.
   * S245: the view's row carries the Extend affordance too (the kickoff's J2/J3
   * anchor — same routing as the card row). */
  const deadlineViewHtml = (task, lang, nowMs) => {
    const state = deadlineStateOf(task, nowMs)
    if (!state) return ''
    const extHint = t('db.ext.extendHint', 'Extend deadline')
    return '<span class="db-due-row st-' + state + ' db-due-view">' + DUE_ICON + '<span class="db-due-txt" dir="auto">' + esc(deadlineLabel(task, state, nowMs, lang)) + '</span>' +
      (task && task.id ? '<button type="button" class="db-due-ext" data-db-extend="' + esc(task.id) + '" title="' + esc(extHint) + '" aria-label="' + esc(extHint) + '">' + EXT_ICON + '</button>' : '') + '</span>'
  }

  // ------------------------------------------------------------- dependency render
  // S246 (spec pack Phase 7 — §14-§16 + Screens K/L): the shared CLIENT dep-fold
  // stack. The MECHANICS all exist server-side since S240/S241 (the dev_task_deps
  // table + the POST/DELETE endpoints + the payload's task_deps edge pool); what
  // this stack owns is the FOLD + the RENDER: *Blocked-by* = the edges where
  // blocked_task_id = X joined against the task rows for completion; the reverse
  // *Blocks N* counts = the SAME fold's other half — derived, NEVER a second
  // endpoint or a stored column (spec §15 + the S241 recorded decision). The
  // classification is §16.1's rule: a task with multiple blockers stays BLOCKED
  // until ALL of them are complete; every blocker complete → 'ready' (the
  // resolution SURFACING — the relationship itself is retained, never erased).
  // Dependencies are SOFT (assumption 2 / §16.1): these helpers are pure folds —
  // they never gate Kanban movement, never mutate priority/status/sprint/deadline,
  // and the renderers keep the badges fully independent of the priority ribbon
  // and the deadline row (spec §16 + §23). One implementation exported on
  // window.HibanaBoard so board-page.js (the /kanban cards + the S238 task view)
  // and project-page.js (the embedded board's repaint twin) render identically
  // — never forked (the S209 parity doctrine).
  /** The Blocked-by rows: the blocker task ids for X (edges where
   * blocked_task_id = X — the §12.3 read contract). */
  const depsOf = (taskId, edges) =>
    (edges || state.task_deps || []).filter((e) => e && e.blocked_task_id === taskId).map((e) => e.blocker_task_id)
  /** The DERIVED reverse count: how many tasks X blocks (the same edges' other
   * half — spec §15: never asked of the user, never stored, never a second
   * endpoint; N counts the blocked tasks regardless of their state — the
   * relationship exists and the badge says so). */
  const blocksCount = (taskId, edges) => {
    let n = 0
    for (const e of edges || state.task_deps || []) if (e && e.blocker_task_id === taskId) n++
    return n
  }
  /** §16.1: 'blocked' while ANY blocker is incomplete; 'ready' when blockers
   * existed and ALL are complete (a persistent derived state — the fold answers
   * it on every render, not a one-time transition event; the edge rows stay in
   * the pool either way — spec §16's "retain the relationship as historical
   * information"); null when the task has no blockers at all. */
  const blockedStateOf = (taskId, edges, taskRows) => {
    const ids = depsOf(taskId, edges)
    if (!ids.length) return null
    const rows = taskRows || state.tasks
    const by = new Map()
    for (const r of rows) if (r && r.id) by.set(r.id, r)
    let open = 0
    for (const id of ids) {
      const r = by.get(id)
      if (!r || r.status !== 'done') open++ // a missing row counts open — never a false Ready
    }
    return open > 0 ? 'blocked' : 'ready'
  }
  // Screen L's compact glyphs — the same restrained stroke grammar as DUE_ICON
  // (a held circle for Blocked, the check for Ready, the outbound arrow for the
  // derived Blocks count). Icons follow logical direction with the layout.
  const DEP_BLOCKED_ICON = '<svg class="icon db-dep-ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M8.4 12h7.2"/></svg>'
  const DEP_READY_ICON = '<svg class="icon db-dep-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'
  const DEP_BLOCKS_ICON = '<svg class="icon db-dep-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13"/><path d="M13 6.5l5.5 5.5-5.5 5.5"/></svg>'
  /** Screen L — the compact card badges, their own row in the Phase 3 seam
   * family (after the sprint row + the deadline row, before the tags — Screen M
   * variants 6/7). `Blocked` (optionally `Blocked · N` with multiple blockers,
   * the guide's compact count form) and/or `Blocks N` render ONLY when relevant
   * (§23: no deps → no row at all). Fully independent of the priority ribbon
   * AND the deadline display; the WORD carries the meaning (never color alone). */
  const depBadgeHtml = (task, edges, taskRows, lang) => {
    const id = task && task.id
    if (!id) return ''
    const e = edges || state.task_deps || []
    const blockedN = depsOf(id, e).length
    const blocksN = blocksCount(id, e)
    if (!blockedN && !blocksN) return ''
    const l = lang || (window.hibanaI18n && window.hibanaI18n.lang ? window.hibanaI18n.lang() : 'en')
    let html = '<span class="db-dep-row">'
    if (blockedN) {
      const st = blockedStateOf(id, e, taskRows)
      const label = st === 'ready'
        ? t('db.dep.ready', 'Ready')
        : (blockedN > 1 ? t('db.dep.blockedN', 'Blocked · {n}').replace('{n}', faDig(blockedN)) : t('db.dep.blocked', 'Blocked'))
      const hint = st === 'ready'
        ? t('db.dep.readyHint', 'All blockers are complete — this task is ready.')
        : t('db.dep.blockedHint', 'Blocked by {n} task(s) — open the task to see them.').replace('{n}', faDig(blockedN))
      html += '<span class="db-dep-badge st-' + st + '" title="' + esc(hint) + '">' + (st === 'ready' ? DEP_READY_ICON : DEP_BLOCKED_ICON) + '<span class="db-dep-badge-txt" dir="auto">' + esc(label) + '</span></span>'
    }
    if (blocksN) {
      const label = t('db.dep.blocksN', 'Blocks {n}').replace('{n}', faDig(blocksN))
      const hint = t('db.dep.blocksHint', 'This task blocks {n} task(s).').replace('{n}', faDig(blocksN))
      html += '<span class="db-dep-badge st-blocks" title="' + esc(hint) + '">' + DEP_BLOCKS_ICON + '<span class="db-dep-badge-txt" dir="auto">' + esc(label) + '</span></span>'
    }
    html += '</span>'
    return html
  }
  /** The S238 read-only task view's row-only twin — the DETAILS surface, so the
   * blocker NAMES join here (spec §16: "detailed blocker names belong in task
   * details or the Edit Task modal, not in long card text"). Same row grammar,
   * compact for the meta stack; '' when the task has no deps in either
   * direction. */
  const depViewHtml = (task, edges, taskRows, lang) => {
    const id = task && task.id
    if (!id) return ''
    const e = edges || state.task_deps || []
    const blockerIds = depsOf(id, e)
    const blocksIds = (e || []).filter((x) => x && x.blocker_task_id === id).map((x) => x.blocked_task_id)
    if (!blockerIds.length && !blocksIds.length) return ''
    const l = lang || (window.hibanaI18n && window.hibanaI18n.lang ? window.hibanaI18n.lang() : 'en')
    const rows = taskRows || state.tasks
    const by = new Map()
    for (const r of rows) if (r && r.id) by.set(r.id, r)
    const nameOf = (tid) => {
      const r = by.get(tid)
      const title = r && r.title ? String(r.title).split('\n')[0] : ''
      return title || '—'
    }
    let html = '<span class="db-dep-row db-dep-view">'
    if (blockerIds.length) {
      const st = blockedStateOf(id, e, rows)
      const label = t('db.dep.viewBlocked', 'Blocked by: {names}').replace('{names}', blockerIds.map(nameOf).join(' · '))
      html += '<span class="db-dep-badge st-' + st + '">' + (st === 'ready' ? DEP_READY_ICON : DEP_BLOCKED_ICON) + '<span class="db-dep-badge-txt" dir="auto">' + esc(label) + '</span></span>'
    }
    if (blocksIds.length) {
      const label = t('db.dep.viewBlocks', 'Blocks: {names}').replace('{names}', blocksIds.map(nameOf).join(' · '))
      html += '<span class="db-dep-badge st-blocks">' + DEP_BLOCKS_ICON + '<span class="db-dep-badge-txt" dir="auto">' + esc(label) + '</span></span>'
    }
    html += '</span>'
    return html
  }

  // hibana-sync-status-spec §8/§14: every TASK mutation reports to the per-card
  // sync tracker (public/js/sync-state.js — the ONE state store; the card badges,
  // the header Sync button count and the aria-live region all derive from it).
  // track() paints Pending optimistically, flips to Syncing past 500ms, and
  // settles Synced/Failed on the server's ack — and the promise still REJECTS on
  // failure, so every caller's toast contract below stays intact. The retry
  // closure re-issues THIS mutation when the card's failed pill is clicked.
  // createTask is deliberately untracked: a fresh card renders from the server's
  // own creation ack (synced by definition — spec §2).
  const tracked = (id, run) => (window.HibanaSyncState && id ? window.HibanaSyncState.track(id, run) : run())
  // S254 (FE-1): createTask/patchTask/reorderTasks MERGE their outcome into
  // state on success (the client twin of the server's own write semantics —
  // see the merge helpers above) so the pages repaint from state without the
  // full board GET. The response shapes are unchanged for every caller.
  const createTask = (body) => api('/api/projects/' + state.projectId + '/devtasks', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((res) => { mergeCreatedTask(res, body); return res })
  const patchTask = (id, body) => tracked(id, () => api('/api/devtasks/' + id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((res) => { mergeTaskPatch(id, body, res); return res }))
  const deleteTask = (id) => tracked(id, () => api('/api/devtasks/' + id, { method: 'DELETE' }))
  // S246 (spec pack Phase 7 — contract §12.3's WRITE surface): the dep edge
  // wrappers, the patchTask shape. They ride the SHARED api() wrapper (ZERO new
  // fetch sites — the Phase 9 re-pin inventory stays untouched) and report to
  // the per-card sync tracker like every task mutation. The POST answers 201
  // new / 200 {existing:true} idempotent; self + cross-project → 400
  // invalid_input; a cycle-closing pick → 409 cycle (the caller surfaces the
  // code INLINE — never a generic toast). The DELETE is the tag-link shape:
  // 200 always.
  const addTaskDep = (id, blockerId) => tracked(id, () => api('/api/devtasks/' + id + '/deps', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ blocker_id: blockerId }),
  }))
  const removeTaskDep = (id, blockerId) => tracked(id, () => api('/api/devtasks/' + id + '/deps/' + blockerId, { method: 'DELETE' }))
  // A reorder is ONE request for many cards: trackBulk puts every id Pending
  // together and settles them on the single verdict (the retry re-issues the bulk
  // — the server contract is idempotent).
  const reorderTasks = (ids) => (window.HibanaSyncState && ids && ids.length
    ? window.HibanaSyncState.trackBulk(ids, () => api('/api/projects/' + state.projectId + '/devtasks/reorder', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
      }))
    : api('/api/projects/' + state.projectId + '/devtasks/reorder', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
      })
  ).then((res) => { applyReorder(ids); return res })
  const addTaskTag = (id, name, color) => tracked(id, () => api('/api/devtasks/' + id + '/tags', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, color }),
  }))
  const removeTaskTag = (id, tagId) => tracked(id, () => api('/api/devtasks/' + id + '/tags/' + tagId, { method: 'DELETE' }))

  // S152: the category colors are the curated fill+ink PAIRS now — create sends the
  // pair, delete archives (soft — block 8: rows stay, task references stay).
  const createCategory = (name, colorFill, colorInk) => api('/api/projects/' + state.projectId + '/categories', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, color_fill: colorFill, color_text: colorInk }),
  })
  const patchCategory = (id, body) => api('/api/categories/' + id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const deleteCategory = (id) => api('/api/categories/' + id + '/archive', { method: 'POST' })

  // S48n: createSprint now accepts optional started_at/ended_at. If both provided,
  // the sprint is created as STARTED (skips the draft step). Presets compute the dates.
  // S250 (0066 — owner decision #11): opts.strategy_id rides the together-assignment —
  // the define dialog picks the strategy WITH the sprint (a 4th optional arg would be
  // unreadable; the options object stays forward-compatible).
  const createSprint = (name, startedAt, endedAt, opts) => {
    const body = {}
    if (name) body.name = name
    if (startedAt) { body.started_at = startedAt; if (endedAt) body.ended_at = endedAt }
    if (opts && opts.strategy_id !== undefined) body.strategy_id = opts.strategy_id
    return api('/api/projects/' + state.projectId + '/sprints', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
  }
  // Phase 5 (2026-09-08): start a DEFINED (draft) sprint — stamps started_at, puts it on
  // the board, and closes any currently open sprint first (server-side day edges).
  const startSprint = (id) => api('/api/sprints/' + id + '/start', { method: 'POST' })
  // generic sprint PATCH — rename AND manual boundaries ({ started_at?, ended_at? }, null = reopen)
  const patchSprint = (id, body) => api('/api/sprints/' + id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const renameSprint = (id, name) => patchSprint(id, { name })
  const finishSprint = (id) => api('/api/sprints/' + id + '/finish', { method: 'POST' })
  const reopenSprint = (id) => api('/api/sprints/' + id + '/reopen', { method: 'POST' })
  const deleteSprint = (id) => api('/api/sprints/' + id, { method: 'DELETE' })
  // S243 (spec pack §5.5 — the S240 endpoints get their client wrappers): pause an
  // ACTIVE sprint (window + task associations untouched) and resume a PAUSED one
  // (subject to the one-active 409 — the conflict modal resolves it). Ridden
  // through the shared api() wrapper, so the fetch-site seam counts never move.
  const pauseSprint = (id) => api('/api/sprints/' + id + '/pause', { method: 'POST' })
  // S250 (0066 — STRATEGIES-SPEC §4): the strategy tier's write wrappers — ridden
  // through the shared api() choke point, so the desktop seam's fetch-site counts
  // never move (the S246 deps precedent). createStrategy carries the owner-approved
  // grammar: name + optional description/emoji/priority, born active. patchStrategy
  // carries every field INCLUDING the lifecycle status (the server guards the
  // completed transition); deleteStrategy is the hard delete behind the UI confirm.
  const createStrategy = (body) => api('/api/projects/' + state.projectId + '/strategies', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const patchStrategy = (id, body) => api('/api/strategies/' + id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const deleteStrategy = (id) => api('/api/strategies/' + id, { method: 'DELETE' })
  const resumeSprint = (id) => api('/api/sprints/' + id + '/resume', { method: 'POST' })
  const reorderCategories = (ids) => api('/api/projects/' + state.projectId + '/categories/reorder', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
  })

  // ---------------------------------------------------------------- shots (S208)
  // S208 (owner: "when creating a new task it doesn't show the button to upload a
  // picture — but already established tasks give you the option; make sure ALL the
  // task options of the original hibana live on this board"): the screenshots /
  // attachments pipeline comes to the board's task editor, ported from
  // project-page.js's S35/S46/S61/S67/S69/S86 stack (the XHR uploader with real
  // per-file progress + cancel, the ≤1600px WebP prepare pass, the staged-shots
  // lifecycle, the inline pinned grid, the lightbox browser). Scoped to
  // state.projectId so the SAME machinery serves board.html AND sprint.html —
  // both surfaces render this modal:
  //   - NEW tasks: the Upload File button stages pictures immediately (POST, no
  //     task_id) — they PIN to the created task on save (PATCH {taskId}) and are
  //     DELETED on cancel/Esc (the project composer's contract — nothing orphans
  //     in the project's gallery).
  //   - EXISTING tasks: the same button uploads + pins in one round-trip per
  //     file, and the inline grid below shows the task's pinned shots with
  //     zoom / edit-note / delete — the pde-shots-grid contract.
  //   - Full S86 bucket: png/jpeg/webp/gif + video/webm + pdf/csv/xlsx/docx/
  //     md/txt (doc tiles download — the serving route stamps
  //     Content-Disposition: attachment for non-images).
  const fmtBytes = (bytes) => {
    // Compact KB/MB for the progress rows (language-neutral units + FA digits).
    const n = Number(bytes) || 0
    if (n >= 1024 * 1024) return faDig((n / (1024 * 1024)).toFixed(1)) + ' MB'
    if (n >= 1024) return faDig(Math.round(n / 1024)) + ' KB'
    return faDig(n) + ' B'
  }
  // S86: the bucket takes PDF, CSV, XLSX, DOCX, MD, TXT alongside the four image
  // types (+ webm video). Browsers report doc mimes unreliably (octet-stream,
  // vendor variants), so the EXTENSION maps to the canonical allowlist mime —
  // the same allowlist the server validates against.
  const MIME_BY_EXT = {
    pdf: 'application/pdf',
    csv: 'text/csv',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    md: 'text/markdown',
    markdown: 'text/markdown',
    txt: 'text/plain',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    webm: 'video/webm',
  }
  const fileExt = (f) => String(f && f.name ? f.name.split('.').pop() : '').toLowerCase()
  const canonicalMime = (f) => {
    const byExt = MIME_BY_EXT[fileExt(f)]
    if (f.type && f.type.startsWith('image/') && ['png', 'jpeg', 'webp', 'gif'].includes(f.type.slice(6))) return f.type
    if (f.type === 'video/webm') return f.type
    if (byExt && (!f.type || f.type === 'application/octet-stream' || f.type === 'text/plain' || f.type.startsWith('text/') || f.type === byExt)) return byExt
    return f.type || byExt || ''
  }
  const isAcceptedFile = (f) => {
    const mime = canonicalMime(f)
    if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) return true
    return Object.values(MIME_BY_EXT).includes(mime)
  }
  const isImageMime = (m) => String(m || '').startsWith('image/')
  const fileExtLabel = (name) => {
    const ext = String(name || '').split('.').pop() || ''
    return ext.toUpperCase().slice(0, 5) || 'FILE'
  }
  const shotName = (s) => {
    const direct = String(s && (s.filename || s.fileName) ? (s.filename || s.fileName) : '').trim()
    if (direct) return direct
    return String(s && s.github_path ? s.github_path : '').split('/').pop().replace(/^[0-9a-f-]{36}-/i, '') || 'file'
  }
  // S86: the shared DOC tile — the same .shot-file shape the server's grid
  // renders; an <a download> (the serving route adds the disposition header).
  const fileTileHtml = (s) => {
    const name = shotName(s)
    const dl = t('project.downloadFile', 'Download {f}').replace('{f}', name)
    return '<a class="shot-file" href="/api/media/screenshots/' + encodeURIComponent(s.id) + '/file" download title="' + esc(dl) + '" aria-label="' + esc(dl) + '">' +
      '<span class="shot-file-ext" aria-hidden="true">' + esc(fileExtLabel(name)) + '</span>' +
      '<span class="shot-file-name" dir="auto">' + esc(name) + '</span>' +
      '<span class="shot-file-dl" aria-hidden="true"><svg class="icon" viewBox="0 0 24 24"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"/></svg></span>' +
    '</a>'
  }
  // image-resize.js is NOT linked by board.html/sprint.html (only project/spark/
  // settings pages carry it) — load it ON DEMAND the first time the editor opens
  // (the app.js ensureImageResize recipe). A failed load keeps the raw
  // FileReader path (uploadShotXHR degrades gracefully without the helper).
  let imgResizeLoader = null
  const ensureImageResize = () => {
    if (window.hibanaImageResize) return Promise.resolve(window.hibanaImageResize)
    if (imgResizeLoader) return imgResizeLoader
    imgResizeLoader = new Promise((resolve) => {
      const s = document.createElement('script')
      s.src = '/js/image-resize.js?v=1'
      s.onload = () => resolve(window.hibanaImageResize || null)
      s.onerror = () => resolve(null)
      document.head.appendChild(s)
    })
    return imgResizeLoader
  }
  // S69 prepare phase rides along: images bound to ≤1600px WebP (quality .85)
  // when >1600px or >220KB, + a ≤320px tile as thumbBase64. GIF/SVG/docs take
  // the raw path (a canvas pass would flatten the animation). registerAbort is
  // called per phase (reader → xhr) so each progress row's ✕ aborts whichever
  // is live; an aborted upload rejects with 'aborted' and drops the row
  // NEUTRALLY (nothing failed — the user cancelled).
  const uploadShotXHR = (file, onProgress, registerAbort) =>
    new Promise((resolve, reject) => {
      let prepareAborted = false
      let pendingThumb = null
      const uploadMime = canonicalMime(file)
      if (registerAbort) registerAbort(() => { prepareAborted = true })
      const reader = new FileReader()
      if (registerAbort) registerAbort(() => { try { reader.abort() } catch { /* already done */ } })
      reader.onabort = () => reject(new Error('aborted'))
      reader.onload = () => {
        const b64 = String(reader.result).split(',')[1]
        const xhr = new window.hibanaXHR()
        if (registerAbort) registerAbort(() => { try { xhr.abort() } catch { /* already done */ } })
        xhr.open('POST', '/api/projects/' + state.projectId + '/screenshots')
        xhr.setRequestHeader('Content-Type', 'application/json')
        xhr.upload.onprogress = (ev) => { if (ev.lengthComputable && onProgress) onProgress(ev.loaded / ev.total) }
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) { try { resolve(JSON.parse(xhr.responseText)) } catch { resolve({}) } }
          else reject(new Error('status ' + xhr.status))
        }
        xhr.onerror = () => reject(new Error('network'))
        xhr.onabort = () => reject(new Error('aborted'))
        xhr.send(JSON.stringify({ fileName: file.name, mimeType: uploadMime, dataBase64: b64, caption: '', ...(pendingThumb ? { thumbBase64: pendingThumb } : {}) }))
      }
      reader.onerror = () => reject(new Error('read-failed'))
      const R = window.hibanaImageResize
      if (!R || !isImageMime(uploadMime) || file.type === 'image/gif' || file.type === 'image/svg+xml') { reader.readAsDataURL(file); return }
      ;(async () => {
        try {
          const img = await R.decodeImage(file)
          const maxSide = Math.max(img.width, img.height)
          const tooBig = maxSide > 1600 || file.size > 220 * 1024
          const main = tooBig ? await R.resizeAndEncode(file, { maxDim: 1600, quality: 0.85 }) : null
          let thumb = null
          try {
            const th = await R.resizeAndEncode(file, { maxDim: 320, quality: 0.8 })
            if (th.mimeType === 'image/webp' && th.dataBase64.length <= 120_000) thumb = th.dataBase64
          } catch { /* tile is optional */ }
          if (prepareAborted) return reject(new Error('aborted'))
          if (!main) { pendingThumb = thumb; reader.readAsDataURL(file); return } // small file — raw bytes + tile
          if (prepareAborted) return reject(new Error('aborted'))
          const xhr = new window.hibanaXHR()
          if (registerAbort) registerAbort(() => { try { xhr.abort() } catch { /* already done */ } })
          xhr.open('POST', '/api/projects/' + state.projectId + '/screenshots')
          xhr.setRequestHeader('Content-Type', 'application/json')
          xhr.upload.onprogress = (ev) => { if (ev.lengthComputable && onProgress) onProgress(ev.loaded / ev.total) }
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) { try { resolve(JSON.parse(xhr.responseText)) } catch { resolve({}) } }
            else reject(new Error('status ' + xhr.status))
          }
          xhr.onerror = () => reject(new Error('network'))
          xhr.onabort = () => reject(new Error('aborted'))
          xhr.send(JSON.stringify({ fileName: file.name, mimeType: main.mimeType, dataBase64: main.dataBase64, caption: '', ...(thumb ? { thumbBase64: thumb } : {}) }))
        } catch {
          if (prepareAborted) return reject(new Error('aborted'))
          reader.readAsDataURL(file) // canvas failed — the raw path still works
        }
      })()
    })
  // The strip: per-file rows (name + size + bar + % + ✕) mounted above the grid;
  // rows go reading → active → done/error/canceled; done rows fade+remove, error
  // rows linger 6s, canceled rows drop immediately (neutral). aria-live=polite so
  // SR users hear completion without per-file toast spam.
  const makeUploadStrip = (mount, insertBefore) => {
    if (!mount) return { addRow: () => ({ setProgress() {}, done() {}, failed() {}, cancel() {} }) }
    let strip = mount.querySelector(':scope > .shots-upload-strip')
    const ensure = () => {
      if (strip) return strip
      strip = document.createElement('div')
      strip.className = 'shots-upload-strip'
      strip.setAttribute('role', 'status')
      strip.setAttribute('aria-live', 'polite')
      strip.setAttribute('aria-label', t('project.uploading', 'Uploading…'))
      mount.insertBefore(strip, insertBefore || null)
      return strip
    }
    return {
      addRow(fileName, fileSize) {
        ensure()
        const row = document.createElement('div')
        row.className = 'shots-upload-row'
        row.dataset.state = 'reading'
        row.innerHTML =
          '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="8" cy="10" r="1.5"/><path d="M21 16l-5-5L5 19"/></svg>' +
          '<span class="shots-upload-name"></span>' +
          (fileSize != null ? '<span class="shots-upload-size"></span>' : '') +
          '<div class="shots-upload-bar" aria-hidden="true"><div class="shots-upload-fill"></div></div>' +
          '<span class="shots-upload-pct"></span>' +
          '<button type="button" class="ghost icon-btn shots-upload-cancel" aria-label="' + t('project.cancelUpload', 'Cancel upload') + '" title="' + t('project.cancelUpload', 'Cancel upload') + '"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>'
        row.querySelector('.shots-upload-name').textContent = fileName // textContent — never innerHTML for names
        const sizeEl = row.querySelector('.shots-upload-size')
        if (sizeEl && fileSize != null) sizeEl.textContent = fmtBytes(fileSize)
        strip.appendChild(row)
        const fill = row.querySelector('.shots-upload-fill')
        const pctEl = row.querySelector('.shots-upload-pct')
        const cancelBtn = row.querySelector('.shots-upload-cancel')
        let abortFn = null
        const drop = () => {
          row.remove()
          if (strip && !strip.querySelector('.shots-upload-row')) { strip.remove(); strip = null }
        }
        cancelBtn.addEventListener('click', () => {
          if (row.dataset.state === 'done' || row.dataset.state === 'error' || row.dataset.state === 'canceled') return
          if (abortFn) abortFn()
          row.dataset.state = 'canceled'
          setTimeout(drop, 260)
        })
        return {
          onAbortable(fn) { abortFn = fn },
          setProgress(frac) {
            if (row.dataset.state === 'done' || row.dataset.state === 'error' || row.dataset.state === 'canceled') return
            row.dataset.state = 'active'
            const pct = Math.max(0, Math.min(100, Math.round((frac || 0) * 100)))
            fill.style.inlineSize = pct + '%'
            pctEl.textContent = pct > 0 ? faDig(pct + '%') : ''
          },
          done() {
            if (row.dataset.state === 'canceled') return
            row.dataset.state = 'done'
            fill.style.inlineSize = '100%'
            pctEl.textContent = '✓'
            setTimeout(drop, 650)
          },
          failed() {
            if (row.dataset.state === 'canceled') return
            row.dataset.state = 'error'
            pctEl.textContent = '✕'
            setTimeout(drop, 6000)
          },
        }
      },
    }
  }
  // { ok: true, shot } landed · { ok: false, canceled: true } user-cancelled
  // (neutral drop, no toast) · { ok: false } failed (red row) — callers aggregate.
  const uploadOne = async (file, strip) => {
    const row = strip.addRow(file.name, file.size)
    try {
      const shot = await uploadShotXHR(file, (f) => row.setProgress(f), (fn) => row.onAbortable(fn))
      row.done()
      return { ok: true, shot }
    } catch (err) {
      if (err && err.message === 'aborted') return { ok: false, canceled: true }
      row.failed()
      return { ok: false }
    }
  }
  const patchShot = (id, body) => api('/api/screenshots/' + id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const deleteShot = (id) => api('/api/screenshots/' + id, { method: 'DELETE' })
  const listShots = async () => {
    const r = await api('/api/projects/' + state.projectId + '/screenshots')
    return (r && r.screenshots) || []
  }
  // S60/S118: the lightbox BROWSER — prev/next walk the sibling figures of the
  // SAME grid (wrap-around, live counter + caption, reading-direction arrows,
  // recordings join via their <video> src), Esc closes AND focus returns to the
  // trigger. S83: a zoom from inside an OPEN native <dialog> (the note dialog,
  // the pinned-pictures dialog) mounts the lightbox INTO that dialog's top
  // layer; from the db-modal (a plain z-90 div) a body-append paints above it
  // (.shot-lightbox is z-200). Esc precedence: this key handler is registered at
  // module load — BEFORE buildModal()'s editor-close listener — and
  // stopImmediatePropagation shields the modal from the same keystroke (the
  // modal's own !shotLightbox guard is the belt).
  let shotLightbox = null // { el, idx, items, lastTrigger, host, onCancel }
  const closeShotLightbox = () => {
    if (!shotLightbox) return
    const tr = shotLightbox.lastTrigger
    const vid = shotLightbox.el.querySelector('video.lb-video')
    if (vid) { try { vid.pause() } catch {} }
    if (shotLightbox.host && shotLightbox.onCancel) shotLightbox.host.removeEventListener('cancel', shotLightbox.onCancel)
    shotLightbox.el.remove()
    shotLightbox = null
    document.body.style.overflow = ''
    try { tr?.focus?.() } catch {} // keyboard users never land in the void
  }
  const lbShotStep = (delta) => {
    if (!shotLightbox || !shotLightbox.items.length) return
    const it = shotLightbox.items
    shotLightbox.idx = (shotLightbox.idx + delta + it.length) % it.length
    const r = it[shotLightbox.idx]
    const img = shotLightbox.el.querySelector('img')
    const vid = shotLightbox.el.querySelector('video.lb-video')
    if (vid && !vid.hidden && !r.video) { try { vid.pause() } catch {} }
    if (img) { img.hidden = !!r.video; if (!r.video) { img.src = r.src; img.alt = r.caption || t('project.shotZoom', 'Screenshot') } }
    if (vid) {
      vid.hidden = !r.video
      if (r.video && vid.getAttribute('src') !== r.src) vid.setAttribute('src', r.src)
    }
    const count = shotLightbox.el.querySelector('.lb-count')
    if (count) count.textContent = faDig(shotLightbox.idx + 1) + ' / ' + faDig(it.length)
    const cap = shotLightbox.el.querySelector('.lb-cap')
    if (cap) cap.textContent = r.caption || ''
    const st = shotLightbox.el.querySelector('.lb-state')
    if (st) {
      st.textContent = r.resolved ? '✓ ' + t('project.shotFixedLabel', 'fixed') : t('project.shotOpenLabel', 'open problem')
      st.classList.toggle('is-fixed', !!r.resolved)
    }
  }
  const openShotLightbox = (src, trigger, scopeGrid, video) => {
    closeShotLightbox()
    const figs = scopeGrid ? [...scopeGrid.querySelectorAll(':scope > .shot-card')] : []
    const items = figs.map((f) => {
      const vid = f.querySelector('video.shot-video')
      if (vid) return { src: vid.getAttribute('src') || '', caption: (f.querySelector('.shot-note')?.textContent || '').trim(), resolved: f.dataset.resolved === '1' || f.classList.contains('is-fixed'), video: true }
      return { src: f.querySelector('.shot-img-btn img')?.getAttribute('src') || '', caption: (f.querySelector('.shot-note')?.textContent || '').trim(), resolved: f.dataset.resolved === '1' || f.classList.contains('is-fixed'), video: false }
    }).filter((x) => x.src)
    let idx = items.findIndex((x) => x.src === src)
    if (idx < 0) { items.push({ src, caption: '', resolved: false, video: !!video }); idx = items.length - 1 }
    const el = document.createElement('div')
    el.className = 'shot-lightbox'
    el.setAttribute('role', 'dialog')
    el.setAttribute('aria-modal', 'true')
    el.setAttribute('data-lb', '')
    el.setAttribute('aria-label', t('project.shotZoom', 'Screenshot'))
    el.innerHTML =
      '<button type="button" class="lb-nav lb-prev" aria-label="' + t('gallery.lbPrev', 'Previous picture') + '"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button>' +
      '<img src="' + esc(src) + '" alt="' + t('project.shotZoom', 'Screenshot') + '"' + (video ? ' hidden' : '') + '>' +
      '<video class="shot-video lb-video" controls playsinline preload="metadata"' + (video ? ' src="' + esc(src) + '"' : ' hidden') + '></video>' +
      '<button type="button" class="lb-nav lb-next" aria-label="' + t('gallery.lbNext', 'Next picture') + '"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></button>' +
      '<button type="button" class="lb-close" aria-label="' + t('gallery.lbClose', 'Close') + '"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' +
      '<div class="lb-meta"><span class="lb-count" aria-live="polite"></span><span class="lb-state" dir="auto"></span><span class="lb-cap" dir="auto"></span></div>'
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('.lb-nav')) { lbShotStep(ev.target.closest('.lb-prev') ? -1 : 1); return }
      if (ev.target.closest('.lb-close')) { closeShotLightbox(); return }
      if (!ev.target.closest('img, video')) closeShotLightbox()
    })
    const host = trigger instanceof Element ? trigger.closest('dialog[open]') : null
    ;(host || document.body).appendChild(el)
    if (!host) document.body.style.overflow = 'hidden'
    let onCancel = null
    if (host) {
      onCancel = (ev) => { if (shotLightbox) { ev.preventDefault(); closeShotLightbox() } }
      host.addEventListener('cancel', onCancel)
    }
    shotLightbox = { el, idx, items, lastTrigger: trigger, host, onCancel }
    lbShotStep(0)
    el.querySelector('.lb-close')?.focus()
  }
  document.addEventListener('keydown', (e) => {
    if (!shotLightbox) return
    if (e.key === 'Escape') {
      try { e.preventDefault() } catch {}
      try { e.stopImmediatePropagation() } catch {} // the modal under it must NOT close on this keystroke
      closeShotLightbox()
      return
    }
    const rtl = document.documentElement.dir === 'rtl'
    if (e.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) lbShotStep(1)
    else if (e.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) lbShotStep(-1)
  })
  // S118/S119: a recording tile zooms on DOUBLE-click / Enter (single click and
  // Space stay the video's native controls); the tile player pauses when the big
  // one opens. S209 (kanban 1:1 parity): devboard.js now ALSO loads on
  // project.html (the label manager) — that page owns its OWN twin handlers for
  // the same tiles (project-page.js's S118/S119 pair), so these document-level
  // handlers must fire ONLY inside THIS module's own surfaces (the editor modal's
  // grids + the pinned-pictures dialog). Otherwise one dblclick would open TWO
  // stacked lightboxes — the module that owns the DOM owns its events.
  const inBoardSurface = (el) => !!(el && el.closest && el.closest('.db-modal, #db-taskshots, #db-shotnote, #db-labels-root'))
  document.addEventListener('dblclick', (e) => {
    const vid = e.target instanceof Element ? e.target.closest('video.shot-video') : null
    if (!vid) return
    if (!inBoardSurface(vid)) return
    const fig = vid.closest('.shot-card')
    if (!fig) return
    e.preventDefault()
    try { vid.pause() } catch {}
    openShotLightbox(vid.getAttribute('src') || '', vid, fig.parentElement, true)
  })
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    const vid = e.target instanceof Element && e.target.matches('video.shot-video') ? e.target : null
    if (!vid) return
    if (!inBoardSurface(vid)) return
    const fig = vid.closest('.shot-card')
    if (!fig) return
    e.preventDefault()
    try { vid.pause() } catch {}
    openShotLightbox(vid.getAttribute('src') || '', vid, fig.parentElement, true)
  })
  // The shared tile: image → zoom button, video → inline player, doc → download
  // tile; caption note + Add/Edit-note + ✕ delete. mode 'staged' (new task) vs
  // 'task' (pinned) only swaps the data-* hooks so one delegated handler serves
  // both grids.
  const SHOT_RETRY_ATTR = ' onerror="(function(i){var n=+(i.dataset.r||0)+1;if(n<4){i.dataset.r=n;var s=i.src;i.onerror=null;setTimeout(function(){i.src=s},800*n)}})(this)"'
  const shotFigureHtml = (s, mode) => {
    const mime = String(s.mime_type || s.mime || '')
    const isVideo = mime.startsWith('video/')
    const caption = String(s.caption || '')
    const zoomAttr = mode === 'staged' ? 'data-db-staged-zoom' : 'data-db-shot-zoom'
    const noteAttr = mode === 'staged' ? 'data-db-staged-note' : 'data-db-shot-note'
    const delAttr = mode === 'staged' ? 'data-db-staged-del' : 'data-db-shot-del'
    return '<figure class="shot-card' + (isVideo ? ' is-video' : !isImageMime(mime) ? ' is-file' : '') + '" data-shot-id="' + esc(s.id) + '">' +
      (isImageMime(mime)
        ? '<button type="button" class="shot-img-btn" ' + zoomAttr + '="' + esc(s.id) + '"><img src="/api/media/screenshots/' + esc(s.id) + '/file" alt="" loading="lazy"' + SHOT_RETRY_ATTR + '></button>'
        : isVideo
          ? '<video class="shot-video" src="/api/media/screenshots/' + esc(s.id) + '/file" controls preload="metadata" playsinline tabindex="0" aria-label="' + esc(t('project.videoTileAria', 'Recording — press Enter to view full screen')) + '"></video>'
          : fileTileHtml(s)) +
      '<figcaption class="shot-body">' +
        (caption ? '<p class="shot-note muted small" dir="auto">' + esc(caption) + '</p>' : '') +
        '<div class="row spread shot-actions">' +
          '<button type="button" class="ghost small" ' + noteAttr + '="' + esc(s.id) + '" title="' + (caption ? t('notes.editNote', 'Edit note') : t('notes.addNote', 'Add note')) + '">' + (caption ? t('notes.editNote', 'Edit note') : t('notes.addNote', 'Add note')) + '</button>' +
          '<button type="button" class="ghost small danger" ' + delAttr + '="' + esc(s.id) + '" title="' + t('common.delete', 'Delete') + '" aria-label="' + t('common.delete', 'Delete') + '">✕</button>' +
        '</div>' +
      '</figcaption>' +
    '</figure>'
  }
  // The note editor — a small native <dialog> (the board's delete-confirm
  // recipe): caption ≤1000 chars, PATCH {caption}, onSaved(text) refreshes the
  // owning grid.
  const shotNoteDialog = (shotId, current, onSaved) => {
    const old = document.getElementById('db-shotnote')
    if (old) old.remove()
    const dlg = document.createElement('dialog')
    dlg.id = 'db-shotnote'
    dlg.className = 'dialog'
    dlg.innerHTML =
      '<form class="modal" method="dialog">' +
        // S233 (every modal carries a close on its top right): the note editor's
        // title row joins the task editor / labels / pinned-pictures grammar —
        // h3 on the inline start, the ✕ on the inline end (the Cancel twin).
        '<div class="row spread"><h3>' + esc(t('project.shotNoteTitle', 'Note — what & where to work')) + '</h3>' +
        '<button type="button" class="ghost" data-note-x aria-label="' + esc(t('common.close', 'Close')) + '">✕</button></div>' +
        '<textarea class="pd-shot-note-ta" rows="6" maxlength="1000" dir="auto" placeholder="' + esc(t('project.shotNotePh', 'What is broken & where — the exact spot to work on…')) + '"></textarea>' +
        '<div class="row" style="justify-content:flex-end;gap:.5rem;margin-top:1rem">' +
          '<button type="button" class="ghost" data-note-cancel>' + esc(t('common.cancel', 'Cancel')) + '</button>' +
          '<button type="button" data-note-save>' + esc(t('common.save', 'Save')) + '</button>' +
        '</div>' +
      '</form>'
    document.body.appendChild(dlg)
    const ta = dlg.querySelector('textarea')
    ta.value = current || ''
    dlg.querySelector('[data-note-cancel]').onclick = () => dlg.close()
    dlg.querySelector('[data-note-x]').onclick = () => dlg.close()
    dlg.querySelector('[data-note-save]').onclick = async () => {
      try {
        await patchShot(shotId, { caption: ta.value.trim() })
        dlg.close()
        if (onSaved) onSaved(ta.value.trim())
      } catch { window.hibana && window.hibana.toast(t('sparks.saveFailed', "Couldn't save"), 'err') }
    }
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close() })
    dlg.showModal()
    setTimeout(() => ta.focus(), 0)
  }
  // Staged shots for the NEW-task editor: uploaded immediately (POST, no
  // task_id), pinned on save, deleted on cancel.
  let modalStaged = []
  // The CURRENT editor's pinned list (cache for the note/delete handlers).
  let modalPinnedShots = []
  function renderStagedGrid() {
    if (!modalEl || !modalCtx || modalCtx.taskId) return
    const grid = modalEl.querySelector('[data-db-shots-grid]')
    if (!grid) return
    grid.innerHTML = modalStaged.map((s) => shotFigureHtml(s, 'staged')).join('')
    const cnt = modalEl.querySelector('[data-db-shots-count]')
    if (cnt) cnt.textContent = modalStaged.length ? t('project.shotsAttached', '{n} attached').replace('{n}', String(modalStaged.length)) : ''
  }
  async function renderPinnedGrid() {
    if (!modalEl || !modalCtx || !modalCtx.taskId) return
    const grid = modalEl.querySelector('[data-db-shots-grid]')
    if (!grid) return
    try {
      const all = await listShots()
      if (!modalCtx) return // closed meanwhile
      modalPinnedShots = all.filter((s) => s.task_id === modalCtx.taskId)
    } catch { return }
    if (!modalCtx || !modalEl || modalEl.hidden) return
    const g2 = modalEl.querySelector('[data-db-shots-grid]')
    if (g2) g2.innerHTML = modalPinnedShots.map((s) => shotFigureHtml(s, 'task')).join('')
  }
  // S46.4/S208: the PINNED-PICTURES dialog (the project page's taskShotsDialog)
  // — a native <dialog> grid of the task's pinned shots with zoom (the lightbox
  // mounts into this dialog's top layer) + unpin; onChanged lets the board
  // reload so the card's badge count stays true.
  async function openTaskShots(taskId, opts) {
    let shots = []
    try { shots = await listShots() } catch { /* offline — the empty dialog explains itself */ }
    const pinned = shots.filter((s) => s.task_id === taskId)
    const old = document.getElementById('db-taskshots')
    if (old) old.remove()
    const dlg = document.createElement('dialog')
    dlg.id = 'db-taskshots'
    dlg.className = 'dialog'
    const emptyText = '<p class="muted">' + esc(t('project.shotsNone', 'No pictures pinned to this item yet.')) + '</p>'
    const gridHtml = '<div class="pd-tshots-grid">' + pinned.map((s) => {
      const mime = String(s.mime_type || '')
      const isVideo = mime.startsWith('video/')
      return '<figure class="shot shot-card' + (s.resolved ? ' is-fixed' : '') + (isVideo ? ' is-video' : !isImageMime(mime) ? ' is-file' : '') + '" data-shot="' + esc(s.id) + '">' +
        (isImageMime(mime)
          ? '<button type="button" class="shot-img-btn" data-tshots-zoom="' + esc(s.id) + '"><img src="/api/media/screenshots/' + esc(s.id) + '/file" alt="" loading="lazy"' + SHOT_RETRY_ATTR + '></button>'
          : isVideo
            ? '<video class="shot-video" src="/api/media/screenshots/' + esc(s.id) + '/file" controls preload="metadata" playsinline tabindex="0" aria-label="' + esc(t('project.videoTileAria', 'Recording — press Enter to view full screen')) + '"></video>'
            : fileTileHtml(s)) +
        '<figcaption class="shot-body"><p class="shot-note muted small" dir="auto">' + (s.caption ? esc(s.caption) : '') + '</p>' +
        '<div class="row spread shot-actions"><span class="shot-state' + (s.resolved ? ' is-fixed' : '') + '">' + (s.resolved ? '✓ ' + t('project.shotFixedLabel', 'fixed') : t('project.shotOpenLabel', 'open problem')) + '</span>' +
        '<button type="button" class="ghost small danger" data-tshots-unpin="' + esc(s.id) + '" title="' + t('project.shotUnpin', 'Unpin') + '">✕</button></div></figcaption></figure>'
    }).join('') + '</div>'
    dlg.innerHTML =
      '<form class="modal" method="dialog">' +
        '<div class="row spread"><h3>' + esc(t('project.taskShotsTitle', 'Pinned pictures')) + '</h3>' +
        '<button type="button" class="ghost" data-tshots-close aria-label="' + esc(t('common.close', 'Close')) + '">✕</button></div>' +
        '<div class="db-modal-body" style="max-block-size:60vh">' + (pinned.length ? gridHtml : emptyText) + '</div>' +
      '</form>'
    document.body.appendChild(dlg)
    dlg.querySelector('[data-tshots-close]').onclick = () => dlg.close()
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close() })
    dlg.addEventListener('click', async (ev) => {
      const zoomBtn = ev.target.closest('[data-tshots-zoom]')
      if (zoomBtn) {
        ev.stopPropagation()
        const img = zoomBtn.querySelector('img')
        if (img) openShotLightbox(img.getAttribute('src'), zoomBtn, zoomBtn.closest('.shot-card')?.parentElement)
        return
      }
      const un = ev.target.closest('[data-tshots-unpin]')
      if (!un) return
      try {
        await patchShot(un.getAttribute('data-tshots-unpin'), { taskId: null })
        window.hibana && window.hibana.toast(t('project.shotUnpinned', 'Unpinned'), 'ok')
        dlg.close()
        if (opts && opts.onChanged) opts.onChanged()
      } catch { window.hibana && window.hibana.toast(t('sparks.saveFailed', "Couldn't save"), 'err') }
    })
    dlg.showModal()
  }

  // ---------------------------------------------------------------- editor modal
  let modalEl = null
  let modalCtx = null // { taskId | null, draft, onSaved }
  let modalDueCtl = null // S244: the mounted shared date control (a fresh instance per renderModal)
  let modalTrap = null // S258 (FE-6): the shared focus-trap's release fn while the editor is open

  function buildModal() {
    if (modalEl) return modalEl
    modalEl = document.createElement('div')
    modalEl.className = 'db-modal'
    modalEl.setAttribute('role', 'dialog')
    modalEl.setAttribute('aria-modal', 'true')
    modalEl.hidden = true
    document.body.appendChild(modalEl)
    modalEl.addEventListener('click', (e) => {
      if (e.target === modalEl) exitFullscreenOrClose()
    })
    document.addEventListener('keydown', (e) => {
      // S208: an open lightbox eats Esc FIRST (its own document listener is older
      // by registration order and stopImmediatePropagation-shields this one) — this
      // guard is the belt: the lightbox must never close the editor under it.
      // S209 (kanban 1:1 parity): fullscreen writing exits FIRST (the project
      // editor's exitOrClose contract — Esc never discards the writing focus mode
      // AND the modal in one keypress).
      if (e.key === 'Escape' && !modalEl.hidden && !shotLightbox) exitFullscreenOrClose()
    })
    return modalEl
  }

  // hibana-sync-status-spec §10: the editor footer's detail badge (icon + label +
  // "Synced N minutes ago"). Built from the ONE tracker state so the footer shows
  // Pending → Syncing → Synced live while the save runs (sync-state.js repaints
  // every [data-sync-badge-detail] node on change).
  const modalSyncBadge = (taskId) => {
    const chips = window.HibanaChips
    if (!taskId || !chips || !chips.syncBadgeDetailHtml) return ''
    const ss = window.HibanaSyncState
    return chips.syncBadgeDetailHtml(taskId, ss ? ss.stateOf(taskId) : 'synced', false, ss ? ss.syncedAt(taskId) : null)
  }

  function openEditor(taskId, opts) {
    modalCtx = { taskId: taskId || null, onSaved: (opts && opts.onSaved) || null, defaults: (opts && opts.defaults) || {}, restoreEl: (opts && opts.restoreEl instanceof Element) ? opts.restoreEl : null }
    const task = taskId ? findTask(taskId) : null
    // S152: stash the task's CURRENT category row (resolves for enabled AND
    // referenced-later-disabled rows; an archived one falls back to the raw id so
    // an edit round-trips instead of silently clearing the value).
    modalCtx.editCat = task && task.category_id ? (findCategory(task.category_id) || { id: task.category_id, name: null }) : null
    modalCtx.draft = task
      ? { title: task.title, status: task.status, priority: task.priority, category_id: task.category_id, sprint_id: task.sprint_id, tags: (task.tags || []).slice() }
      : { title: '', status: modalCtx.defaults.status || 'idea', priority: 'medium', category_id: null, sprint_id: null, tags: [] }
    // S244 (spec §9.1 — the task deadline toggle): OFF by default in Add; in Edit
    // the toggle reflects the task's PERSONAL deadline only (due_at is the raw
    // personal field on the payload row — the computed effective_* triple is
    // never a toggle source). The inherited sprint deadline keeps the toggle OFF
    // and renders the read-only line below it (§10.1).
    modalCtx.draft.dueOn = !!(task && task.due_at)
    modalCtx.draft.dueAt = task && task.due_at ? task.due_at : null
    // S246 (spec pack Phase 7 — Screen K): the Dependencies section's state —
    // COLLAPSED on every open (spec §15's collapsed-by-default; the open state
    // never persists across opens). Edit mode's current blockers read the edge
    // pool live at render (depsOf); Add mode stages its picks here.
    modalCtx.draft.depsOpen = false
    if (!task) modalCtx.draft.depStaged = []
    // S208: NEW tasks carry a STAGED tag list (the create body's tags[] — the
    // server find-or-creates them; the project composer's contract) and a fresh
    // staged-shots strip. Existing tasks keep their live tag add/remove.
    if (!task) modalCtx.draft.newTags = []
    modalStaged = []
    modalPinnedShots = []
    ensureImageResize() // warm the resize helper before a file gets picked
    renderModal()
    buildModal().hidden = false
    // S258 (FE-6): the shared trap — Tab wraps inside the editor card; the
    // release (closeModal) restores focus to the opener. Pages pass the VISIBLE
    // trigger (the ⋯ button — the pop's rows hide with the menu, which would
    // strand the restore on <body>); without one the trap captures
    // document.activeElement at open (the quick-add rows' own opener). A
    // defensive hand-off first: every open path closes before re-opening, but a
    // stray double-open must not double-bind.
    if (modalTrap) { modalTrap(); modalTrap = null }
    if (window.hibana && window.hibana.focusTrap) modalTrap = window.hibana.focusTrap(modalEl, modalCtx.restoreEl ? { restoreTo: modalCtx.restoreEl } : undefined)
    if (modalCtx.taskId) renderPinnedGrid() // S208: the task's pinned shots load under the button
    const focus = modalEl.querySelector('[name=title]')
    if (focus) { focus.focus(); focus.select() }
  }

  // S209 (kanban 1:1 parity — the owner: "the kanban in the hibana is 1:1 the same
  // as the kanban at projects.hibana.ir/kanban"): the FULLSCREEN WRITING toggle
  // joins the shared modal (the project editor's S46.7 contract — a focus mode that
  // grows the writing area to the viewport and hides the metadata rows). Esc, ✕,
  // Cancel and the backdrop EXIT FULLSCREEN FIRST, never the modal itself — the
  // user never loses the task definition by pressing one key too many.
  function modalCard() { return modalEl ? modalEl.querySelector('.db-modal-card') : null }
  function exitFullscreenOrClose() {
    const card = modalCard()
    if (card && card.classList.contains('db-fullscreen')) { card.classList.remove('db-fullscreen'); return }
    closeModal(false)
  }

  async function closeModal(saved) {
    if (modalEl) {
      modalEl.hidden = true
      const card = modalCard()
      if (card) card.classList.remove('db-fullscreen') // a re-open never starts in focus mode
    }
    // S258 (FE-6): unbind the wrap + restore focus to the opener (before the
    // onSaved repaint re-renders the lane — the opener may be replaced by then,
    // the trap's document.contains guard degrades gracefully exactly like the
    // sheet's manual restore did).
    if (modalTrap) { modalTrap(); modalTrap = null }
    const ctx = modalCtx
    modalCtx = null
    const cb = ctx && ctx.onSaved
    if (saved && cb) cb()
    // S208: a cancelled NEW-task editor deletes its STAGED shots (the composer's
    // contract — nothing orphans in the project's gallery). Saved editors pinned
    // theirs already (the save flow clears modalStaged after pinning); existing-
    // task uploads pinned live, they stay. The list is grabbed + cleared
    // synchronously so a fast re-open can't double-delete.
    if (!saved && ctx && !ctx.taskId && modalStaged.length) {
      const staged = [...modalStaged]
      modalStaged = []
      for (const s of staged) {
        try { await api('/api/screenshots/' + s.id, { method: 'DELETE' }) } catch { /* leave it — the gallery can clean later */ }
      }
    }
  }

  function renderModal() {
    const el = buildModal()
    const d = modalCtx.draft
    const isNew = !modalCtx.taskId
    const cats = state.categories
    const lang = window.hibanaI18n && window.hibanaI18n.lang ? window.hibanaI18n.lang() : 'en'
    el.innerHTML =
      '<div class="db-modal-card" dir="' + (lang === 'fa' ? 'rtl' : 'auto') + '">' +
        '<div class="row spread db-modal-head"><h3>' + (isNew ? esc(t('db.newTask', 'New task')) : esc(t('db.editTask', 'Edit task'))) + '</h3>' +
        '<div class="row" style="gap:.25rem">' +
          // S209 (kanban 1:1 parity): the fullscreen writing toggle — the SAME
          // affordance the project page's task editor carries (S46.7, owner: "add a
          // button for full screen writing to optimize focus"). Toggling grows the
          // title textarea to the viewport and hides the metadata rows (CSS
          // .db-fullscreen in devboard.css); Esc/✕/Cancel exit focus mode FIRST.
          '<button type="button" class="ghost" data-db-fullscreen aria-label="' + esc(t('pde.fullscreen', 'Full-screen writing')) + '" title="' + esc(t('pde.fullscreen', 'Full-screen writing')) + '"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6M4 4v6M14 4h6M20 4v6M4 20v-6M4 20h6M20 20h-6M20 20v-6"/></svg></button>' +
          '<button type="button" class="ghost" data-db-close aria-label="' + esc(t('common.close', 'Close')) + '">✕</button></div></div>' +
        // S89 (owner item: the task modal's scroll fix): ONE scroll region between
        // the sticky header and the sticky footer — fields live in .db-modal-body
        // (overflow-y auto); the header (title/✕) + footer (Delete/Cancel/Save)
        // never scroll away on long content. The card is an overflow:hidden flex
        // column capped at 90vh (was a whole-card overflow-y auto).
        '<div class="db-modal-body">' +
        // S209 (kanban 1:1 parity): the formatting toolbar carries the ORIGINAL
        // hibana task editor's FULL set (the project page's .pd-tb — bold /
        // underline / strikethrough | bullet list / ordered list | align ×4 | code)
        // so both editors produce the exact same markdown-lite vocabulary the
        // renderer understands (**bold**, __underline__, ~~strike~~, - bullets,
        // 1. ordered, {:left|center|right|justify}, ``` fences). Same buttons,
        // same icons, same separators as project.html's composer — the ops below
        // write the RAW markdown directly into the single title textarea (the
        // board's Session-22/23 single-field contract; the renderer is shared).
        '<div class="pd-tb" role="toolbar" aria-label="' + esc(t('pd.fmtToolbar', 'Formatting')) + '">' +
          '<button type="button" class="pd-tb-btn" data-tb="bold" title="' + esc(t('pd.fmtBold', 'Bold')) + '"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h6a3.5 3.5 0 1 1 0 7H7zM7 12h7a3.5 3.5 0 1 1 0 7H7z"/></svg></button>' +
          '<button type="button" class="pd-tb-btn" data-tb="underline" title="' + esc(t('pd.fmtUnderline', 'Underline')) + '"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v5a5 5 0 0 0 10 0V4"/><path d="M5 19h14"/></svg></button>' +
          '<button type="button" class="pd-tb-btn" data-tb="strikethrough" title="' + esc(t('pd.fmtStrike', 'Strikethrough')) + '"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/><path d="M16 8a4 4 0 0 0-4-2c-2 0-3.5 1-3.5 2.5M8 16a4 4 0 0 0 4 2c2 0 3.5-1 3.5-2.5"/></svg></button>' +
          '<span class="pd-tb-sep" aria-hidden="true"></span>' +
          '<button type="button" class="pd-tb-btn" data-tb="list" title="' + esc(t('pd.fmtList', 'Bullet list')) + '"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4.5" cy="6" r="1.3" fill="currentColor"/><circle cx="4.5" cy="12" r="1.3" fill="currentColor"/><circle cx="4.5" cy="18" r="1.3" fill="currentColor"/></svg></button>' +
          '<button type="button" class="pd-tb-btn" data-tb="ordered-list" title="' + esc(t('pd.fmtOrderedList', 'Numbered list')) + '"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h12M9 12h12M9 18h12"/><path d="M3 5h.01M4 4.5v4M3.5 16h1a1 1 0 0 0 0-2h-.5a1 1 0 0 1 0-2H5" stroke-width="1.5" stroke-linecap="round"/></svg></button>' +
          '<span class="pd-tb-sep" aria-hidden="true"></span>' +
          '<button type="button" class="pd-tb-btn" data-tb="align-left" title="' + esc(t('pd.fmtAlignLeft', 'Align left')) + '"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 10h10M4 14h16M4 18h10"/></svg></button>' +
          '<button type="button" class="pd-tb-btn" data-tb="align-center" title="' + esc(t('pd.fmtAlignCenter', 'Align center')) + '"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M6 10h12M6 14h12M4 18h16"/></svg></button>' +
          '<button type="button" class="pd-tb-btn" data-tb="align-right" title="' + esc(t('pd.fmtAlignRight', 'Align right')) + '"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M10 10h10M4 14h16M10 18h10"/></svg></button>' +
          '<button type="button" class="pd-tb-btn" data-tb="align-justify" title="' + esc(t('pd.fmtAlignJustify', 'Justify')) + '"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 10h16M4 14h16M4 18h16"/></svg></button>' +
          '<span class="pd-tb-sep" aria-hidden="true"></span>' +
          '<button type="button" class="pd-tb-btn" data-tb="code" title="' + esc(t('pd.fmtCode', 'Code block')) + '"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 6-6 6 6 6M16 6l6 6-6 6"/></svg></button>' +
        '</div>' +
        '<label class="db-field"><span>' + esc(t('db.title', 'Title')) + '</span>' +
          // Session 22 (user request): TEXTAREA (was a single-line input with
          // maxlength=300) — unlimited, multi-line, 9rem min + resizable (app.css),
          // matching the project-page composer. Enter saves, Shift+Enter breaks the
          // line. Session 23 (user request): (a) dir follows the UI locale — fa → rtl
          // (dir="auto" let a Latin first char keep the editor LTR while writing
          // Farsi; rendered code blocks stay LTR islands via .t-code), (b) newlines are
          // PRESERVED on save (titles render multi-line with fenced code blocks).
          '<textarea name="title" rows="6" dir="' + (lang === 'fa' ? 'rtl' : 'auto') + '" placeholder="' + esc(t('db.titlePh', 'What needs to be built?')) + '">' + esc(d.title) + '</textarea></label>' +
        '<div class="db-field"><span>' + esc(t('db.status', 'Status')) + '</span>' +
          '<div class="db-seg" data-seg="status">' + STATUSES.map((s) =>
            '<button type="button" data-val="' + s + '" class="' + (d.status === s ? 'is-on' : '') + '">' + esc(statusLabel(s)) + '</button>').join('') + '</div></div>' +
        '<div class="db-field"><span>' + esc(t('db.priority', 'Priority')) + '</span>' +
          '<div class="db-seg" data-seg="priority">' + PRIORITIES.map((p) =>
            '<button type="button" data-val="' + p + '" class="prio-' + p + ' ' + (d.priority === p ? 'is-on' : '') + '">' + esc(prioLabel(p)) + '</button>').join('') + '</div></div>' +
        '<div class="db-two">' +
          '<label class="db-field"><span>' + esc(t('db.category', 'Category')) + '</span>' +
            '<select data-db-cat><option value="">' + esc(t('db.uncategorized', 'Uncategorized')) + '</option>' +
              cats.map((c) => '<option value="' + esc(c.id) + '" ' + (d.category_id === c.id ? 'selected' : '') + '>' + esc(c.name) + '</option>').join('') +
              // S152: a task carrying a DISABLED-later category keeps its option so an
              // edit round-trips instead of silently clearing the value.
              (d.category_id && !cats.some((c) => c.id === d.category_id) && modalCtx.editCat ? '<option value="' + esc(d.category_id) + '" selected>' + esc(modalCtx.editCat.name || t('cat.current', '(current category)')) + '</option>' : '') +
              '<option value="__new">' + '＋ ' + esc(t('db.newCategory', 'New category…')) + '</option>' +
            '</select></label>' +
          '<label class="db-field"><span>' + esc(t('db.sprint', 'Sprint')) + '</span>' +
            '<select data-db-sprint><option value="">' + esc(t('db.noSprint', 'No sprint')) + '</option>' +
              // S242 (spec §8 + Screen D): every sprint wears its identity glyph
              // (emoji or the default ◆) beside the name; COMPLETED sprints are not
              // new-assignment options — but the task's CURRENT completed sprint
              // stays as the selected value (historical association; the PATCH
              // re-assert the old edit-modal echo does is legal server-side).
              state.sprints.map((s) => {
                if (sprintCompleted(s) && d.sprint_id !== s.id) return ''
                return '<option value="' + esc(s.id) + '" ' + (d.sprint_id === s.id ? 'selected' : '') + '>' + esc(sprintGlyph(s) + ' ' + s.name) + (s.is_draft ? ' — ' + esc(t('db.draftTag', 'draft')) : '') + '</option>'
              }).join('') +
              '<option value="__new">' + '＋ ' + esc(t('db.newSprint', 'New sprint')) + '</option>' +
            '</select></label>' +
        '</div>' +
        '<div class="db-cat-new" data-db-cat-new hidden>' +
          '<input data-db-cat-name maxlength="80" dir="auto" placeholder="' + esc(t('db.categoryName', 'Category name (Feature Development…)')) + '">' +
          // S152 (block 5): the 16 curated fill+ink pairs — read from the --cat-sw-*
          // tokens (no free-form color picker anywhere).
          '<div class="pd-tag-colors pd-cat-swatches" data-db-cat-swatches></div>' +
        '</div>' +
        (isNew
          ? '<div class="db-field"><span>' + esc(t('db.tags', 'Tags')) + '</span>' +
            '<div class="db-tags-row" data-db-newtags>' +
              (d.newTags || []).map((name) => '<span dir="auto" class="chip db-tag" data-newtag="' + esc(name) + '">' + esc(name) + ' <button type="button" class="ghost danger" data-newtag-del="' + esc(name) + '" aria-label="✕">✕</button></span>').join('') +
              '<input data-db-newtag-in maxlength="60" dir="auto" placeholder="' + esc(t('db.addTag', 'Add tag + Enter')) + '">' +
            '</div></div>'
          : '<div class="db-field"><span>' + esc(t('db.tags', 'Tags')) + '</span>' +
          '<div class="db-tags-row" data-db-tags>' +
            d.tags.map((id) => { const tg = tagById(id); return tg ? '<span dir="auto" class="chip db-tag" data-tag="' + esc(id) + '" style="background:' + esc(tg.color) + '33"><span style="color:' + esc(tg.color) + '">●</span> ' + esc(tg.name) + ' <button type="button" class="ghost danger" data-untag="' + esc(id) + '" aria-label="✕">✕</button></span>' : '' }).join('') +
            '<input data-db-tag-in maxlength="60" dir="auto" placeholder="' + esc(t('db.addTag', 'Add tag + Enter')) + '">' +
          '</div></div>') +
        // S244 (spec §9.1 + §3.3 + Screen C): the task-level deadline section —
        // a compact Due date (optional) toggle, OFF BY DEFAULT (hidden controls
        // while OFF; the form stays compact — spec §9.1), mounted between Tags
        // and Upload File. ON reveals the SHARED Gregorian/Jalali control (D6 —
        // the due-control.js module); OFF on an inherited task renders the
        // read-only line (§10.1: 'Using <sprint> sprint deadline · <date>' — the
        // server-computed triple's effective_due_source, never a client
        // re-derivation). The Add mode reads the drafted sprint's own due_at
        // (raw row data — no resolution involved; the toggle is OFF).
        (function () {
          const ctlOk = !!(window.HibanaDueControl && window.HibanaDueControl.create)
          if (!ctlOk) return '' // belt: a page without the module keeps the pre-S244 shape
          const task = modalCtx.taskId ? findTask(modalCtx.taskId) : null
          let inhName = ''
          let inhDate = null
          if (!modalCtx.draft.dueOn) {
            if (task && task.effective_due_source === 'sprint' && task.effective_due_at) {
              // §10.1's primary read: the payload row's server-computed inheritance
              const sp = findSprint(task.sprint_id)
              inhName = sp ? sp.name : ''
              inhDate = task.effective_due_at
            } else if (task && task.sprint_id) {
              // §10.2's removal preview: the toggle came OFF on an edited task — the
              // post-save state returns to the sprint's own deadline (a raw display
              // read; the completed-sprint neutrality applies, no re-derivation)
              const sp = findSprint(task.sprint_id)
              if (sp && sp.due_at && sprintStatusOf(sp) !== 'completed') { inhName = sp.name || ''; inhDate = sp.due_at }
            } else if (!task && modalCtx.draft.sprint_id) {
              // add mode: the drafted sprint's own due (raw row data — the toggle
              // is OFF, so whatever the sprint carries is what the task will inherit)
              const sp = findSprint(modalCtx.draft.sprint_id)
              if (sp && sp.due_at && sprintStatusOf(sp) !== 'completed') { inhName = sp.name || ''; inhDate = sp.due_at }
            }
          }
          const lang2 = window.hibanaI18n && window.hibanaI18n.lang ? window.hibanaI18n.lang() : 'en'
          const inhTxt = inhDate
            ? t('db.due.inherited', 'Using {sprint} sprint deadline · {date}')
                .replace('{sprint}', inhName)
                .replace('{date}', dueDayLabel(Date.parse(inhDate), lang2))
            : ''
          // S245 (§13 + Screen J2/J3): the Extend… link beside the field — J2's
          // preset shortcuts for a task that HAS a deadline (personal → J2;
          // inherited → J3's choice modal). Rendered only for an EXISTING task
          // with a saved personal deadline or an inherited line (the add-mode
          // inherited line is a PREVIEW of what a new task would inherit —
          // nothing to extend yet); the link's wiring closes the editor first
          // (its draft would go stale against the extended truth).
          const canExtend = !!(ctlOk && task && (task.due_at || inhDate))
          return '<div class="db-field db-due-field" data-db-due-field>' +
            '<label class="db-sq-toggle"><input type="checkbox" data-db-due-toggle' + (modalCtx.draft.dueOn ? ' checked' : '') + '><span>' + esc(t('db.due.toggleOpt', 'Due date (optional)')) + '</span></label>' +
            '<div class="db-due-mount" data-db-due-mount' + (modalCtx.draft.dueOn ? '' : ' hidden') + '></div>' +
            (inhTxt ? '<p class="db-due-inherited muted small" data-db-due-inherited>' + esc(inhTxt) + '</p>' : '') +
            (canExtend ? '<button type="button" class="ghost small db-due-ext-link" data-db-due-extend-link>' + EXT_ICON + ' ' + esc(t('db.extendSprint', 'Extend') + '…') + '</button>' : '') +
            '<p class="db-due-err" data-db-due-modal-err role="alert" hidden></p>' +
          '</div>'
        })() +
        // S246 (spec pack Phase 7 — §15 + Screen K): the Dependencies section —
        // COLLAPSED BY DEFAULT (spec §15: "optional and collapsed by default so
        // ordinary task creation remains uncluttered"; the S244 due-toggle's
        // grammar: a compact section header, hidden controls while collapsed).
        // The header carries a small count of the current blockers so an edited
        // task's links stay discoverable without expanding. Expanded reveals the
        // SEARCHABLE Blocked-by multi-select of SAME-PROJECT tasks (the loaded
        // payload's state.tasks — each option: title + sprint identity + status);
        // the current blockers pre-selected. EDIT mode mutates LIVE through the
        // existing endpoints (POST on select / DELETE on deselect — the recorded
        // decision: the 400/409 answers surface INLINE at the moment of the bad
        // pick, and the modal never carries a dep-diff to reconcile at Save);
        // ADD mode STAGES the picks and POSTs them right after the create ack
        // (a task that does not exist yet cannot be linked — self/cycle are
        // impossible pre-create, same-project is by construction). No second
        // editable Blocks field EVER (spec §15 — the reverse view is derived).
        (function () {
          const curIds = isNew ? (modalCtx.draft.depStaged || []) : depsOf(modalCtx.taskId, state.task_deps)
          const blocksN = isNew ? 0 : blocksCount(modalCtx.taskId, state.task_deps)
          const open = !!modalCtx.draft.depsOpen
          return '<div class="db-field db-deps-field" data-db-deps-field>' +
            '<button type="button" class="db-deps-toggle" data-db-deps-toggle aria-expanded="' + open + '" aria-controls="db-deps-mount">' +
              '<svg class="icon db-deps-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>' +
              '<span>' + esc(t('db.deps.section', 'Dependencies (optional)')) + '</span>' +
              (curIds.length ? '<span class="db-deps-count" aria-label="' + esc(t('db.dep.blockedHint', 'Blocked by {n} task(s) — open the task to see them.').replace('{n}', faDig(curIds.length))) + '">' + esc(faDig(curIds.length)) + '</span>' : '') +
            '</button>' +
            '<div class="db-deps-mount" data-db-deps-mount id="db-deps-mount"' + (open ? '' : ' hidden') + '>' +
              '<span class="db-deps-label">' + esc(t('db.deps.blockedBy', 'Blocked by')) + '</span>' +
              '<input type="search" class="db-deps-q" data-db-deps-q dir="auto" autocomplete="off" spellcheck="false" placeholder="' + esc(t('db.deps.searchPh', 'Search tasks…')) + '" aria-label="' + esc(t('db.deps.searchPh', 'Search tasks…')) + '">' +
              '<div class="db-deps-list" data-db-deps-list role="listbox" aria-multiselectable="true" aria-label="' + esc(t('db.deps.blockedBy', 'Blocked by')) + '"></div>' +
              '<p class="muted small db-deps-note">' + esc(t('db.deps.autoNote', 'The reverse Blocks view is derived automatically — you only enter Blocked by.')) + '</p>' +
              (isNew ? '<p class="muted small db-deps-note">' + esc(t('db.deps.addNote', 'Links are created when the task is saved.')) + '</p>' : '') +
              (!isNew && blocksN ? '<p class="db-deps-blocksline muted small" data-db-deps-blocksline>' + esc(t('db.deps.blocksLine', 'This task blocks {n} task(s).').replace('{n}', faDig(blocksN))) + '</p>' : '') +
              '<p class="db-deps-err" data-db-deps-err role="alert" hidden></p>' +
            '</div>' +
          '</div>'
        })() +
        // S208: the Upload File button + the shots grid — for BOTH modes (the
        // owner's ask: creating a task must offer the picture upload the same way
        // established tasks do). New tasks stage; existing tasks pin immediately
        // and the grid below shows the task's pinned shots (zoom / note / delete).
        '<div class="pd-taskadd-shots" data-db-shots>' +
          '<input type="file" data-db-shots-input accept=".pdf,.csv,.xlsx,.docx,.md,.txt,image/png,image/jpeg,image/webp,image/gif,video/webm" multiple hidden>' +
          '<div class="row" style="gap:.5rem;align-items:center">' +
            '<button type="button" class="ghost" data-db-shots-add title="' + esc(t('pde.shotsAttachTitle', 'Upload a file — images, video (webm), PDF, Excel, Word, Markdown, text — pinned to this item')) + '"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21.2 11.2 12.6 19.8a5.4 5.4 0 0 1-7.6-7.6l8.5-8.5a3.6 3.6 0 0 1 5.1 5.1l-8.5 8.5a1.8 1.8 0 0 1-2.5-2.5l7.8-7.8"/></svg> ' + esc(t('pde.shotsAttach', 'Upload File')) + '</button>' +
            (isNew ? '<span class="muted small" data-db-shots-count></span>' : '') +
          '</div>' +
          '<div class="pd-taskadd-shots-grid" data-db-shots-grid></div>' +
        '</div>' +
        '</div>' +
        '<div class="row spread db-modal-foot">' +
          (isNew ? '' : '<button type="button" class="btn ghost danger" data-db-del>' + esc(t('common.delete', 'Delete')) + '</button>') +
          // hibana-sync-status-spec §10: the same badge worn near the Save area of
          // the item editor — icon + label (+ the last confirmed sync time when
          // synced). data-sync-badge-detail lets sync-state.js's paint loop keep it
          // live while the save round-trip runs (modalSyncBadge above).
          '<div class="row" style="gap:.5rem;align-items:center">' + (isNew ? '' : modalSyncBadge(modalCtx.taskId)) + '<button type="button" class="ghost" data-db-close>' + esc(t('common.cancel', 'Cancel')) + '</button></div>' +
          // Session 23 (user request: "the ذخیره button must be green like other
          // buttons"): plain <button> = the system's green CTA fill (was .btn neutral).
          '<button type="button" data-db-save>' + esc(isNew ? t('common.add', 'Add') : t('common.save', 'Save')) + '</button></div></div>' +
        '</div>' +
      '</div>'

    // S152 (block 5): the inline quick-add's swatch grid — the 16 curated fill+ink
    // pairs read from the --cat-sw-* tokens; the first tile starts selected.
    const swWrap = el.querySelector('[data-db-cat-swatches]')
    if (swWrap && !swWrap.childElementCount) {
      const cs = getComputedStyle(document.documentElement)
      let tiles = ''
      for (let i = 1; i <= 16; i++) {
        const fill = cs.getPropertyValue('--cat-sw-' + i + '-fill').trim()
        const ink = cs.getPropertyValue('--cat-sw-' + i + '-ink').trim()
        if (!fill || !ink) continue
        tiles += '<button type="button" class="pd-cat-swatch-tile' + (i === 1 ? ' is-sel' : '') + '" data-db-cat-fill="' + fill + '" data-db-cat-ink="' + ink + '" style="background:' + fill + ';color:' + ink + '" aria-label="' + fill + '"><span aria-hidden="true">Aa</span></button>'
      }
      swWrap.innerHTML = tiles
      swWrap.onclick = (ev) => {
        const tile = ev.target.closest('.pd-cat-swatch-tile')
        if (!tile) return
        swWrap.querySelectorAll('.pd-cat-swatch-tile').forEach((x) => x.classList.remove('is-sel'))
        tile.classList.add('is-sel')
      }
    }
    // S209 (kanban 1:1 parity): the FULL toolbar wiring — every op writes RAW
    // markdown into the single title textarea (the board's editing model) using
    // the exact vocabulary chip-render.js + the server twin parse: inline wraps
    // (**bold**, __underline__, ~~strike~~), line-prefix ops (- bullets, 1.
    // ordered — numbered sequentially), paragraph alignment markers ({:left} /
    // {:center} / {:right} / {:justify} at line start, replacing an existing
    // marker so clicking another align SWITCHES it), and ``` fences on their own
    // lines. The project editor applies the same vocabulary through its
    // contenteditable + htmlToMd — both editors now produce the same language.
    el.querySelectorAll('.pd-tb [data-tb]').forEach((b) => {
      b.onclick = () => {
        const ta = el.querySelector('[name=title]')
        if (!ta) return
        const s = ta.selectionStart == null ? ta.value.length : ta.selectionStart
        const en = ta.selectionEnd == null ? s : ta.selectionEnd
        const v = ta.value
        const sel = v.slice(s, en)
        const kind = b.dataset.tb
        if (kind === 'list' || kind === 'ordered-list' || kind.indexOf('align-') === 0) {
          // line-spanning ops — the full lines the selection touches (the bullet
          // contract; alignment marks the paragraph, chip-render reads it at ^\s*{:\n          // and toggles at the next non-aligned line)
          const ls = v.lastIndexOf('\n', s - 1) + 1
          let le = v.length
          if (sel.includes('\n')) { const n = v.indexOf('\n', Math.max(en, s)); if (n !== -1) le = n }
          const lines = v.slice(ls, le).split('\n')
          let marked
          if (kind === 'list') {
            marked = lines.map((l) => (l === '' || /^[-*]\s/.test(l)) ? l : '- ' + l).join('\n')
          } else if (kind === 'ordered-list') {
            let i = 0
            marked = lines.map((l) => (l === '' || /^\d+\.\s/.test(l)) ? l : (++i) + '. ' + l).join('\n')
          } else {
            const marker = '{:' + kind.slice(6) + '}' // align-left → {:left}
            marked = lines.map((l) => {
              if (!l.trim()) return l
              return marker + l.replace(/^\s*\{:(left|center|right|justify)\}/, '')
            }).join('\n')
          }
          ta.setRangeText(marked, ls, le, 'end')
          ta.focus()
          return
        }
        let before = '', after = ''
        if (kind === 'code') {
          const pre = s === 0 || v[s - 1] === '\n' ? '' : '\n'
          before = pre + '```\n'
          after = '\n```' + (en === v.length || v[en] === '\n' ? '' : '\n')
        } else if (kind === 'underline') {
          before = '__'; after = '__'
        } else if (kind === 'strikethrough') {
          before = '~~'; after = '~~'
        } else {
          before = '**'
          after = '**'
        }
        ta.setRangeText(before + sel + after, s, en, 'end')
        if (sel) ta.setSelectionRange(s + before.length, s + before.length + sel.length)
        else ta.setSelectionRange(s + before.length, s + before.length)
        ta.focus()
      }
    })
    // S209: the fullscreen writing toggle + the close family (✕ / Cancel) exit
    // fullscreen FIRST — the project editor's exitOrClose contract.
    const fsBtn = el.querySelector('[data-db-fullscreen]')
    if (fsBtn) {
      fsBtn.onclick = () => {
        const card = el.querySelector('.db-modal-card')
        if (card) card.classList.toggle('db-fullscreen')
      }
    }
    el.querySelectorAll('[data-db-close]').forEach((b) => { b.onclick = exitFullscreenOrClose })
    el.querySelectorAll('.db-seg button').forEach((b) => {
      b.onclick = () => {
        const seg = b.closest('[data-seg]').dataset.seg
        modalCtx.draft[seg] = b.dataset.val
        b.closest('.db-seg').querySelectorAll('button').forEach((x) => x.classList.toggle('is-on', x === b))
      }
    })
    const catSel = el.querySelector('[data-db-cat]')
    catSel.onchange = () => {
      if (catSel.value === '__new') {
        el.querySelector('[data-db-cat-new]').hidden = false
        modalCtx.draft.category_id = '__pending'
      } else {
        el.querySelector('[data-db-cat-new]').hidden = true
        modalCtx.draft.category_id = catSel.value || null
      }
    }
    const sprintSel = el.querySelector('[data-db-sprint]')
    // The quick-create callbacks re-render the card — the typed title must survive
    // the repaint (the tag flows' syncTitleToDraft contract, same scope below).
    const sprintQRender = () => { syncTitleToDraft(); syncDueToDraft(); if (modalCtx) renderModal() }
    sprintSel.onchange = () => {
      if (sprintSel.value === '__new') {
        // S242 (spec §7.1/Screen D): ＋ New sprint opens the QUICK-CREATE dialog
        // (the S206 nameless createSprint() reuse is retired). The draft keeps the
        // PREVIOUS value while the dialog runs — cancel snaps the select back,
        // success pushes the new sprint + re-renders with it selected for this
        // task (the recommended default). draft.sprint_id never becomes '__new'.
        openSprintQuickCreate({
          onCreated: (sp) => {
            if (!modalCtx) return // the task modal closed meanwhile
            if (!state.sprints.some((x) => x.id === sp.id)) state.sprints.push(sp)
            modalCtx.draft.sprint_id = sp.id
            sprintQRender()
          },
          onCanceled: sprintQRender,
        })
        return
      }
      modalCtx.draft.sprint_id = sprintSel.value || null
      // S244 (§10.1): the inherited read-only line follows the drafted sprint —
      // the sprint select's normal change re-renders through the same survival
      // contract the quick-create callbacks use (title + due synced first), so
      // picking a sprint with a deadline shows its line while the toggle is OFF.
      sprintQRender()
    }
    // S244 (spec §9.1): the Due date (optional) toggle — ON reveals the shared
    // control (a fresh mount per render; the picked value survives repaints
    // through syncDueToDraft, the title's own survival contract). OFF keeps the
    // draft's saved value in place — the REMOVAL happens at Save time (the
    // PATCH's explicit due_at:null), so an accidental toggle never destroys a
    // picked date (§10.2's semantics live server-side).
    const dueToggle = el.querySelector('[data-db-due-toggle]')
    const dueMount = el.querySelector('[data-db-due-mount]')
    const dueModalErr = el.querySelector('[data-db-due-modal-err]')
    if (dueToggle && dueMount) {
      if (!dueMount.hidden && window.HibanaDueControl && window.HibanaDueControl.create) {
        modalDueCtl = window.HibanaDueControl.create({ value: modalCtx.draft.dueAt })
        dueMount.textContent = ''
        dueMount.appendChild(modalDueCtl.el)
      }
      dueToggle.onchange = () => {
        syncTitleToDraft()
        syncDueToDraft()
        modalCtx.draft.dueOn = dueToggle.checked
        if (dueModalErr) { dueModalErr.hidden = true }
        renderModal()
      }
    }
    // S245 (§13 + Screen J2/J3): the due field's Extend… link — closes the
    // editor WITHOUT saving (an extension is its own dedicated flow; the draft
    // would go stale against the extended truth) and hands the SAVED task row
    // to the router (personal → J2's picker; sprint-sourced → J3's choice).
    // The editor's own onSaved (the caller's board reload) rides along as the
    // dialog's onDone — the extension is a mutation that needs the re-pull.
    const dueExtLink = el.querySelector('[data-db-due-extend-link]')
    if (dueExtLink) {
      dueExtLink.onclick = () => {
        const savedTask = modalCtx && modalCtx.taskId ? findTask(modalCtx.taskId) : null
        const after = modalCtx ? modalCtx.onSaved : null
        closeModal(false)
        if (savedTask) openTaskDeadlineExtend(savedTask, { onDone: after })
      }
    }
    // S246 (spec pack Phase 7 — Screen K): the Dependencies section's wiring.
    // The toggle flips the mount's hidden + aria-expanded IN PLACE (no re-render
    // — the search text + the scroll position survive); the list paints from the
    // truth pools (edit: state.task_deps; add: the staged picks) filtered by the
    // search box. Clicking an option: edit mode mutates LIVE (the recorded
    // decision — POST on select / DELETE on deselect through the existing
    // endpoints, so the 400 self / 409 cycle answers surface INLINE at the
    // moment of the bad pick and the modal never carries a dep-diff); add mode
    // toggles the staged pick (the links POST right after the create ack).
    const depsToggleBtn = el.querySelector('[data-db-deps-toggle]')
    const depsMountEl = el.querySelector('[data-db-deps-mount]')
    const depsListEl = el.querySelector('[data-db-deps-list]')
    const depsQEl = el.querySelector('[data-db-deps-q]')
    const depsErrEl = el.querySelector('[data-db-deps-err]')
    if (depsToggleBtn && depsMountEl && depsListEl) {
      const depSelected = () => (isNew ? (modalCtx.draft.depStaged || []) : depsOf(modalCtx.taskId, state.task_deps))
      // A live dep mutation changes OTHER cards' badges too (the blocker's
      // Blocks N, the lane-mates of any dependent) — coalesce ONE board refresh
      // behind the open editor (the caller's onSaved, debounced: rapid picks
      // collapse into a single re-pull). The modal itself is a body child and
      // survives the board's re-render untouched.
      let depRefreshTimer = null
      const depBoardRefresh = () => {
        if (!modalCtx || !modalCtx.onSaved) return
        clearTimeout(depRefreshTimer)
        depRefreshTimer = setTimeout(() => { if (modalCtx && modalCtx.onSaved) modalCtx.onSaved() }, 300)
      }
      const depPaintList = () => {
        const q = depsQEl && depsQEl.value ? String(depsQEl.value).trim().toLowerCase() : ''
        const cur = depSelected()
        const rows = state.tasks.filter((row) => !q || String(row.title || '').toLowerCase().includes(q))
        depsListEl.innerHTML = rows.length
          ? rows.map((row) => {
              const sel = cur.includes(row.id)
              const sp = row.sprint_id ? findSprint(row.sprint_id) : null
              // each option: TITLE + sprint identity (the glyph grammar) + status
              // (Screen K — "identify each task clearly by title and, where
              // useful, its sprint"); the CURRENT task stays listed (marked) so
              // the self-400 surface is reachable + honest, but it can never
              // stick (§14.2's no-self rule answers inline).
              const meta = (sp ? sprintGlyph(sp) + ' ' + sp.name : t('db.noSprint', 'No sprint')) + ' · ' + statusLabel(row.status || 'idea')
              const self = !isNew && row.id === modalCtx.taskId
              return '<button type="button" class="db-deps-opt' + (sel ? ' is-on' : '') + '" role="option" aria-selected="' + sel + '" data-dep="' + esc(row.id) + '" dir="auto">' +
                '<span class="db-deps-check" aria-hidden="true">' + (sel ? '✓' : '') + '</span>' +
                '<span class="db-deps-opt-body"><span class="db-deps-opt-title">' + esc(String(row.title || '').split('\n')[0]) + (self ? ' <span class="muted">(' + esc(t('db.deps.thisTask', 'this task')) + ')</span>' : '') + '</span>' +
                '<span class="db-deps-opt-meta muted">' + esc(meta) + '</span></span>' +
              '</button>'
            }).join('')
          : '<p class="db-deps-empty muted small">' + esc(t('db.deps.noneFound', 'No tasks match.')) + '</p>'
      }
      depsToggleBtn.onclick = () => {
        modalCtx.draft.depsOpen = !modalCtx.draft.depsOpen
        depsToggleBtn.setAttribute('aria-expanded', String(modalCtx.draft.depsOpen))
        depsMountEl.hidden = !modalCtx.draft.depsOpen
        if (modalCtx.draft.depsOpen) depPaintList()
      }
      if (!depsMountEl.hidden) depPaintList() // a mid-edit re-render with the section already open
      if (depsQEl) depsQEl.oninput = depPaintList
      depsListEl.onclick = async (ev) => {
        const btn = ev.target.closest('[data-dep]')
        if (!btn || !modalCtx) return
        const depId = btn.getAttribute('data-dep')
        const row = findTask(depId)
        const name = row ? String(row.title || '').split('\n')[0] : ''
        const isOn = depSelected().includes(depId)
        if (depsErrEl) { depsErrEl.hidden = true; depsErrEl.textContent = '' }
        if (isNew) {
          // Add mode: STAGE the pick. Self/cycle cannot exist pre-create (nothing
          // references an id that does not exist yet) and same-project is by
          // construction — the list IS this project's payload tasks.
          modalCtx.draft.depStaged = isOn ? depSelected().filter((x) => x !== depId) : [...depSelected(), depId]
          depPaintList()
          return
        }
        // Edit mode: the LIVE mutation (the recorded decision).
        try {
          if (isOn) await removeTaskDep(modalCtx.taskId, depId)
          else await addTaskDep(modalCtx.taskId, depId)
          // keep the local edge pool in lock-step with the ack (the modal's own
          // fold + the board's next render read it; cards refresh at the next
          // reload — the live-tag-chips precedent)
          if (isOn) state.task_deps = state.task_deps.filter((x) => !(x.blocker_task_id === depId && x.blocked_task_id === modalCtx.taskId))
          else if (!state.task_deps.some((x) => x.blocker_task_id === depId && x.blocked_task_id === modalCtx.taskId)) state.task_deps.push({ blocker_task_id: depId, blocked_task_id: modalCtx.taskId })
          depBoardRefresh()
          depPaintList()
        } catch (e2) {
          // the INLINE 400/409 surfaces (Screen K: "show a clear inline
          // explanation" — never a generic toast). A failed pick never sticks:
          // the repaint below re-reads the unchanged truth pools.
          const code = e2 && e2.code ? String(e2.code) : ''
          if (depsErrEl) {
            if (code === 'cycle') depsErrEl.textContent = t('db.deps.cycleErr', 'Circular dependency: {name} is already blocked by this task, directly or through a chain.').replace('{name}', name)
            else if (code === 'invalid_input') depsErrEl.textContent = t('db.deps.selfErr', 'A task cannot block itself.')
            else depsErrEl.textContent = t('db.deps.saveErr', "Couldn't update the dependency.")
            depsErrEl.hidden = false
          }
          depPaintList()
        }
      }
    }
    // S208: renderModal() rebuilds the whole card — the TITLE textarea is the
    // one live-buffered field (status/priority/category/sprint sync their own
    // draft keys on change). Sync it before any mid-edit re-render (a tag chip
    // add/remove) so the typed title survives the repaint — a latent wipe the
    // existing-task tag flow carried too.
    const syncTitleToDraft = () => {
      const titleEl = el.querySelector('[name=title]')
      if (titleEl) modalCtx.draft.title = titleEl.value
    }
    // S244: the due control's live value joins the title's survival contract —
    // every mid-edit re-render (a tag chip, the quick-create callbacks) reads the
    // mounted control into the draft first, so a picked deadline survives the
    // repaint exactly like the typed title.
    const syncDueToDraft = () => {
      if (modalDueCtl && modalCtx && modalCtx.draft && modalCtx.draft.dueOn) modalCtx.draft.dueAt = modalDueCtl.value()
    }
    const tagIn = el.querySelector('[data-db-tag-in]')
    if (tagIn) tagIn.onkeydown = async (ev) => {
      if (ev.key !== 'Enter' || ev.isComposing) return
      ev.preventDefault()
      const name = tagIn.value.trim()
      if (!name) return
      try {
        const r = await addTaskTag(modalCtx.taskId, name)
        if (!modalCtx) return // closed meanwhile
        syncTitleToDraft()
        syncDueToDraft()
        if (!d.tags.includes(r.id)) d.tags.push(r.id)
        // S260 (the S259 finding's micro-fix): the immediate add must ALSO land
        // in state.tasks — the post-save repaint (FE-1) renders the card from
        // state, so without this merge the chip only appeared after the next
        // reload (pre-S254 the save's full reload() refetched it). One merge in
        // the shared state closes every surface that renders from it (the board
        // lane repaint + the sprint page's pure render).
        const stTask = findTask(modalCtx.taskId)
        if (stTask && Array.isArray(stTask.tags) && !stTask.tags.includes(r.id)) stTask.tags.push(r.id)
        if (!tagById(r.id)) state.tags.push({ id: r.id, name, color: '#8AB8F0' })
        tagIn.value = ''
        renderModal()
      } catch { window.hibana && window.hibana.toast(t('sparks.saveFailed', "Couldn't save"), 'err') }
    }
    el.querySelectorAll('[data-untag]').forEach((b) => {
      b.onclick = async () => {
        try {
          await removeTaskTag(modalCtx.taskId, b.dataset.untag)
          syncTitleToDraft()
          syncDueToDraft()
          modalCtx.draft.tags = modalCtx.draft.tags.filter((x) => x !== b.dataset.untag)
          // S260: the remove twin — splice the id from the state row too, or the
          // post-save repaint leaves a STALE chip on the card in the same window
          // (the finding's second half).
          const stTask = findTask(modalCtx.taskId)
          if (stTask && Array.isArray(stTask.tags)) stTask.tags = stTask.tags.filter((x) => x !== b.dataset.untag)
          renderModal()
        } catch { window.hibana && window.hibana.toast(t('sparks.saveFailed', "Couldn't save"), 'err') }
      }
    })
    // S208: the NEW-task staged tags — Enter stages the name (chips with ✕),
    // they ride the create body's tags[] (the server find-or-creates them).
    const newTagIn = el.querySelector('[data-db-newtag-in]')
    if (newTagIn) newTagIn.onkeydown = (ev) => {
      if (ev.key !== 'Enter' || ev.isComposing) return
      ev.preventDefault()
      const name = newTagIn.value.trim()
      if (!name) return
      if (!modalCtx.draft.newTags.includes(name)) modalCtx.draft.newTags.push(name)
      syncTitleToDraft()
      syncDueToDraft()
      renderModal()
      const again = el.querySelector('[data-db-newtag-in]')
      if (again) again.focus()
    }
    el.querySelectorAll('[data-newtag-del]').forEach((b) => {
      b.onclick = () => {
        modalCtx.draft.newTags = modalCtx.draft.newTags.filter((n) => n !== b.dataset.newtagDel)
        syncTitleToDraft()
        syncDueToDraft()
        renderModal()
        const again = el.querySelector('[data-db-newtag-in]')
        if (again) again.focus()
      }
    })
    // S208: the shots section — the Upload File button + staged/pinned grid.
    const shotsAdd = el.querySelector('[data-db-shots-add]')
    const shotsInput = el.querySelector('[data-db-shots-input]')
    if (shotsAdd && shotsInput) {
      shotsAdd.onclick = () => shotsInput.click()
      shotsInput.onchange = async () => {
        if (!modalCtx) return
        const files = [...(shotsInput.files || [])].filter(isAcceptedFile)
        shotsInput.value = ''
        if (!files.length) return
        await ensureImageResize()
        const wrap = el.querySelector('[data-db-shots]')
        const gridNow = el.querySelector('[data-db-shots-grid]')
        const strip = makeUploadStrip(wrap, gridNow)
        let ok = 0, fail = 0
        for (const file of files) {
          const r = await uploadOne(file, strip)
          if (!modalCtx) return // closed meanwhile — the pin/cleanup is not ours
          if (r.ok && r.shot && r.shot.id) {
            if (isNew) {
              modalStaged.push({ id: r.shot.id, mime: r.shot.mimeType, fileName: file.name, caption: '' })
              ok++
              renderStagedGrid()
            } else {
              try { await patchShot(r.shot.id, { taskId: modalCtx.taskId }); ok++ } catch { fail++ }
              await renderPinnedGrid()
            }
          } else if (!r.ok && !r.canceled) fail++
        }
        if (ok && !fail) window.hibana && window.hibana.toast(t('project.shotUploaded', 'Screenshot uploaded'), 'ok')
        else if (fail && !ok) window.hibana && window.hibana.toast(t('project.shotFailed', 'Upload failed'), 'err')
        else if (fail) window.hibana && window.hibana.toast(t('project.shotsMixed', '{ok} uploaded, {fail} failed').split('{ok}').join(faDig(ok)).split('{fail}').join(faDig(fail)), 'err')
      }
    }
    // S208: delegated grid handlers — zoom (the lightbox), edit-note (the PATCH
    // dialog), delete (the DELETE + grid refresh). One handler serves the staged
    // grid (new tasks) and the pinned grid (existing tasks).
    const shotsGrid = el.querySelector('[data-db-shots-grid]')
    if (shotsGrid) shotsGrid.onclick = async (ev) => {
      if (!modalCtx) return
      const zoom = ev.target.closest('[data-db-shot-zoom], [data-db-staged-zoom]')
      if (zoom) {
        const img = zoom.querySelector('img')
        if (img) openShotLightbox(img.getAttribute('src'), zoom, shotsGrid)
        return
      }
      const del = ev.target.closest('[data-db-shot-del], [data-db-staged-del]')
      if (del) {
        const sid = del.getAttribute('data-db-shot-del') || del.getAttribute('data-db-staged-del')
        try {
          await deleteShot(sid)
          window.hibana && window.hibana.toast(t('project.shotDeleted', 'File deleted'), 'ok')
        } catch { window.hibana && window.hibana.toast(t('sparks.saveFailed', "Couldn't delete"), 'err') }
        if (isNew) {
          modalStaged = modalStaged.filter((s) => s.id !== sid)
          renderStagedGrid()
        } else {
          await renderPinnedGrid()
        }
        return
      }
      const note = ev.target.closest('[data-db-shot-note], [data-db-staged-note]')
      if (note) {
        const sid = note.getAttribute('data-db-shot-note') || note.getAttribute('data-db-staged-note')
        const cur = isNew
          ? String((modalStaged.find((s) => s.id === sid) || {}).caption || '')
          : String((modalPinnedShots.find((s) => s.id === sid) || {}).caption || '')
        shotNoteDialog(sid, cur, (text) => {
          if (isNew) {
            const s = modalStaged.find((x) => x.id === sid)
            if (s) s.caption = text
            renderStagedGrid()
          } else renderPinnedGrid()
        })
      }
    }
    if (isNew) renderStagedGrid()
    const delBtn = el.querySelector('[data-db-del]')
    if (delBtn) {
      delBtn.onclick = async () => {
        if (!await window.hibana.confirm(t('db.delConfirm', 'Delete this task?'), { title: 'Delete task', danger: true, confirmLabel: 'Delete' })) return
        try {
          await deleteTask(modalCtx.taskId)
          window.hibana && window.hibana.toast(t('db.taskDeleted', 'Task deleted'), 'ok')
          closeModal(true)
        } catch { window.hibana && window.hibana.toast(t('sparks.saveFailed', "Couldn't save"), 'err') }
      }
    }
    el.querySelector('[data-db-save]').onclick = async () => {
      const titleIn = el.querySelector('[name=title]')
      // Session 23 (user request): newlines PRESERVED (multi-line titles with fenced
      // code blocks / bullet lists) — only \r\n normalized + outer trim. Was collapsed
      // to single spaces ("titles are single-line", pre-Session-23 contract).
      const title = titleIn.value.replace(/\r\n/g, '\n').trim()
      if (!title) { titleIn.focus(); return }
      try {
        let categoryId = modalCtx.draft.category_id
        if (categoryId === '__pending') {
          const cname = el.querySelector('[data-db-cat-name]').value.trim()
          if (!cname) { el.querySelector('[data-db-cat-name]').focus(); return }
          const tile = el.querySelector('[data-db-cat-swatches] .pd-cat-swatch-tile.is-sel')
          if (!tile) { el.querySelector('[data-db-cat-name]').focus(); return }
          const r = await createCategory(cname, tile.dataset.dbCatFill, tile.dataset.dbCatInk)
          categoryId = r.id
        }
        // S242 (spec pack D2 — contract §12.4): ＋ New sprint resolves through the
        // quick-create dialog at SELECTION time (the onchange above) — by save time
        // the draft carries a real id or null. The belt covers the impossible
        // leftover. The S206 draft-reuse block is retired with the nameless create.
        let sprintId = modalCtx.draft.sprint_id
        if (sprintId === '__new') sprintId = null
        // S244 (spec §9.1/§10.2 — the deadline save contract): the toggle ON sends
        // the control's ISO instant; a toggle ON with NO picked date blocks the save
        // inline (never a silent no-deadline). The create body always carries an
        // EXPLICIT due_at (null = none — the S242 explicit-key pattern); the edit
        // PATCH sends the key when the toggle is ON (set/keep the personal
        // override) or when a personal deadline is being REMOVED (§10.2: explicit
        // null — the server's origin rules clear due_at + due_origin_at and
        // inheritance resumes); otherwise the key stays ABSENT (contract §12.4:
        // undefined = untouched).
        syncDueToDraft()
        const savedTask = modalCtx.taskId ? findTask(modalCtx.taskId) : null
        const hadPersonal = !!(savedTask && savedTask.due_at)
        if (modalCtx.draft.dueOn && !modalCtx.draft.dueAt) {
          const errEl2 = el.querySelector('[data-db-due-modal-err]')
          if (errEl2) {
            errEl2.textContent = t('db.due.required', 'Pick a date for the deadline, or turn it off.')
            errEl2.hidden = false
          }
          const dateIn = el.querySelector('[data-db-due-mount] input')
          if (dateIn) dateIn.focus()
          return
        }
        if (isNew) {
          // S208: the staged tags ride the create body (the server find-or-creates
          // them) and the staged shots PIN to the fresh task (the project
          // composer's PATCH loop). A failed pin leaves the shot in the project's
          // gallery unpinned (the same best-effort contract) — counted + toasted.
          const created = await createTask({
            title, status: modalCtx.draft.status, priority: modalCtx.draft.priority,
            category_id: categoryId || undefined,
            // S242 (D2): the create body always carries an EXPLICIT sprint_id —
            // null = No sprint (the old `|| undefined` tripped the server's legacy
            // draft/open auto-assign, so "No sprint" never really meant No sprint
            // from this modal; undefined stays reserved for old clients).
            sprint_id: sprintId ?? null,
            // S244 (§9.1): the explicit due_at — the control's ISO instant, or null
            // when the toggle is OFF (no deadline is ever assigned implicitly).
            due_at: modalCtx.draft.dueOn ? modalCtx.draft.dueAt : null,
            ...(modalCtx.draft.newTags && modalCtx.draft.newTags.length ? { tags: modalCtx.draft.newTags } : {}),
          })
          const stagedCount = modalStaged.length
          let pinFail = 0
          for (const s of [...modalStaged]) {
            try { await patchShot(s.id, { taskId: created.id }) } catch { pinFail++ }
          }
          modalStaged = []
          // S246 (Screen K, add mode): the STAGED dep links POST right after the
          // create ack — the create-then-link chain (the staged-shots pin loop's
          // shape). A failed link is counted + toasted, never a silent miss
          // (self/cycle are impossible pre-create; same-project is by
          // construction — the belt only answers a network-level failure).
          let depFail = 0
          const stagedDeps = [...(modalCtx.draft.depStaged || [])]
          for (const bid of stagedDeps) {
            try { await addTaskDep(created.id, bid) } catch { depFail++ }
          }
          window.hibana && window.hibana.toast(t('db.taskAdded', 'Task added'), 'ok')
          if (pinFail) window.hibana && window.hibana.toast(t('project.shotsMixed', '{ok} uploaded, {fail} failed').split('{ok}').join(faDig(stagedCount - pinFail)).split('{fail}').join(faDig(pinFail)), 'err')
          if (depFail) window.hibana && window.hibana.toast(t('db.deps.saveErr', "Couldn't update the dependency.").split('{n}').join(faDig(depFail)), 'err')
        } else {
          const body = { title, status: modalCtx.draft.status, priority: modalCtx.draft.priority, category_id: categoryId || null, sprint_id: sprintId || null }
          // S244 (§10.2): ON → the override rides; OFF on a task that HAD a personal
          // deadline → the explicit null removal; OFF + no prior personal deadline →
          // the key is absent (undefined = untouched, contract §12.4).
          if (modalCtx.draft.dueOn) body.due_at = modalCtx.draft.dueAt
          else if (hadPersonal) body.due_at = null
          await patchTask(modalCtx.taskId, body)
          window.hibana && window.hibana.toast(t('sparks.saved', 'Saved'), 'ok')
        }
        closeModal(true)
      } catch { window.hibana && window.hibana.toast(t('sparks.saveFailed', "Couldn't save"), 'err') }
    }
    // Enter on the title saves (Shift+Enter = a real newline — Session 22)
    el.querySelector('[name=title]').onkeydown = (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); el.querySelector('[data-db-save]').click() }
    }
  }

  // ------------------------------------------------- sprint quick-create (S242)
  // Spec pack §7.1 + Screen D: the Add/Edit modal's ＋ New sprint opens this SMALL
  // dialog (replacing the S206 nameless createSprint() reuse). Required name;
  // optional emoji (the shared full-library picker — window.hibanaEmojiPicker, the
  // sparks-folder precedent); Add description + Set due date toggles OFF by default
  // (spec §4.2 — the form stays compact until asked). 409 duplicate → INLINE
  // case-insensitive error (never a silent rename); 409 draft_exists → inline error
  // (the draft is already in the dropdown); success → close + refresh the dropdown +
  // select the new sprint for the current task (the recommended default). The due
  // date uses the sprint define-popover's minimal <input type="date"> precedent
  // (UTC end-of-day parse, sprint-page.js's S206 twin) — Phase 5 swaps in the shared
  // Gregorian/Jalali deadline control.
  let sprintQEl = null
  // Capture-phase Esc shield: while the quick-create is open, Escape must close IT —
  // not the task modal underneath (the emoji picker's own S41 shield pattern).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sprintQEl && !sprintQEl.hidden) {
      e.preventDefault()
      e.stopPropagation()
      closeSprintQuickCreate(false)
    }
  }, true)
  function closeSprintQuickCreate(created) {
    if (!sprintQEl) return
    const ctx = sprintQEl._ctx
    sprintQEl._ctx = null
    sprintQEl.hidden = true
    if (ctx) {
      if (created && ctx.onCreated) ctx.onCreated(ctx._created)
      else if (!created && ctx.onCanceled) ctx.onCanceled()
    }
  }
  function openSprintQuickCreate(opts) {
    const lang = window.hibanaI18n && window.hibanaI18n.lang ? window.hibanaI18n.lang() : 'en'
    if (!sprintQEl) {
      sprintQEl = document.createElement('div')
      sprintQEl.className = 'db-modal db-sprintq'
      sprintQEl.setAttribute('role', 'dialog')
      sprintQEl.setAttribute('aria-modal', 'true')
      sprintQEl.hidden = true
      document.body.appendChild(sprintQEl)
      sprintQEl.addEventListener('click', (e) => { if (e.target === sprintQEl) closeSprintQuickCreate(false) })
    }
    sprintQEl._ctx = { onCreated: (opts && opts.onCreated) || null, onCanceled: (opts && opts.onCanceled) || null }
    let emoji = ''
    sprintQEl.innerHTML =
      '<div class="db-modal-card db-sprintq-card" dir="' + (lang === 'fa' ? 'rtl' : 'auto') + '">' +
        '<div class="row spread db-modal-head"><h3>' + esc(t('db.newSprint', 'New sprint')) + '</h3>' +
          '<button type="button" class="ghost" data-sq-close aria-label="' + esc(t('common.close', 'Close')) + '">✕</button></div>' +
        '<form class="db-sprintq-body">' +
          '<label class="db-field"><span>' + esc(t('db.sprintName', 'Sprint name')) + '</span>' +
            '<input name="sq-name" data-sq-name maxlength="80" dir="auto" required placeholder="' + esc(t('db.sq.namePh', 'Security…')) + '" aria-required="true"></label>' +
          '<div class="db-field"><span>' + esc(t('db.sq.emoji', 'Emoji (optional)')) + '</span>' +
            '<div class="row db-sq-emoji-row">' +
              '<button type="button" class="ghost db-sq-emoji-btn" data-sq-emoji-btn><span class="db-sq-emoji-cur" data-sq-emoji-cur aria-hidden="true">◆</span> <span data-sq-emoji-label>' + esc(t('db.sq.chooseEmoji', 'Choose emoji')) + '</span></button>' +
              '<button type="button" class="ghost danger db-sq-emoji-clear" data-sq-emoji-clear hidden aria-label="' + esc(t('db.sq.clearEmoji', 'Back to the default icon')) + '" title="' + esc(t('db.sq.clearEmoji', 'Back to the default icon')) + '">✕</button>' +
            '</div></div>' +
          // Spec §4.2: description input hides behind an OFF-by-default toggle.
          '<label class="db-sq-toggle"><input type="checkbox" data-sq-desc-toggle><span>' + esc(t('db.sq.addDesc', 'Add description')) + '</span></label>' +
          '<textarea class="db-sq-desc" data-sq-desc maxlength="2000" dir="auto" hidden placeholder="' + esc(t('db.sq.descPh', 'What is this sprint about?')) + '"></textarea>' +
          // Spec §4.2: due-date controls hide behind an OFF-by-default toggle.
          // S244 (D6 — Phase 5): the interim <input type="date"> (S242's
          // UTC-end-of-day parse, assumption 10's recorded interim) is SUPERSEDED
          // by the shared Gregorian/Jalali control (due-control.js): date-only now
          // resolves to LOCAL 23:59 (spec §11.2) and the calendar selector +
          // presets + optional time ship with it.
          '<label class="db-sq-toggle"><input type="checkbox" data-sq-due-toggle><span>' + esc(t('db.sq.setDue', 'Set due date')) + '</span></label>' +
          '<div class="db-sq-due-mount" data-sq-due-mount hidden></div>' +
          '<p class="db-sq-error" data-sq-error role="alert" hidden></p>' +
        '</form>' +
        '<div class="row spread db-modal-foot">' +
          '<span class="muted small"></span>' +
          '<div class="row" style="gap:.5rem">' +
            '<button type="button" class="ghost" data-sq-cancel>' + esc(t('common.cancel', 'Cancel')) + '</button>' +
            '<button type="button" data-sq-create>' + esc(t('db.sq.create', 'Create sprint')) + '</button>' +
          '</div></div>' +
      '</div>'
    const nameIn = sprintQEl.querySelector('[data-sq-name]')
    const emojiBtn = sprintQEl.querySelector('[data-sq-emoji-btn]')
    const emojiCur = sprintQEl.querySelector('[data-sq-emoji-cur]')
    const emojiLabel = sprintQEl.querySelector('[data-sq-emoji-label]')
    const emojiClear = sprintQEl.querySelector('[data-sq-emoji-clear]')
    const descToggle = sprintQEl.querySelector('[data-sq-desc-toggle]')
    const descTa = sprintQEl.querySelector('[data-sq-desc]')
    const dueToggle = sprintQEl.querySelector('[data-sq-due-toggle]')
    const dueMount = sprintQEl.querySelector('[data-sq-due-mount]')
    // S244 (D6): the shared control instance for this dialog — created ON demand
    // at first reveal (the dialog's innerHTML is rebuilt per open, so a fresh
    // instance per open keeps the state clean).
    let dueCtl = null
    const errEl = sprintQEl.querySelector('[data-sq-error]')
    const createBtn = sprintQEl.querySelector('[data-sq-create]')
    const showErr = (msg) => { errEl.textContent = msg; errEl.hidden = false }
    const hideErr = () => { errEl.hidden = true; errEl.textContent = '' }
    const paintEmoji = () => {
      emojiCur.textContent = emoji || '◆'
      emojiLabel.textContent = emoji ? t('db.sq.changeEmoji', 'Change') : t('db.sq.chooseEmoji', 'Choose emoji')
      emojiClear.hidden = !emoji
    }
    sprintQEl.querySelector('[data-sq-close]').onclick = () => closeSprintQuickCreate(false)
    sprintQEl.querySelector('[data-sq-cancel]').onclick = () => closeSprintQuickCreate(false)
    emojiBtn.onclick = () => {
      const picker = window.hibanaEmojiPicker
      if (!picker) { showErr(t('sparks.saveFailed', "Couldn't save")); return }
      picker.open({ anchor: emojiBtn, current: emoji, onPick: (e2) => { emoji = String(e2 || ''); paintEmoji(); hideErr() } })
    }
    emojiClear.onclick = () => { emoji = ''; paintEmoji() }
    descToggle.onchange = () => { descTa.hidden = !descToggle.checked }
    // S244: revealing mounts the shared control (a toggle ON with no picked date
    // blocks Create inline — the modal's own contract).
    dueToggle.onchange = () => {
      if (dueToggle.checked && !dueCtl && window.HibanaDueControl && window.HibanaDueControl.create) {
        dueCtl = window.HibanaDueControl.create({ value: null })
        dueMount.textContent = ''
        dueMount.appendChild(dueCtl.el)
      }
      dueMount.hidden = !dueToggle.checked
    }
    const doCreate = async () => {
      const name = nameIn.value.trim()
      if (!name) { showErr(t('db.sq.nameRequired', 'Enter a name for the sprint.')); nameIn.focus(); return }
      // S244: the due toggle ON needs a picked date — inline error, never a silent
      // dateless create (the modal's own contract).
      const dueVal = dueCtl ? dueCtl.value() : null
      if (dueToggle.checked && !dueVal) { showErr(t('db.due.required', 'Pick a date for the deadline, or turn it off.')); return }
      hideErr()
      createBtn.disabled = true
      createBtn.textContent = t('db.sq.creating', 'Creating…')
      try {
        const body = { name }
        if (emoji) body.emoji = emoji
        if (descToggle.checked) { const dv = descTa.value.trim(); if (dv) body.description = dv }
        // S244 (§11.2 — superseding assumption 10's interim): the control resolves
        // date-only to LOCAL 23:59 (was the S242 'T23:59:59Z' UTC parse with its
        // ~3.5h Tehran delta); the value is the ISO-8601 UTC instant.
        if (dueToggle.checked) body.due_at = dueVal
        const r = await api('/api/projects/' + state.projectId + '/sprints', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })
        // The synthetic row for the dropdown until the next full reload (the task
        // save's onSaved re-pulls everything authoritative). A quick-create never
        // sends started_at → the sprint is born a DRAFT (planned, is_draft=1).
        sprintQEl._ctx._created = {
          id: r.id, project_id: state.projectId, name: r.name, version: r.version,
          is_draft: r.draft ? 1 : 0, status: r.draft ? 'planned' : 'active',
          emoji: emoji || null, due_at: body.due_at || null, due_origin_at: body.due_at || null,
          started_at: null, ended_at: null, updated_at: new Date().toISOString(),
        }
        closeSprintQuickCreate(true)
      } catch (err) {
        createBtn.disabled = false
        createBtn.textContent = t('db.sq.create', 'Create sprint')
        if (err && err.code === 'duplicate') showErr(t('db.sq.dupErr', 'A sprint with this name already exists in this project — names are case-insensitive.'))
        else if (err && err.code === 'draft_exists') showErr(t('db.draftExists', 'A sprint is already being defined — start it or delete it first'))
        else showErr(t('db.sq.failed', "Couldn't create the sprint — try again."))
      }
    }
    createBtn.onclick = doCreate
    sprintQEl.querySelector('form').onsubmit = (ev) => { ev.preventDefault(); doCreate() }
    sprintQEl.hidden = false
    paintEmoji()
    nameIn.focus()
  }

  // ------------------------------------------------- sprint lifecycle UI (S243)
  // Spec pack Phase 4 (§5/§6 + Screens H1/H2/H3/I): the lifecycle confirmation
  // dialogs + the shared start/resume conflict flow. Richer than the S210
  // hibana.confirm card (counts, sprint identity, multiple actions) — built the
  // S242 quick-create way: a .db-modal overlay + .db-modal-card, dir follows the
  // locale, a capture-phase Esc shield (Escape closes THIS dialog, never
  // whatever lives underneath), z-96 above the sprint popovers and the sprint
  // detail panel. Shared by every surface: sprint.html (the Sprints page rows,
  // draft card + toolbar), board-page.js (the compact Kanban overview) and
  // project-page.js (the embedded board's twin — the S242 parity decision,
  // SHIPPED). The H3 pause keeps the lightweight hibana.confirm card (Screen H3:
  // "a lightweight confirmation is appropriate") — pause is reversible.
  let sprintModEl = null
  let sprintModCtx = null
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sprintModEl && !sprintModEl.hidden) {
      e.preventDefault()
      e.stopPropagation()
      closeSprintModal()
    }
  }, true)
  function closeSprintModal() {
    if (!sprintModEl) return null
    const ctx = sprintModCtx
    sprintModCtx = null
    sprintModEl.hidden = true
    return ctx
  }
  function sprintModal(html, opts) {
    const lang = window.hibanaI18n && window.hibanaI18n.lang ? window.hibanaI18n.lang() : 'en'
    if (!sprintModEl) {
      sprintModEl = document.createElement('div')
      sprintModEl.className = 'db-modal db-sprintmod'
      sprintModEl.setAttribute('role', 'dialog')
      sprintModEl.setAttribute('aria-modal', 'true')
      sprintModEl.hidden = true
      document.body.appendChild(sprintModEl)
      sprintModEl.addEventListener('click', (e) => { if (e.target === sprintModEl) closeSprintModal() })
    }
    sprintModCtx = { onDone: (opts && opts.onDone) || null }
    sprintModEl.innerHTML =
      '<div class="db-modal-card db-sprintmod-card" dir="' + (lang === 'fa' ? 'rtl' : 'auto') + '">' + html + '</div>'
    sprintModEl.hidden = false
    return sprintModEl
  }
  const smHead = (title) =>
    '<div class="row spread db-modal-head"><h3>' + esc(title) + '</h3>' +
    '<button type="button" class="ghost" data-sm-close aria-label="' + esc(t('common.close', 'Close')) + '">✕</button></div>'
  const smIdentity = (s, label) =>
    '<p class="db-sm-identity"><span class="db-sm-glyph" aria-hidden="true">' + esc(sprintGlyph(s)) + '</span>' +
    '<b dir="auto">' + esc(s.name || '') + '</b>' +
    (label ? '<span class="db-sm-role muted small">' + esc(label) + '</span>' : '') + '</p>'
  const smFoot = (cancelLabel, confirmAttrs, confirmLabel, danger) =>
    '<div class="row spread db-modal-foot"><span class="muted small"></span>' +
    '<div class="row" style="gap:.5rem">' +
    '<button type="button" class="ghost" data-sm-cancel>' + esc(cancelLabel) + '</button>' +
    '<button type="button" ' + confirmAttrs + (danger ? ' class="ghost danger"' : '') + '>' + esc(confirmLabel) + '</button>' +
    '</div></div>'
  const smWireCancel = (el) => {
    el.querySelector('[data-sm-close]').onclick = () => closeSprintModal()
    el.querySelector('[data-sm-cancel]').onclick = () => closeSprintModal()
  }

  // H2 (spec §5.3 + Screen H2): "Finish sprint?" — the sprint's identity, the
  // count of tasks in Implemented THAT WILL BE ARCHIVED (client fold of the loaded
  // payload), the count of unfinished tasks that stay put, the explicit
  // "No tasks will be deleted." Confirm → POST /finish → the toast quotes the
  // SERVER's additive archived count (the exact number, never the preview).
  function openSprintFinish(s, opts) {
    if (!s) return
    const o = opts || {}
    const done = o.onDone || null // captured up front: an Esc mid-flight must not swallow the reload (the mutation lands either way)
    const fold = sprintLaneCounts(s.id, o.taskRows)
    const doneN = fold.counts.done || 0
    const unfinished = fold.total - doneN
    const el = sprintModal(
      smHead(t('db.h2.title', 'Finish sprint?')) +
      '<div class="db-sprintmod-body">' +
        smIdentity(s) +
        '<p class="db-sm-line">' + esc(t('db.h2.willArchive', '{n} tasks in Implemented will be archived.').replace('{n}', faDig(doneN))) + '</p>' +
        '<p class="db-sm-line">' + esc(t('db.h2.unfinished', '{n} unfinished tasks stay in their columns and keep this sprint.').replace('{n}', faDig(unfinished))) + '</p>' +
        '<p class="db-sm-line db-sm-safe">' + esc(t('db.h2.noDelete', 'No tasks will be deleted.')) + '</p>' +
      '</div>' +
      smFoot(t('common.cancel', 'Cancel'), 'data-sm-finish', t('db.h2.confirm', 'Finish Sprint'), false),
    o)
    smWireCancel(el)
    const btn = el.querySelector('[data-sm-finish]')
    btn.onclick = async () => {
      btn.disabled = true
      try {
        const r = await finishSprint(s.id) // 200 {ok, archived:n} — the server's exact count
        window.hibana && window.hibana.toast(t('db.h2.done', 'Sprint finished — {n} tasks archived').replace('{n}', faDig(r && r.archived != null ? r.archived : doneN)), 'ok')
        closeSprintModal()
        if (done) done()
      } catch {
        btn.disabled = false
        window.hibana && window.hibana.toast(t('sparks.saveFailed', "Couldn't save"), 'err')
      }
    }
    btn.focus()
  }

  // Screen I (spec §6): the delete confirmation with EXACT impact counts. Active
  // sprints answer the "pause or finish first" guard inline (the 409's twin);
  // completed sprints are history and answer inline too (spec §5.4). Planned +
  // Paused delete through the modal: total associated tasks, non-archived that
  // become "No sprint", archived that keep the "Sprint: <name> (deleted)"
  // snapshot label (counted from the lazy archives list — the row's sprint_id,
  // added S243), and the explicit "No tasks will be deleted."
  async function openSprintDelete(s, opts) {
    if (!s) return
    const o = opts || {}
    const delDone = o.onDone || null // captured up front: an Esc mid-flight must not swallow the reload
    const status = sprintStatusOf(s)
    if (status === 'completed') {
      window.hibana && window.hibana.toast(t('db.del.completed', "Completed sprints are part of your history — they can't be deleted."), 'err')
      return
    }
    if (status === 'active') {
      window.hibana && window.hibana.toast(t('db.del.active', 'Pause or finish this sprint before deleting it.'), 'err')
      return
    }
    const fold = sprintLaneCounts(s.id, o.taskRows)
    // the archived count comes from the archives list (lazy, existing) — the
    // modal opens only when the fetch landed so every count it shows is EXACT;
    // a failed fetch refuses the modal (a miscounted destructive confirm is
    // worse than a retry). Ridden through the shared api() wrapper (no new
    // fetch site; the embedded board passes its own projectId via opts).
    let archivedN = 0
    try {
      const pid = (o.projectId != null ? o.projectId : state.projectId) || ''
      const r = await api('/api/projects/' + pid + '/archives')
      archivedN = ((r && r.archives) || []).filter((a) => a && a.sprint_id === s.id).length
    } catch {
      window.hibana && window.hibana.toast(t('sparks.saveFailed', "Couldn't load"), 'err')
      return
    }
    const total = fold.total + archivedN
    const el = sprintModal(
      smHead(t('db.del.title', 'Delete sprint?')) +
      '<div class="db-sprintmod-body">' +
        smIdentity(s) +
        '<p class="db-sm-line">' + esc(t('db.del.total', '{n} tasks are associated with this sprint.').replace('{n}', faDig(total))) + '</p>' +
        '<p class="db-sm-line">' + esc(t('db.del.unassign', '{n} non-archived tasks will become unassigned (No sprint).').replace('{n}', faDig(fold.total))) + '</p>' +
        '<p class="db-sm-line">' + esc(t('db.del.archived', '{n} archived tasks stay archived, labeled "Sprint: {name} (deleted)".').replace('{n}', faDig(archivedN)).replace('{name}', s.name || '')) + '</p>' +
        '<p class="db-sm-line db-sm-safe">' + esc(t('db.del.noDelete', 'No tasks will be deleted.')) + '</p>' +
      '</div>' +
      smFoot(t('common.cancel', 'Cancel'), 'data-sm-del', t('db.del.confirm', 'Delete Sprint'), true),
    o)
    smWireCancel(el)
    const btn = el.querySelector('[data-sm-del]')
    btn.onclick = async () => {
      btn.disabled = true
      try {
        await deleteSprint(s.id)
        window.hibana && window.hibana.toast(t('db.del.done', 'Sprint deleted'), 'ok')
        closeSprintModal()
        if (delDone) delDone()
      } catch (err) {
        btn.disabled = false
        // the server's twin guards answer inline (a race lost between load + click)
        if (err && err.code === 'sprint_active') window.hibana && window.hibana.toast(t('db.del.active', 'Pause or finish this sprint before deleting it.'), 'err')
        else if (err && err.code === 'sprint_completed') window.hibana && window.hibana.toast(t('db.del.completed', "Completed sprints are part of your history — they can't be deleted."), 'err')
        else window.hibana && window.hibana.toast(t('sparks.saveFailed', "Couldn't save"), 'err')
      }
    }
    btn.focus()
  }

  // H1 (spec §5.2 + Screen H1): start/resume hitting the one-active rule — show
  // BOTH identities and offer three EXPLICIT actions: pause current & start
  // selected, finish current & start selected (the archive count rides the button
  // so the user sees it BEFORE confirming), or cancel. The transition runs as
  // sequential calls (pause → start / finish → start) — atomic from the user's
  // perspective; a lost race re-answers the 409, which is SURFACED (never a
  // silent retry), and the board reloads so the landed partial state shows.
  function openSprintConflict(active, selected, opts) {
    if (!active || !selected || active.id === selected.id) return
    const o = opts || {}
    const armDone = o.onDone || null // captured up front: an Esc mid-flight must not swallow the reload
    const doneN = (sprintLaneCounts(active.id, o.taskRows).counts.done) || 0
    const el = sprintModal(
      smHead(t('db.h1.title', 'Another sprint is active')) +
      '<div class="db-sprintmod-body">' +
        '<p class="db-sm-line">' + esc(t('db.h1.explain', 'Only one sprint can be active in this project at a time.')) + '</p>' +
        '<p class="db-sm-role-lab muted small">' + esc(t('db.h1.current', 'Currently active')) + '</p>' +
        smIdentity(active) +
        '<p class="db-sm-role-lab muted small">' + esc(t('db.h1.starting', 'You are starting')) + '</p>' +
        smIdentity(selected) +
        '<button type="button" class="db-sm-action" data-sm-pause-start>' +
          '<span aria-hidden="true">⏸</span> ' +
          esc(t('db.h1.pauseStart', 'Pause {a} & Start {b}').replace('{a}', active.name || '').replace('{b}', selected.name || '')) +
        '</button>' +
        '<button type="button" class="db-sm-action" data-sm-finish-start>' +
          '<span aria-hidden="true">⏹</span> ' +
          esc(t('db.h1.finishStart', 'Finish {a} & Start {b}').replace('{a}', active.name || '').replace('{b}', selected.name || '')) +
        '</button>' +
        '<p class="db-sm-line muted small">' + esc(t('db.h1.finishNote', 'Finishing archives only tasks in Implemented — {n} will be archived.').replace('{n}', faDig(doneN))) + '</p>' +
      '</div>' +
      '<div class="row spread db-modal-foot"><span class="muted small"></span>' +
        '<div class="row" style="gap:.5rem"><button type="button" class="ghost" data-sm-cancel>' + esc(t('common.cancel', 'Cancel')) + '</button></div>' +
      '</div>',
    o)
    smWireCancel(el)
    const runArm = async (arm) => {
      try {
        if (arm === 'pause') {
          await pauseSprint(active.id)
        } else {
          const r = await finishSprint(active.id)
          if (r && r.archived != null && r.archived > 0) {
            window.hibana && window.hibana.toast(t('db.h2.done', 'Sprint finished — {n} tasks archived').replace('{n}', faDig(r.archived)), 'ok')
          }
          // S243 (the S235 day-window seam): /finish stamps ended_at = NOW (today)
          // and /start stamps started_at = NOW (the same day) — assertSprintWindowOk
          // keeps ONE sprint per day on the timeline, so the start would 400
          // invalid_input EVERY time without the trim. The system's own recorded
          // convention for exactly this case is the create-with-dates auto-close
          // (devboard.ts: closeMs = max(newStart - 1day, sibling.started_at)) — the
          // finish arm applies the SAME trim to the just-finished sprint's band
          // edge before promoting the selected one, so both arms resolve the way
          // the modal promises. The finished sprint's archive stamps stay honest
          // (archived_at keeps the real finish instant; only the BAND edge moves).
          const nowMs = Date.now()
          const startedMs = Date.parse(active.started_at || '') || nowMs
          const trimMs = Math.max(nowMs - 86400000, startedMs + 1) // strictly after its own start (the PATCH guard)
          if (trimMs < nowMs) {
            try { await patchSprint(active.id, { ended_at: new Date(trimMs).toISOString() }) } catch { /* the band keeps the finish stamp — the start below answers honestly */ }
          }
        }
        await startSprint(selected.id) // planned + paused both promote through /start
        window.hibana && window.hibana.toast(t('db.sprintStarted', 'Sprint started'), 'ok')
        closeSprintModal()
        if (armDone) armDone()
      } catch (err) {
        // never a silent retry: surface what the server said, close, and let the
        // caller's onDone reload so any PARTIAL landing (paused but not started)
        // renders honestly.
        if (err && err.code === 'sprint_active_exists') {
          window.hibana && window.hibana.toast(t('db.h1.stale', 'Another sprint became active just now — the board reloaded to show it.'), 'err')
        } else if (err && err.code === 'invalid_input') {
          // the S235 day-window rule (a same-day-started sprint still owns today —
          // the trim above cannot move its edge before its own start). Honest and
          // specific: the current sprint landed; the selected one needs a free day.
          window.hibana && window.hibana.toast(t('db.h1.dayBlocked', '{b} could not start — the timeline keeps one sprint per day and a sprint that started today still covers it. Start it on the next free day.').replace('{b}', selected.name || ''), 'err')
        } else {
          window.hibana && window.hibana.toast(t('sparks.saveFailed', "Couldn't save"), 'err')
        }
        closeSprintModal()
        if (armDone) armDone()
      }
    }
    el.querySelector('[data-sm-pause-start]').onclick = () => runArm('pause')
    el.querySelector('[data-sm-finish-start]').onclick = () => runArm('finish')
    el.querySelector('[data-sm-pause-start]').focus()
  }

  // The shared start/resume flow (spec §5.2): with no active sibling it is one
  // call; with one, the H1 conflict modal resolves it. The 409 belt reads the
  // server's active_id (err.body — S243) so a sprint started in ANOTHER client
  // still resolves by id, never by a stale local guess.
  async function startSprintWithConflict(id, opts) {
    if (!id) return
    const o = opts || {}
    const pool = o.sprints || state.sprints
    const selected = pool.find((x) => x && x.id === id) || null
    if (!selected) return
    const active = pool.find((x) => x && sprintStatusOf(x) === 'active') || null
    if (active && active.id !== id) { openSprintConflict(active, selected, o); return }
    try {
      const status = sprintStatusOf(selected)
      if (status === 'paused') await resumeSprint(id)
      else await startSprint(id)
      window.hibana && window.hibana.toast(t('db.sprintStarted', 'Sprint started'), 'ok')
      if (o.onDone) o.onDone()
    } catch (err) {
      if (err && err.code === 'sprint_active_exists') {
        const activeId = err.body && err.body.active_id
        const real = pool.find((x) => x && x.id === activeId) || pool.find((x) => x && sprintStatusOf(x) === 'active') || null
        if (real && real.id !== id) openSprintConflict(real, selected, o)
        else {
          // the active sprint is unknown to this payload (created after our load)
          // surface it + reload — never guess, never retry silently
          window.hibana && window.hibana.toast(t('db.h1.stale', 'Another sprint became active just now — the board reloaded to show it.'), 'err')
          if (o.onDone) o.onDone()
        }
      } else if (err && err.code === 'strategy_completed') {
        // S250 (0066): starting a sprint whose strategy is COMPLETED is refused —
        // a finished direction takes no running sprints. Name the reason + the fix.
        window.hibana && window.hibana.toast(t('st.startBlocked', 'This sprint\u2019s strategy is completed — re-assign it to an active one first (Settings → Strategy).'), 'err')
      } else {
        window.hibana && window.hibana.toast(t('sparks.saveFailed', "Couldn't save"), 'err')
      }
    }
  }

  // H3 (spec §5.5 + Screen H3): pause stays a LIGHTWEIGHT confirm (hibana.confirm,
  // the app's action convention — reversible, no counts to preview): "tasks stay
  // where they are and keep this sprint."
  async function confirmSprintPause(s, opts) {
    if (!s) return
    const o = opts || {}
    const msg = t('db.pauseConfirm', 'Pause {name}? Tasks stay where they are and keep this sprint.').split('{name}').join(s.name || '')
    const label = t('db.pauseSprint', 'Pause sprint')
    if (!await window.hibana.confirm(msg, { title: label, confirmLabel: label })) return
    try {
      await pauseSprint(s.id)
      window.hibana && window.hibana.toast(t('db.sprintPaused', 'Sprint paused'), 'ok')
      if (o.onDone) o.onDone()
    } catch {
      window.hibana && window.hibana.toast(t('sparks.saveFailed', "Couldn't save"), 'err')
    }
  }

  // Reopen (spec §5.4): completed → active; the one-active 409 resolves through
  // the same H1 modal (the reopen's "Start" arm reads correctly — activation).
  async function reopenSprintFlow(id, opts) {
    if (!id) return
    const o = opts || {}
    const pool = o.sprints || state.sprints
    const selected = pool.find((x) => x && x.id === id) || null
    try {
      await reopenSprint(id)
      window.hibana && window.hibana.toast(t('db.sprintReopened', 'Sprint reopened'), 'ok')
      if (o.onDone) o.onDone()
    } catch (err) {
      if (err && err.code === 'sprint_active_exists') {
        const activeId = err.body && err.body.active_id
        const real = pool.find((x) => x && x.id === activeId) || pool.find((x) => x && sprintStatusOf(x) === 'active') || null
        if (selected && real && real.id !== id) openSprintConflict(real, selected, o)
        else {
          window.hibana && window.hibana.toast(t('db.h1.stale', 'Another sprint became active just now — the board reloaded to show it.'), 'err')
          if (o.onDone) o.onDone()
        }
      } else {
        window.hibana && window.hibana.toast(t('sparks.saveFailed', "Couldn't save"), 'err')
      }
    }
  }

  // ------------------------------------------------ deadline extension UI (S245)
  // Spec pack Phase 6 (§13 + Screens J1/J2/J3): the EXTENSION flows — pure PATCH
  // orchestration over the EXISTING write surface (contract §12.1/§12.4 — no new
  // endpoints, no migrations): the sprint-wide arm PATCHes /api/sprints/:id
  // {due_at} (every inheriting task's server-computed triple re-resolves on the
  // next payload pull); the task-only arm PATCHes /api/devtasks/:id {due_at}
  // (value→value PRESERVES due_origin_at server-side — an extension is not a
  // re-assignment); the INHERITED task-only arm rides the §13.4 origin
  // ride-along (the additive due_origin_at body field, honored server-side only
  // on the null→value transition it creates) so the bar keeps the SPRINT's start
  // point instead of looking newly assigned. The presets ADD TO THE EXISTING
  // deadline — never to the current moment (§13.1). The impact previews fold the
  // payload (the S243 pdOvRows doctrine — never the 5-capped DOM). Shared by
  // every surface (sprint.html, board.html, project.html) through the same
  // window.HibanaBoard exports (spec §18 — no forking).

  /** §13.1: the preset math — the selected duration ADDS TO THE EXISTING
   * deadline, never to the current moment. Hour-exact arithmetic (the same
   * scale the S244 control's own 24/48/72h presets use). */
  const extendPresetDue = (baseIso, hours) => {
    const base = Date.parse(baseIso)
    if (!Number.isFinite(base) || !Number.isFinite(hours) || hours <= 0) return null
    return new Date(base + hours * 3600000).toISOString()
  }

  /** §13.2's BEFORE-confirmation impact preview — the §12.5-style client fold
   * over the loaded payload: tasks with sprint_id === S and due_at == null
   * INHERIT the deadline and follow the extension; due_at != null are PROTECTED
   * by personal overrides (any lane/status — the association is the count). */
  const sprintDeadlineImpact = (sprintId, taskRows) => {
    const rows = taskRows || state.tasks
    let inheritors = 0
    let overrides = 0
    for (const task of rows) {
      if (!task || task.sprint_id !== sprintId) continue
      if (task.due_at == null) inheritors++
      else overrides++
    }
    return { inheritors, overrides }
  }

  /** The dialogs' current/new deadline line — the S244 render stack's own
   * wording ('Due Nov 21 · 16 days left' / 'Overdue by 1 day'), so the dialog
   * and the card read identically. deadlineLabel over a synthetic personal
   * row (the §12.3 vocabulary; never a re-derivation of anything). */
  const deadlineSummary = (iso, lang, nowMs) => {
    const row = { status: '', effective_due_at: iso, effective_due_source: null }
    return deadlineLabel(row, deadlineStateOf(row, nowMs), nowMs, lang)
  }

  /** The four §13.1 choices as chips (the .db-due-presets recipe) + the shared
   * control behind Custom (pre-loaded with the CURRENT value — the user edits
   * from it, D6). Returns the wiring for a freshly-rendered dialog. */
  const extChoicesHtml = () => {
    const chip = (key, label) =>
      '<button type="button" class="db-ext-choice" data-ext-preset="' + key + '">' + esc(label) + '</button>'
    return '<div class="db-ext-choices" data-ext-choices role="group" aria-label="' + esc(t('db.ext.choicesLabel', 'Extension choices')) + '">' +
      chip('24', t('db.ext.p24', '+24 hours')) +
      chip('48', t('db.ext.p48', '+48 hours')) +
      chip('72', t('db.ext.p72', '+72 hours')) +
      chip('custom', t('db.ext.custom', 'Custom date')) +
      '</div>' +
      '<div class="db-ext-custom" data-ext-custom hidden></div>' +
      '<p class="db-ext-preview muted small" data-ext-preview role="status"></p>'
  }

  /** The one extension-picker dialog every flow shares (J1, J2, J3's task-only
   * arm): the head (identity + the current deadline line), the four choices,
   * the live new-deadline preview, the scope lines (impact counts / only-this-
   * task), the origin note (§13.2/§13.3/§13.4 — "the progress start point is
   * preserved"), and a Confirm that stays disabled until a choice is made. */
  function openExtendDialog(cfg) {
    const lang = window.hibanaI18n && window.hibanaI18n.lang ? window.hibanaI18n.lang() : 'en'
    const done = cfg.onDone || null // captured up front: an Esc mid-flight must not swallow the reload
    const el = sprintModal(
      smHead(cfg.title) +
      '<div class="db-sprintmod-body">' +
        cfg.headHtml +
        extChoicesHtml() +
        (cfg.scopeHtml || '') +
        '<p class="db-sm-line db-sm-safe">' + esc(t('db.ext.originNote', 'The progress start point is preserved.')) + '</p>' +
        '<p class="db-due-err" data-ext-err role="alert" hidden></p>' +
      '</div>' +
      smFoot(t('common.cancel', 'Cancel'), 'data-ext-confirm', cfg.confirmLabel || t('db.extendSprint', 'Extend'), false),
      { onDone: done })
    smWireCancel(el)
    const confirmBtn = el.querySelector('[data-ext-confirm]')
    const previewEl = el.querySelector('[data-ext-preview]')
    const customMount = el.querySelector('[data-ext-custom]')
    const errEl = el.querySelector('[data-ext-err]')
    let sel = null // '24' | '48' | '72' | 'custom'
    let ctl = null // the shared control instance (Custom arm only)
    const currentLine = (iso) => esc(t('db.ext.newDeadline', 'New deadline: {d}').replace('{d}', deadlineSummary(iso, lang)))
    const paintPreview = () => {
      const chips = el.querySelectorAll('[data-ext-preset]')
      chips.forEach((c) => { c.classList.toggle('is-on', sel !== null && c.dataset.extPreset === sel) })
      if (sel === 'custom') {
        const v = ctl ? ctl.value() : null
        previewEl.textContent = v ? currentLine(v) : t('db.ext.pickCustom', 'Pick the new date above.')
      } else if (sel) {
        previewEl.textContent = currentLine(extendPresetDue(cfg.baseIso, Number(sel)))
      } else {
        previewEl.textContent = t('db.ext.pickHint', 'Choose an extension to see the new deadline.')
      }
      confirmBtn.disabled = !sel // disabled until a choice is made (a picked Custom rides the control's live value)
    }
    el.querySelector('[data-ext-choices]').onclick = (ev) => {
      const btn = ev.target.closest('[data-ext-preset]')
      if (!btn) return
      sel = btn.dataset.extPreset
      if (errEl) errEl.hidden = true
      if (sel === 'custom') {
        if (!ctl && window.HibanaDueControl && window.HibanaDueControl.create) {
          // D6: the shared Gregorian/Jalali control, PRE-LOADED with the current
          // value — the user edits from the existing deadline (§13.1 Custom).
          ctl = window.HibanaDueControl.create({ value: cfg.baseIso })
          customMount.textContent = ''
          customMount.appendChild(ctl.el)
        }
        customMount.hidden = false
      } else {
        customMount.hidden = true
      }
      paintPreview()
    }
    // the control's own inputs repaint the preview live (delegated change)
    customMount.addEventListener('change', paintPreview)
    customMount.addEventListener('input', paintPreview)
    paintPreview()
    confirmBtn.onclick = async () => {
      const newIso = sel === 'custom' ? (ctl ? ctl.value() : null) : (sel ? extendPresetDue(cfg.baseIso, Number(sel)) : null)
      if (!newIso) {
        if (errEl) { errEl.textContent = t('db.due.required', 'Pick a date for the deadline, or turn it off.'); errEl.hidden = false }
        return
      }
      confirmBtn.disabled = true
      try {
        await cfg.onConfirm(newIso)
        closeSprintModal()
        if (done) done()
      } catch {
        confirmBtn.disabled = false
        window.hibana && window.hibana.toast(t('sparks.saveFailed', "Couldn't save"), 'err')
      }
    }
    confirmBtn.focus()
  }

  /** J1 (§13.2 + Screen J1): the sprint-deadline extension. The presets add to
   * the EXISTING sprint deadline; the impact preview (inheritors follow /
   * overrides protected) shows BEFORE the Confirm; the PATCH rides
   * patchSprint {due_at} — value→value, so the server PRESERVES the sprint's
   * due_origin_at (§13.2's "do not reset the progress start point"). */
  function openSprintDeadlineExtend(s, opts) {
    if (!s || !s.due_at) {
      // no deadline, no extend — the anchors hide themselves; this is the belt
      window.hibana && window.hibana.toast(t('db.ext.noDue', 'No deadline to extend yet — set one first.'), 'err')
      return
    }
    const o = opts || {}
    const lang = window.hibanaI18n && window.hibanaI18n.lang ? window.hibanaI18n.lang() : 'en'
    const rows = o.taskRows || state.tasks
    const impact = sprintDeadlineImpact(s.id, rows)
    openExtendDialog({
      title: t('db.ext.sprintTitle', 'Extend sprint deadline'),
      headHtml:
        smIdentity(s) +
        '<p class="db-sm-line"><span class="muted small">' + esc(t('db.ext.current', 'Current deadline')) + '</span> <b>' + esc(deadlineSummary(s.due_at, lang)) + '</b></p>',
      baseIso: s.due_at,
      scopeHtml:
        '<p class="db-sm-line">' + esc(t('db.ext.inherit', '{n} tasks inherit this deadline and follow the extension.').replace('{n}', faDig(impact.inheritors))) + '</p>' +
        '<p class="db-sm-line">' + esc(t('db.ext.protected', '{n} tasks are protected by personal deadlines and stay unchanged.').replace('{n}', faDig(impact.overrides))) + '</p>',
      onConfirm: async (newIso) => {
        await patchSprint(s.id, { due_at: newIso }) // value→value — due_origin_at preserved (§13.2)
        window.hibana && window.hibana.toast(t('db.ext.done', 'Deadline extended'), 'ok')
      },
      onDone: o.onDone,
    })
  }

  /** J2/J3's task-only picker (§13.3/§13.4 + Screens J2/J3-arm-B): the task's
   * identity, the current deadline (the personal one, or the INHERITED one the
   * override will be based on), the four choices, the "only this task changes"
   * scope line. The personal arm PATCHes value→value (origin preserved by the
   * server's rule); the inherited arm creates the override null→value riding
   * the SPRINT's effective_due_origin_at (§13.4's "preserve the inherited
   * deadline's original progress origin — never make the bar look newly
   * assigned"). */
  function openTaskExtendDialog(task, opts) {
    const o = opts || {}
    const lang = window.hibanaI18n && window.hibanaI18n.lang ? window.hibanaI18n.lang() : 'en'
    const personal = task.due_at != null
    const baseIso = personal ? task.due_at : task.effective_due_at
    if (!baseIso) return
    const sprint = personal ? null : (o.sprints || state.sprints).find((x) => x && x.id === task.sprint_id) || null
    const currentHtml = '<p class="db-sm-line"><span class="muted small">' + esc(t('db.ext.current', 'Current deadline')) + '</span> <b>' + esc(deadlineSummary(baseIso, lang)) + '</b></p>'
    const headHtml =
      '<p class="db-sm-line db-sm-taskline" dir="auto">' + esc(String(task.title || '').split('\n')[0]) + '</p>' +
      currentHtml +
      (personal ? '' :
        (sprint ? '<p class="db-sm-line muted small">' + esc(t('db.ext.inheritedBase', 'Inherited from the sprint deadline — the extension becomes this task’s personal deadline.')) + '</p>' : ''))
    openExtendDialog({
      title: t('db.ext.taskTitle', 'Extend deadline'),
      headHtml,
      baseIso,
      scopeHtml: '<p class="db-sm-line db-sm-safe">' + esc(t('db.ext.onlyTask', 'Only this task changes.')) + '</p>',
      onConfirm: async (newIso) => {
        if (personal) {
          await patchTask(task.id, { due_at: newIso }) // value→value — origin preserved (§13.3)
        } else {
          // §13.4: the override creation rides the SPRINT's origin (the additive
          // S245 ride-along, honored server-side ONLY on this null→value arm).
          const body = { due_at: newIso }
          if (task.effective_due_origin_at) body.due_origin_at = task.effective_due_origin_at
          await patchTask(task.id, body)
        }
        window.hibana && window.hibana.toast(t('db.ext.done', 'Deadline extended'), 'ok')
      },
      onDone: o.onDone,
    })
  }

  /** J3 (§13.4 + Screen J3): the INHERITED-deadline extension CHOICE — two
   * clearly distinct paths with the scope visible BEFORE confirmation, so a
   * task-only intent can never silently move the sprint. The sprint-wide arm
   * reuses J1 (with its full impact preview); the task-only arm opens the
   * picker based on the CURRENT INHERITED deadline. */
  function openInheritedExtendChoice(task, opts) {
    const o = opts || {}
    const lang = window.hibanaI18n && window.hibanaI18n.lang ? window.hibanaI18n.lang() : 'en'
    const pool = o.sprints || state.sprints
    const rows = o.taskRows || state.tasks
    const sprint = pool.find((x) => x && x.id === task.sprint_id) || null
    if (!sprint || !sprint.due_at) return
    const impact = sprintDeadlineImpact(sprint.id, rows)
    const el = sprintModal(
      smHead(t('db.ext.choiceTitle', 'Extend this deadline')) +
      '<div class="db-sprintmod-body">' +
        '<p class="db-sm-line db-sm-taskline" dir="auto">' + esc(String(task.title || '').split('\n')[0]) + '</p>' +
        '<p class="db-sm-line muted small">' + esc(t('db.ext.inherits', 'This task inherits the sprint deadline:')) + '</p>' +
        smIdentity(sprint) +
        '<p class="db-sm-line"><span class="muted small">' + esc(t('db.ext.current', 'Current deadline')) + '</span> <b>' + esc(deadlineSummary(task.effective_due_at, lang)) + '</b></p>' +
        '<button type="button" class="db-sm-action" data-ext-arm-sprint>' +
          '<span aria-hidden="true">⏱</span> ' + esc(t('db.ext.choiceSprint', 'Extend sprint deadline')) +
          '<span class="db-sm-action-sub muted small">' + esc(t('db.ext.choiceSprintSub', 'Moves every task inheriting it — {n} follow, {m} protected.').replace('{n}', faDig(impact.inheritors)).replace('{m}', faDig(impact.overrides))) + '</span>' +
        '</button>' +
        '<button type="button" class="db-sm-action" data-ext-arm-task>' +
          '<span aria-hidden="true">⏱</span> ' + esc(t('db.ext.choiceTask', 'Extend this task only')) +
          '<span class="db-sm-action-sub muted small">' + esc(t('db.ext.choiceTaskSub', 'Creates a personal deadline for this task, based on the inherited one. Other tasks stay unchanged.')) + '</span>' +
        '</button>' +
      '</div>' +
      '<div class="row spread db-modal-foot"><span class="muted small"></span>' +
        '<div class="row" style="gap:.5rem"><button type="button" class="ghost" data-sm-cancel>' + esc(t('common.cancel', 'Cancel')) + '</button></div>' +
      '</div>',
      { onDone: o.onDone || null })
    smWireCancel(el)
    el.querySelector('[data-ext-arm-sprint]').onclick = () => {
      closeSprintModal()
      openSprintDeadlineExtend(sprint, o) // the J1 dialog with its full impact preview
    }
    el.querySelector('[data-ext-arm-task]').onclick = () => {
      closeSprintModal()
      openTaskExtendDialog(task, o)
    }
    el.querySelector('[data-ext-arm-sprint]').focus()
  }

  /** The Extend affordance's ROUTER (the card row / task view / modal link all
   * land here): a PERSONAL deadline (due_at set) → J2; a sprint-sourced
   * inherited deadline (effective_due_source === 'sprint') → J3's choice; no
   * effective deadline → nothing (no deadline, no extend). */
  function openTaskDeadlineExtend(task, opts) {
    if (!task) return
    if (task.due_at != null) { openTaskExtendDialog(task, opts); return }
    if (task.effective_due_source === 'sprint' && task.effective_due_at) { openInheritedExtendChoice(task, opts); return }
  }

  // ---------------------------------------------------------------- label manager
  // S30 batch 4 (user request — "rename/merge/recolor/delete-unused tags, powered by
  // fixing B2"): a dialog listing every user tag with its LIVE usage_count. Row actions:
  // rename (Enter; a colliding name MERGES onto the existing tag), recolor (8-swatch
  // palette), merge (a select of the other tags), delete. S232 (owner: "two labels
  // that can't be deleted") — delete is now on EVERY row: a used label confirms first
  // (the count rides the message) and sends ?force=1 so the server cascades the
  // unlink. Owned here so any surface can open it; board.html's toolbar is the first.
  let labelsEl = null
  let labelsCtx = null // open-flag ({ onChanged } shape kept for renderLabels' guard)
  // The changed-callback lives OUTSIDE the close lifecycle: Esc racing an in-flight
  // action (PATCH → refresh → reload) must not cancel the board's repaint — the chips
  // would silently keep the stale color until the next manual refresh.
  let labelsOnChanged = null

  async function fetchTags() {
    // S206 part 2: same no-store rule (see the api() note) — this reloads the same
    // URL after label edits; same class, same opt-out.
    const res = await window.hibanaFetch('/api/tags', { cache: 'no-store' })
    if (!res.ok) throw new Error('tags failed')
    return (await res.json()).tags || []
  }

  function renderLabels(tags) {
    const el = labelsEl
    if (!el || !labelsCtx) return
    const lang = window.hibanaI18n && window.hibanaI18n.lang ? window.hibanaI18n.lang() : 'en'
    const d = document.createElement('div')
    d.className = 'db-modal-card db-labels-card'
    d.dir = lang === 'fa' ? 'rtl' : 'auto'
    d.innerHTML =
      '<div class="row spread"><h3>' + esc(t('db.labelsTitle', 'Labels')) + '</h3>' +
        '<button type="button" class="ghost" data-lbl-close aria-label="' + esc(t('common.close', 'Close')) + '">✕</button></div>' +
      '<p class="muted small">' + esc(t('db.labelsHint', 'Rename merges onto an existing name; colors are yours to pick; deleting a used label removes it from its tasks.')) + '</p>' +
      // S211 (owner: "the labels do not have an option to delete/create new label"):
      // the dialog had rename/merge/recolor/delete-unused but NO way to CREATE a new
      // label. A create row now sits at the top of the list: color swatch (click →
      // palette) + name input + Create button (or Enter). POST /api/tags {name,color}.
      '<div class="db-label-row db-label-create">' +
        '<span class="db-label-swatch" id="lbl-create-swatch" style="background:#f6d365" title="' + esc(t('db.labelsColor', 'Recolor')) + '"></span>' +
        '<input class="db-label-name" id="lbl-create-name" placeholder="' + esc(t('db.labelsCreatePh', 'New label name…')) + '" maxlength="60" dir="auto" aria-label="' + esc(t('db.labelsName', 'Label name')) + '">' +
        '<span class="db-label-actions">' +
          '<button type="button" class="ghost small" id="lbl-create-color" title="' + esc(t('db.labelsColor', 'Recolor')) + '" aria-label="' + esc(t('db.labelsColor', 'Recolor')) + '">🎨</button>' +
        '</span>' +
        '<button type="button" class="btn small" id="lbl-create-btn">' + esc(t('db.labelsCreate', 'Create')) + '</button>' +
        '<span class="pd-tag-colors db-label-palette" id="lbl-create-palette" hidden>' +
          ['#8AB8F0', '#E8B27D', '#E59AA5', '#8FD3A9', '#B3A5D6', '#7CC7C1', '#F2D58A', '#C9CDD2'].map(function (c) {
            return '<button type="button" class="pd-swatch" data-lbl-create-pick data-color="' + c + '" style="background:' + c + '" aria-label="' + c + '"></button>'
          }).join('') +
        '</span>' +
      '</div>' +
      '<div class="db-labels-list">' + (tags.length ? tags.map(function (tg) {
        return '<div class="db-label-row" data-tag-id="' + esc(tg.id) + '">' +
          '<span class="db-label-swatch" style="background:' + esc(tg.color) + '"></span>' +
          '<input class="db-label-name" value="' + esc(tg.name) + '" maxlength="60" dir="auto" aria-label="' + esc(t('db.labelsName', 'Label name')) + '">' +
          '<span class="muted small db-label-usage">' + esc(t('db.usedTimes', 'used {n}×').split('{n}').join(String(tg.usage_count == null ? 0 : tg.usage_count))) + '</span>' +
          '<span class="db-label-actions">' +
            '<button type="button" class="ghost small" data-lbl-color title="' + esc(t('db.labelsColor', 'Recolor')) + '" aria-label="' + esc(t('db.labelsColor', 'Recolor')) + '">🎨</button>' +
            '<select class="db-label-merge" data-lbl-merge aria-label="' + esc(t('db.labelsMerge', 'Merge into…')) + '">' +
              '<option value="">' + esc(t('db.labelsMergePh', 'merge into…')) + '</option>' +
              tags.filter(function (o) { return o.id !== tg.id }).map(function (o) { return '<option value="' + esc(o.id) + '">' + esc(o.name) + '</option>' }).join('') +
            '</select>' +
            // S232: the ✕ rides EVERY row — a used label deletes through the confirm
            // dialog (the count is in the message); an unused one deletes at once.
            '<button type="button" class="ghost small danger" data-lbl-del title="' + esc(t('db.labelsDel', 'Delete label')) + '" aria-label="' + esc(t('db.labelsDel', 'Delete label')) + '">✕</button>' +
          '</span>' +
          '<span class="pd-tag-colors db-label-palette" hidden>' +
            ['#8AB8F0', '#E8B27D', '#E59AA5', '#8FD3A9', '#B3A5D6', '#7CC7C1', '#F2D58A', '#C9CDD2'].map(function (c) {
              return '<button type="button" class="pd-swatch" data-color="' + c + '" style="background:' + c + '" aria-label="' + c + '"></button>'
            }).join('') +
          '</span>' +
        '</div>'
      }).join('') : '<p class="muted">' + esc(t('db.labelsEmpty', 'No labels yet — add one from a task.')) + '</p>') + '</div>'
    el.innerHTML = ''
    el.appendChild(d)

    const close = function () { el.hidden = true; labelsCtx = null }
    d.querySelector('[data-lbl-close]').onclick = close
    el.onclick = function (ev) { if (ev.target === el) close() }

    // S211: the create-new-label row — color swatch (palette toggle) + name input
    // (Enter creates) + Create button. POST /api/tags {name, color} → 201 {ok,id}
    // or 409 on duplicate name (the API's INSERT OR IGNORE refuses a dupe).
    var createName = d.querySelector('#lbl-create-name')
    var createSwatch = d.querySelector('#lbl-create-swatch')
    var createPaletteBtn = d.querySelector('#lbl-create-color')
    var createPalette = d.querySelector('#lbl-create-palette')
    var createBtn = d.querySelector('#lbl-create-btn')
    var createColor = '#f6d365'
    if (createPaletteBtn) createPaletteBtn.onclick = function () { if (createPalette) createPalette.hidden = !createPalette.hidden }
    if (createSwatch) createSwatch.onclick = function () { if (createPalette) createPalette.hidden = !createPalette.hidden }
    Array.prototype.slice.call(d.querySelectorAll('[data-lbl-create-pick]')).forEach(function (sw) {
      sw.onclick = function () {
        createColor = sw.dataset.color
        if (createSwatch) createSwatch.style.background = createColor
        if (createPalette) createPalette.hidden = true
      }
    })
    async function doCreate() {
      var name = createName ? createName.value.trim() : ''
      if (!name) { createName && createName.focus(); return }
      try {
        var res = await window.hibanaFetch('/api/tags', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name, color: createColor }) })
        if (res.status === 409) { window.hibana && window.hibana.toast(t('db.labelsExists', 'A label with that name already exists'), 'err'); return }
        if (!res.ok) throw new Error('create failed')
        window.hibana && window.hibana.toast(t('db.labelsCreated', 'Label created'), 'ok')
        refresh()
      } catch (e) { window.hibana && window.hibana.toast(t('sparks.saveFailed', "Couldn't save"), 'err') }
    }
    if (createBtn) createBtn.onclick = doCreate
    if (createName) createName.onkeydown = function (ev) {
      if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); doCreate() }
    }

    const rows = Array.prototype.slice.call(d.querySelectorAll('.db-label-row[data-tag-id]'))
    rows.forEach(function (row) {
      const id = row.dataset.tagId
      // the row's OWN tag record (the confirm message quotes the real name + count)
      const tg = tags.find(function (x) { return x.id === id }) || { name: '', usage_count: 0 }
      // rename (Enter) — a colliding name merges (the API doubles as merge)
      const nameIn = row.querySelector('.db-label-name')
      nameIn.onkeydown = async function (ev) {
        if (ev.key !== 'Enter' || ev.isComposing) return
        ev.preventDefault()
        const name = nameIn.value.trim()
        if (!name) return
        try {
          const res = await window.hibanaFetch('/api/tags/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name }) })
          if (!res.ok) throw new Error('rename failed')
          const body = await res.json()
          if (body.merged_into) window.hibana && window.hibana.toast(t('db.labelsMerged', 'Merged into the existing label'))
          else window.hibana && window.hibana.toast(t('sparks.saved', 'Saved'), 'ok')
          refresh()
        } catch (e) { window.hibana && window.hibana.toast(t('sparks.saveFailed', "Couldn't save"), 'err') }
      }
      // recolor palette toggle + pick
      row.querySelector('[data-lbl-color]').onclick = function () {
        const pal = row.querySelector('.db-label-palette')
        if (pal) pal.hidden = !pal.hidden
      }
      Array.prototype.slice.call(row.querySelectorAll('.db-label-palette [data-color]')).forEach(function (sw) {
        sw.onclick = async function () {
          try {
            const res = await window.hibanaFetch('/api/tags/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ color: sw.dataset.color }) })
            if (!res.ok) throw new Error('color failed')
            const swatch = row.querySelector('.db-label-swatch')
            if (swatch) swatch.style.background = sw.dataset.color
            const pal = row.querySelector('.db-label-palette')
            if (pal) pal.hidden = true
            window.hibana && window.hibana.toast(t('sparks.saved', 'Saved'), 'ok')
            refresh() // repaints the list + fires onChanged (the board reloads its chips)
          } catch (e) { window.hibana && window.hibana.toast(t('sparks.saveFailed', "Couldn't save"), 'err') }
        }
      })
      // merge select
      const mergeSel = row.querySelector('[data-lbl-merge]')
      mergeSel.onchange = async function () {
        const into = mergeSel.value
        if (!into) return
        const targetName = mergeSel.options[mergeSel.selectedIndex].textContent
        const msg = t('db.labelsMergeConfirm', 'Merge this label into {name}? Every link moves.').split('{name}').join(targetName)
        if (!await window.hibana.confirm(msg, { title: 'Merge label', confirmLabel: 'Merge' })) { mergeSel.value = ''; return }
        try {
          const res = await window.hibanaFetch('/api/tags/' + id + '/merge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ into: into }) })
          if (!res.ok) throw new Error('merge failed')
          window.hibana && window.hibana.toast(t('db.labelsMerged', 'Merged into the existing label'))
          refresh()
        } catch (e) { window.hibana && window.hibana.toast(t('sparks.saveFailed', "Couldn't save"), 'err') }
      }
      // delete (S232) — every row carries the ✕. A USED label confirms first (the
      // count is in the message; danger grammar) and rides ?force=1 so the server
      // cascades the unlink from its tasks; an unused one deletes at once, as ever.
      // A 409 back means the tag came back into use between load and click — surface
      // it instead of the generic save-failed toast.
      const delBtn = row.querySelector('[data-lbl-del]')
      if (delBtn) delBtn.onclick = async function () {
        const used = (tg.usage_count == null ? 0 : tg.usage_count) > 0
        if (used) {
          const msg = t('db.labelsDelConfirm', 'Delete "{name}"? It is used by {n} tasks — the label will be removed from those tasks.')
            .split('{name}').join(tg.name)
            .split('{n}').join(String(tg.usage_count == null ? 0 : tg.usage_count))
          if (!await window.hibana.confirm(msg, { title: t('db.labelsDelTitle', 'Delete label'), danger: true })) return
        }
        try {
          const res = await window.hibanaFetch('/api/tags/' + id + (used ? '?force=1' : ''), { method: 'DELETE' })
          if (res.status === 409) { window.hibana && window.hibana.toast(t('db.labelsInUse', 'That label is in use — reopen Labels and try again'), 'err'); return }
          if (!res.ok) throw new Error('delete failed')
          window.hibana && window.hibana.toast(t('db.labelsDeleted', 'Label deleted'), 'ok')
          refresh()
        } catch (e) { window.hibana && window.hibana.toast(t('sparks.saveFailed', "Couldn't save"), 'err') }
      }
    })
  }

  async function refresh() {
    // labelsOnChanged is close-proof (see its declaration) — the board reload fires
    // even when Esc beat the async chain.
    const cb = labelsOnChanged
    try {
      const tags = await fetchTags()
      renderLabels(tags)
    } catch (e) { window.hibana && window.hibana.toast(t('sparks.saveFailed', "Couldn't load"), 'err') }
    if (cb) cb()
  }

  async function openLabels(opts) {
    labelsCtx = { open: true }
    labelsOnChanged = (opts && opts.onChanged) || null
    if (!labelsEl) {
      labelsEl = document.createElement('div')
      labelsEl.className = 'db-modal'
      labelsEl.setAttribute('role', 'dialog')
      labelsEl.setAttribute('aria-modal', 'true')
      labelsEl.hidden = true
      document.body.appendChild(labelsEl)
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && labelsEl && !labelsEl.hidden) { labelsEl.hidden = true; labelsCtx = null } })
    }
    labelsEl.hidden = false
    await refresh()
  }

  window.HibanaBoard = {
    state, load, api, t, esc, faDig,
    STATUSES, PRIORITIES, PRIO_CYCLE, cyclePriority, mdTaskLine, statusLabel, prioLabel, openLabels,
    DAY, dayIdx, todayIdx, calOf, monthLabel, dayLabel, fullLabel, weekdayIdx,
    findTask, findCategory, findSprint, tagById,
    // S254 (FE-1): the state-merge stack for the per-column repaint (board) and
    // the no-refetch render (sprint) — exported for the pages' repaint flows.
    mergeTaskPatch, mergeCreatedTask, applyReorder, removeTaskLocal, sortTasksLikeServer,
    createTask, patchTask, deleteTask, reorderTasks, addTaskTag, removeTaskTag,
    createCategory, patchCategory, deleteCategory, reorderCategories,
    createSprint, startSprint, patchSprint, renameSprint, finishSprint, reopenSprint, deleteSprint,
    // S250 (0066 — STRATEGIES-SPEC §4): the strategy tier's shared stack — lookups,
    // lifecycle coalescing, the glyph, and the three write wrappers. Exported so
    // sprint.html owns the ONLY strategies surface this phase (spec §5: task cards
    // carry nothing; board/project pages stay untouched) without forking a second
    // implementation (spec §18 — no forking).
    createStrategy, patchStrategy, deleteStrategy,
    findStrategy, strategyStatusOf, strategyGlyph,
    // S243 (spec pack Phase 4): pause/resume wrappers + the lifecycle UI stack —
    // statusOf/laneCounts helpers, the H2 finish + Screen-I delete confirmations,
    // the H1 one-active conflict modal + the shared start/resume/reopen flows,
    // and the H3 lightweight pause confirm. Exported so sprint.html, board.html
    // and project.html share ONE implementation (spec §18 — no forking).
    pauseSprint, resumeSprint,
    sprintGlyph, sprintCompleted, sprintStatusOf, sprintLaneCounts,
    // S255 (BE-3): the payload-diet stack — the both-shapes ☑ fold + the doc-fetch
    // affordance (the choke-point rider). Exported so every sprint surface reads
    // the stat through ONE seam regardless of which payload variant booted.
    sprintDocChecked, sprintDoc,
    // S244 (spec pack Phase 5 — §12): the shared deadline RENDER stack — the
    // classification (§12.3 thresholds, client-side rendering of the
    // server-resolved triple), the elapsed-time ratio (§12.2, from the payload's
    // effective_due_origin_at — never re-derived), and the card row + bar grammar.
    // Exported so board-page.js AND project-page.js render identically (§18).
    deadlineStateOf, deadlineElapsedPct, deadlineRowHtml, deadlineViewHtml,
    // S246 (spec pack Phase 7 — §14-§16 + Screens K/L): the shared dependency
    // stack — the folds (Blocked-by rows, the DERIVED reverse Blocks count,
    // §16.1's blocked/ready classification: blocked until ALL blockers are
    // complete) + the compact card badges (Screen L — their own row, fully
    // independent of the priority ribbon AND the deadline display) + the task
    // view's row-only twin (the details surface — blocker NAMES live here per
    // §16) + the dep-edge write wrappers (the patchTask shape, riding the
    // shared api() — ZERO new fetch sites). Exported so board-page.js AND
    // project-page.js render identically (§18 — never forked).
    depsOf, blocksCount, blockedStateOf, depBadgeHtml, depViewHtml, addTaskDep, removeTaskDep,
    // S245 (spec pack Phase 6 — §13 + Screens J1/J2/J3): the deadline EXTENSION
    // stack — the preset math (§13.1: add to the EXISTING deadline, never now),
    // the §13.2 impact fold (inheritors follow / overrides protected — the
    // §12.5-style payload fold), and the three flows' entry points (J1 the
    // sprint-wide dialog, the J2/J3 router that opens the task picker or the
    // inherited CHOICE modal — never a silent sprint change). Exported so
    // sprint.html, board.html and project.html share ONE implementation (§18).
    extendPresetDue, sprintDeadlineImpact, openSprintDeadlineExtend, openTaskDeadlineExtend,
    openSprintFinish, openSprintDelete, openSprintConflict,
    startSprintWithConflict, confirmSprintPause, reopenSprintFlow,
    openEditor, openTaskShots, // S208: the pinned-pictures dialog (the card badge)
  }
})()
