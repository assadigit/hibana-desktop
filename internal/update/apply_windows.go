//go:build windows

package update

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"

	"hibana/desktop/internal/winshell"
)

// createNoWindow keeps the helper's console invisible (a PowerShell flash on
// every update would read as a glitch; the helper is machinery, not UI).
const createNoWindow = 0x08000000

// applyHelperPs is the detached PowerShell helper — the one-shot handoff that
// survives the app's exit and finishes the round:
//
//  1. WAIT for the parent PID to die (Wait-Process — Windows locks a running
//     exe, so the swap can only happen after the app is gone; the wait is
//     event-driven, not a blind sleep);
//  2. a short drain pause (file handles release asynchronously);
//  3. THE SWAP —
//     zip flow:      expand the verified archive to <stage>/, Copy-Item the
//     hibana.exe entry over the running exe's path, drop the
//     stage;
//     installer flow: run the NSIS wizard VISIBLE and wait for it (no /S by
//     design — a silent wizard needing elevation would hang on
//     a UAC prompt no one can see; the lane always ships the
//     zip, so this path is the rare fallback);
//  4. RELAUNCH the exe at the SAME path — the new version boots; auth.Restore
//     finds the untouched session.bin in the DATA dir and the board opens
//     straight away (the owner's "without losing data or needing user to
//     re login" — the data dir is never on the replace path, WPP §1).
//
// Written without `${}` template holes — every value rides a -param, so a
// path with spaces or an apostrophe can never break the line.
const applyHelperPs = `param([string]$Mode, [string]$Asset, [string]$Exe, [int]$ParentPid)
$ErrorActionPreference = 'Stop'
try { Wait-Process -Id $ParentPid -ErrorAction SilentlyContinue } catch { }
Start-Sleep -Milliseconds 1200
if ($Mode -eq 'zip') {
  $stage = Join-Path ([IO.Path]::GetDirectoryName($Asset)) 'stage'
  if (Test-Path -LiteralPath $stage) { Remove-Item -Recurse -Force -LiteralPath $stage }
  Expand-Archive -LiteralPath $Asset -DestinationPath $stage -Force
  Copy-Item -LiteralPath (Join-Path $stage 'hibana.exe') -Destination $Exe -Force
  Remove-Item -Recurse -Force -LiteralPath $stage
} else {
  Start-Process -FilePath $Asset -Wait
}
Start-Process -FilePath $Exe
`

// apply writes the helper next to the staged asset and spawns it DETACHED —
// the helper owns everything after this returns; the app then quits (the
// shell's restart hook) and the helper's Wait-Process observes the exit.
//
// The interpreter is RESOLVED through internal/winshell (v0.1.18): the
// canonical ABSOLUTE path first, the PATH lookup last. The v0.1.17 dogfood
// proved a by-name spawn dies on any machine whose inherited PATH lacks the
// WindowsPowerShell directory — "exec: \"powershell.exe\": executable file
// not found in %PATH%" — while the interpreter sat untouched at
// %SystemRoot%\System32\WindowsPowerShell\v1.0. When nothing resolves at
// all the error names the staged zip AND the release page, so a human can
// always finish the round by hand.
func apply(assetPath, kind, exePath, releaseURL string, parentPID int) error {
	if assetPath == "" || exePath == "" {
		return fmt.Errorf("update: apply: empty asset or exe path")
	}
	if kind != KindPortable && kind != KindInstaller {
		return fmt.Errorf("update: apply: unknown kind %q", kind)
	}
	if _, err := os.Stat(assetPath); err != nil {
		return fmt.Errorf("update: apply: the staged asset is missing: %w", err)
	}
	helper := filepath.Join(filepath.Dir(assetPath), "apply-update.ps1")
	if err := os.WriteFile(helper, []byte(applyHelperPs), 0o644); err != nil {
		return fmt.Errorf("update: apply: writing the helper: %w", err)
	}
	mode := "zip"
	if kind == KindInstaller {
		mode = "installer"
	}
	// THE INTERPRETER (v0.1.18): resolved by absolute path first — a stripped
	// PATH must never kill the swap (the v0.1.17 dogfood). -File (not
	// -Command) keeps the values on named script parameters, so PowerShell
	// itself does the quoting — no injection surface at all.
	ps, err := winshell.PowerShell()
	if err != nil {
		return fmt.Errorf("update: apply: %v — the verified update is staged at %s; install it manually from %s", err, assetPath, releaseURL)
	}
	cmd := exec.Command(ps,
		"-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
		"-File", helper,
		"-Mode", mode,
		"-Asset", assetPath,
		"-Exe", exePath,
		"-ParentPid", strconv.Itoa(parentPID),
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("update: apply: spawning the helper: %w", err)
	}
	// Detached by contract: the helper outlives the app — never Wait on it,
	// just release the handle.
	_ = cmd.Process.Release()
	return nil
}
