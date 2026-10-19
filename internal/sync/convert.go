// Package sync — the offline-first engine (API-AND-SYNC-CONTRACT.md §10).
//
// The cloud stays the single source of truth; the desktop's SQLite mirror is
// a cache + offline workspace — never a second store of truth (hard rule 2).
//
// This file: the wire→mirror converters. The mirror's column shapes are
// copied VERBATIM from the cloud (DATA-MODEL.md §6); the wire shapes are the
// board payload's JSON (api/types.go) — the conversion is deliberately
// explicit, one field per line, so any server-side shape change trips here
// loudly instead of drifting silently.
package sync

import (
	"hibana/desktop/internal/api"
	"hibana/desktop/internal/store"
)

// boardToStore converts one full board payload into the mirror's row shapes.
func boardToStore(bp *api.BoardPayload, userScope string) (store.Project, []store.Task, []store.Sprint, []store.Category, []store.Tag, []store.TaskTag, []store.CategoryRef) {
	p := store.Project{
		ID:     bp.Project.ID,
		Title:  bp.Project.Title,
		Status: bp.Project.Status,
		Type:   bp.Project.Type,
		// CreatedAt intentionally empty: the board payload carries only the
		// 4-field header — store.ReplaceBoard does the targeted header UPDATE
		// and the projects-list pull owns the full row.
	}

	tasks := make([]store.Task, 0, len(bp.Tasks))
	for _, t := range bp.Tasks {
		tasks = append(tasks, store.Task{
			ID:         t.ID,
			ProjectID:  t.ProjectID,
			Title:      t.Title,
			Status:     t.Status,
			Priority:   t.Priority,
			CategoryID: t.CategoryID,
			SprintID:   t.SprintID,
			SortOrder:  t.SortOrder,
			CreatedAt:  t.CreatedAt,
			DoneAt:     t.DoneAt,
			StartAt:    t.StartAt,
			EndAt:      t.EndAt,
			SearchTags: t.SearchTags,
			UpdatedAt:  t.UpdatedAt,
		})
	}

	sprints := make([]store.Sprint, 0, len(bp.Sprints))
	for _, s := range bp.Sprints {
		sprints = append(sprints, store.Sprint{
			ID:          s.ID,
			ProjectID:   s.ProjectID,
			Name:        s.Name,
			StartedAt:   s.StartedAt,
			EndedAt:     s.EndedAt,
			CreatedAt:   s.CreatedAt,
			IsDraft:     s.IsDraft,
			Version:     s.Version,
			Description: s.Description,
		})
	}

	cats := make([]store.Category, 0, len(bp.Categories))
	var projCats []store.CategoryRef
	for _, c := range bp.Categories {
		cats = append(cats, store.Category{
			ID:         c.ID,
			UserID:     c.UserID,
			Name:       c.Name,
			ColorFill:  c.ColorFill,
			ColorText:  c.ColorText,
			IsArchived: c.IsArchived,
			CreatedAt:  c.CreatedAt,
		})
		if c.Enabled == 1 {
			projCats = append(projCats, store.CategoryRef{ProjectID: bp.Project.ID, CategoryID: c.ID})
		}
	}

	tags := make([]store.Tag, 0, len(bp.Tags))
	for _, t := range bp.Tags {
		tags = append(tags, store.Tag{
			ID:         t.ID,
			UserID:     t.UserID,
			Name:       t.Name,
			Color:      t.Color,
			UsageCount: t.UsageCount,
			CreatedAt:  t.CreatedAt,
		})
	}

	// The payload's flat join already restricts to the board's tasks
	// (taskTagsForProject) — mirror it verbatim.
	joins := make([]store.TaskTag, 0, len(bp.TaskTags))
	for _, j := range bp.TaskTags {
		joins = append(joins, store.TaskTag{TaskID: j.TaskID, TagID: j.ID})
	}

	return p, tasks, sprints, cats, tags, joins, projCats
}

// projectListToStore converts one projects-list row into the mirror shape.
// The list payload carries FULL ProjectRow columns (contract §3.1) — this is
// the path that owns the projects table's full rows.
func projectListToStore(p api.ProjectListItem) store.Project {
	return store.Project{
		ID:               p.ID,
		UserID:           p.UserID,
		Title:            p.Title,
		Description:      p.Description,
		Type:             p.Type,
		Status:           p.Status,
		SortOrder:        p.SortOrder,
		LatestNote:       p.LatestNote,
		ProgressPercent:  p.ProgressPercent,
		ArchivedState:    p.ArchivedState,
		ClientName:       p.ClientName,
		DueDate:          p.DueDate,
		RemindersEnabled: p.RemindersEnabled,
		FolderID:         p.FolderID,
		LogoPath:         p.LogoPath,
		CreatedAt:        p.CreatedAt,
		UpdatedAt:        p.UpdatedAt,
		DeletedAt:        p.DeletedAt,
		PinnedAt:         p.PinnedAt,
		CoverShotID:      p.CoverShotID,
	}
}
