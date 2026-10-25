# Hibana Kanban — Portable mode (the 2-page contract)

> For the installed build, none of this applies: data lives in
> `%LOCALAPPDATA%\hibana\` and the NSIS uninstaller owns removal.

## Stays in the tray (closing ≠ quitting)

The **Hibana icon sits in the notification area** (by the clock) the whole
session. The **✕ button hides the window to the tray** — the app keeps
running and syncing in the background; it never quit. To bring it back:

- **left-click the tray icon** (or double-click), or
- **launch the .exe again** — the running instance shows itself, or
- right-click the icon → **Open Hibana**.

Right-click also offers **Hide to tray on close** (a checked menu item —
uncheck it and ✕ really quits; the choice is remembered in
`data\mirror.db`), **Start with Windows** (v0.1.15 — see the next
section), and **Quit Hibana** — the real exit. If the tray ever
fails to start (it is the first thing in the log), the ✕ falls back to
quitting so a hidden window is never stranded.

## Quick access — Start Menu + Start with Windows (v0.1.15)

A portable zip ships **no installer**, so out of the box Windows could not
find Hibana anywhere. On first launch (and after every move of the folder)
the app now takes care of that itself, per-user, no admin prompt:

- a **Start Menu shortcut** (`Hibana Kanban`) — Windows "All apps", Search,
  and the taskbar's pin flow all see it; launching it opens the board as
  normal;
- a **Startup shortcut** with the *start hidden* argument — **the next time
  Windows runs, Hibana boots itself to the tray** (icon by the clock, one
  left-click and the board is back) instead of appearing nowhere until you
  remember the folder you unzipped it to.

Both are idempotent: a `data\shortcuts.marker` note records what was
written, so a normal boot re-checks quietly and only rewrites when the .exe
moved or the preference changed. Move the whole `hibana\` folder and the
next launch rebuilds both shortcuts at the new path automatically.

Don't want it at boot? The tray menu's **Start with Windows** (checked by
default) removes/recreates the Startup shortcut — your Start Menu entry
stays either way, and the choice is remembered in `data\mirror.db`.

## Dark mode (and its toggle)

The app ships the web's own two looks — light and dark — and follows your
Windows app mode by default. Toggle it three ways: the board toolbar's
sun/moon button, the moon button on the sign-in card's corner, or the tray
menu's `Theme → Light / Dark / Follow system`. The choice persists across
restarts and never touches the web app's separate preference.

## Signing in (first launch)

The first launch opens a **sign-in card** — use your **hibana.ir account**
(email or username + password). Signing in is what loads your boards: the
kanban appears once you're connected. The app keeps its own session in
`data\session.bin` (0600), so you stay signed in across restarts; the cloud
refreshes the session while you use the app, and it expires after 30 days
unused — the card simply reopens, you sign in again, the board reloads. The
password itself is never stored anywhere.

## The Sync button

Next to Sprints and Labels, the toolbar's colored **Sync** button (v0.1.8 —
teal with a white label; it is the one filled button in the toolbar row)
opens a small window that PROVES a sync live:
connecting to the Hibana (Cloudflare) server, then uploading any queued
changes, then re-checking every board — ending on "Everything synced — your
boards are saved on the Hibana cloud — they will not vanish". Under each
step its **live fact** is spelled out in full (v0.1.15: "signed in as …",
"every board already current · 7 project(s) · 7 board(s)" — the facts wrap
on their own line and are never cut mid-word; they are the proof the modal
exists for). If some changes are still uploading (a slow line, a rate-limit
window) it says so by name instead of pretending. Closing the window never
cancels the sync; the app keeps syncing every 5 minutes anyway.

## Uploading files (the Upload File button)

The task editor's **Upload File** button (images, video, PDF/Excel/Word/
Markdown/text) uploads to the SAME cloud storage the web app uses, with the
round's three verdicts (v0.1.15): the per-file **progress bar fills with the
real bytes on the wire**, the row ends on **✓** and a green **"Screenshot
uploaded"** toast, and the **thumbnail appears in the grid** — pictures and
their tiles load through the app's own authed media proxy, so the tile you
just uploaded is visible exactly like on the web.

## Where your data lives

The portable build keeps **everything** in a `data\` folder **next to the .exe**:

```
hibana\
├── hibana.exe
├── PORTABLE.md          ← this file
└── data\                ← created on first launch
    ├── mode.lock        ← "portable" — locks this data dir to portable mode
    ├── shortcuts.marker ← v0.1.15: the Start Menu/Startup shortcuts' state note
    ├── mirror.db        ← the SQLite mirror (a CACHE of your cloud data + offline edits)
    ├── session.bin      ← your session token (0600; DPAPI-encrypted from M5)
    └── logs\
        └── hibana.log   ← rolling logs (7-day retention)
```

- **The cloud is the source of truth.** `mirror.db` is a cache + your offline
  workspace — deleting it costs you nothing but a re-download of your boards
  (queued offline edits are drained to the cloud on reconnect BEFORE any
  cleanup; still, don't delete `data\` while airplane-mode edits are pending).
- **Never mix data dirs.** On first launch the app writes `mode.lock`; from
  then on, launching this .exe always uses THIS `data\` folder — even from a
  different machine/profile — and never silently switches to
  `%LOCALAPPDATA%`. Copy the whole `hibana\` folder to move it.
- **Backups:** copy the `hibana\` folder. That's the entire app + state.

## Don't

- **Don't put the .exe in a synced or protected folder** (OneDrive/Dropbox/
  Program Files): `mirror.db` is a live WAL database — sync engines corrupt
  live databases, and protected folders block the write path.
- **Don't run two portable copies pointing at the same `data\`** — the
  single-instance lock focuses the first window, but two *copies* of the exe
  in two folders are two apps with two mirrors; the cloud reconciles them,
  your offline queues don't merge.
- **Don't edit `frontend`-anything** — the embedded UI is a checksum-pinned
  copy of the web app; a new release replaces it wholesale.

## Upgrading

Download the new `hibana-portable-<version>.zip`, extract, and replace the
old `hibana.exe` (keep your `data\` folder). Verify the download against the
`checksums.txt` published with the release (`Get-FileHash hibana.exe`).
The app's version + the embedded web ref appear in the about surface
(`AppInfo`); the web ref must match a released hibana-source version.
