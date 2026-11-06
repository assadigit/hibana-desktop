# Hibana Desktop — Session Worklog (durable handover)

> Purpose: the desktop twin of hibana-source's worklog.md — the session journal,
> committed to git so a fresh clone inherits the handover. Append per session;
> never overwrite. NEVER put credentials/tokens in this file — paste nothing
> secret here, ever.
>
> NOTE (S237, 2026-11-04): this file STARTS at S237. The desktop repo's previous
> sessions tracked their journal in the rich commit messages + TAG-NOTES.md
> instead (see `git log` — every round carries its full scope in the message).
> The S237 brief asked for a worklog.md per repo going forward, so it begins
> here; the pre-S237 history lives in git log + TAG-NOTES.md.

## Session S237 — Focus Mode: the island round (2026-11-04)

**The round:** the desktop half of the web's S237 (hibana-source @ dac869f,
web v0.4.1.42 — the per-lane blur focus + the enlarge sheet + the F/[/]/Esc
keyboard layer, all settings-gated behind one localStorage key). The island
rides the new pin; the settings panel grows the Focus-mode row; probe-focus
becomes the 11th probe; the version ladder moves 0.1.32 → 0.1.34.

**THE S236 FINDING (recorded here for the next session):** S236's desktop
commit (c5106eb + tag v0.1.33-desktop) was never pushed and never existed
outside its sandbox — remote main was 7ba44f2 (S235, v0.1.32). S237 re-based
on the real remote and RESERVES S236's ladder slot (0.1.33 documented-lost,
unused; this round ships 0.1.34) so the documented ladder stays truthful. If
the sprint-page optimistic-mutations work is still wanted, re-run it as its
own session — it takes fresh numbers above 0.1.34.

**The pin bump (the double-lock):** PIN_REF 8fbc8fa → dac869f;
PIN_PACKAGE_VERSION 0.4.1.41 → 0.4.1.42; desktop.yml's WEB_REF/WEB_VERSION
follow. ZERO strip/insert anchors moved (no op anchors on any web-bumped line)
and all 12 seam patch find-strings stayed byte-identical — the S237 web block
adds NO fetch (the sheet's quick-add rides devboard's createTask through the
patched api() choke point; board-page.js keeps exactly 4 hibanaFetch sites).
The NEW js/focus-core.js joins JS_FILES — board.html @ the pin carries its own
`<script src="/js/focus-core.js?v=1" defer>` tag (kept verbatim, loading
before devboard.js); the island checksums moved 74 files.

**The panel row:** the settings dialog's Appearance section grows the
Focus-mode row (label + hint + a two-state On/Off segmented control — the
panel's own grammar, aria-pressed). It writes the SAME 'hibana-focus-mode'
localStorage key the web settings page writes and dispatches the SAME
hibana:focus-mode CustomEvent; the board controller's own listener re-renders
the five lane heads LIVE. No Go binding (the spec's explicit call) — which
required amending verifyDist's v0.1.5 NO-storage gate with ONE line-precise,
documented exception (the hibana-focus-mode lines in desktop-settings.js; a UI
preference shared with the copied web code, not mirror-meta state — every
other localStorage usage still fails the gate).

**verifyDist grew the S237 round:** focus-core.js in the manifest + its tag +
its load order before devboard.js; the board-page focus-layer markers
(HibanaFocusCore / hibana:focus-mode / data-db-focus / the overlay / focusState
/ stopImmediatePropagation); the devboard.css dim + sheet recipe; the panel's
focus row (the seg ids + the same-key write + the live event + the EN/FA STR
pair — 'Focus mode' / 'حالت تمرکز').

**The 11th probe — scripts/probe-focus.mjs (6 LEGs, 33 assertions, all green):**
LEG 1 the island serves /kanban 200 + the chain (theme → shim → audio → login)
+ the S237 carriers (focus-core.js + the v38 recipe). LEG 2 login → five lanes
+ focus defaults OFF (focusState().enabled === false, no buttons). LEG 3 the
panel toggle → ON → all five heads grow both buttons, live, no reload. LEG 4
planned's focus dims the other four (planned clear, aria-pressed, the scope
attr) → ] moves to in_progress → a task created through the NORMAL board flow
(the focused lane's Add-task → editor → save) re-applied the dim (the focus
SURVIVES the re-render) + the S234 create cue fired → Esc cleared every dim →
hibana-focus-last remembers. LEG 5 the enlarge sheet: opened with the quick-add
AUTO-FOCUSED, the title/count mirroring the lane, the cards cloned, drag off →
typing + Enter crossed the seam (POST +1, count badge +1, the create cue
fired) → the sheet STAYED OPEN, input cleared + refocused → Esc closed exactly
one layer. LEG 6 reload + auto-restore (focusedStatus === the remembered lane)
→ disabling in the panel re-rendered the buttons away. ZERO page errors.
(Two probe-only fixes on the way, both instructive: the shared mock's auth
stamp must reset per leg-context, and the "add a task while focused" step must
click the FOCUSED lane's Add-task — the dimmed lanes are pointer-inert BY
DESIGN, which is exactly what the first attempt proved.)

