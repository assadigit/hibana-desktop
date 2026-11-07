// Package store is the Hibana desktop client's local SQLite mirror: the
// cloud-subset cache + offline workspace specified by DATA-MODEL.md §6, plus the
// local-only machinery that lives beside it (outbox, meta, migration bookkeeping,
// and the 7-day deletion-shadow grace table).
//
// Hard rules baked into this package (GO-DESKTOP-IMPLEMENTATION-GUIDE.md §5.2):
//   - The mirror is a CACHE + offline workspace; the CLOUD is the source of truth
//     (GO-DESKTOP-PORT-PLAN.md §4). Nothing in this package talks to the network
//     and nothing here is ever pushed to the cloud.
//   - Pure Go, zero cgo (modernc.org/sqlite), zero Wails imports — the package
//     must build for linux tests AND the Windows cross-build.
//   - Timestamps are TEXT ISO-8601 everywhere and are compared as strings —
//     lexicographic order == chronological order for this format (DATA-MODEL.md
//     §6, mapping notes; the same rule underpins the server's ?since= delta plan,
//     API-AND-SYNC-CONTRACT.md §7d). Write them with nowISO() so every writer in
//     the process produces the same fixed-width shape.
//   - CHECK constraints are reproduced verbatim so local writes fail loudly
//     instead of drifting (DATA-MODEL.md §6, mapping notes).
package store

