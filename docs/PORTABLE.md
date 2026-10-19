# Hibana Kanban — Portable mode (the 2-page contract)

> For the installed build, none of this applies: data lives in
> `%LOCALAPPDATA%\hibana\` and the NSIS uninstaller owns removal.

## Where your data lives

The portable build keeps **everything** in a `data\` folder **next to the .exe**:

```
hibana\
├── hibana.exe
├── PORTABLE.md          ← this file
└── data\                ← created on first launch
    ├── mode.lock        ← "portable" — locks this data dir to portable mode
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
