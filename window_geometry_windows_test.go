//go:build windows

package main

import "testing"

func TestCompactPosition(t *testing.T) {
	for _, tc := range []struct {
		name         string
		work, window desktopRect
		margin, x, y int32
	}{
		{"primary", desktopRect{0, 0, 1920, 1040}, desktopRect{100, 80, 408, 700}, 12, 1600, 80},
		{"left monitor", desktopRect{-1920, 0, 0, 1040}, desktopRect{-1800, 900, -1492, 1520}, 12, -320, 408},
		{"taskbar on left", desktopRect{48, 0, 1920, 1080}, desktopRect{100, -20, 408, 600}, 12, 1600, 0},
		{"scaled", desktopRect{1920, 0, 4480, 1400}, desktopRect{2100, 100, 2562, 1030}, 18, 4000, 100},
	} {
		t.Run(tc.name, func(t *testing.T) {
			x, y := compactPosition(tc.work, tc.window, tc.margin)
			if x != tc.x || y != tc.y {
				t.Fatalf("got (%d,%d), want (%d,%d)", x, y, tc.x, tc.y)
			}
		})
	}
}
