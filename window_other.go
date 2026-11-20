//go:build !windows

package main

import (
	"context"
	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

func placeCompactWindow() {}
func restoreWindowPosition(ctx context.Context, x, y int) {
	wruntime.WindowSetPosition(ctx, x, y)
}
