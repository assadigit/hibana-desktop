package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// Row types. Field names mirror the DATA-MODEL.md §6 column names; pointer
// fields are the nullable columns (nil ↔ SQL NULL). Timestamps are TEXT
// ISO-8601 and are compared as strings (§6, mapping notes).
// ---------------------------------------------------------------------------

// Project mirrors one projects row (DATA-MODEL.md §2.1, DDL §6 verbatim).
type Project struct {
	ID               string  // id
	UserID           string  // user_id (constant = the signed-in user, kept verbatim for row-level diffing)
	Title            string  // title
	Description      string  // description
	Type             string  // type: 'personal' | 'client'
	Status           string  // status: spark|planning|queued|developing|awaiting_dev|operational
	SortOrder        int64   // sort_order
	LatestNote       string  // latest_note
	ProgressPercent  *int64  // progress_percent (nullable)
	ArchivedState    *string // archived_state: 'online' | 'offline' (nullable)
	ClientName       *string // client_name (nullable)
	DueDate          *string // due_date (nullable)
	RemindersEnabled int64   // reminders_enabled (0/1)
	FolderID         *string // folder_id (nullable)
	LogoPath         *string // logo_path (nullable)
	CreatedAt        string  // created_at (ISO-8601 TEXT)
	UpdatedAt        string  // updated_at (ISO-8601 TEXT)
	DeletedAt        *string // deleted_at (nullable — project tombstone)
	PinnedAt         *string // pinned_at (nullable)
	CoverShotID      *string // cover_shot_id (nullable)
}

// Task mirrors one dev_tasks row — a Kanban card (DATA-MODEL.md §2.2, DDL §6).
type Task struct {
	ID         string  // id
	ProjectID  string  // project_id
	Title      string  // title
	Status     string  // status: idea|bug|planned|in_progress|done
	Priority   string  // priority: low|medium|high|urgent
	CategoryID *string // category_id (nullable)
	SprintID   *string // sprint_id (nullable)
	SortOrder  int64   // sort_order
	CreatedAt  string  // created_at
	DoneAt     *string // done_at (nullable)
	StartAt    *string // start_at (nullable)
	EndAt      *string // end_at (nullable)
	SearchTags string  // search_tags (server-maintained denormalization)
	UpdatedAt  *string // updated_at (nullable)
}

// Sprint mirrors one sprints row (DATA-MODEL.md §2.3, DDL §6).
type Sprint struct {
	ID          string  // id
	ProjectID   string  // project_id
	Name        string  // name
	StartedAt   string  // started_at
	EndedAt     *string // ended_at (nullable)
	CreatedAt   string  // created_at
	IsDraft     int64   // is_draft (0/1)
	Version     *string // version (nullable)
	Description *string // description (nullable)
}

// Category mirrors one categories row — task categories (DATA-MODEL.md §2.4).
type Category struct {
	ID         string // id
	UserID     string // user_id
	Name       string // name
	ColorFill  string // color_fill
	ColorText  string // color_text
	IsArchived int64  // is_archived (0/1)
	CreatedAt  string // created_at
}

// Tag mirrors one tags row (DATA-MODEL.md §2.5). UNIQUE (user_id, name) holds.
type Tag struct {
	ID         string // id
	UserID     string // user_id
	Name       string // name
	Color      string // color
	UsageCount int64  // usage_count
	CreatedAt  string // created_at
}

// TaskTag is one dev_task_tags join row: card ↔ label (DATA-MODEL.md §2.5).
type TaskTag struct {
	TaskID string // task_id
	TagID  string // tag_id
}

// CategoryRef is one project_categories join row (DATA-MODEL.md §2.4).
type CategoryRef struct {
	ProjectID  string // project_id
	CategoryID string // category_id
}

// Archive mirrors one project_archives row — a done-task snapshot (DATA-MODEL.md
// §2.6). Archived ≠ deleted: rows stay restorable; Tags is the label snapshot
// JSON ("[]").
type Archive struct {
	ID                string  // id
	ProjectID         string  // project_id
	Title             string  // title
	Status            string  // status
	Priority          string  // priority
	CategoryID        *string // category_id (nullable)
	SprintID          *string // sprint_id (nullable)
	DoneAt            *string // done_at (nullable)
	OriginalCreatedAt string  // original_created_at
	ArchivedAt        string  // archived_at
	Tags              string  // tags (JSON array snapshot)
}

