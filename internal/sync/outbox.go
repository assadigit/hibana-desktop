package sync

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"hibana/desktop/internal/api"
	"hibana/desktop/internal/store"
)

// The outbox drain — contract §10's push rules, verbatim:
//
//	FIFO, ONE in-flight request at a time (ordering contracts like reorder
//	rewriting sort_order 0..n assume sequential application); retry with
//	exponential backoff (1s → cap 60s, +jitter — the loop's job; Drain does one
//	round). Status handling, mirroring the verified web queue semantics
//	(queue.js:125-132) plus the server's actual codes:
//
//	  2xx        → done (row deleted)
//	  401        → re-auth then retry the same op ONCE — never drop
//	  403        → the T6 Origin header is always sent by our client, so a 403
//	               means ban → STOP the round, surface (retrying a ban is futile)
//	  404        → deleted-or-archived server-side → drop the op (the next pull
//	               re-syncs the mirror)
//	  409        → conflict (draft_exists, tag_in_use, id_conflict) → drop + surface
//	  429        → back off to the next 60s window → stop the round, KEEP the entry
//	  5xx       → retry later (attempts++); ≤5 then dead-letter (queue.js:127-132)
//	  transport  → attempts++ + hold — an UNKNOWN outcome (the write may have
//	               landed) must NEVER blind-replay a create: at-most-once per
//	               entry (DATA-MODEL §7's reconciliation note — M0 §7c removes
//	               this friction with idempotent creates).
//
// Entity → path mapping keeps the spec'd outbox columns {op, entity, id,
// payload} (DATA-MODEL §6): op is the HTTP method; entity names the resource
// operation; id is the collection parent or the target's canonical id.
type DrainResult struct {
	Done    int   // 2xx'd (incl. the one 401-retry success)
	Dropped int   // 404/409/dead-letter — permanently removed from the queue
	Held    int   // still queued (backoff/ban/transport-unknown)
	RateHit bool  // a 429 stopped the round
	Stopped bool  // the round stopped early (see LastErr)
	LastErr error // the surfaced reason for the stop, if any
}

// pathFor maps an outbox entry to its API path (op = the HTTP method).
func pathFor(entity, id string) (string, error) {
	switch entity {
	case "devtask.create":
		return "/api/projects/" + id + "/devtasks", nil
	case "devtask.patch", "devtask.delete":
		return "/api/devtasks/" + id, nil
	case "devtask.reorder":
		return "/api/projects/" + id + "/devtasks/reorder", nil
	case "devtask.archive-done":
		return "/api/projects/" + id + "/devtasks/archive-done", nil
	case "project.create":
		return "/api/projects", nil // the client id rides the payload (idempotent replay)
	case "project.patch", "project.delete":
		return "/api/projects/" + id, nil
	case "project.archive":
		return "/api/projects/" + id + "/archive", nil
	case "project.unarchive":
		return "/api/projects/" + id + "/unarchive", nil
	default:
		return "", fmt.Errorf("sync: unknown outbox entity %q", entity)
	}
}

