# scripts/make-portable.ps1 — the portable artifact (WPP §3.3):
#   hibana.exe + docs/PORTABLE.md → hibana-portable-<version>.zip
# The version comes from the git tag (the CI release step); locally it
# defaults to the Version stamp in the binary's -X (pass -Version explicitly).
param(
    [string]$Version = "0.1.8",
    [string]$ExePath = ".\build\bin\hibana.exe"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $ExePath)) { Write-Error "hibana.exe not found at $ExePath — run the wails build first" }
if (-not (Test-Path ".\docs\PORTABLE.md")) { Write-Error "docs\PORTABLE.md missing" }

$staging = Join-Path $env:TEMP "hibana-portable-$Version"
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
New-Item -ItemType Directory -Path $staging | Out-Null
Copy-Item $ExePath (Join-Path $staging "hibana.exe")
# The portable zip ships the 2-page contract NEXT TO the exe (WPP §1).
Copy-Item ".\docs\PORTABLE.md" (Join-Path $staging "PORTABLE.md")

$zip = "hibana-portable-$Version.zip"
Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zip -Force
Remove-Item -Recurse -Force $staging

$hash = (Get-FileHash $zip -Algorithm SHA256).Hash
Write-Host "built $zip"
Write-Host "sha256 $hash   # append to checksums.txt (the updater's verification input)"
