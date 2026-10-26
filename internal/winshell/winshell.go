// Package winshell — resolving the Windows shell interpreters the desktop's
// one-shot helpers spawn (v0.1.18).
//
// THE BUG THIS PACKAGE CLOSES (the v0.1.17 dogfood): the update apply and the
// quick-access .lnk writer both spawned "powershell.exe" BY NAME, which rides
// exec.LookPath — i.e. the PATH the app HAPPENED to inherit. A stripped or
// mangled PATH (a stripped-env launcher, an installer that clobbered the
// system PATH) leaves PowerShell perfectly installed at its canonical
// absolute path while the lookup still fails:
//
//	update: apply: spawning the helper: exec: "powershell.exe":
//	executable file not found in %PATH%
//
// The machine had PowerShell; the app just never looked where it lives. The
// resolver inverts the order: the CANONICAL ABSOLUTE PATHS first (every
// Windows that can run the app — WebView2 caps it at Win10+ — ships Windows
// PowerShell 5.1 at %SystemRoot%\System32\WindowsPowerShell\v1.0), PowerShell
// 7's pwsh.exe next, and the PATH lookup LAST, as the fallback it should have
// always been.
//
// The discipline is the apply helper's own (apply_windows.go): the resolved
// path is passed to exec.Command verbatim — the script's parameters still
// ride named -File parameters, so there is no new injection surface.
package winshell