// Shot mirrors one screenshots row — METADATA ONLY; the object bytes stay in the
// store/local files (DATA-MODEL.md §2.8, DDL §6).
type Shot struct {
	ID         string  // id
	ProjectID  string  // project_id
	GitHubPath string  // github_path
	MimeType   string  // mime_type
	Caption    string  // caption
	CreatedAt  string  // created_at
	Resolved   int64   // resolved (0/1)
	TaskID     *string // task_id (nullable — pins the shot to a card)
	Bytes      int64   // bytes
	Filename   *string // filename (nullable)
}

// OutboxEntry is one queued mutation (the FIFO queue that replaces the web
// client's queue.js — GO-DESKTOP-IMPLEMENTATION-GUIDE.md §5.3).
type OutboxEntry struct {
	Seq            int64   // seq (FIFO key)
	Op             string  // op
	Entity         string  // entity
	ID             string  // id
	Payload        string  // payload (JSON)
	IdempotencyKey *string // idempotency_key (nullable)
	CreatedAt      string  // created_at
	Attempts       int64   // attempts
	LastError      *string // last_error (nullable)
}

// OutboxMaxAttempts is the retry ceiling from the sync contract (5xx retry ≤5
// then dead-letter — API-AND-SYNC-CONTRACT.md §10 via
// GO-DESKTOP-IMPLEMENTATION-GUIDE.md §5.3).
const OutboxMaxAttempts = 5

// Dead reports whether this entry has exhausted the retry ceiling. Dead-letter
// is the sync engine's call: the spec'd outbox shape (DATA-MODEL.md §6) has no
// done column — completion is DELETION (DropOutbox) — so a dead entry simply
// stays queued with attempts and last_error set until the engine drops or
// retries it.
func (e *OutboxEntry) Dead() bool { return e.Attempts >= OutboxMaxAttempts }

// TagChip is a card's label chip: tags.name/color through the dev_task_tags join
// (the flat task_tags payload shape, devboard-helpers.ts:154-159).
type TagChip struct {
	ID    string // tags.id
	Name  string // tags.name
	Color string // tags.color
}

// TaskCard is a task plus its presentation extras: label chips and the shot
// badge count (the S208 per-task shot_count — API-AND-SYNC-CONTRACT.md §3.2).
type TaskCard struct {
	Task
	Tags      []TagChip
	ShotCount int64
}

// scanner is the Scan subset shared by *sql.Rows and *sql.Row.
type scanner interface{ Scan(dest ...any) error }

// execer is the ExecContext subset shared by *sql.DB and *sql.Tx.
type execer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// ---------------------------------------------------------------------------
// SQL. Explicit column lists everywhere — never SELECT * — so column order is
// part of the contract with the scan code below.
// ---------------------------------------------------------------------------

const sqlUpsertProject = `
INSERT INTO projects (
  id, user_id, title, description, type, status, sort_order, latest_note,
  progress_percent, archived_state, client_name, due_date, reminders_enabled,
  folder_id, logo_path, created_at, updated_at, deleted_at, pinned_at, cover_shot_id
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  user_id = excluded.user_id, title = excluded.title,
  description = excluded.description, type = excluded.type,
  status = excluded.status, sort_order = excluded.sort_order,
  latest_note = excluded.latest_note,
  progress_percent = excluded.progress_percent,
  archived_state = excluded.archived_state, client_name = excluded.client_name,
  due_date = excluded.due_date, reminders_enabled = excluded.reminders_enabled,
  folder_id = excluded.folder_id, logo_path = excluded.logo_path,
  created_at = excluded.created_at, updated_at = excluded.updated_at,
  deleted_at = excluded.deleted_at, pinned_at = excluded.pinned_at,
  cover_shot_id = excluded.cover_shot_id`