// Drain runs one outbox round: every ready entry, one at a time, in FIFO
// order, paced politely (≤5 mutations/s — the server has no mutations bucket,
// this is politeness + breathing room for the reorder-ordering contract).
func (e *Engine) Drain(ctx context.Context) (DrainResult, error) {
	var res DrainResult
	pause := time.NewTicker(200 * time.Millisecond)
	defer pause.Stop()
	for {
		entry, ok, err := e.store.NextOutbox(ctx)
		if err != nil {
			return res, err
		}
		if !ok {
			return res, nil // queue empty — round complete
		}
		path, err := pathFor(entry.Entity, entry.ID)
		if err != nil {
			// Unroutable forever — a programming error in the enqueue path;
			// dead-letter it loudly so the queue can't wedge (queue.js's lesson).
			_ = e.store.MarkOutboxAttempt(ctx, entry.Seq, err.Error())
			_ = e.store.DropOutbox(ctx, entry.Seq)
			res.Dropped++
			res.LastErr = err
			continue
		}

		resp, err := e.client.Request(ctx, entry.Op, path, outboxBody(entry))

		// 2xx → done.
		if err == nil && resp.Status >= 200 && resp.Status < 300 {
			_ = e.store.DropOutbox(ctx, entry.Seq)
			res.Done++
			e.pace(ctx, pause)
			continue
		}

		// Transport-level failure (deadline/connection): UNKNOWN outcome —
		// never blind-replay; hold + attempts++ (backoff is the loop's).
		if err != nil && !isStatus(err) {
			_ = e.store.MarkOutboxAttempt(ctx, entry.Seq, "transport: "+err.Error())
			res.Held++
			res.Stopped = true
			res.LastErr = err
			return res, nil
		}

		se := asStatus(err)
		if se == nil && err == nil {
			// A non-2xx that came back without an error object (defensive).
			_ = e.store.MarkOutboxAttempt(ctx, entry.Seq, fmt.Sprintf("unexpected status %d", resp.Status))
			res.Held++
			continue
		}

		switch se.Status {
		case http.StatusUnauthorized:
			// Re-auth then retry the SAME op once (§10) — never drop.
			if e.relogin != nil {
				if rerr := e.relogin(ctx); rerr == nil {
					resp2, err2 := e.client.Request(ctx, entry.Op, path, outboxBody(entry))
					if err2 == nil && resp2.Status >= 200 && resp2.Status < 300 {
						_ = e.store.DropOutbox(ctx, entry.Seq)
						res.Done++
						e.pace(ctx, pause)
						continue
					}
					if err2 != nil && !isStatus(err2) {
						_ = e.store.MarkOutboxAttempt(ctx, entry.Seq, "transport(retry): "+err2.Error())
						res.Held++
						res.Stopped = true
						res.LastErr = err2
						return res, nil
					}
					se = asStatus(err2)
				}
			}
			// Still 401 (or no relogin hook): hold + surface — the shell
			// opens the session-expiry dialog; the entry survives.
			_ = e.store.MarkOutboxAttempt(ctx, entry.Seq, "unauthorized: session expired")
			res.Held++
			res.Stopped = true
			res.LastErr = se
			return res, nil

		case http.StatusForbidden:
			// Our client always sends Origin (the T6 gate) — a 403 is a ban.
			_ = e.store.MarkOutboxAttempt(ctx, entry.Seq, "forbidden: "+se.Code)
			res.Held++
			res.Stopped = true
			res.LastErr = se
			return res, nil

		case http.StatusNotFound:
			// Deleted-or-archived server-side → drop; the next pull re-syncs.
			_ = e.store.MarkOutboxAttempt(ctx, entry.Seq, "dropped: gone server-side")
			_ = e.store.DropOutbox(ctx, entry.Seq)
			res.Dropped++

		case http.StatusConflict:
			// draft_exists / tag_in_use / id_conflict — retrying is futile.
			_ = e.store.MarkOutboxAttempt(ctx, entry.Seq, "dropped: conflict "+se.Code)
			_ = e.store.DropOutbox(ctx, entry.Seq)
			res.Dropped++

		case http.StatusTooManyRequests:
			// Back off to the next 60s window (ratelimit.ts fixed windows):
			// stop the round, keep the entry.
			_ = e.store.MarkOutboxAttempt(ctx, entry.Seq, "rate-limited: waiting for the next window")
			res.Held++
			res.RateHit = true
			res.Stopped = true
			res.LastErr = se
			return res, nil

		default:
			if se.Status >= 500 {
				_ = e.store.MarkOutboxAttempt(ctx, entry.Seq, fmt.Sprintf("server error %d: %s", se.Status, se.Code))
				after, _, err2 := e.store.NextOutbox(ctx) // re-read for the attempts verdict
				if err2 == nil && after != nil && after.Seq == entry.Seq && after.Dead() {
					// ≤5 retries then dead-letter (queue.js:127-132) — the
					// row is dropped with its last_error recorded above.
					_ = e.store.DropOutbox(ctx, entry.Seq)
					res.Dropped++
					res.LastErr = fmt.Errorf("sync: dead-lettered %s %s after %d attempts: %v", entry.Op, path, after.Attempts, after.LastError)
					continue
				}
				res.Held++
				res.Stopped = true
				res.LastErr = se
				return res, nil
			}
			// Any other 4xx: unexpected but permanent-ish — surface + hold.
			_ = e.store.MarkOutboxAttempt(ctx, entry.Seq, fmt.Sprintf("status %d: %s", se.Status, se.Code))
			res.Held++
			res.Stopped = true
			res.LastErr = se
			return res, nil
		}
	}
}

func outboxBody(entry *store.OutboxEntry) []byte {
	if entry.Payload == "" {
		return nil
	}
	return []byte(entry.Payload)
}

func isStatus(err error) bool {
	var se *api.StatusError
	return errors.As(err, &se)
}

func asStatus(err error) *api.StatusError {
	var se *api.StatusError
	if errors.As(err, &se) {
		return se
	}
	return nil
}

func (e *Engine) pace(ctx context.Context, t *time.Ticker) {
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}
