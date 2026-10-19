package store

import (
	"context"
	"fmt"
)

// migration is one local schema step: a version number plus the SQL script it
// runs. Scripts are multi-statement and take no bind parameters.
type migration struct {
	version int
	sql     string
}

// migrations is the ordered, append-only local schema history. Applied versions
// are tracked in desktop_meta_migrations and skipped, so re-opening an existing
// mirror is idempotent. The bookkeeping table is named desktop_meta_migrations —
// NEVER "_migrations": that's server/Node bookkeeping and is explicitly NOT
// mirrored (DATA-MODEL.md §6, "What does NOT get mirrored";
// GO-DESKTOP-IMPLEMENTATION-GUIDE.md §5.2: "schema versioning via embedded SQL
// migrations in the module (never D1's _migrations table)").
//
//	v1 — the DATA-MODEL.md §6 cloud-subset mirror, verbatim.
//	v2 — local-only machinery: outbox + meta + local_grace_tasks + local indexes.
var migrations = []migration{
	{version: 1, sql: mirrorSchemaV1},
	{version: 2, sql: localSchemaV2},
}

// migrationsTableDDL is the local bookkeeping table (see migrations above).
// CREATE IF NOT EXISTS: the bootstrap create is itself idempotent, independent of
// the version list.
const migrationsTableDDL = `
CREATE TABLE IF NOT EXISTS desktop_meta_migrations (
  version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
)
`

// migrate brings the schema up to date: it creates the bookkeeping table, reads
// the applied versions, then applies each missing migration in order, each inside
// its own transaction (script + version stamp commit together, or not at all).
func (s *Store) migrate(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, migrationsTableDDL); err != nil {
		return fmt.Errorf("store: create migrations bookkeeping: %w", err)
	}

	applied := make(map[int]struct{})
	rows, err := s.db.QueryContext(ctx, `SELECT version FROM desktop_meta_migrations`)
	if err != nil {
		return fmt.Errorf("store: read applied migrations: %w", err)
	}
	for rows.Next() {
		var v int
		if err := rows.Scan(&v); err != nil {
			rows.Close()
			return fmt.Errorf("store: scan applied migration: %w", err)
		}
		applied[v] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("store: iterate applied migrations: %w", err)
	}
	rows.Close()

	for _, m := range migrations {
		if _, done := applied[m.version]; done {
			continue // idempotent: skip applied versions
		}
		if err := s.applyMigration(ctx, m); err != nil {
			return fmt.Errorf("store: migration v%d: %w", m.version, err)
		}
	}
	return nil
}

// applyMigration runs one migration's script and stamps its version row in a
// single transaction. Statements prepared from a tx are closed by Commit, so no
// manual statement cleanup is needed here.
func (s *Store) applyMigration(ctx context.Context, m migration) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() // no-op after a successful Commit

	// Multi-statement script with no bind parameters (modernc.org/sqlite steps
	// through every statement in one Exec when no args are bound).
	if _, err := tx.ExecContext(ctx, m.sql); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO desktop_meta_migrations (version, applied_at) VALUES (?, ?)`,
		m.version, nowISO(),
	); err != nil {
		return err
	}
	return tx.Commit()
}
