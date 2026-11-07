Desktop 0.1.39 — auto-release: every update to main ships a release.

Changes since v0.1.38-desktop:

- fix(ci): the island checksum gate's WEB_REF env follows the sealed pin — 7f314e9 → 6dd40c0 (the S250 re-pin; the gate compares the workflow env against the script's PIN_REF and the S250 round moved only the script side)

Embedded web island: hibana-source 6dd40c0 (v0.4.1.43). Sign in with your hibana.ir account; once you sign in, the kanban loads, and a live session boots straight to the board. See checksums.txt.
