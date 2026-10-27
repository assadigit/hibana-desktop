// public/js/chip-render.js — S30 batch 5 (the W3 first slice, user request
// 2026-09-12): the ONE shared title-clamp + tag-chip renderer.
//
// Before this module the EXACT same title renderer (fenced ``` code blocks, **bold**,
// 150-char clamp + hidden .pd-title-rest + read-more button) lived copy-pasted in
// board-page.js AND project-page.js (the server keeps its own detail-helpers.ts twin —
// htmx fragments re-render server-side, that copy is load-bearing there), and the label
// chip had two near-twins (project .pd-tag span vs board .db-mini-chip button).
// sticky.js set the consolidation pattern (Session 28): a tiny IIFE global, both pages
// delegate, zero behavior change — the e2e net (read-more toggles, label filters,
// copy/export reading textContent) pins the contract.
//
// Contract details that MUST stay byte-compatible (pages + tests depend on them):
//   · titleHtml: first TITLE_CLAMP chars visible, the rest inside a hidden
//     .pd-title-rest span WITHIN the title element — textContent keeps reading the
//     FULL title (copy/export/delete-confirm/the magic wand all consume it).
//   · renderTitle: fence LINES open/close a <code class="t-code" dir="ltr"> container
//     with the fence lines kept in <span hidden class="t-fence"> markers INSIDE it —
//     textContent round-trips the RAW title exactly. Unclosed fences render as code
//     till end (self-healing). Prose lines get **pair** → <strong>.
//   · readMoreBtn: [data-task-read-more] button, aria-expanded sync — both pages'
//     delegated togglers query exactly this.
//   · chips: .pd-tag (span, filter-clickable via the pages' .pd-tag delegation) and
//     .db-mini-chip (button, data-tag-name lowercase — the board's filter key).
/* global window */
(function () {
  'use strict'

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const t = (k, f) => (window.hibanaI18n && window.hibanaI18n.t(k)) || f

  const TITLE_CLAMP = 150

  // Session 23 renderer (user request): titles may carry fenced ``` CODE blocks,
  // **bold** spans, - / * BULLET lists and manual line breaks.
  // S46.8 (owner: "The bullet point is not tied to text items. fix it"): `- ` / `* `
  // prefixed lines now render as <ul><li> with proper list-style (bullets sit NEXT to
  // the text via padding-inline-start, not detached on the far edge). The \n between
  // list items is suppressed (the <ul> layout is structural — pre-line would add
  // blank lines between items).
  // S48d (owner: "fullscreen editor needs underline/strikethrough/ordered-list/
  // alignment"): added __underline__ → <u>, ~~strikethrough~~ → <s>, 1. ordered list
  // → <ol><li>, and {:left}/{:center}/{:right}/{:justify} paragraph-alignment markers
  // → <div style="text-align:…">. The inline transforms (bold/underline/strike) run
  // on every prose line (not inside code fences or list items, which keep their own
  // structure). Alignment markers wrap the whole paragraph in a styled div.
  function renderTitle(raw) {
    const escd = esc(raw)
    const hasFence = /(^|\n)\s*```/.test(escd)
    const hasBold = /\*\*[^*\n]+\*\*/.test(escd)
    const hasUnderline = /__[^_\n]+__/.test(escd)
    const hasStrike = /~~[^~\n]+~~/.test(escd)
    const hasBullet = /(^|\n)\s*[-*]\s+/.test(escd)
    const hasOrdered = /(^|\n)\s*\d+\.\s+/.test(escd)
    const hasAlign = /(^|\n)\s*\{:(?:left|center|right|justify)\}/.test(escd)
    if (!hasFence && !hasBold && !hasUnderline && !hasStrike && !hasBullet && !hasOrdered && !hasAlign) return escd
    // inline transforms shared by prose + list items (NOT code)
    const inline = (s) => s
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_\n]+)__/g, '<u>$1</u>')
      .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    const lines = escd.split('\n')
    let out = ''
    let inCode = false, inUl = false, inOl = false
    const closeUl = () => { if (inUl) { out += '</ul>'; inUl = false } }
    const closeOl = () => { if (inOl) { out += '</ol>'; inOl = false } }
    const closeLists = () => { closeUl(); closeOl() }
    // group consecutive alignment-marked lines into one <div> per paragraph
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const nl = i < lines.length - 1 ? '\n' : ''
      if (!inCode && /^\s*```/.test(line)) {
        closeLists()
        inCode = true
        const codeLang = line.trim().slice(3).trim()
        out += '<code class="t-code"' + (codeLang ? ' data-lang="' + codeLang + '"' : '') + ' dir="ltr"><span hidden class="t-fence">' + line + '</span>'
      } else if (inCode && line.trim() === '```') {
        inCode = false
        out += '<span hidden class="t-fence">' + line + '</span></code>' + nl
      } else if (inCode) {
        out += line + nl
      } else {
        // alignment marker — wrap the paragraph in a styled div (toggled off at the next blank line / non-aligned line)
        const am = line.match(/^(\s*)\{:(left|center|right|justify)\}(.*)$/)
        if (am) {
          closeLists()
          out += '<div style="text-align:' + am[2] + '">' + inline(am[3]) + '</div>'
          // no nl — the div is structural
        } else {
          const bm = line.match(/^(\s*)(?:[-*])\s+(.*)$/)
          const om = line.match(/^(\s*)(\d+)\.\s+(.*)$/)
          if (bm) {
            closeOl()
            if (!inUl) { out += '<ul>'; inUl = true }
            out += '<li>' + inline(bm[2]) + '</li>'
          } else if (om) {
            closeUl()
            if (!inOl) { out += '<ol>'; inOl = true }
            out += '<li>' + inline(om[3]) + '</li>'
          } else {
            closeLists()
            out += inline(line) + nl
          }
        }
      }
    }
    closeLists()
    if (inCode) out += '</code>'
    return out
  }

  // Session 22 (user request): unlimited titles clamp at TITLE_CLAMP CHARS.
  // S48j (owner: "in the box, only title must be shown — like UI/UX Tweaks. When
  //   clicked you can see full plans"): the card now shows ONLY the first line (the
  //   title). The full title+content is stored in data-raw-title (the editor reads it
  //   on open → splits on \n → title field + content field).
  function titleHtml(title) {
    const s = String(title == null ? '' : title)
    const nl = s.indexOf('\n')
    const titleOnly = nl >= 0 ? s.slice(0, nl) : s
    if (titleOnly.length <= TITLE_CLAMP) return renderTitle(titleOnly)
    return renderTitle(titleOnly.slice(0, TITLE_CLAMP)) + '<span class="pd-title-rest" hidden>' + renderTitle(titleOnly.slice(TITLE_CLAMP)) + '</span>'
  }

  const titleAttrs = (title) => {
    const s = String(title || '')
    return (s.length > TITLE_CLAMP ? ' data-clamped=""' : '') + ' data-raw-title="' + esc(s) + '"'
  }

  const readMoreBtn = (title) => (String(title || '').length > TITLE_CLAMP
    ? '<button type="button" class="pd-read-more" data-task-read-more aria-expanded="false">' + esc(t('pd.readMore', 'read more')) + '</button>'
    : '')

  // S86 (owner request): the content PREVIEW under the task heading — the lines after
  // the first \n, flattened, ~110 chars, single-line ellipsis. Mirrors the server's
  // previewHtml in projects/detail-helpers.ts so client-inserted tasks render the
  // same card shape as the server-rendered ones.
  const PREVIEW_CLAMP = 110
  function previewHtml(title) {
    const s = String(title == null ? '' : title)
    const nl = s.indexOf('\n')
    if (nl < 0) return ''
    const rest = s.slice(nl + 1).replace(/\s+/g, ' ').trim()
    if (!rest) return ''
    const cut = rest.length > PREVIEW_CLAMP
    return '<span class="pd-task-preview" dir="auto">' + esc(rest.slice(0, PREVIEW_CLAMP)) + (cut ? '…' : '') + '</span>'
  }

  // Label chips. kind 'pd' (project page — span; the page's delegation makes it a
  // filter toggle) or 'db' (board — button carrying the lowercase filter key).
  function tagChip(name, color, kind) {
    const n = String(name == null ? '' : name)
    const c = String(color || '#8AB8F0')
    if (kind === 'db') {
      return '<button type="button" dir="auto" class="db-mini-chip" data-tag-name="' + esc(n.toLowerCase()) + '" style="background:' + esc(c) + '26" title="' + esc(t('db.filterTagHint', 'Click to filter by this label')) + '"><span style="color:' + esc(c) + '">●</span> ' + esc(n) + '</button>'
    }
    // dir="auto" (S32 — the general bidi law at chip level): the leading dot must LEAD
    // the label on both sides — flex order follows the element's dir, so a Latin label
    // flips the whole chip LTR (dot left) while a Farsi one keeps dot-right. The chip
    // text itself is covered by the .pd-tag/.db-mini-chip plaintext rule (polish-batch).
    return '<span dir="auto" class="pd-tag" data-pd-tag-name="' + esc(n) + '"><i class="pd-tag-dot" style="background:' + esc(c) + '"></i>' + esc(n) + '</span>'
  }
  // The project page's chip ROW (list = [{name, color}]).
  function tagChipsRow(list, extra) {
    // S209 (kanban 1:1 parity): `extra` appends trailing markup INSIDE the
    // .pd-task-tags row (the embedded board's ◆ sprint badge — the same chip
    // the /kanban cards carry); empty lists + an extra still render the row.
    const inner = (list && list.length ? list.map((tg) => tagChip(tg.name, tg.color, 'pd')).join('') : '') + (extra || '')
    if (!inner) return ''
    return '<span class="pd-task-tags">' + inner + '</span>'
  }

  // Re-clamp an existing title element in place (after edits / wand writes).
  // S77 (owner: "paste code in the editor, save, come back — gone"): data-raw-title
  // MUST move in lockstep with innerHTML — the task editor reopens from this
  // attribute. A stale value meant the just-saved content vanished on reopen, and
  // saving THAT stale view would permanently revert the edit in the DB.
  function applyTitle(el, text) {
    if (!el) return
    el.innerHTML = titleHtml(text)
    el.setAttribute('data-raw-title', String(text ?? ''))
    if (String(text || '').length > TITLE_CLAMP) el.setAttribute('data-clamped', '')
    else el.removeAttribute('data-clamped')
    const btn = el.parentElement ? el.parentElement.querySelector('[data-task-read-more]') : null
    if (btn) {
      if (String(text || '').length > TITLE_CLAMP) {
        btn.hidden = false
        btn.textContent = t('pd.readMore', 'read more')
        btn.setAttribute('aria-expanded', 'false')
      } else {
        btn.hidden = true
      }
    }
    // S86: the content preview rides the same write — a wand translation or an edit
    // changes the content too, and a stale preview would contradict the card above it.
    const body = el.closest('.pd-task-body')
    if (body) {
      const old = body.querySelector('.pd-task-preview')
      const next = previewHtml(text)
      if (old && next) old.outerHTML = next
      else if (old && !next) old.remove()
      else if (next) {
        // insert right after the title row (before read-more/chips/meta)
        const row = body.querySelector('.pd-task-title-row')
        if (row) row.insertAdjacentHTML('afterend', next)
      }
    }
  }

  // htmlToMd (S49, moved verbatim from project-page.js's pdeHtmlToMd): the WYSIWYG
  // contenteditable's HTML → markdown, i.e. the exact INVERSE of renderTitle above.
  // Storage stays markdown (backward compatible — the DB + renderer + detail-helpers.ts
  // twin all speak markdown); the editor converts on save (htmlToMd) and on load
  // (renderTitle). Walks the DOM + converts execCommand's browser-dependent output
  // (Chrome: <b>/<u>/<s>; others: <strong>/<span style>) back to the markdown syntax.
  // Pure function — only touches the `document` it runs against, no page state, so it
  // lives here next to its renderTitle twin (same consolidation pattern as S30b5).
  //
  // S77 (owner report: "<code> in the text editor — paste code inside, it shows, but
  // after save + come back it's lost"): Chromium NEVER inserts a raw \n into a
  // contenteditable. A multi-line paste/typing inside a code block is split into
  // SIBLING elements — inside a toolbar-inserted block: <pre><code>line1</code>
  // <code>line2</code>…</pre>; inside a loaded bare .t-code island: consecutive
  // <code class="t-code">line1</code><code class="t-code">line2</code>… at the
  // container root. The old converter read el.querySelector('code') (the FIRST
  // sibling only) → every line after the first was silently DROPPED from the saved
  // markdown (permanent data loss), and the bare-island run produced one separate
  // ``` fence per line. Both splits are now rejoined into ONE fence.
  function htmlToMd(html) {
    const tmp = document.createElement('div')
    tmp.innerHTML = html
    // A code element's CONTENT: text nodes verbatim, <br> → newline, hidden .t-fence
    // markers + the S176 non-editable header bar (dropdown + copy button) skipped —
    // neither the fence markers nor the bar's chrome are ever code content.
    const codeText = (el) => {
      let out = ''
      for (const c of el.childNodes) {
        if (c.nodeType === 3) { out += c.textContent; continue }
        if (c.nodeType !== 1) continue
        if (c.classList && (c.classList.contains('t-fence') || c.classList.contains('t-code-bar'))) continue
        if (c.tagName === 'BR') { out += '\n'; continue }
        out += codeText(c)
      }
      return out
    }
    // Merge a RUN of sibling .t-code islands (Chromium's line-split output) into ONE
    // fenced block: pieces joined with \n, each piece's edge newlines trimmed (the
    // loaded island carries a trailing \n before its closing fence marker).
    const isTCode = (el) => el.classList && el.classList.contains('t-code')
    const fenceFor = (pieces, lang) => {
      const content = pieces
        .map((p) => p.replace(/^[\n]+|[\n]+$/g, ''))
        .join('\n')
      return '\n```' + (lang || '') + '\n' + content + '\n```\n'
    }
    const walk = (node) => {
      let out = ''
      const children = Array.from(node.childNodes)
      for (let i = 0; i < children.length; i++) {
        const child = children[i]
        if (child.nodeType === 3) { out += child.textContent; continue }
        if (child.nodeType !== 1) continue
        if (isTCode(child) && !child.closest('pre')) {
          const lang = child.getAttribute('data-lang') || ''
          const pieces = [codeText(child)]
          let j = i + 1
          while (j < children.length) {
            const nxt = children[j]
            if (nxt.nodeType === 3 && nxt.textContent.trim() === '') { j++; continue }
            if (nxt.nodeType === 1 && isTCode(nxt)) { pieces.push(codeText(nxt)); j++; continue }
            break
          }
          out += fenceFor(pieces, lang)
          i = j - 1
          continue
        }
        out += elToMd(child)
      }
      return out
    }
    const elToMd = (el) => {
      const tag = el.tagName.toLowerCase()
      const inner = walk(el)
      switch (tag) {
        case 'b': case 'strong': return '**' + inner + '**'
        case 'u': return '__' + inner + '__'
        case 's': case 'strike': case 'del': return '~~' + inner + '~~'
        case 'ul': case 'ol': return inner // <li> handles its own marker
        case 'li': {
          const parent = el.parentElement
          if (parent && parent.tagName === 'OL') {
            const sibs = Array.from(parent.children).filter((n) => n.tagName === 'LI')
            return (sibs.indexOf(el) + 1) + '. ' + inner + '\n'
          }
          return '- ' + inner + '\n'
        }
        case 'div': case 'p': {
          const align = el.style && el.style.textAlign
          if (align) return '{:' + align + '}' + inner + '\n'
          return inner + '\n'
        }
        case 'pre': {
          // S77: Chromium splits a multi-line paste inside the toolbar's code block
          // into SIBLING <code> elements (one per line) inside the <pre>. The old
          // el.querySelector('code') read the FIRST one only — every line after it
          // was silently dropped from the saved markdown. Collect them all.
          // S176: the container is <pre class="t-code-pre" data-lang> now — the fence
          // keeps the block's language (```python), and the non-editable header bar
          // (a direct <pre> child, never a <code>) is excluded by construction: only
          // the CODE elements are the content. The hljs token SPANS are transparent —
          // codeText recurses through them and the saved fence stays PLAIN TEXT.
          const lang = (el.getAttribute('data-lang')
            || (el.querySelector('code') ? el.querySelector('code').getAttribute('data-lang') : '') || ''
          ).toLowerCase()
          const codes = el.querySelectorAll('code')
          let text
          if (codes.length > 1) text = Array.from(codes).map((c) => codeText(c)).join('\n')
          else text = codes.length === 1 ? codeText(codes[0]) : codeText(el)
          return '\n```' + lang + '\n' + text + '\n```\n'
        }
        case 'code': {
          // A .t-code island that reached elToMd singly (walk already merges sibling
          // runs) — extract the content (skip hidden fence spans) + reconstruct the fence.
          if (el.classList && el.classList.contains('t-code')) {
            const lang = el.getAttribute('data-lang') || ''
            return '\n```' + lang + '\n' + codeText(el) + '\n```\n'
          }
          return inner // inline code — just return the text
        }
        case 'br': return '\n'
        case 'span': {
          // Chrome sometimes emits <span style="text-decoration:underline"> for
          // underline (when execCommand('underline') runs on a partial selection
          // inside an existing inline). Detect + convert.
          const deco = el.style && el.style.textDecoration
          if (deco && deco.includes('underline')) return '__' + inner + '__'
          if (deco && deco.includes('line-through')) return '~~' + inner + '~~'
          return inner
        }
        default: return inner
      }
    }
    return walk(tmp).replace(/\n{3,}/g, '\n\n').trim()
  }

  // --- S110 (v0.3.43.0): the SHARED card meta line ---------------------------------
  // The fullscreen board's meta was a bare date ("22 Sep 2026") while the project
  // page's progress box rendered "<priority label> · date · clock" — the last
  // remaining token drift of the [MEDIUM] "fullscreen box must inherit the exact
  // design tokens" item. chip-render is loaded by BOTH surfaces, so the meta
  // composition lives here ONCE; the e2e parity pin asserts the two surfaces render
  // byte-identical meta for the same task. Twin of project-page.js's pdMetaLine /
  // pdPrioLabel (lang passed explicitly — this module has no page context).
  const PRIO_LABEL = {
    urgent: { en: 'Urgent', fa: 'فوری' },
    high: { en: 'High Priority', fa: 'اولویت بالا' },
    medium: { en: 'Medium Priority', fa: 'اولویت متوسط' },
    low: { en: 'Low Priority', fa: 'اولویت کم' },
  }
  const faDig = (s) => String(s).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[+d])
  const G_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  function prioLabel(p, lang) {
    const e = PRIO_LABEL[p] || PRIO_LABEL.medium
    return lang === 'fa' ? e.fa : e.en
  }
  // Meta line under a task title: date + CLOCK — Jalali + FA digits when fa (Intl
  // persian calendar; the pages never load the jalaali vendor for this), Gregorian +
  // 12h clock when en. UTC edge — twin of the server-side taskMetaLabel() in
  // routes/projects.ts and of project-page.js's pdMetaLine (pinned equal by e2e).
  function metaLine(iso, done, lang) {
    const fa = lang === 'fa'
    const d = new Date(iso)
    if (isNaN(d.getTime())) return ''
    const hh = d.getUTCHours()
    const mm = String(d.getUTCMinutes()).padStart(2, '0')
    const clock = fa
      ? faDig(String(hh).padStart(2, '0')) + ':' + faDig(mm)
      : ((hh % 12) || 12) + ':' + mm + ' ' + (hh < 12 ? 'AM' : 'PM')
    let date
    if (fa) {
      try {
        date = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).format(d)
      } catch {
        date = d.toISOString().slice(0, 10)
      }
    } else {
      date = d.getUTCDate() + ' ' + G_MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear()
    }
    return (done ? '✓ ' : '') + date + ' · ' + clock
  }
  function metaHtml(prio, iso, done, lang) {
    return '<span class="pd-meta-prio prio-' + esc(prio || 'medium') + '">' + esc(prioLabel(prio || 'medium', lang)) + '</span> · ' + esc(metaLine(iso, done, lang))
  }
  // S144 (owner: the priority banner): the meta line WITHOUT the priority label — the
  // PRIORITY BANNER fused across the card's top carries the label now, so the card's
  // footer keeps just the date + clock. metaHtml stays exported for any surface that
  // still wants the label inline.
  function metaDateHtml(iso, done, lang) {
    return esc(metaLine(iso, done, lang))
  }

  // ---------------------------------------------------------------------------
  // The per-card sync badge (hibana-sync-status-spec.md §4–§6, §12). ONE badge
  // component for every kanban card type — the client twin of detail-helpers.ts's
  // server-side badge (a fresh server render is 'synced' by definition: the data
  // came from the server). Markup contract shared with the server twin — keep
  // them byte-compatible. Icons: the SAME 24×24 stroke grammar as the page
  // header's Sync button (base.css .icon — one stroke-weight system), all four
  // the same size; the syncing glyph is the header Sync button's own arrows.
  const SYNC_ICONS = {
    pending: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M17.5 13.5a4 4 0 0 0-.3-7.99A5.5 5.5 0 0 0 6.9 4.6 3.5 3.5 0 0 0 7 13.5Z"/><path d="M12 21v-5"/><path d="M9.5 18.5 12 16l2.5 2.5"/></svg>',
    syncing: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10"/><path d="M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/></svg>',
    synced: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M17.5 18.5a4 4 0 0 0-.3-7.99A5.5 5.5 0 0 0 6.9 9.6 3.5 3.5 0 0 0 7 18.5Z"/><path d="m9.5 12.5 2 2 3.5-3.5"/></svg>',
    failed: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M17.5 18.5a4 4 0 0 0-.3-7.99A5.5 5.5 0 0 0 6.9 9.6 3.5 3.5 0 0 0 7 18.5Z"/><path d="M12 9.5v4.5"/><path d="M12 17.4v.3"/></svg>',
  }
  const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false
  // Spec §4 label table (EN + FA live in i18n-en.js / i18n-fa.js under sync.*).
  // Offline Pending swaps to the "Waiting for connection" label (§8).
  function syncLabel(state) {
    if (state === 'pending') return isOffline() ? t('sync.pendingOffline', 'Waiting for connection') : t('sync.pending', 'Saved on this device')
    if (state === 'syncing') return t('sync.syncing', 'Syncing…')
    if (state === 'failed') return t('sync.failed', "Couldn't sync. Retry")
    return t('sync.synced', 'Synced')
  }
  // The CARD badge: icon-only for pending/syncing/synced (no text on the card, no
  // tab stop — the label is the accessible name and the hover tooltip, spec §12);
  // failed is a real pill BUTTON with the word Retry (spec §6) whose click
  // re-runs just that card's mutation (sync-state.js's delegated handler).
  function syncBadgeHtml(id, state, pop) {
    const s = state === 'pending' || state === 'syncing' || state === 'failed' ? state : 'synced'
    const label = syncLabel(s)
    if (s === 'failed') {
      return '<button type="button" class="pd-sync s-failed" data-sync-badge="' + esc(id) + '" data-sync-retry="' + esc(id) + '" data-label="' + esc(label) + '" aria-label="' + esc(label) + '">' + SYNC_ICONS.failed + '<span class="pd-sync-label">' + esc(t('sync.retry', 'Retry')) + '</span></button>'
    }
    const popCls = pop && s === 'synced' ? ' pop' : ''
    return '<span class="pd-sync s-' + s + popCls + '" data-sync-badge="' + esc(id) + '" data-label="' + esc(label) + '" role="img" aria-label="' + esc(label) + '">' + SYNC_ICONS[s] + '</span>'
  }
  // The DETAIL badge (spec §10): same component family, worn near the Save area of
  // the task editor (devboard.js's modal footer) — the icon plus the text label,
  // and when synced, the time of the last confirmed sync ("Synced 2 minutes ago").
  function syncedAgoText(atMs) {
    const mins = Math.max(0, Math.round((Date.now() - atMs) / 60000))
    const lang = (window.hibanaI18n && window.hibanaI18n.lang && window.hibanaI18n.lang()) || (typeof document !== 'undefined' && document.documentElement.lang) || 'en'
    let rel = ''
    try { rel = new Intl.RelativeTimeFormat(lang === 'fa' ? 'fa' : 'en', { numeric: 'auto' }).format(-mins, 'minute') } catch { return t('sync.synced', 'Synced') }
    return t('sync.synced', 'Synced') + ' ' + rel
  }
  function syncBadgeDetailHtml(id, state, pop, syncedAtMs) {
    const s = state === 'pending' || state === 'syncing' || state === 'failed' ? state : 'synced'
    const label = syncLabel(s)
    const text = s === 'synced' && syncedAtMs ? syncedAgoText(syncedAtMs) : label
    const popCls = pop && s === 'synced' ? ' pop' : ''
    return '<span class="pd-sync pd-sync-detail s-' + s + popCls + '" data-sync-badge-detail="' + esc(id) + '" data-label="' + esc(label) + '" role="img" aria-label="' + esc(label) + '">' + SYNC_ICONS[s] + '<span class="pd-sync-label">' + esc(text) + '</span></span>'
  }

  window.HibanaChips = {
    esc, t, TITLE_CLAMP,
    renderTitle, titleHtml, titleAttrs, readMoreBtn, previewHtml, applyTitle, htmlToMd,
    tagChip, tagChipsRow,
    prioLabel, metaLine, metaHtml, metaDateHtml,
    syncBadgeHtml, syncBadgeDetailHtml, syncLabel,
  }
})()
