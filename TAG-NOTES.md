Desktop 0.1.21 — auto-release: every update to main ships a release.

Changes since v0.1.20-desktop:

- THE PER-CARD SYNC BADGE (hibana-sync-status-spec.md, mirrored from the web v0.4.1.37): every kanban card now shows whether IT is safely in the Hibana cloud. The badge sits at the far end of the card's meta row (next to the timestamp): a teal cloud-with-up-arrow the moment your edit is saved on this device (Pending), the Sync button's own rotating arrows while the server round-trip runs (Syncing — only past half a second; faster saves skip the spinner), a quiet grey cloud-with-check once the server confirmed (Synced), and a red Retry pill when a save gave up — click it and ONLY that card re-sends. Hover any icon for its label; the shapes differ so colour is never the only signal; Farsi mirrors to the left side automatically. The task editor's footer shows the same state with "Synced N minutes ago".
- THE SYNC BUTTON COUNT: the toolbar's Sync button now wears a small red count = the cards still pending or failed, from the SAME tracker the cards' badges paint from (they can never disagree); it hides at zero and the icon rotates while any sync runs.
- Island moved to hibana-source 7a3198b (web v0.4.1.37) — the full web round's changelog: https://github.com/assadigit/hibana-source/releases/tag/v0.4.1.37

Embedded web island: hibana-source 7a3198b (v0.4.1.37). Sign in with your hibana.ir account; once you sign in, the kanban loads, and a live session boots straight to the board. See checksums.txt.
