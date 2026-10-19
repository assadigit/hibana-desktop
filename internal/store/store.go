package store

import (
	"context"
	"database/sql"
	"fmt"
	"sync"
	"time"

	_ "modernc.org/sqlite" // the pure-Go SQLite driver (no cgo) — GO-DESKTOP-IMPLEMENTATION-GUIDE.md §5.2
)

// isoLayout is the canonical TEXT timestamp format used across the mirror: UTC
// with millisecond precision, byte-identical to JS toISOString()
// ("2026-10-21T03:23:00.000Z"), so lexicographic comparison == chronological
// comparison (DATA-MODEL.md §6, mapping notes; server format per §4.5).
const isoLayout = "2006-01-02T15:04:05.000Z"

// gracePeriod is how long a task that vanished from a pull stays in
// local_grace_tasks before being purged (GO-DESKTOP-PORT-PLAN.md §5's
// "disappeared from pull = deleted, 7-day local grace copy"; DATA-MODEL.md §6
// "Deletion shadow (pre-tombstone)" note).
const gracePeriod = 7 * 24 * time.Hour

// nowISO returns the current instant in isoLayout form. Every mirror writer in
// this package stamps time through it so all stored timestamps share one
// fixed-width, string-comparable shape.
func nowISO() string { return time.Now().UTC().Format(isoLayout) }

// Store is an open SQLite mirror. It is safe for concurrent use: reads go
// through the database/sql pool (WAL lets readers run beside the writer) and all
// writes are serialized by one mutex — modernc.org/sqlite allows a single writer
// at a time, so the mutex keeps SQLITE_BUSY out of the hot path; busy_timeout is
// the second belt (see Open).
type Store struct {
	db      *sql.DB
	writeMu sync.Mutex
}

// Open opens (creating if needed) the SQLite mirror at path and brings its
// schema up to date via the embedded migrations. The database stays at path in
// WAL mode for the lifetime of the Store; call Close when done.
//
// Pragmas mirror the proven Node adapter (src/db/sqlite.ts:12-13):
// journal_mode=WAL and foreign_keys=ON, plus busy_timeout=5000. They ride the
// DSN as per-connection pragmas so EVERY connection in the database/sql pool
// gets them — journal_mode persists in the file, but foreign_keys and
// busy_timeout are per-connection state, and a one-shot Exec after Open would
// only hit whichever pooled connection happened to be handed out first.
func Open(path string) (*Store, error) {
	// No "file:" URI prefix: the modernc driver strips the query string itself
	// for plain paths, so path is opened verbatim (Windows drive-letter paths
	// included) and the _pragma values run on every new connection.
	dsn := path + "?_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("store: open %s: %w", path, err)
	}
	s := &Store{db: db}
	if err := s.migrate(context.Background()); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

// Close closes the store's database/sql pool.
func (s *Store) Close() error { return s.db.Close() }