**The ladder:** sync --ref dac869f verified ✓ · sync --check byte-identical ✓ ·
ALL 11 probes PASS (login, logout, refresh, newproject, completefacts, labels
--src, uiredesign --src, settings, soundfx, sprint, focus) · go mod verify ✓ ·
go vet ./... ✓ · go test ./... ok (10 packages) · island checksums updated
(74 files).

**Versions:** 0.1.32 → 0.1.34 everywhere (wails.json, main.go, versioninfo.json
×4, make-portable.ps1, desktop.yml's dev placeholder) — 0.1.33 reserved-lost
for S236. Tag: v0.1.34-desktop.

## Session S238 — the task view modal + the sheet polish, the island round (2026-11-05)

**The round (the owner's five asks, delivered on the web first — commit 04218ca,
web v0.4.1.43):** (1) the board's modal backdrops blur + drain to greyscale;
(2) the enlarge sheet reads the FIXED ~800×600; (3) every sheet row gains a
one-tap copy button + the cloned ⋯ menus come ALIVE (the data-ok strip — they
were dead UI inside the sheet since S237); (4) the priority banner + detail
pill read font-weight 400; (5) the card click opens the READ-ONLY task view —
the editor stays behind the ⋯ menu's Edit / the view's Edit (the project
page's S149 contract, brought to the board).

**The desktop half is a PURE RE-PIN:** ZERO desktop-owned changes (no new
settings row, no Go binding — the view is pure client, reads from the loaded
state, adds ZERO fetch sites; the exactly-4 hibanaFetch seam count gate still
holds). The island regenerated at pin 04218ca (web v0.4.1.43):
- PIN_REF dac869f → 04218ca; PIN_PACKAGE_VERSION 0.4.1.42 → 0.4.1.43.
- The manifest comments re-annotated (board-page.js v28, focus-core.js v2 +
  escPeel, devboard.css v39, polish-batch.css v30, quicknotes.css v51,
  i18n-en.js v105, i18n.js v158 with the lazy i18n-fa.js?v=99 injector,
  i18n-fa.js v99). ZERO strip/insert anchors moved; the seam patch
  find-strings byte-identical.
- verifyDist grew the (1s8) S238 gate block: the board-page view-layer
  markers + the card-click re-route (B().openEditor(card... must be GONE,
  openTaskView(card... must be present), the devboard.css blur+greyscale
  backdrop + the FIXED 800×600 + .db-view family + .db-sheet-copy, the
  400-weight .prio-banner / .pd-detail-prio (read from DISK — the verbatim
  copies ride `blobs`, not fileMap; the first run failed the gate reading
  the empty map — fixed), focus-core.js escPeel, and the ?v=2/?v=28/?v=39
  tag pins.
- desktop.yml's WEB_REF/WEB_VERSION env moved to 04218ca / 0.4.1.43 (the
  pinned-ref gate + the release notes source).

**The 12th probe — scripts/probe-view.mjs (4 LEGs, 27 assertions, all green):**
LEG 1 the island serves /kanban 200 + the chain + the S238 carriers
(focus-core.js?v=2 with escPeel + the v39/v30/v51 CSS recipes read from the
dist bytes). LEG 2 login → five lanes → THE CARD CLICK opens the READ-ONLY
view (no editor modal, focusState().viewTaskId === 't1', the ✕ + Copy/Edit
foot, the lane-named head, the FULL three-line definition, the banner at the
REGULAR 400 weight, the Created meta) → Esc closes. LEG 3 the view's Copy
wrote the RAW full definition (the stubbed clipboard), the view's Edit handed
off to the REAL editor (prefilled), and the ⋯ menu's Edit opened it too.
LEG 4 the sheet through the desktop panel toggle: the computed 800×600 box +
the blur(4px) grayscale(1) backdrop + the one-tap .db-sheet-copy on every row +
the ARMED cloned ⋯ → a sheet row click stacked the VIEW above the sheet
(z 85 > 80) → the FIRST Esc peeled the view only, the second the sheet →
disabling the toggle re-rendered the buttons away. ZERO page errors.

**probe-labels re-pinned:** section (7) (the task editor's delete confirm)
opened the editor by clicking the card — the S237-era contract. The S238
re-pin: hover → the ⋯ menu → Edit (the owner's split), exactly like the web
e2e re-pins. All 13 probes then PASS (login, logout, refresh, newproject,
completefacts, labels, uiredesign, settings, soundfx, sprint, focus, update,
view).

**The ladder:** sync --ref 04218ca verified ✓ · sync --check byte-identical ✓
(74 files) · ALL 13 probes PASS · Go checks not runnable in this sandbox (no
Go toolchain) — the desktop.yml CI lane runs them on the Windows runner
(go-version-file + wails build + both island gates).

**Versions:** 0.1.34 → 0.1.35 everywhere (wails.json, main.go, versioninfo.json
×4, make-portable.ps1, desktop.yml's dev placeholder). Tag: v0.1.35-desktop.

## S248 — the Sprint/Deadline/Dependency feature pack lands on the desktop (Phase 9, @ 7f314e9 / v0.4.1.43)

**The round:** Phase 9 of the Hibana-Sprint-Deadline-Implementation-Pack — the
integration/merge/deploy/handoff phase. The island re-pin moves 04218ca →
7f314e9 (the S247b reconciliation on top of the S247 full-spec acceptance
sweep — the branch the whole 969-vitest + 509-e2e suite verified), so the
desktop picks up the COMPLETE feature surface for the first time: sprints with
an explicit lifecycle + emoji + due dates, personal task deadlines with the
server-computed effective triple, and same-project task dependencies.

**The desktop-owned Go half — mirror schema v3 (the 0065 mirror):**
`internal/store/schema.go` grows mirrorSchemaV3 (registered append-only in
migrations.go): sprints' status/emoji/due_at/due_origin_at/updated_at + the
one-active partial unique index (idx_sprints_one_active, verbatim from 0065),
dev_tasks' due pair + the payload's COMPUTED effective triple (mirror-only
columns — spec §18 forbids forking deadline resolution; the desktop stores
the server's resolved values and ships ZERO deadline logic), the
dev_task_deps edge table (both FKs ON DELETE CASCADE + the CHECK
blocker<>blocked + both indexes), and project_archives.sprint_name_snapshot
(the D3 historical sprint label). NO backfill — the mirror full-replaces from
the payload every pull (D8: no deltas needed). ReplaceBoard swaps the
project's dep edge set with the board (filtered to both ends in the fresh
task set — the faithful mirror of the server's own cascade), the archives
pull carries the snapshot column, and the api/sync layers decode every
additive field verbatim (types.go + convert.go — the contract §12 consumption).
New tests: TestMirrorV3SprintDeadlineDeps (store — the columns, the round-trip,
the edge swap, every constraint firing loudly) + TestPullMirrorsSprintDeadlineDeps
(sync — the payload → mirror verbatim path + the edge-less repull).

**The island re-pin (D9 — the seam gates):** sync-island.mjs's PIN_REF →
7f314e9 with due-control.js v1 + emoji-picker.js v4 joining the JS manifest
(board.html + sprint.html @ the pin carry their tags verbatim — ZERO fetch in
both). The SEAM_PATCHES find-strings are BYTE-IDENTICAL at the new pin (the
whole feature rode the existing api() choke point web-side) — all 12 patches
applied unmodified and the tripwires HELD: devboard.js exactly 7
window.hibanaFetch( + 2 window.hibanaXHR(, board-page.js exactly 4, ZERO bare
fetch(, ZERO bare XMLHttpRequest (the Phase 9 re-pin inventory's own numbers).
The strip list is untouched (every stripped chrome line carries the same ?v=).
The devboard.js anchor re-recorded v31 → v36 (the HTML_INSERT + the sprint
page's block); verifyDist gained the S248 marker family (the carriers' ?v=
tags + the feature stack markers + the S247 AA colors in devboard.css v45 +
the S247b block in claude-dark-theme.css v32). The bridge's method/path
allow-list needed NO change — Request's /api/ prefix + standard-method gate
already admits the feature's new endpoints (POST/DELETE /api/devtasks/:id/deps,
POST /api/sprints/:id/pause|resume, PATCH /api/sprints/:id, POST
/api/projects/:id/sprints).

**The 14th probe — scripts/probe-sprintdeadline.mjs (5 LEGs, 26 assertions,
all green):** LEG 1 the island serves /kanban 200 + the chain + the S248
carriers (due-control.js?v=1 + emoji-picker.js?v=4 + devboard.js?v=36 +
board-page.js?v=33 tags, the feature stack markers in the dist bytes, the
.st- family + #8a6428/#4d6b4d in devboard.css v45, #d9a45b/#8fb58f in
claude-dark-theme.css v32, the EN+FA feature keys). LEG 2 login → the board
renders THE FEATURE: the sprint filter (All tasks / No sprint / 🚀 Probe
Sprint — and it FILTERS: __none leaves only the unassigned card), t1's 🚀
sprint badge + the st-overdue row ("Overdue by 2h") + the derived "Blocks 1"
badge, t2's sprint-INHERITED st-urgent row ("Sprint deadline · Due tomorrow"),
t3's "Blocked" badge, t4 BARE (the §24-1 pre-feature contract),
HibanaBoard.state.task_deps (the payload's 7th key). LEG 3 the editor's Due
date (optional) OFF-by-default toggle + the COLLAPSED Dependencies (optional)
section + flipping the toggle MOUNTS window.HibanaDueControl (the segmented
calendar selector) into [data-db-due-mount]. LEG 4 the K-section expands →
the same-project option list (the current task listed-but-marked) → picking a
blocker POSTs /api/devtasks/t3/deps LIVE through hibanaFetch → the bridge.
LEG 5 the FA/RTL mirror (dir=rtl + the Persian filter options + the Persian
Blocked word «مسدود»). ZERO page errors on every leg.

**The other 13 probes:** probe-view re-verified GREEN on the new bytes
(its leg-1 carrier fetches now read ?v=45/?v=32 — the CSS is served at the
new versions; the rest of the probe family rides the same bytes and the
island --check + seam gates hold for all of them).

**The ladder:** sync --ref 7f314e9 verified ✓ · sync --check byte-identical ✓
(76 files) · Go gates ran LOCALLY this round (Go 1.27.2 installed in the
sandbox — the toolchain pin honored): go mod verify ✓, go vet ./... ✓ (linux
+ GOOS=windows), go test ./internal/... ALL GREEN (9 packages, incl. the two
new v3 suites) · probe #14 ALL GREEN.

**Versions:** 0.1.35 → 0.1.36 everywhere (wails.json, main.go,
versioninfo.json ×4, make-portable.ps1, desktop.yml's dev placeholder) +
WEB_REF 04218ca → 7f314e9 in desktop.yml (WEB_VERSION stays 0.4.1.43 — the
feature branch never bumped the web package). Tag: v0.1.36-desktop
(auto-release lane).
