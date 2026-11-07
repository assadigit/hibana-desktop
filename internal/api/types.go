// Package api — the cloud client for the existing Hibana Worker API.
//
// Everything here implements API-AND-SYNC-CONTRACT.md §1-§6 + §8 (the VERIFIED
// facts of v0.4.1.35 / schema 63):
//
//   - Cookie-session auth: the __Host-hibana_session cookie is HOST-ONLY; the
//     desktop holds its own session (§2) — one login POST, the jar keeps it,
//     30-day rolling expiry.
//   - The T6 CSRF/origin gate: every POST/PUT/PATCH/DELETE must carry an Origin
//     header (a headerless writer is 403'd, src/app.ts:172-194). The client
//     stamps Origin: <trusted origin> on every write — the island never knows.
//   - JSON-only: always Accept: application/json, never HX-Request (§3).
//   - ETags: weak FNV-1a body-hash validators on the hot GETs (§8); the client
//     keeps the last ETag per path and sends If-None-Match — a 304 costs one
//     header and zero body work. The WEB board client bypasses this with
//     cache:'no-store' (an S206 Chromium workaround, NOT a server contract);
//     the Go stack uses the ETag path as the contract recommends.
//   - The web client's resilience recipe (devboard.js:10-64) re-homed: GETs
//     carry a 3s deadline + ONE fresh retry; mutations never retry blind
//     (double-write risk) — the OUTBOX owns their retry semantics (§10).
package api

import "time"

// Me is GET /api/auth/me — identity + language/calendar prefs (contract §3.4).
// Only the fields the desktop consumes are decoded; JSON decoding ignores the rest.
type Me struct {
	User MeUser `json:"user"`
}

type MeUser struct {
	ID           string `json:"id"`
	Username     string `json:"username"`
	Email        string `json:"email"`
	Role         string `json:"role"`
	LanguagePref string `json:"language_pref"`
	CalendarPref string `json:"calendar_pref"`
}

// ProjectListItem is one row of GET /api/projects — a FULL ProjectRow + the
// tags array (contract §3.1). The desktop uses it both for the switcher and
// for mirroring full project rows (the list pull OWNS the projects table;
// the board payload carries only the 4-field header).
type ProjectListItem struct {
	ID               string   `json:"id"`
	UserID           string   `json:"user_id"`
	Title            string   `json:"title"`
	Description      string   `json:"description"`
	Type             string   `json:"type"`
	Status           string   `json:"status"`
	SortOrder        int64    `json:"sort_order"`
	LatestNote       string   `json:"latest_note"`
	ProgressPercent  *int64   `json:"progress_percent"`
	ArchivedState    *string  `json:"archived_state"`
	ClientName       *string  `json:"client_name"`
	DueDate          *string  `json:"due_date"`
	RemindersEnabled int64    `json:"reminders_enabled"`
	FolderID         *string  `json:"folder_id"`
	LogoPath         *string  `json:"logo_path"`
	CreatedAt        string   `json:"created_at"`
	UpdatedAt        string   `json:"updated_at"`
	DeletedAt        *string  `json:"deleted_at"`
	PinnedAt         *string  `json:"pinned_at"`
	CoverShotID      *string  `json:"cover_shot_id"`
	Tags             []string `json:"tags"`
}

type projectsListResp struct {
	Projects []ProjectListItem `json:"projects"`
}

// BoardPayload is THE one board payload: GET /api/projects/:id/devboard
// (contract §3.2, devboard.ts:139-195). Seven keys since S241/S248 (the 0065
// additive surface, contract §12), ETag-wrapped.
type BoardPayload struct {
	Project    BoardProject  `json:"project"`
	Tasks      []TaskPayload `json:"tasks"`
	Categories []CategoryRow `json:"categories"`
	Sprints    []SprintRow   `json:"sprints"`
	Tags       []TagRow      `json:"tags"`
	TaskTags   []TaskTagJoin `json:"task_tags"`

	// S248 (Phase 9 / contract §12.3): the 7th additive key — the flat per-project
	// dep edge join {blocker_task_id, blocked_task_id}, ordered deterministically
	// upstream. Additive + backward-compatible: a decoder that ignores it keeps
	// working against a pre-0065 payload (which never carries the key).
	TaskDeps []TaskDepEdge `json:"task_deps,omitempty"`

	// S250 (0066 / STRATEGIES-SPEC §4): the 8th additive key — the project's
	// strategy registry (priority-first order upstream). Additive + omitempty:
	// a decoder that ignores it keeps working against a pre-0066 payload.
	Strategies []StrategyRow `json:"strategies,omitempty"`
}

// TaskDepEdge is one payload task_deps row: "blocker_task_id blocks
// blocked_task_id" (0065 / contract §12.3). The reverse Blocks view is derived
// client-side — never a separate endpoint or a stored column.
type TaskDepEdge struct {
	BlockerTaskID string `json:"blocker_task_id"`
	BlockedTaskID string `json:"blocked_task_id"`
}