const sqlInsertTask = `
INSERT INTO dev_tasks (
  id, project_id, title, status, priority, category_id, sprint_id, sort_order,
  created_at, done_at, start_at, end_at, search_tags, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

const sqlUpsertSprint = `
INSERT INTO sprints (
  id, project_id, name, started_at, ended_at, created_at, is_draft, version, description
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  project_id = excluded.project_id, name = excluded.name,
  started_at = excluded.started_at, ended_at = excluded.ended_at,
  created_at = excluded.created_at, is_draft = excluded.is_draft,
  version = excluded.version, description = excluded.description`

const sqlUpsertCategory = `
INSERT INTO categories (
  id, user_id, name, color_fill, color_text, is_archived, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  user_id = excluded.user_id, name = excluded.name,
  color_fill = excluded.color_fill, color_text = excluded.color_text,
  is_archived = excluded.is_archived, created_at = excluded.created_at`

// sqlUpsertTag has TWO conflict clauses: id is canonical (row-level diffing
// against cloud payloads), but the table also carries UNIQUE (user_id, name)
// verbatim from the cloud (DATA-MODEL.md §2.5) — if a pull delivers a tag under
// a new id for a (user_id, name) the mirror already holds, the second clause
// retargets that row to the new id instead of erroring out mid-replace.
const sqlUpsertTag = `
INSERT INTO tags (id, user_id, name, color, usage_count, created_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  user_id = excluded.user_id, name = excluded.name, color = excluded.color,
  usage_count = excluded.usage_count, created_at = excluded.created_at
ON CONFLICT(user_id, name) DO UPDATE SET
  id = excluded.id, color = excluded.color,
  usage_count = excluded.usage_count, created_at = excluded.created_at`

const sqlInsertTaskTag = `
INSERT OR IGNORE INTO dev_task_tags (task_id, tag_id) VALUES (?, ?)`

const sqlInsertProjectCategory = `
INSERT OR IGNORE INTO project_categories (project_id, category_id) VALUES (?, ?)`

const sqlDeleteBoardTaskTags = `
DELETE FROM dev_task_tags WHERE task_id IN (SELECT id FROM dev_tasks WHERE project_id = ?)`

const sqlDeleteBoardTasks = `DELETE FROM dev_tasks WHERE project_id = ?`

const sqlDeleteBoardProjectCategories = `
DELETE FROM project_categories WHERE project_id = ?`

const sqlGraceInsert = `
INSERT OR REPLACE INTO local_grace_tasks (id, project_id, title, seen_missing_at)
VALUES (?, ?, ?, ?)`

// sqlGraceClearRestored removes the shadow of any task that is back in
// dev_tasks for this project (re-appeared within the grace window → restored).
const sqlGraceClearRestored = `
DELETE FROM local_grace_tasks
WHERE project_id = ? AND id IN (SELECT id FROM dev_tasks WHERE project_id = ?)`

// sqlGracePurge drops shadows older than the 7-day window. String compare on
// the fixed-width ISO-8601 TEXT (§6, mapping notes). Global by design: a stale
// shadow is stale regardless of which board's pull is running.
const sqlGracePurge = `DELETE FROM local_grace_tasks WHERE seen_missing_at < ?`

const sqlInsertArchive = `
INSERT INTO project_archives (
  id, project_id, title, status, priority, category_id, sprint_id, done_at,
  original_created_at, archived_at, tags
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

const sqlUpsertScreenshot = `
INSERT INTO screenshots (
  id, project_id, github_path, mime_type, caption, created_at, resolved, task_id,
  bytes, filename
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  project_id = excluded.project_id, github_path = excluded.github_path,
  mime_type = excluded.mime_type, caption = excluded.caption,
  created_at = excluded.created_at, resolved = excluded.resolved,
  task_id = excluded.task_id, bytes = excluded.bytes,
  filename = excluded.filename`

const sqlListProjects = `
SELECT id, user_id, title, description, type, status, sort_order, latest_note,
  progress_percent, archived_state, client_name, due_date, reminders_enabled,
  folder_id, logo_path, created_at, updated_at, deleted_at, pinned_at, cover_shot_id
FROM projects
ORDER BY updated_at DESC`

// prioOrderSQL is the server's canonical board order (PRIO_ORDER semantics,
// devboard-helpers.ts:231-232; API-AND-SYNC-CONTRACT.md §3.2): priority rank,
// then sort_order, then created_at. The queries below alias dev_tasks as t.
const prioOrderSQL = `CASE t.priority
    WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
  t.sort_order, t.created_at`

const sqlGetBoard = `
SELECT id, project_id, title, status, priority, category_id, sprint_id, sort_order,
  created_at, done_at, start_at, end_at, search_tags, updated_at
FROM dev_tasks t
WHERE t.project_id = ?
ORDER BY ` + prioOrderSQL

const sqlBoardCards = `
SELECT t.id, t.project_id, t.title, t.status, t.priority, t.category_id, t.sprint_id,
  t.sort_order, t.created_at, t.done_at, t.start_at, t.end_at, t.search_tags, t.updated_at,
  COALESCE(g.id, ''), COALESCE(g.name, ''), COALESCE(g.color, ''),
  COALESCE(sc.shot_count, 0)
FROM dev_tasks t
LEFT JOIN dev_task_tags j ON j.task_id = t.id
LEFT JOIN tags g ON g.id = j.tag_id
LEFT JOIN (
  SELECT task_id, COUNT(*) AS shot_count FROM screenshots
  WHERE task_id IS NOT NULL GROUP BY task_id
) sc ON sc.task_id = t.id
WHERE t.project_id = ?
ORDER BY ` + prioOrderSQL

// ---------------------------------------------------------------------------
// Mirror writes (used by the sync pull).
// ---------------------------------------------------------------------------

func scanProject(sc scanner, p *Project) error {
	return sc.Scan(&p.ID, &p.UserID, &p.Title, &p.Description, &p.Type, &p.Status,
		&p.SortOrder, &p.LatestNote, &p.ProgressPercent, &p.ArchivedState,
		&p.ClientName, &p.DueDate, &p.RemindersEnabled, &p.FolderID, &p.LogoPath,
		&p.CreatedAt, &p.UpdatedAt, &p.DeletedAt, &p.PinnedAt, &p.CoverShotID)
}

func scanTask(sc scanner, t *Task) error {
	return sc.Scan(&t.ID, &t.ProjectID, &t.Title, &t.Status, &t.Priority,
		&t.CategoryID, &t.SprintID, &t.SortOrder, &t.CreatedAt, &t.DoneAt,
		&t.StartAt, &t.EndAt, &t.SearchTags, &t.UpdatedAt)
}

func upsertProject(ctx context.Context, ex execer, p Project) error {
	_, err := ex.ExecContext(ctx, sqlUpsertProject,
		p.ID, p.UserID, p.Title, p.Description, p.Type, p.Status, p.SortOrder,
		p.LatestNote, p.ProgressPercent, p.ArchivedState, p.ClientName, p.DueDate,
		p.RemindersEnabled, p.FolderID, p.LogoPath, p.CreatedAt, p.UpdatedAt,
		p.DeletedAt, p.PinnedAt, p.CoverShotID)
	return err
}

// UpsertProject writes one projects row keyed by id (INSERT .. ON CONFLICT(id)
// DO UPDATE over all columns) — the pull-side mirror write.
func (s *Store) UpsertProject(ctx context.Context, p Project) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := upsertProject(ctx, s.db, p); err != nil {
		return fmt.Errorf("store: upsert project %s: %w", p.ID, err)
	}
	return nil
}

// sqlMarkProjectGone tombstones a mirror row WITHOUT deleting it: the web's
// gone state (404 "doesn't exist or was deleted", board-page.js:913-921) is
// the server's own tombstone voice, so the mirror records it instead of
// re-polling a dead board every round. The guard clause (deleted_at IS NULL)
// keeps the FIRST gone stamp — the honest "when did it die" moment — and the
// list pull owns resurrection: a fresh server row (the project live again)
// clears the tombstone via UpsertProject's excluded.deleted_at overwrite.
const sqlMarkProjectGone = `UPDATE projects SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`

// MarkProjectGone tombstones one projects row (deleted_at = at, ISO-8601) and
// is idempotent: a row already tombstoned keeps its original stamp. An id the
// mirror does not hold is a no-op, never an error (the list pull owns the
// row's life, the board pull only ends it).
func (s *Store) MarkProjectGone(ctx context.Context, id, at string) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if _, err := s.db.ExecContext(ctx, sqlMarkProjectGone, at, id); err != nil {
		return fmt.Errorf("store: mark project gone %s: %w", id, err)
	}
	return nil
}

// ReplaceBoard swaps in one project's freshly-pulled board atomically. One
// transaction: upsert the project; delete + reinsert that project's dev_tasks /
// dev_task_tags / project_categories; upsert sprints / categories / tags (tags
// are user-scoped: upsert by id, never delete user tags here); then the
// disappearance pass (GO-DESKTOP-PORT-PLAN.md §5, "disappeared from pull =
// deleted, 7-day local grace copy"; DATA-MODEL.md §6 "Deletion shadow
// (pre-tombstone)"):
//
//   - every previously-mirrored task of this project that is NOT in the fresh
//     set moves to local_grace_tasks (INSERT OR REPLACE, seen_missing_at = now)
//     and is gone from dev_tasks and dev_task_tags;
//   - a task that re-appears inside the grace window is restored by the fresh
//     insert itself, and its shadow row is dropped;
//   - shadows with seen_missing_at older than 7 days are purged (string
//     compare on ISO-8601 TEXT).
//
// projectID, p and tasks must agree (loud checks below): the board payload is
// project-scoped and complete (API-AND-SYNC-CONTRACT.md §3.2), so anything
// absent from the fresh set was deleted upstream.
func (s *Store) ReplaceBoard(ctx context.Context, projectID string, p Project, tasks []Task, sprints []Sprint, categories []Category, tags []Tag, taskTags []TaskTag, projCategories []CategoryRef) error {
	if p.ID != projectID {
		return fmt.Errorf("store: ReplaceBoard: project id %q does not match board id %q", p.ID, projectID)
	}
	for _, t := range tasks {
		if t.ProjectID != projectID {
			return fmt.Errorf("store: ReplaceBoard: task %q belongs to project %q, not %q", t.ID, t.ProjectID, projectID)
		}
	}
	for _, sp := range sprints {
		if sp.ProjectID != projectID {
			return fmt.Errorf("store: ReplaceBoard: sprint %q belongs to project %q, not %q", sp.ID, sp.ProjectID, projectID)
		}
	}

	fresh := make(map[string]struct{}, len(tasks))
	for _, t := range tasks {
		fresh[t.ID] = struct{}{}
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() // no-op after a successful Commit

	// 1. Snapshot the previously-mirrored task set (id + title) before deleting:
	//    the disappearance pass needs it for the shadow rows.
	type shadowed struct{ id, title string }
	var oldTasks []shadowed
	rows, err := tx.QueryContext(ctx, `SELECT id, title FROM dev_tasks WHERE project_id = ?`, projectID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var o shadowed
		if err := rows.Scan(&o.id, &o.title); err != nil {
			rows.Close()
			return err
		}
		oldTasks = append(oldTasks, o)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	// 2. Project upsert. The board payload's project header carries ONLY
	//    {id, title, status, type} (devboard.ts:139-195) — CreatedAt empty
	//    signals the board-pull partial. A full upsert would clobber the
	//    description/latest_note/created_at… the projects-list pull owns
	//    (RefreshProjects upserts full rows); so: targeted header UPDATE when
	//    the row exists, INSERT belt (nullable-safe empty strings) when the
	//    board arrived before its list pull on a fresh mirror.
	if p.CreatedAt == "" {
		res, err := tx.ExecContext(ctx,
			`UPDATE projects SET title = ?, status = ?, type = ? WHERE id = ?`,
			p.Title, p.Status, p.Type, p.ID)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			partial := p
			partial.CreatedAt = "" // NOT NULL column: the list pull replaces this belt row
			if err := upsertProject(ctx, tx, partial); err != nil {
				return err
			}
		}
	} else if err := upsertProject(ctx, tx, p); err != nil {
		return err
	}

	// 3. Clear the project's previous board rows. The join rows go first (they
	//    key on task ids), then the tasks, then the project↔category joins.
	if _, err := tx.ExecContext(ctx, sqlDeleteBoardTaskTags, projectID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, sqlDeleteBoardTasks, projectID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, sqlDeleteBoardProjectCategories, projectID); err != nil {
		return err
	}

	// 4. Fresh task set.
	insertTask, err := tx.PrepareContext(ctx, sqlInsertTask)
	if err != nil {
		return err
	}
	for _, t := range tasks {
		if _, err := insertTask.ExecContext(ctx, t.ID, t.ProjectID, t.Title, t.Status,
			t.Priority, t.CategoryID, t.SprintID, t.SortOrder, t.CreatedAt, t.DoneAt,
			t.StartAt, t.EndAt, t.SearchTags, t.UpdatedAt); err != nil {
			return err
		}
	}

	// 5. Card↔label joins. Filtered to the fresh task set: a join row for a task
	//    the payload doesn't carry would just dangle (dev_task_tags has no FK and
	//    is only ever read through dev_tasks).
	insertTaskTag, err := tx.PrepareContext(ctx, sqlInsertTaskTag)
	if err != nil {
		return err
	}
	for _, j := range taskTags {
		if _, ok := fresh[j.TaskID]; !ok {
			continue
		}
		if _, err := insertTaskTag.ExecContext(ctx, j.TaskID, j.TagID); err != nil {
			return err
		}
	}

	// 6. Project↔category joins.
	insertProjectCategory, err := tx.PrepareContext(ctx, sqlInsertProjectCategory)
	if err != nil {
		return err
	}
	for _, c := range projCategories {
		if _, err := insertProjectCategory.ExecContext(ctx, c.ProjectID, c.CategoryID); err != nil {
			return err
		}
	}

	// 7. Sprints, categories, tags — upserts by id (never deletes; tags are
	//    user-scoped, sprints/categories may still be referenced elsewhere).
	upsertSprint, err := tx.PrepareContext(ctx, sqlUpsertSprint)
	if err != nil {
		return err
	}
	for _, sp := range sprints {
		if _, err := upsertSprint.ExecContext(ctx, sp.ID, sp.ProjectID, sp.Name,
			sp.StartedAt, sp.EndedAt, sp.CreatedAt, sp.IsDraft, sp.Version,
			sp.Description); err != nil {
			return err
		}
	}
	upsertCategory, err := tx.PrepareContext(ctx, sqlUpsertCategory)
	if err != nil {
		return err
	}
	for _, c := range categories {
		if _, err := upsertCategory.ExecContext(ctx, c.ID, c.UserID, c.Name,
			c.ColorFill, c.ColorText, c.IsArchived, c.CreatedAt); err != nil {
			return err
		}
	}
	upsertTag, err := tx.PrepareContext(ctx, sqlUpsertTag)
	if err != nil {
		return err
	}
	for _, tg := range tags {
		if _, err := upsertTag.ExecContext(ctx, tg.ID, tg.UserID, tg.Name, tg.Color,
			tg.UsageCount, tg.CreatedAt); err != nil {
			return err
		}
	}

	// 8. Disappearance pass: previously-mirrored tasks absent from the fresh set
	//    move to the shadow table (their dev_tasks / dev_task_tags rows are
	//    already gone via step 3). The 7-day clock starts at the FIRST
	//    disappearance: a task already shadowed in an earlier pull is not
	//    re-stamped.
	moveToGrace, err := tx.PrepareContext(ctx, sqlGraceInsert)
	if err != nil {
		return err
	}
	for _, o := range oldTasks {
		if _, ok := fresh[o.id]; ok {
			continue
		}
		if _, err := moveToGrace.ExecContext(ctx, o.id, projectID, o.title, nowISO()); err != nil {
			return err
		}
	}

	// 9. Restored tasks lose their shadow (re-appeared within the window).
	if _, err := tx.ExecContext(ctx, sqlGraceClearRestored, projectID, projectID); err != nil {
		return err
	}

	// 10. Purge shadows past the 7-day window (string compare, ISO-8601).
	cutoff := time.Now().UTC().Add(-gracePeriod).Format(isoLayout)
	if _, err := tx.ExecContext(ctx, sqlGracePurge, cutoff); err != nil {
		return err
	}

	if err := tx.Commit(); err != nil {
		return err
	}
	return nil
}

// UpsertArchives replaces the archived-task set for one project (delete + insert
// inside one transaction). Archived ≠ deleted: the rows stay restorable
// (DATA-MODEL.md §2.6) — only the project-scoped set is swapped, mirroring the
// cloud's current archive list for the pull.
func (s *Store) UpsertArchives(ctx context.Context, projectID string, arcs []Archive) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() // no-op after a successful Commit

	if _, err := tx.ExecContext(ctx, `DELETE FROM project_archives WHERE project_id = ?`, projectID); err != nil {
		return err
	}
	insertArchive, err := tx.PrepareContext(ctx, sqlInsertArchive)
	if err != nil {
		return err
	}
	for _, a := range arcs {
		if _, err := insertArchive.ExecContext(ctx, a.ID, a.ProjectID, a.Title,
			a.Status, a.Priority, a.CategoryID, a.SprintID, a.DoneAt,
			a.OriginalCreatedAt, a.ArchivedAt, a.Tags); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// UpsertScreenshot writes one screenshots row (metadata only — bytes stay in
// the store/local files, DATA-MODEL.md §2.8), keyed by id.
func (s *Store) UpsertScreenshot(ctx context.Context, sc Shot) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, err := s.db.ExecContext(ctx, sqlUpsertScreenshot,
		sc.ID, sc.ProjectID, sc.GitHubPath, sc.MimeType, sc.Caption, sc.CreatedAt,
		sc.Resolved, sc.TaskID, sc.Bytes, sc.Filename)
	if err != nil {
		return fmt.Errorf("store: upsert screenshot %s: %w", sc.ID, err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Outbox — the local FIFO mutation queue (never pushed as a table; its ENTRIES
// are drained to the cloud by internal/sync).
// ---------------------------------------------------------------------------

// Enqueue appends one mutation to the outbox. op is the operation
// ("create_task", "patch_task", …), entity + id address the row, payload is the
// request JSON, and idempotencyKey is the replay belt for creates that accept
// client ids (DATA-MODEL.md §7); an empty key stores NULL.
func (s *Store) Enqueue(ctx context.Context, op, entity, id, payload, idempotencyKey string) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	var key *string
	if idempotencyKey != "" {
		key = &idempotencyKey
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO outbox (op, entity, id, payload, idempotency_key, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
		op, entity, id, payload, key, nowISO())
	if err != nil {
		return fmt.Errorf("store: enqueue %s %s: %w", op, id, err)
	}
	return nil
}

// NextOutbox returns the oldest queued entry (FIFO by seq). The outbox has no
// done state in its spec'd shape (DATA-MODEL.md §6): completion is DELETION, so
// every row still standing is pending — including dead-lettered ones
// (attempts ≥ OutboxMaxAttempts), which stay visible here until the sync
// engine decides to drop or retry them.
func (s *Store) NextOutbox(ctx context.Context) (*OutboxEntry, bool, error) {
	var e OutboxEntry
	err := s.db.QueryRowContext(ctx,
		`SELECT seq, op, entity, id, payload, idempotency_key, created_at, attempts, last_error
                 FROM outbox ORDER BY seq ASC LIMIT 1`,
	).Scan(&e.Seq, &e.Op, &e.Entity, &e.ID, &e.Payload, &e.IdempotencyKey,
		&e.CreatedAt, &e.Attempts, &e.LastError)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("store: next outbox: %w", err)
	}
	return &e, true, nil
}

// MarkOutboxAttempt records one drain attempt on an entry: attempts++ and
// last_error set to errMsg (an empty errMsg clears last_error to NULL — the
// "unknown outcome, hold the entry" case of DATA-MODEL.md §7). The row itself
// stays queued; only DropOutbox completes it.
func (s *Store) MarkOutboxAttempt(ctx context.Context, seq int64, errMsg string) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	var le *string
	if errMsg != "" {
		le = &errMsg
	}
	if _, err := s.db.ExecContext(ctx,
		`UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE seq = ?`,
		le, seq); err != nil {
		return fmt.Errorf("store: mark outbox attempt %d: %w", seq, err)
	}
	return nil
}

// DropOutbox deletes an entry — the ONLY completion path (success, or the
// sync engine's final verdict on a dead-lettered row).
func (s *Store) DropOutbox(ctx context.Context, seq int64) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if _, err := s.db.ExecContext(ctx, `DELETE FROM outbox WHERE seq = ?`, seq); err != nil {
		return fmt.Errorf("store: drop outbox %d: %w", seq, err)
	}
	return nil
}

// OutboxLen returns the number of queued entries (dead-lettered included —
// filtering them is the sync engine's call).
func (s *Store) OutboxLen(ctx context.Context) (int, error) {
	var n int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM outbox`).Scan(&n); err != nil {
		return 0, fmt.Errorf("store: outbox len: %w", err)
	}
	return n, nil
}

// ResetAccount wipes every ACCOUNT-scoped table + the pull-cursor meta rows
// in ONE transaction — the logout hand-off (the v0.1.9 owner ask: "option of
// logout and enter with a new account"): the previous account's boards, tasks,
// chips, screenshots, deletion shadows and queued outbox ops leave the
// machine with the session, so the next account starts from a clean mirror
// and its first pull is a full unconditional 200 (the paired
// api.Client.ClearSession drops the in-memory validators; the engine's 304
// cheap-poll assumes the mirror still holds the content a wipe just removed).
//
// The DEVICE-scoped meta rows survive a sign-out by design — the caller
// names them in keepMeta (the shell passes ui.ThemeMetaKey +
// internal/tray.MetaKey): the light/dark preference and the close-to-tray
// toggle are machine settings, not account data. Every OTHER meta key dies
// (the engine's cursors — etag:*, lastpull:*, projects-pull — are
// account-validated facts that must never cross an account boundary).
// Idempotent: resetting an already-clean mirror is a no-op.
func (s *Store) ResetAccount(ctx context.Context, keepMeta ...string) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: reset account: %w", err)
	}
	defer tx.Rollback() // no-op after a successful Commit

	// Children before parents on the FK graph (dev_tasks → projects etc.),
	// though foreign_keys would accept any order inside one tx of pure
	// DELETEs — the explicit order keeps the intent legible.
	for _, table := range []string{
		"dev_task_tags",
		"dev_tasks",
		"sprints",
		"categories",
		"tags",
		"project_categories",
		"project_archives",
		"screenshots",
		"local_grace_tasks",
		"projects",
		"outbox",
	} {
		if _, err := tx.ExecContext(ctx, `DELETE FROM `+table); err != nil {
			return fmt.Errorf("store: reset account: wiping %s: %w", table, err)
		}
	}

	// The meta keep-list: device prefs stay, engine cursors go.
	if len(keepMeta) == 0 {
		if _, err := tx.ExecContext(ctx, `DELETE FROM meta`); err != nil {
			return fmt.Errorf("store: reset account: wiping meta: %w", err)
		}
	} else {
		placeholders := strings.TrimRight(strings.Repeat("?,", len(keepMeta)), ",")
		args := make([]interface{}, 0, len(keepMeta))
		for _, k := range keepMeta {
			args = append(args, k)
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM meta WHERE key NOT IN (`+placeholders+`)`, args...); err != nil {
			return fmt.Errorf("store: reset account: pruning meta: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: reset account: commit: %w", err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Meta — pull cursors (last server_time) and the ETag map (one JSON blob under
// one key is fine). NEVER store credentials in meta: the session cookie is
// DPAPI-persisted by internal/auth (GO-DESKTOP-IMPLEMENTATION-GUIDE.md §5.5),
// not mirrored here (DATA-MODEL.md §6 keeps auth state out of the mirror).
// ---------------------------------------------------------------------------

// GetMeta reads one meta value; ok is false when the key is absent.
func (s *Store) GetMeta(ctx context.Context, key string) (value string, ok bool, err error) {
	err = s.db.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = ?`, key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("store: get meta %q: %w", key, err)
	}
	return value, true, nil
}

// SetMeta writes one meta value (upsert).
func (s *Store) SetMeta(ctx context.Context, key, value string) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if _, err := s.db.ExecContext(ctx,
		`INSERT INTO meta (key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		key, value); err != nil {
		return fmt.Errorf("store: set meta %q: %w", key, err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Reads for the read-only board (M2 surface; kept minimal).
// ---------------------------------------------------------------------------

// ListProjects returns all mirrored projects, most recently updated first
// (updated_at DESC — string compare on ISO-8601 TEXT).
func (s *Store) ListProjects(ctx context.Context) ([]Project, error) {
	rows, err := s.db.QueryContext(ctx, sqlListProjects)
	if err != nil {
		return nil, fmt.Errorf("store: list projects: %w", err)
	}
	defer rows.Close()
	var out []Project
	for rows.Next() {
		var p Project
		if err := scanProject(rows, &p); err != nil {
			return nil, fmt.Errorf("store: scan project: %w", err)
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list projects: %w", err)
	}
	return out, nil
}

// GetBoard returns one project's tasks in the server's canonical board order:
// PRIO_ORDER rank, then sort_order, then created_at (the contract's order —
// devboard-helpers.ts:231-232; API-AND-SYNC-CONTRACT.md §3.2).
func (s *Store) GetBoard(ctx context.Context, projectID string) ([]Task, error) {
	rows, err := s.db.QueryContext(ctx, sqlGetBoard, projectID)
	if err != nil {
		return nil, fmt.Errorf("store: get board %s: %w", projectID, err)
	}
	defer rows.Close()
	var out []Task
	for rows.Next() {
		var t Task
		if err := scanTask(rows, &t); err != nil {
			return nil, fmt.Errorf("store: scan task: %w", err)
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get board %s: %w", projectID, err)
	}
	return out, nil
}

// BoardTasksWithTags returns one project's tasks in board order, each with its
// label chips (tags.id/name/color via dev_task_tags → tags) and its shot badge
// count (COUNT over screenshots.task_id — the S208 per-task shot_count,
// API-AND-SYNC-CONTRACT.md §3.2; project-level shots with task_id NULL count
// toward no card).
func (s *Store) BoardTasksWithTags(ctx context.Context, projectID string) ([]TaskCard, error) {
	rows, err := s.db.QueryContext(ctx, sqlBoardCards, projectID)
	if err != nil {
		return nil, fmt.Errorf("store: board cards %s: %w", projectID, err)
	}
	defer rows.Close()

	var cards []TaskCard
	last := -1 // index of the card the current row belongs to
	for rows.Next() {
		var (
			t    Task
			chip TagChip
			shot int64
		)
		if err := rows.Scan(&t.ID, &t.ProjectID, &t.Title, &t.Status, &t.Priority,
			&t.CategoryID, &t.SprintID, &t.SortOrder, &t.CreatedAt, &t.DoneAt,
			&t.StartAt, &t.EndAt, &t.SearchTags, &t.UpdatedAt,
			&chip.ID, &chip.Name, &chip.Color, &shot); err != nil {
			return nil, fmt.Errorf("store: scan task card: %w", err)
		}
		// All rows of one task share the ORDER BY keys, so they arrive
		// adjacent; each row contributes at most one chip.
		if last < 0 || cards[last].ID != t.ID {
			cards = append(cards, TaskCard{Task: t, ShotCount: shot})
			last = len(cards) - 1
		}
		if chip.ID != "" {
			cards[last].Tags = append(cards[last].Tags, chip)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: board cards %s: %w", projectID, err)
	}
	return cards, nil
}
