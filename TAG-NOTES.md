Desktop 0.1.37 — auto-release: every update to main ships a release.

Changes since v0.1.36-desktop:

- fix(shell): S249 the /sprint.html serving lane — "clicking Sprints sends me back to login" fixed: the S235 sprint page was served verbatim (no live auth state on <html>, no Wails runtime tags), so an authed session got the fail-visible login gate painted over a live session and a dead bridge underneath. One new lane (SprintMiddleware), same recipe as /kanban — bump to 0.1.37

Embedded web island: hibana-source 7f314e9 (v0.4.1.43). Sign in with your hibana.ir account; once you sign in, the kanban loads, and a live session boots straight to the board. See checksums.txt.