// BoardProject is the payload's project header (four fields only).
type BoardProject struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Status string `json:"status"`
	Type   string `json:"type"`
}

// TaskPayload is one dev_tasks row as the board serves it: the SQL columns
// (SELECT t.*, devboard.ts:152) + the S208 additions — tags (joined tag-id
// array, devboard.ts:187) and shot_count (COALESCE pin count, devboard.ts:152-153).
// S248 (Phase 9 / contract §12.2): the 0065 additive deadline pair + the
// SERVER-COMPUTED effective-deadline triple ride every row — decoded verbatim,
// never resolved locally (spec §18: the desktop ships zero deadline logic).
type TaskPayload struct {
	ID         string   `json:"id"`
	ProjectID  string   `json:"project_id"`
	Title      string   `json:"title"`
	Status     string   `json:"status"`
	Priority   string   `json:"priority"`
	CategoryID *string  `json:"category_id"`
	SprintID   *string  `json:"sprint_id"`
	SortOrder  int64    `json:"sort_order"`
	CreatedAt  string   `json:"created_at"`
	DoneAt     *string  `json:"done_at"`
	StartAt    *string  `json:"start_at"`
	EndAt      *string  `json:"end_at"`
	SearchTags string   `json:"search_tags"`
	UpdatedAt  *string  `json:"updated_at"`
	Tags       []string `json:"tags"`       // tag IDs, joined server-side
	ShotCount  int64    `json:"shot_count"` // pinned screenshots count

	// S248: the personal deadline pair (raw 0065 columns).
	DueAt     *string `json:"due_at"`        // ISO-8601 instant or null
	DueOrigin *string `json:"due_origin_at"` // the progress START stamp (§12.2)

	// S248: the computed triple (personal > sprint-inherited-while-not-completed
	// > none, resolved server-side by effectiveDeadlineOf — contract §12.2).
	EffectiveDueAt     *string `json:"effective_due_at"`        // the resolved instant or null
	EffectiveDueSource *string `json:"effective_due_source"`    // "task" | "sprint" | null
	EffectiveDueOrigin *string `json:"effective_due_origin_at"` // the winning level's origin stamp
}

// CategoryRow is the payload's project-visible category slice: the global
// library's rows enabled for this project UNION task-referenced ones —
// `enabled` splits the picker set from the chip set (devboard.ts:173-183).
type CategoryRow struct {
	ID         string `json:"id"`
	UserID     string `json:"user_id"`
	Name       string `json:"name"`
	ColorFill  string `json:"color_fill"`
	ColorText  string `json:"color_text"`
	IsArchived int64  `json:"is_archived"`
	CreatedAt  string `json:"created_at"`
	Enabled    int64  `json:"enabled"`
}

// SprintRow is one sprints row (DATA-MODEL.md §2.3), verbatim. S248 (Phase 9 /
// contract §12.1): the 0065 additive columns — the explicit lifecycle status
// (planned|active|paused|completed; NULL only on a lagging pre-0065 payload),
// emoji, the due pair, and updated_at — all decoded verbatim (the origin rules,
// thresholds, and precedence live server-side only).
type SprintRow struct {
	ID          string  `json:"id"`
	ProjectID   string  `json:"project_id"`
	Name        string  `json:"name"`
	StartedAt   string  `json:"started_at"`
	EndedAt     *string `json:"ended_at"`
	CreatedAt   string  `json:"created_at"`
	IsDraft     int64   `json:"is_draft"`
	Version     *string `json:"version"`
	Description *string `json:"description"`

	// S248: 0065's additive columns (contract §12.1).
	Status    *string `json:"status"`        // planned|active|paused|completed (nullable)
	Emoji     *string `json:"emoji"`         // one picker token (nullable)
	DueAt     *string `json:"due_at"`        // ISO-8601 instant (nullable)
	DueOrigin *string `json:"due_origin_at"` // progress START stamp (nullable)
	UpdatedAt *string `json:"updated_at"`    // stamped on every cloud write — D8 (nullable)

	// S250: 0066's additive column — the optional strategy this sprint serves
	// (STRATEGIES-SPEC §3; NULL = unassigned; ON DELETE SET NULL cloud-side).
	StrategyID *string `json:"strategy_id"`
}

// StrategyRow is one strategies row (0066 / STRATEGIES-SPEC §3), verbatim — the
// tier above sprints: the broad direction a sprint serves. Lifecycle mirrors the
// sprint grammar (active|paused|completed — NOT NULL at birth cloud-side); the
// priority REUSES the task vocabulary; the roll-up is derived, never stored.
type StrategyRow struct {
	ID          string  `json:"id"`
	ProjectID   string  `json:"project_id"`
	Name        string  `json:"name"`
	Description string  `json:"description"`
	Priority    string  `json:"priority"`   // low|medium|high|urgent (the task vocabulary)
	Status      string  `json:"status"`     // active|paused|completed
	Emoji       *string `json:"emoji"`      // one picker token (nullable; ⚑ default)
	SortOrder   int64   `json:"sort_order"` // future manual drag; v1 sorts priority-first upstream
	CreatedAt   string  `json:"created_at"`
	UpdatedAt   *string `json:"updated_at"` // the D8 sync stamp (nullable)
}

