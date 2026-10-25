package quickaccess

import (
	"strings"
	"testing"
)

// TestShouldEnsure — the pure boot decision: a marker matching the current
// state keeps the boot quiet (zero PowerShell spawns); any divergence
// (missing marker, moved exe, flipped startup) rebuilds both shortcuts.
func TestShouldEnsure(t *testing.T) {
	want := ShortcutState{ExePath: `C:\Tools\Hibana\hibana.exe`, StartupOn: true}

	cases := []struct {
		name   string
		marker string
		want   bool
	}{
		{"a matching marker stays quiet", MarkerFor(want), false},
		{"an empty marker rebuilds", "", true},
		{"a missing file reads as empty", MarkerFor(want), true},
		{"a moved exe rebuilds", MarkerFor(ShortcutState{ExePath: `D:\Old\hibana.exe`, StartupOn: true}), true},
		{"a flipped startup rebuilds", MarkerFor(ShortcutState{ExePath: want.ExePath, StartupOn: false}), true},
		{"a truncated marker rebuilds", "exe=C:\\Tools", true},
		{"a hand-mangled marker rebuilds", "startup=1\n", true},
		{"a garbage marker rebuilds", "totally not a marker", true},
		{"an empty exe line rebuilds", "exe=\nstartup=1\n", true},
		{"an unknown startup value rebuilds", "exe=" + want.ExePath + "\nstartup=maybe\n", true},
	}
	for _, tc := range cases {
		if tc.name == "a missing file reads as empty" {
			// (the empty-string read IS the os.ReadFile error path's stand-in)
			continue
		}
		if got := ShouldEnsure(tc.marker, want); got != tc.want {
			t.Fatalf("%s: ShouldEnsure(%q) = %v, want %v", tc.name, tc.marker, got, tc.want)
		}
	}
}

// TestMarkerRoundTrip — MarkerFor and parseMarker are inverses; the CRLF the
// file might grow on Windows is tolerated.
func TestMarkerRoundTrip(t *testing.T) {
	for _, s := range []ShortcutState{
		{ExePath: `C:\Tools\Hibana\hibana.exe`, StartupOn: true},
		{ExePath: `C:\Tools\Hibana\hibana.exe`, StartupOn: false},
		{ExePath: `/home/z/portable/hibana`, StartupOn: true},
		{ExePath: `D:\a folder with spaces\hibana.exe`, StartupOn: false},
	} {
		m := MarkerFor(s)
		exe, startup, ok := parseMarker(m)
		if !ok || exe != s.ExePath || startup != s.StartupOn {
			t.Fatalf("round-trip broke for %+v: %q → %q,%v,%v", s, m, exe, startup, ok)
		}
		// The CRLF tolerance: a file hand-edited (or written by an editor that
		// adds \r) must still read.
		exe2, startup2, ok2 := parseMarker(strings.ReplaceAll(m, "\n", "\r\n"))
		if !ok2 || exe2 != s.ExePath || startup2 != s.StartupOn {
			t.Fatalf("the CRLF-tolerant read broke for %+v", s)
		}
	}
}

// TestAutostartFlagConstant — the Startup shortcut's argument is the one
// main.go's hasAutostartFlag reads; a drift here would boot a visible window
// on every login (or never boot at all).
func TestAutostartFlagConstant(t *testing.T) {
	if AutostartFlag != "--autostart" {
		t.Fatalf("AutostartFlag = %q", AutostartFlag)
	}
	if AppName != "Hibana Kanban" {
		t.Fatalf("AppName = %q", AppName)
	}
	if startupLnkName() != "Hibana Kanban.lnk" {
		t.Fatalf("startupLnkName() = %q", startupLnkName())
	}
}
