//go:build !windows

// theme_other.go — the non-Windows half of the boot background pair: the
// desktop app is Windows-only (ADR-001), but the module must vet + test +
// cross-build from Linux. 'system' cannot ask a Windows registry here, so
// it resolves LIGHT — the pre-v0.1.5 baseline. The real read lives in
// theme_windows.go.
package main

import (
	"hibana/desktop/internal/ui"

	"github.com/wailsapp/wails/v2/pkg/options"
)

var (
	bootBgDark  = options.RGBA{R: 0x14, G: 0x14, B: 0x13, A: 255} // #141413
	bootBgLight = options.RGBA{R: 0xE7, G: 0xE7, B: 0xE7, A: 255} // #E7E7E7
)

func resolveBootBackground(pref string) options.RGBA {
	switch pref {
	case ui.ThemeDark:
		return bootBgDark
	case ui.ThemeLight:
		return bootBgLight
	default:
		return bootBgLight // 'system' on a non-Windows host reads light
	}
}
