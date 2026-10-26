//go:build windows

package quickaccess

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"hibana/desktop/internal/winshell"
)

// createNoWindow keeps the PowerShell helper invisible (a console flash on
// every boot would read as a glitch; the helper is machinery, not UI — the
// apply_windows.go constant).
const createNoWindow = 0x08000000

// lnkWriterPs is the one-shot .lnk writer: WScript.Shell's COM shortcut over
// the target/args/working-dir/icon/description, saved to the destination.
// Every value rides a -param (no string-built command line — a path with
// spaces or an apostrophe can never break it); $Description exists so the
// .lnk's hover text matches what the shell shows elsewhere.
const lnkWriterPs = `param([string]$Lnk, [string]$Target, [string]$Args, [string]$WorkDir, [string]$Description)
$ErrorActionPreference = 'Stop'
$dir = [IO.Path]::GetDirectoryName($Lnk)
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($Lnk)
$s.TargetPath = $Target
$s.Arguments = $Args
$s.WorkingDirectory = $WorkDir
$s.Description = $Description
$s.IconLocation = $Target
$s.Save()
`

// makeShortcut writes one .lnk through the PowerShell helper. DETACHED from
// the boot path (Run never waits on it — a slow COM spin can never stall the
// window); errors surface through the caller's log. The interpreter is
// RESOLVED by absolute path first (internal/winshell, v0.1.18) — the same
// stripped-PATH dogfood that killed the update apply would have killed the
// Start Menu shortcut too, on the very same machine.
func makeShortcut(lnkPath, target, args, workDir, description string) error {
	helper, err := os.CreateTemp("", "hibana-lnk-*.ps1")
	if err != nil {
		return fmt.Errorf("quickaccess: writing the helper: %w", err)
	}
	helperName := helper.Name()
	defer os.Remove(helperName)
	if _, err := helper.WriteString(lnkWriterPs); err != nil {
		helper.Close()
		return fmt.Errorf("quickaccess: writing the helper: %w", err)
	}
	if err := helper.Close(); err != nil {
		return fmt.Errorf("quickaccess: closing the helper: %w", err)
	}
	ps, err := winshell.PowerShell()
	if err != nil {
		return fmt.Errorf("quickaccess: lnk helper: %w", err)
	}
	cmd := exec.Command(ps,
		"-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
		"-File", helperName,
		"-Lnk", lnkPath,
		"-Target", target,
		"-Args", args,
		"-WorkDir", workDir,
		"-Description", description,
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("quickaccess: lnk helper: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// startMenuPaths resolves the per-user Start Menu Programs + Startup folders
// from %APPDATA% (the same shell-folder roots NSIS's $SMPROGRAMS and
// $SMSTARTUP resolve to; read from the env so no COM round-trip is needed
// for the paths themselves).
func startMenuPaths() (programsDir, startupDir string, err error) {
	appData := os.Getenv("APPDATA")
	if appData == "" {
		return "", "", fmt.Errorf("quickaccess: APPDATA is not set")
	}
	programs := filepath.Join(appData, "Microsoft", "Windows", "Start Menu", "Programs")
	return filepath.Join(programs, "Hibana Kanban.lnk"), filepath.Join(programs, "Startup", "Hibana Kanban.lnk"), nil
}

// Ensure is the boot call (main.go runs it in a goroutine — the app never
// waits on it): write BOTH shortcuts when the marker says they are stale,
// then record the marker. The Start Menu shortcut is unconditional (the
// easy-access surface); the Startup shortcut only when startup is on (the
// persisted preference, default on).
//
// A failure is returned whole (the caller logs it and moves on — a missing
// Start Menu entry must never block the board); the marker is only written
// after BOTH .lnk files landed, so a half-written round retries next boot.
func Ensure(exePath, dataDir string, startupOn bool) error {
	if exePath == "" {
		return fmt.Errorf("quickaccess: empty exe path")
	}
	if dataDir == "" {
		return fmt.Errorf("quickaccess: empty data dir")
	}
	markerPath := filepath.Join(dataDir, markerFile)
	if b, err := os.ReadFile(markerPath); err == nil {
		if !ShouldEnsure(string(b), ShortcutState{ExePath: exePath, StartupOn: startupOn}) {
			return nil // the .lnk files already tell the truth — zero spawns
		}
	}
	programsLnk, startupLnk, err := startMenuPaths()
	if err != nil {
		return err
	}
	workDir := filepath.Dir(exePath)
	if err := makeShortcut(programsLnk, exePath, "", workDir, "Hibana Kanban — boards, sprints and ideas"); err != nil {
		return err
	}
	if startupOn {
		if err := makeShortcut(startupLnk, exePath, AutostartFlag, workDir, "Hibana Kanban — starts to the tray"); err != nil {
			return err
		}
	} else if err := os.Remove(startupLnk); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("quickaccess: removing the stale startup shortcut: %w", err)
	}
	if err := os.WriteFile(markerPath, []byte(MarkerFor(ShortcutState{ExePath: exePath, StartupOn: startupOn})), 0o600); err != nil {
		return fmt.Errorf("quickaccess: writing the marker: %w", err)
	}
	return nil
}

// SetStartup flips the startup preference's SHORTCUT side (the tray menu's
// "Start with Windows" click): on → (re)create the Startup .lnk; off →
// remove it. The marker is updated to the new state either way so the next
// boot's Ensure stays quiet.
func SetStartup(on bool, exePath, dataDir string) error {
	if exePath == "" || dataDir == "" {
		return fmt.Errorf("quickaccess: empty exe path or data dir")
	}
	_, startupLnk, err := startMenuPaths()
	if err != nil {
		return err
	}
	if on {
		workDir := filepath.Dir(exePath)
		if err := makeShortcut(startupLnk, exePath, AutostartFlag, workDir, "Hibana Kanban — starts to the tray"); err != nil {
			return err
		}
	} else if err := os.Remove(startupLnk); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("quickaccess: removing the startup shortcut: %w", err)
	}
	markerPath := filepath.Join(dataDir, markerFile)
	if err := os.WriteFile(markerPath, []byte(MarkerFor(ShortcutState{ExePath: exePath, StartupOn: on})), 0o600); err != nil {
		return fmt.Errorf("quickaccess: writing the marker: %w", err)
	}
	return nil
}

// StartupLnkPath reports the Startup shortcut's absolute path (the tray
// toggle's truth probe: os.Stat on it IS the preference's visible state).
func StartupLnkPath() (string, error) {
	_, startupLnk, err := startMenuPaths()
	return startupLnk, err
}
