//go:build !windows

package winshell

import "fmt"

// PowerShell is the non-Windows stub: the shipped product is Windows-only,
// but the Go test/vet/cross-build ladder runs on Linux — every caller lives
// behind a //go:build windows file, so this keeps the package compiling and
// honestly reports the boundary (the apply_other.go discipline).
func PowerShell() (string, error) {
	return "", fmt.Errorf("winshell: PowerShell is Windows-only")
}
