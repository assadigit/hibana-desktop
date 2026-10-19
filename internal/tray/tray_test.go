package tray

import (
	"bytes"
	"encoding/binary"
	"testing"
)

// buildICO assembles a minimal-but-valid .ico for the parser tests: an
// ICONDIR + n directory entries + n fake image blobs. The byte shapes match
// the real format (parseICO checks exactly these), the "images" don't need
// to decode — the shell does that, never the parser.
func buildICO(entries []int) []byte {
	var b bytes.Buffer
	b.Write([]byte{0, 0, 1, 0})                                 // reserved=0, type=1 (icon)
	binary.Write(&b, binary.LittleEndian, uint16(len(entries))) // frame count
	hdrLen := 6 + 16*len(entries)
	off := hdrLen
	var dir bytes.Buffer
	for _, size := range entries {
		dir.Write([]byte{16, 16, 0, 0, 1, 0, 32, 0}) // w,h,colors,rsv,planes,bitcnt
		binary.Write(&dir, binary.LittleEndian, uint32(size))
		binary.Write(&dir, binary.LittleEndian, uint32(off))
		off += size
	}
	b.Write(dir.Bytes())
	for _, size := range entries {
		b.Write(make([]byte, size))
	}
	return b.Bytes()
}

// TestParseICOValid covers the header + entry-bounds path the real
// build/windows/icon.ico (7 frames) satisfies.
func TestParseICOValid(t *testing.T) {
	for _, tc := range []struct {
		name    string
		entries []int
	}{
		{"one frame", []int{703}},
		{"seven frames like the shipped icon", []int{703, 1092, 1461, 2177, 2950, 5547, 10179}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			frames, err := parseICO(buildICO(tc.entries))
			if err != nil {
				t.Fatalf("parseICO: %v", err)
			}
			if frames != len(tc.entries) {
				t.Fatalf("frames = %d, want %d", frames, len(tc.entries))
			}
		})
	}
}

// TestParseICORejections — every corrupt shape must fail loudly (a bad icon
// would otherwise render a blank tray tile; Run turns these into a hard
// startup error and main falls back to close-quits).
func TestParseICORejections(t *testing.T) {
	for _, tc := range []struct {
		name string
		b    []byte
	}{
		{"empty", nil},
		{"shorter than the header", []byte{0, 0, 1}},
		{"reserved must be 0", []byte{1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}},
		{"type must be icon (2 = cursor)", []byte{0, 0, 2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}},
		{"zero frames", buildICO(nil)},
		{"truncated directory", buildICO([]int{703, 1092})[:6+16]},
		{"frame outside the buffer", func() []byte {
			b := buildICO([]int{703})
			b[6+8] = 0xFF // first entry's size → huge
			return b
		}()},
		{"frame offset before the directory", func() []byte {
			b := buildICO([]int{703})
			binary.LittleEndian.PutUint32(b[6+12:], 0) // first entry's offset → 0
			return b
		}()},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := parseICO(tc.b); err == nil {
				t.Fatalf("parseICO accepted a corrupt icon")
			}
		})
	}
}

// TestMouseAction — the classic Shell_NotifyIcon mouse-message mapping.
func TestMouseAction(t *testing.T) {
	for _, tc := range []struct {
		msg  uint32
		want action
	}{
		{msgLButtonUp, actShow},
		{msgLButtonDblClk, actShow},
		{msgRButtonUp, actMenu},
		{msgContextMenu, actMenu},
		{0x0200 /* WM_MOUSEMOVE */, actNone},
		{0x0204 /* WM_RBUTTONDOWN */, actNone},
		{0, actNone},
	} {
		if got := mouseAction(tc.msg); got != tc.want {
			t.Fatalf("mouseAction(0x%04X) = %v, want %v", tc.msg, got, tc.want)
		}
	}
}

// TestCommandAction — TPM_RETURNCMD ids (0 = dismissed without a choice).
func TestCommandAction(t *testing.T) {
	for _, tc := range []struct {
		id   int32
		want action
	}{
		{cmdShow, actShow},
		{cmdToggle, actToggle},
		{cmdQuit, actQuit},
		{0, actNone},
		{-1, actNone},
		{9999, actNone},
	} {
		if got := commandAction(tc.id); got != tc.want {
			t.Fatalf("commandAction(%d) = %v, want %v", tc.id, got, tc.want)
		}
	}
}

// TestHideOnCloseFromMeta — the persisted-preference resolution: anything
// but an explicit "0" is ON (the owner's requested default must never
// silently flip the X button into quit).
func TestHideOnCloseFromMeta(t *testing.T) {
	for _, tc := range []struct {
		v    string
		ok   bool
		want bool
	}{
		{"", false, true},  // never stored → on (the default)
		{"1", true, true},  // explicitly on
		{"0", true, false}, // explicitly off → X quits
		{"", true, true},   // empty string row → on
		{"2", true, true},  // garbage → on, never quit-by-accident
	} {
		if got := HideOnCloseFromMeta(tc.v, tc.ok); got != tc.want {
			t.Fatalf("HideOnCloseFromMeta(%q, %v) = %v, want %v", tc.v, tc.ok, got, tc.want)
		}
	}
}
