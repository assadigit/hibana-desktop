# Hibana Desktop — Session Worklog (durable handover)

> Purpose: the desktop twin of hibana-source's worklog.md — the session journal,
> committed to git so a fresh clone inherits the handover. Append per session;
> never overwrite. NEVER put credentials/tokens in this file — paste nothing
> secret here, ever.
>
> NOTE (S237, 2026-11-04): this file STARTS at S237. The desktop repo's previous
> sessions tracked their journal in the rich commit messages + docs/TAG-NOTES.md
> instead (see `git log` — every round carries its full scope in the message).
> The S237 brief asked for a worklog.md per repo going forward, so it begins
> here; the pre-S237 history lives in git log + docs/TAG-NOTES.md.

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

## S249 — the sprint-page serving lane: "clicking Sprints sends me back to login" (0.1.37)

**The report:** in the shipped desktop app, an AUTHED user clicks Sprints (the
toolbar's db-sprint-link) and lands on the login card — "it goes back to login
again, but it shouldn't because the user is already logged in." Behind the
gate the page was also dead: the login form itself failed with "The desktop
bridge is not wired — restart the app."

**The root cause — ONE missing serving lane, the S235 embed's blind spot:**
the desktop never opens hibana.ir; it serves the byte-pinned island from the
embedded asset server, and every HTML document must be served through a
middleware lane that stamps the LIVE auth state onto the <html> tag
(data-desktop-authed — the login gate's visibility is a first-paint CSS
decision, fail-visible by design) and splices the Wails runtime tags into
<head> (ipc.js + runtime.js — Wails' own injector only fires for "/"-suffix
documents, assetserver.isRuntimeInjectionMatch). v0.1.2 wired exactly TWO
lanes: "/" (IndexMiddleware) and the /kanban aliases (KanbanIndexMiddleware).
S235 then embedded sprint.html as a SECOND island document (its own login-gate
markup, its own desktop chain, its own entry guard) and pointed
board-page.js's db-sprint-link at /sprint.html?project=… — but the alias list
in main.go was never extended. The WebView's /sprint.html navigation matched
NO lane, fell through to the raw file server, and was served VERBATIM: no
data-desktop-authed (the fail-visible gate painted over a LIVE session — the
reported "back to login") and no runtime tags (window.go missing — every
sprint-page bridge call, the login form included, died "bridge not wired").

**Why the gates didn't catch it:** probe-sprint.mjs's mock server implements
the INTENDED serving contract (serveDocument stamps data-desktop-authed and
injects the runtime tags into /sprint.html — scripts/probe-sprint.mjs:91-99),
so the browser probe was green while the production asset server never had
the lane; assetserver_integration_test.go only covered the /kanban, / and
asset paths. The mock was right, the server was wrong — the exact shape of
gap a serving-lane test has to pin.

**The fix (Go-side only — the island bytes are untouched, checksums hold):**
internal/ui/authinject.go's indexMiddleware generalizes from the hardcoded
"/" + "/index.html" pair to a path SET (variadic docPaths → a set lookup),
and grows SprintMiddleware — /sprint.html, WITH the runtime injection, NO
path rewrite (the file server serves sprint.html itself; only the shell state
and the runtime tags are stamped onto its bytes). main.go's middleware
dispatch grows the third lane between the kanban aliases and the root
fallback. InjectShellState/InjectWailsRuntime work on sprint.html as-is (it
carries the identical <html lang="en"> marker and a <head>), and the lane's
no-store + conditional-header stripping keeps the WebView from caching a
stale gate state across a sign-in — a login-from-expiry on the sprint page
(location.reload keeps ?project=) now re-serves the document stamped authed.

**The regression test — TestSprintLaneCarriesTheRuntime:** the Wails-dispatch
replica (assetserver_integration_test.go) mirrors the new main.go contract
and pins the lane: /sprint.html serves the SPRINT document (not index.html)
with data-desktop-authed="false" when fresh, the runtime tags EXACTLY once
and ordered (ipc.js before the desktop chain), no-store, and NO verbatim
<html lang="en"> on the wire; after a.Login it serves
data-desktop-authed="true" (the reported symptom, held as an assertion), and
/kanban still serves the board (no lane cross-contamination).

**The verification ladder:** go mod verify ✓, go vet ./... ✓ (linux AND
GOOS=windows — Go 1.27.2 installed in the sandbox, the toolchain pin
honored), go test ./... ALL GREEN (9 packages incl. the new lane test), plus
a live wire-level harness (the real middleware + the real island bytes + the
replica dispatch on a real socket): an authed /sprint.html?project=… serves
<html … data-desktop-authed="true" data-desktop-theme="…"> + exactly one
/wails/ipc.js + runtime.js pair + the Sprints title — and /kanban matches
byte-for-byte semantics. probe-sprint re-run GREEN on the real island (all
6 LEGs — the browser-level flow is unchanged; the mock and the server now
agree). The other 13 probes ride the same untouched island bytes.

**Versions:** 0.1.36 → 0.1.37 everywhere (wails.json, main.go,
versioninfo.json ×4, make-portable.ps1, desktop.yml's dev placeholder). No
island re-pin (PIN_REF stays 7f314e9 — zero frontend/dist bytes moved). Tag:
v0.1.37-desktop (auto-release lane).

## Session S250 — the strategies tier, the desktop half (2026-11-07)

**The web round (hibana-source 6dd40c0, v0.4.1.44)** shipped the owner's Strategy →
Sprint → Task hierarchy end to end (migration 0066 on both D1s, the 8-key payload,
strategies CRUD + the assignment/lifecycle guards, the sprint page's strategies section).
This round mirrors it on the desktop — the owner's standing rule: every web change lands
here too, for a consistent experience.

**The Go half:**
- Mirror **schema v4** (`internal/store/schema.go`): the `strategies` registry + the
  nullable `sprints.strategy_id` FK (ON DELETE SET NULL — the cloud's 0066 grammar).
  No backfill (the v3 doctrine: ReplaceBoard full-replaces from the live payload).
- `ReplaceBoard` gains the `strategies` param: the registry is FULL-REPLACED per pull
  (DELETE + INSERT — the tasks' pattern, not the sprints' upsert), with the FK ordering
  documented (the delete's ON DELETE SET NULL mirrors the cloud's delete semantics; the
  fresh sprint upserts then re-assert the payload's assignments).
- `api/types.go`: `StrategyRow` + the payload's 8th additive key + `SprintRow.StrategyID`.
- `sync/convert.go`: the verbatim mapping.

**The island half (`scripts/sync-island.mjs` — the only mutator):**
- The pin moved 7f314e9 → **6dd40c0** (v0.4.1.43 → 0.4.1.44). The drifted anchors
  re-recorded (devboard.js v36 → v37 on the board + sprint insert ops); the verify
  needles moved with the carriers (board-page v34, devboard.css v46, i18n-en v111,
  i18n v164/i18n-fa v105).
- NEW **S250 drift gates**: a pre-strategies island can never silently ship — the
  wrappers + the 8th-key state fold in devboard.js, the section renders + the shared
  select grammar in sprint-page.js, the section markup in sprint.html, the st.* keys in
  BOTH dictionaries.
- The seam counts HELD (the S246 deps precedent): every strategy call rides the ONE
  `api()` choke point — zero new fetch sites.
- `--check` green: 76 files byte-identical, idempotent.

**The proof:**
- **probe-sprint.mjs grows LEG 6** (the strategies leg): the section renders on top
  (2 cards, priority-first — urgent first), the urgent/active badges, the ▸ SEO line,
  the 50% roll-up bar, the 🚀 emoji glyph, the focus filter (narrow to 1 row + the
  is-on look + the restore), the define dialog's select (No strategy + both
  assignable strategies, default empty), the detail Settings' select (seeded with the
  sprint's strategy id), and a create crossing the seam — ZERO page errors.
- ALL 14 probes green on the new bytes (login/logout/newproject/refresh/labels/
  focus/view/soundfx/update/settings/completefacts/uiredesign/sprintdeadline + the
  extended sprint) — the sprintdeadline carriers re-pinned (v37/v34).
- Go: gofmt clean, vet green linux AND windows, `go test -count=1 -race` green
  (9 packages), the cgo-free Windows cross-build PE-compiles.

**Versions:** 0.1.37 → 0.1.38 everywhere (wails.json, main.go -dev stamp,
versioninfo.json ×4, make-portable.ps1, desktop.yml's dev placeholder). Tag:
v0.1.38-desktop (auto-release lane on push).

## Session S250 close — the release (2026-11-07, continued)

The WEB_REF follow-up (16a864e): the island checksum gate reads the pin from the
workflow's `WEB_REF` env, which the S250 re-pin had moved only script-side — the gate
refused `--ref 7f314e9` against the sealed `6dd40c0`. One line (the env follows the pin)
→ CI green on both the fix and its auto-release bump (c9d44a7) → **v0.1.39-desktop
released** (installer + portable zip + checksums, the auto-release lane).

The web half went live the same session (be43ccb → CD): the 13-probe live verification
on hibana.ir is recorded in hibana-source's worklog. Owner-side: the desktop app picks
up 0.1.39 on the next update check; the Sprints page carries the strategies tier.
