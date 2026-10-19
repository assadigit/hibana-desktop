// Package auth — the desktop's own session against the cookie-session API
// (GO-DESKTOP-IMPLEMENTATION-GUIDE.md §5.5).
//
// The web app is cookie-session, host-only (API-AND-SYNC-CONTRACT.md §2): a
// desktop client cannot share the browser's jar, logs in itself, and holds its
// own __Host-hibana_session. 401 mid-session → the session-expiry dialog →
// re-POST → the failing op retries once (the outbox's 401 rule, §10).
//
// At rest, the session token is DPAPI-protected on Windows
// (WINDOWS-PACKAGING-PLAN.md §8: %LOCALAPPDATA%\hibana\session.bin installed /
// .\data\ portable). DPAPI itself is M2/M5 wiring — FileStore below persists
// 0600 plaintext as the M1 stand-in and is clearly marked. No secrets ever
// ship in the binary (Agents.md rule 5 / guide hard rule 1): only the user's
// credentials at runtime, and at rest only the session cookie.
package auth

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"hibana/desktop/internal/api"
)

// Login performs the login + identity read in one call. The password exists
// in memory only for this call — never logged, never stored.
func Login(ctx context.Context, c *api.Client, login, password string) (*api.Me, error) {
	if err := c.Login(ctx, login, password); err != nil {
		return nil, fmt.Errorf("auth: login: %w", err)
	}
	me, err := c.Me(ctx)
	if err != nil {
		return nil, fmt.Errorf("auth: post-login identity read: %w", err)
	}
	return me, nil
}

// Store persists the session token across restarts.
//
// SECURITY NOTE (guide §5.5 + WINDOWS-PACKAGING-PLAN §8): the production
// implementation is DPAPI-encrypted on Windows (CryptProtectData under
// %LOCALAPPDATA%\hibana\session.bin). Until that lands (M5 packaging), the
// FileStore here writes the token 0600-owner-only and every consumer must
// treat the file as sensitive local state (never synced, never committed —
// the data dir is gitignored by the repo).
type Store interface {
	SaveSession(token string) error
	LoadSession() (string, error) // ("", nil) when no stored session
	Clear() error
}

// MemStore is the no-persistence store (tests, --portable one-shot runs).
type MemStore struct{ token string }

func (m *MemStore) SaveSession(t string) error { m.token = t; return nil }
func (m *MemStore) LoadSession() (string, error) {
	return m.token, nil
}
func (m *MemStore) Clear() error { m.token = ""; return nil }

// FileStore persists the session token to <dir>/session.bin with 0600.
// M5 TODO (WINDOWS-PACKAGING-PLAN §8): encrypt via DPAPI on Windows
// (CryptProtectData); portable mode carries the DPAPI-scope caveat documented
// in the packaging plan §8.
type FileStore struct{ Path string }

func (f *FileStore) SaveSession(token string) error {
	if token == "" {
		return f.Clear()
	}
	if err := os.MkdirAll(filepath.Dir(f.Path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(f.Path, []byte(token), 0o600)
}

func (f *FileStore) LoadSession() (string, error) {
	b, err := os.ReadFile(f.Path)
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func (f *FileStore) Clear() error {
	if err := os.Remove(f.Path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// Restore loads a stored token into the client and validates it against the
// API. Returns the identity + (true, nil) when the session is live; (nil,
// false, nil) when there is no stored session or it is dead (the store is
// cleared — a fresh login is needed, the login card opens); an error only
// for real I/O/network trouble. The returned Me seeds the bridge's boot
// snapshot (AuthState) so the login card's visibility resolves at first
// paint and the island's language hook has the user's language_pref.
func Restore(ctx context.Context, c *api.Client, s Store) (*api.Me, bool, error) {
	tok, err := s.LoadSession()
	if err != nil {
		return nil, false, err
	}
	if tok == "" {
		return nil, false, nil
	}
	c.SetSessionToken(tok)
	me, err := c.Me(ctx)
	if err != nil {
		if se, ok := err.(*api.StatusError); ok && se.Status == 401 {
			_ = s.Clear() // dead session — drop it so the login path runs
			return nil, false, nil
		}
		return nil, false, err
	}
	return me, true, nil
}