// TagRow is one tags row (DATA-MODEL.md §2.5), verbatim — user-scoped labels.
type TagRow struct {
	ID         string `json:"id"`
	UserID     string `json:"user_id"`
	Name       string `json:"name"`
	Color      string `json:"color"`
	UsageCount int64  `json:"usage_count"`
	CreatedAt  string `json:"created_at"`
}

// TaskTagJoin is the flat per-task label join ({task_id, id, name, color}) —
// one query, joined client-side by whoever renders cards (devboard.ts:193,
// devboard-helpers.ts:160-167).
type TaskTagJoin struct {
	TaskID string `json:"task_id"`
	ID     string `json:"id"`
	Name   string `json:"name"`
	Color  string `json:"color"`
}

// CreateTaskReq is POST /api/projects/:id/devtasks (createDevTaskSchema,
// devboard.ts:43-59): title ≤100k, tags ride the create as names (≤12 × ≤48).
type CreateTaskReq struct {
	Title      string   `json:"title"`
	Status     string   `json:"status,omitempty"`
	Priority   string   `json:"priority,omitempty"`
	CategoryID string   `json:"category_id,omitempty"`
	SprintID   string   `json:"sprint_id,omitempty"`
	StartAt    string   `json:"start_at,omitempty"`
	EndAt      string   `json:"end_at,omitempty"`
	Tags       []string `json:"tags,omitempty"`
}

// CreateTaskResp is the create response: server-minted id + resolved tags
// (devboard.ts:231-241). NOTE (DATA-MODEL §7): ids are SERVER-minted today —
// offline-create idempotency is the M0 §7c addition; until it ships, a retried
// create duplicates and the drain must be at-most-once per entry.
type CreateTaskResp struct {
	OK   bool     `json:"ok"`
	ID   string   `json:"id"`
	Tags []TagRow `json:"tags"`
}

// PatchTaskReq is PATCH /api/devtasks/:id (updateDevTaskSchema, devboard.ts:60-72):
// ONLY the fields the body carries are written server-side (the SET builder —
// LWW-per-field merges cleanly, contract §10). Tags are a replace-set.
type PatchTaskReq struct {
	Title      *string  `json:"title,omitempty"`
	Status     *string  `json:"status,omitempty"`
	Priority   *string  `json:"priority,omitempty"`
	CategoryID *string  `json:"category_id,omitempty"`
	SprintID   *string  `json:"sprint_id,omitempty"`
	SortOrder  *int64   `json:"sort_order,omitempty"`
	StartAt    *string  `json:"start_at,omitempty"`
	EndAt      *string  `json:"end_at,omitempty"`
	Tags       []string `json:"tags,omitempty"`
}

// CreateProjectReq is POST /api/projects — the ONE idempotent create today:
// an optional client UUID replays 200 {ok, duplicate:true} (index.ts:394-402).
type CreateProjectReq struct {
	ID    string `json:"id,omitempty"` // client-minted UUID — the offline-replay belt
	Title string `json:"title"`
}

type okResp struct {
	OK    bool   `json:"ok"`
	ID    string `json:"id,omitempty"`
	Dup   bool   `json:"duplicate,omitempty"`
	Error string `json:"error,omitempty"`
	Count int64  `json:"archived,omitempty"`
}

// ArchiveRow is one project_archives row as GET …/archives serves it
// (devboard.ts:381-399): the done-task snapshot + parsed label snapshot.
// S248 (Phase 9 / contract §12.1 D3): sprint_name_snapshot rides additively —
// a deleted sprint's history survives as "<name> (deleted)"; a finish stamps
// the sprint's own name. NULL on rows archived before their sprint gained the
// label (and absent entirely on a lagging pre-0065 payload → nil here).
type ArchiveRow struct {
	ID                string       `json:"id"`
	ProjectID         string       `json:"project_id"`
	Title             string       `json:"title"`
	Status            string       `json:"status"`
	Priority          string       `json:"priority"`
	CategoryID        *string      `json:"category_id"`
	SprintID          *string      `json:"sprint_id"`
	DoneAt            *string      `json:"done_at"`
	OriginalCreatedAt string       `json:"original_created_at"`
	ArchivedAt        string       `json:"archived_at"`
	Tags              []ArchiveTag `json:"tags"`
	SprintName        *string      `json:"sprint_name_snapshot"` // S248, D3
}

// ArchiveTag is one parsed label snapshot entry ({name, color}).
type ArchiveTag struct {
	Name  string `json:"name"`
	Color string `json:"color"`
}

type archivesResp struct {
	Archives []ArchiveRow `json:"archives"`
}

// Rate-limit windows (contract §3.6 — fixed 60s windows, D1-backed): auth 30
// and upload 30 per 60s. The desktop paces itself BELOW the ceiling.
const (
	authBucket   = "auth"
	uploadBucket = "upload"

	rateWindow  = 60 * time.Second
	rateCeiling = 30
)
