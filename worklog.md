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
