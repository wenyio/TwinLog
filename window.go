package main

import wruntime "github.com/wailsapp/wails/v2/pkg/runtime"

type windowBounds struct {
	width, height, x, y int
	maximised, pinned   bool
}

// The JS runtime dispatches individual window writes in separate goroutines.
// Keep dependent operations together so size never races the minimum size.
func (a *App) SetCompactWindow(compact bool, width, height int, pinned bool) {
	a.windowMu.Lock()
	defer a.windowMu.Unlock()
	if compact {
		if a.windowRestore != nil {
			return
		}
		bounds := &windowBounds{maximised: wruntime.WindowIsMaximised(a.ctx), pinned: pinned}
		if bounds.maximised {
			wruntime.WindowUnmaximise(a.ctx)
		}
		bounds.width, bounds.height = wruntime.WindowGetSize(a.ctx)
		bounds.x, bounds.y = wruntime.WindowGetPosition(a.ctx)
		a.windowRestore = bounds
		wruntime.WindowSetMinSize(a.ctx, 282, 560)
		wruntime.WindowSetSize(a.ctx, max(282, width), max(560, height))
		placeCompactWindow()
		wruntime.WindowSetAlwaysOnTop(a.ctx, true)
		return
	}
	if bounds := a.windowRestore; bounds != nil {
		wruntime.WindowUnmaximise(a.ctx)
		wruntime.WindowSetMinSize(a.ctx, 1080, 640)
		wruntime.WindowSetSize(a.ctx, bounds.width, bounds.height)
		restoreWindowPosition(a.ctx, bounds.x, bounds.y)
		wruntime.WindowSetAlwaysOnTop(a.ctx, bounds.pinned)
		if bounds.maximised {
			wruntime.WindowMaximise(a.ctx)
		}
		a.windowRestore = nil
	}
}
