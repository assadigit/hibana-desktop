//go:build windows

package winshell

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// PowerShell resolves the interpreter the one-shot helpers (-File + named
// parameters) run on. Resolution order, most-certain first:
//
//  1. %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe — Windows
//     PowerShell 5.1, stock on every Windows 10+ box the app can run on at
//     all (WebView2 floor); %SystemRoot% is set since NT, immune to PATH
//     damage.
//  2. C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe — the same
//     file for the pathological case of a stripped environment block.
//  3. %ProgramFiles%\PowerShell\7\pwsh.exe (and the C:\ hardcode) —
//     PowerShell 7, for the rare deprovisioned-5.1 machine; the helpers'
//     script surface (Wait-Process / Expand-Archive / Start-Process) is
//     7-compatible by construction.
//  4. exec.LookPath("powershell.exe" / "pwsh.exe") — the PATH lookup LAST:
//     it is the lookup that failed on the dogfooded machine, so it can never
//     again be the only one tried.
//
// The error names every place that was tried, so a genuinely
// PowerShell-less machine reports an actionable fact instead of a bare
// exec.ErrNotFound.
func PowerShell() (string, error) {
	var candidates []string
	if sr := os.Getenv("SystemRoot"); sr != "" {
		candidates = append(candidates, filepath.Join(sr, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"))
	}
	candidates = append(candidates, `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`)
	if pf := os.Getenv("ProgramFiles"); pf != "" {
		candidates = append(candidates, filepath.Join(pf, "PowerShell", "7", "pwsh.exe"))
	}
	candidates = append(candidates, `C:\Program Files\PowerShell\7\pwsh.exe`)
	for _, c := range candidates {
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			return c, nil
		}
	}
	// The PATH fallback — last, never first (the v0.1.17 lesson).
	for _, name := range []string{"powershell.exe", "pwsh.exe"} {
		if p, err := exec.LookPath(name); err == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf("winshell: PowerShell not found (tried %%SystemRoot%%\\System32\\WindowsPowerShell\\v1.0, C:\\Windows\\System32\\WindowsPowerShell\\v1.0, PowerShell 7, and PATH)")
}
