Desktop 0.1.7 — auto-release: every update to main ships a release.

Changes since v0.1.6-desktop:

- fix(autorelease): the bump push now rides RELEASE_PAT — GITHUB_TOKEN can never push a workflow-file change (the hard-9 lockstep bump touches desktop.yml's dev placeholder; GitHub refuses App-token workflow updates, the lane's second live firing), so the checkout embeds the owner PAT (workflow scope, sealed in repo secrets) in origin's URL and the tag push inherits it
- fix(autorelease): the desktop.yml dev-placeholder bump crashed on its first live firing — in bash double quotes the pattern's double-backslash-dollar-v collapsed to a bare dollar-v expansion that set -u killed ('v: unbound variable', run 39347297230); the pattern now escapes all three chars so sed receives the literal escaped-dollar-v regex it needs
- ci: the lanes go re-run-safe on the public repos — the pinned-ref gate rides the now-public hibana-source (token preferred, anonymous fallback — a stale secret can never red the gate) + the release job is idempotent (an existing release keeps its assets; only missing ones upload — a re-run never reds)

Embedded web island: hibana-source e6661c8 (v0.4.1.35). Sign in with your hibana.ir account; once you sign in, the kanban loads, and a live session boots straight to the board. See checksums.txt.
