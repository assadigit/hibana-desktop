package main

import _ "embed"

// The tray icon bytes — the SAME traced-logo ICO the exe/window resources
// wear (scripts/make-icons.py output, 7 frames 16→256px; CreateIconFromResourceEx
// picks the 16×16 frame for the tray tile). Embedded at the module root
// because internal/tray cannot reach up out of its package for an embed.
//
//go:embed build/windows/icon.ico
var trayIconICO []byte
