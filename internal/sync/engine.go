package sync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"hibana/desktop/internal/api"
	"hibana/desktop/internal/store"
)

// Meta keys (the store's local-only meta table — DATA-MODEL.md §6).
const (
	metaETagPrefix   = "etag:"         // + board path → last validator
	metaLastPull     = "lastpull:"     // + project id → ISO time of the last 200 pull
	metaProjectsPull = "projects-pull" // ISO time of the last projects-list pull
)

// ErrProjectGone — the 404 branch: "doesn't exist or was deleted" (the web's
// gone state, board-page.js:913-921). The shell shows the gone screen; the
// engine stops pulling that board until the projects list says otherwise.
var ErrProjectGone = errors.New("sync: project gone (404)")

// Engine is the pull + push engine. The PULL cadence (on focus + every 5 min
// + manual, contract §10) is owned by the shell's timers; the engine owns one
// pull and one drain round-trip each.
type Engine struct {
	client  *api.Client
	store   *store.Store
	relogin func(ctx context.Context) error // the 401 re-auth hook (the shell wires the login window; nil = surface the 401)
	now     func() time.Time
}

func New(c *api.Client, s *store.Store) *Engine {
	return &Engine{client: c, store: s, now: time.Now}
}

// SetRelogin wires the 401 re-auth hook: on a drained op's 401 the engine
// calls it once, then retries the op once (contract §10's outbox rule).
func (e *Engine) SetRelogin(fn func(ctx context.Context) error) { e.relogin = fn }

// RefreshProjects pulls the projects list (sort=recent — the switcher's model)
// and upserts FULL rows into the mirror. This is the path that owns the
// projects table; the board pull only updates the 4-field header.
//
// A 304 from the list GET is the §10 cheap-poll doing its job ("the cheap
// pre-check: GET /api/projects?sort=recent + ETag") — nothing changed, the
// mirror stands, and the caller proceeds (the per-board pulls each carry
// their own validators).
func (e *Engine) RefreshProjects(ctx context.Context) (int, error) {
	list, err := e.client.ListProjects(ctx)
	if err != nil {
		if errors.Is(err, api.ErrNotModified) {
			n, merr := e.store.ListProjects(ctx)
			if merr != nil {
				return 0, merr
			}
			return len(n), nil
		}
		return 0, err
	}
	for _, p := range list {
		if err := e.store.UpsertProject(ctx, projectListToStore(p)); err != nil {
			return 0, fmt.Errorf("sync: mirroring project %s: %w", p.ID, err)
		}
	}
	_ = e.store.SetMeta(ctx, metaProjectsPull, e.now().UTC().Format(time.RFC3339Nano))
	return len(list), nil
}

// Pull does one board pull with the ETag cheap-poll (§8/§10):
//
//	path := /api/projects/:id/devboard
//	seed the client's ETag store from the mirror's meta (fresh process)
//	GET with If-None-Match → 304 → nothing to do (pulled=false)
//	                     → 200 → ReplaceBoard into the mirror + persist the ETag
//
// 404 → ErrProjectGone. 401/other statuses flow through as *api.StatusError so
// the shell can branch (401 → the session-expiry dialog → relogin → retry).
func (e *Engine) Pull(ctx context.Context, projectID string) (pulled bool, err error) {
	path := api.BoardPath(projectID)
	if et := e.client.ETag(path); et == "" {
		if stored, ok, _ := e.store.GetMeta(ctx, metaETagPrefix+path); ok && stored != "" {
			e.client.SetETag(path, stored)
		}
	}
	resp, err := e.client.Request(ctx, "GET", path, nil)
	if err != nil {
		if errors.Is(err, api.ErrNotModified) {
			return false, nil // the cheap poll — zero body work (§8)
		}
		if se, ok := err.(*api.StatusError); ok && se.Status == 404 {
			return false, ErrProjectGone
		}
		return false, err
	}
	var bp api.BoardPayload
	if err := json.Unmarshal(resp.Body, &bp); err != nil {
		return false, fmt.Errorf("sync: board payload decode: %w", err)
	}
	p, tasks, sprints, cats, tags, joins, projCats := boardToStore(&bp, "")
	if err := e.store.ReplaceBoard(ctx, projectID, p, tasks, sprints, cats, tags, joins, projCats); err != nil {
		return false, fmt.Errorf("sync: mirroring board %s: %w", projectID, err)
	}
	_ = e.store.SetMeta(ctx, metaETagPrefix+path, resp.ETag)
	_ = e.store.SetMeta(ctx, metaLastPull+projectID, e.now().UTC().Format(time.RFC3339Nano))
	return true, nil
}

// PullArchives mirrors the done-task archive for a project (archived ≠
// deleted — rows stay restorable, DATA-MODEL §2.6).
func (e *Engine) PullArchives(ctx context.Context, projectID string) error {
	arcs, err := e.client.Archives(ctx, projectID)
	if err != nil {
		return err
	}
	rows := make([]store.Archive, 0, len(arcs))
	for _, a := range arcs {
		tagsJSON, _ := json.Marshal(a.Tags) // the mirror stores the label snapshot JSON verbatim ("[]" default)
		row := store.Archive{
			ID:                a.ID,
			ProjectID:         a.ProjectID,
			Title:             a.Title,
			Status:            a.Status,
			Priority:          a.Priority,
			CategoryID:        a.CategoryID,
			SprintID:          a.SprintID,
			DoneAt:            a.DoneAt,
			OriginalCreatedAt: a.OriginalCreatedAt,
			ArchivedAt:        a.ArchivedAt,
			Tags:              string(tagsJSON),
		}
		rows = append(rows, row)
	}
	return e.store.UpsertArchives(ctx, projectID, rows)
}

// SyncOnce is the "focus/manual" round: refresh the projects list, then pull
// every mirrored board (skip-none; 304s make it cheap). Errors are collected,
// not fatal — one broken board must not stop the others (the same resilience
// the web switcher shows per-board).
func (e *Engine) SyncOnce(ctx context.Context) (boardsPulled int, errs []error) {
	if _, err := e.RefreshProjects(ctx); err != nil {
		errs = append(errs, fmt.Errorf("projects list: %w", err))
	}
	projects, err := e.store.ListProjects(ctx)
	if err != nil {
		errs = append(errs, fmt.Errorf("mirror list: %w", err))
		return
	}
	for _, p := range projects {
		if p.DeletedAt != nil {
			continue // soft-deleted server-side; the list pull owns its lifecycle
		}
		pulled, err := e.Pull(ctx, p.ID)
		if err != nil {
			if errors.Is(err, ErrProjectGone) {
				continue // gone state — the shell surfaces it when the user opens it
			}
			errs = append(errs, fmt.Errorf("board %s: %w", p.ID, err))
			continue
		}
		if pulled {
			boardsPulled++
		}
	}
	return boardsPulled, errs
}
