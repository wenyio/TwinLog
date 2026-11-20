//go:build windows

package main

func compactPosition(work, window desktopRect, margin int32) (int32, int32) {
	width, height := window.right-window.left, window.bottom-window.top
	x := max(work.left, work.right-width-margin)
	y := max(work.top, min(window.top, work.bottom-height-margin))
	return x, y
}
