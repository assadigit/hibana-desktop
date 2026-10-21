//go:build !windows

package update

import "fmt"

// apply is the non-Windows stub: the shipped product is Windows-only (the
// lane builds hibana.exe; the WPP's whole surface is the Windows desktop),
// but the Go test/vet/cross-build ladder runs on Linux — this keeps every
// package compiling and honestly reports the boundary instead of silently
// no-opping. A test pins the contract (fail loudly, never a fake success).
func apply(assetPath, kind, exePath string, parentPID int) error {
	return fmt.Errorf("update: apply: the in-place replace is Windows-only (kind=%q)", kind)
}
