Desktop 0.1.8 — auto-release: every update to main ships a release.

Changes since v0.1.7-desktop:

- fix(toolbar): the sync button is VISIBLE at last — the owner ask: "a sync button on the header of app, next to sprints and labels, but colored. (fill colored)" + "sprints and labels need to be same size" (v0.1.8: the v0.1.6 ghost ICON at the toolbar's edge read as NO sync button — the Sync button is now a LABELED, FILL-COLORED CTA pill right after Labels: the bare-button solid-primary grammar (base.css S186 — a plain <button> IS the app's one solid fill), the refresh glyph + the Sync label at the SAME twin metrics as its neighbors, theme-native teal #2E7B7F light / terracotta #c2643f dark with white ink, the label + aria desktop-localized EN 'Sync' / FA 'همگام‌سازی'; and Sprints (an <a class="btn ghost small"> whose a.ghost box: 0.55rem 0.75rem + weight 400 diverged) + Labels (a <button> at the global 0.55rem 1rem + 500) are now TWIN-SIZED — one #id rule pins both to identical padding/weight/height, all three buttons 41.3px)

Embedded web island: hibana-source e6661c8 (v0.4.1.35). Sign in with your hibana.ir account; once you sign in, the kanban loads, and a live session boots straight to the board. See checksums.txt.