// mirrorSchemaV1 is the "Cloud-subset mirror" block of DATA-MODEL.md §6, VERBATIM
// (column names, types, defaults and CHECK constraints; whitespace reformatted
// only). It mirrors the verified cloud shapes §2.1-2.8 — the exact SQL the Node
// self-host already runs ("Same SQL as the D1 adapter; only the driver differs",
// src/db/sqlite.ts:6-9), which is the feasibility proof for this driver swap
// (GO-DESKTOP-IMPLEMENTATION-GUIDE.md §5.2).
const mirrorSchemaV1 = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'personal' CHECK (type IN ('personal','client')),
  status TEXT NOT NULL DEFAULT 'spark' CHECK (status IN
      ('spark','planning','queued','developing','awaiting_dev','operational')),
  sort_order INTEGER NOT NULL DEFAULT 0, latest_note TEXT NOT NULL DEFAULT '',
  progress_percent INTEGER, archived_state TEXT CHECK (archived_state IN ('online','offline')),
  client_name TEXT, due_date TEXT, reminders_enabled INTEGER NOT NULL DEFAULT 0,
  folder_id TEXT, logo_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  deleted_at TEXT, pinned_at TEXT, cover_shot_id TEXT
);
CREATE TABLE dev_tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idea' CHECK (status IN ('idea','bug','planned','in_progress','done')),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  category_id TEXT, sprint_id TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, done_at TEXT, start_at TEXT, end_at TEXT,
  search_tags TEXT NOT NULL DEFAULT '', updated_at TEXT
);
CREATE TABLE sprints (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
  started_at TEXT NOT NULL, ended_at TEXT, created_at TEXT NOT NULL,
  is_draft INTEGER NOT NULL DEFAULT 0, version TEXT, description TEXT
);
CREATE TABLE categories (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
  color_fill TEXT NOT NULL, color_text TEXT NOT NULL,
  is_archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE tags (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#f6d365', usage_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, UNIQUE (user_id, name)
);
CREATE TABLE dev_task_tags (
  task_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY (task_id, tag_id)
);
CREATE TABLE project_categories (
  project_id TEXT NOT NULL, category_id TEXT NOT NULL, PRIMARY KEY (project_id, category_id)
);
CREATE TABLE project_archives (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'done', priority TEXT NOT NULL DEFAULT 'medium',
  category_id TEXT, sprint_id TEXT, done_at TEXT, original_created_at TEXT NOT NULL,
  archived_at TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE screenshots (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, github_path TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'image/png', caption TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0,
  task_id TEXT, bytes INTEGER NOT NULL DEFAULT 0, filename TEXT
);
`

// mirrorSchemaV3 is the S248 (Phase 9) mirror of the web's migration
// 0065_sprint_deadline_deps.sql — the Sprint/Deadline/Dependency feature pack
// (API-AND-SYNC-CONTRACT.md §12, the contract this mirror consumes). Semantics
// are IDENTICAL to 0065 where the columns exist cloud-side:
//
//   - sprints gain the explicit lifecycle (status TEXT — the service layer +
//     the partial unique index idx_sprints_one_active enforce one-active, never
//     a NOT NULL column: SQLite cannot ADD COLUMN with a non-constant default),
//     emoji, due_at + due_origin_at (the §12.2 origin rules live SERVER-side),
//     and updated_at (the D8 sync field, stamped on every cloud write).
//   - dev_tasks gain the personal deadline pair due_at + due_origin_at.
//   - dev_task_deps links blocker→blocked with both FKs ON DELETE CASCADE, the
//     table-level CHECK blocker<>blocked, and both FK indexes (cycles are a
//     service-layer CTE cloud-side; the mirror only ever full-replaces from the
//     payload, so it inherits the cloud's already-clean edge set).
//   - project_archives gains sprint_name_snapshot (D3: a deleted sprint's
//     history survives as "Sprint: <name> (deleted)").
//
// NO backfill runs here — unlike the cloud's 0065 (which normalized legacy
// is_draft/ended_at data), the mirror never migrates legacy sprint rows: it is
// offline-local and every ReplaceBoard full-replaces the project's rows from
// the live payload, so a fresh column set + the server-computed values simply
// arrive on the next pull (D8: no deltas needed).
//
// MIRROR-ONLY additions beyond 0065 (documented divergence, NOT schema drift —
// the cloud computes these at read time and never stores them): dev_tasks also
// carries the payload's server-computed effective-deadline triple
// effective_due_at / effective_due_source / effective_due_origin_at VERBATIM
// (contract §12.2: spec §18 forbids forking deadline resolution between
// platforms — the desktop stores the computed values and ships ZERO
// deadline-resolution logic of its own).
const mirrorSchemaV3 = `
-- ---- sprints: the explicit lifecycle (0065 / D1) ---------------------------
ALTER TABLE sprints ADD COLUMN status TEXT;
ALTER TABLE sprints ADD COLUMN emoji TEXT;
ALTER TABLE sprints ADD COLUMN due_at TEXT;
ALTER TABLE sprints ADD COLUMN due_origin_at TEXT;
ALTER TABLE sprints ADD COLUMN updated_at TEXT;
-- The one-active invariant at the persistence layer, verbatim from 0065: the
-- payload can never carry two active sprints (the cloud enforces the same
-- index), so this is the fail-loudly belt against a drifted payload.
CREATE UNIQUE INDEX idx_sprints_one_active ON sprints(project_id) WHERE status = 'active';

-- ---- dev_tasks: personal deadlines (0065 / D7) + the payload's computed triple
ALTER TABLE dev_tasks ADD COLUMN due_at TEXT;
ALTER TABLE dev_tasks ADD COLUMN due_origin_at TEXT;
ALTER TABLE dev_tasks ADD COLUMN effective_due_at TEXT;
ALTER TABLE dev_tasks ADD COLUMN effective_due_source TEXT CHECK (effective_due_source IS NULL OR effective_due_source IN ('task','sprint'));
ALTER TABLE dev_tasks ADD COLUMN effective_due_origin_at TEXT;

-- ---- dev_task_deps: task dependencies (0065 / D7) ---------------------------
CREATE TABLE dev_task_deps (
  blocker_task_id TEXT NOT NULL REFERENCES dev_tasks(id) ON DELETE CASCADE,
  blocked_task_id TEXT NOT NULL REFERENCES dev_tasks(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (blocker_task_id, blocked_task_id),
  CHECK (blocker_task_id <> blocked_task_id)
);
CREATE INDEX idx_dev_task_deps_blocker ON dev_task_deps(blocker_task_id);
CREATE INDEX idx_dev_task_deps_blocked ON dev_task_deps(blocked_task_id);

-- ---- project_archives: the historical sprint label (0065 / D3) ---------------
ALTER TABLE project_archives ADD COLUMN sprint_name_snapshot TEXT;
`

// localSchemaV2 holds the LOCAL-ONLY additions. None of it is ever pushed to the
// cloud; none of it diverges from the §6 column shapes.
const localSchemaV2 = `
-- Local-only sync machinery (never pushed) — DATA-MODEL.md §6.
CREATE TABLE outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT NOT NULL, entity TEXT NOT NULL, id TEXT NOT NULL,
  payload TEXT NOT NULL, idempotency_key TEXT, created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT
);
CREATE TABLE meta (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
-- Deletion shadow (pre-tombstone), DATA-MODEL.md §6: tasks that vanished from a
-- pull are treated as deleted but kept as a local grace copy for 7 days
-- (GO-DESKTOP-PORT-PLAN.md §5, "disappeared from pull = deleted"). The cloud
-- schema has no dev_tasks tombstone to mirror yet (API-AND-SYNC-CONTRACT.md §7b,
-- pending M0), so this local table is the bridge. ReplaceBoard purges rows once
-- seen_missing_at is older than 7 days (string compare on ISO-8601 TEXT).
CREATE TABLE local_grace_tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
  seen_missing_at TEXT NOT NULL
);
-- Local-only query-performance indexes: plain additions over existing §6
-- columns, never schema drift.
CREATE INDEX idx_mirror_dev_tasks_project ON dev_tasks(project_id);
CREATE INDEX idx_mirror_tags_user ON tags(user_id);
`

// mirrorSchemaV4 is the S250 mirror of the web's migration
// 0066_strategies.sql — the Strategies layer (STRATEGIES-SPEC.md §3, the
// owner's Strategy → Sprint → Task hierarchy). Semantics are IDENTICAL to 0066
// where the columns exist cloud-side:
//
//   - the per-project `strategies` registry: name + description + the REUSED
//     task priority vocabulary + the explicit active|paused|completed lifecycle
//     (NOT NULL here — a fresh table pins its CHECKs, unlike 0065's backfilled
//     sprints.status) + the optional emoji identity + sort_order (future drag).
//   - sprints gains the nullable strategy_id FK (ON DELETE SET NULL — a deleted
//     strategy's sprints survive unassigned, exactly the cloud grammar).
//
// NO backfill runs here (the v3 doctrine): the mirror never migrates legacy
// rows — every ReplaceBoard full-replaces the project's rows from the live
// payload, so the new columns + the registry simply arrive on the next pull.
const mirrorSchemaV4 = `
-- ---- strategies: the tier above sprints (0066 / STRATEGIES-SPEC §3) ---------
CREATE TABLE strategies (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed')),
  emoji TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX idx_strategies_project ON strategies(project_id);

-- ---- sprints: the optional strategy this sprint serves (0066) ----------------
ALTER TABLE sprints ADD COLUMN strategy_id TEXT REFERENCES strategies(id) ON DELETE SET NULL;
CREATE INDEX idx_sprints_strategy ON sprints(strategy_id);
`
