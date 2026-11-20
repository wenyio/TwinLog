//go:build windows

package main

import (
	"context"
	"os"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var windowUser32 = windows.NewLazySystemDLL("user32.dll")
var enumDesktopWindows = windowUser32.NewProc("EnumWindows")
var windowProcessID = windowUser32.NewProc("GetWindowThreadProcessId")
var windowClassName = windowUser32.NewProc("GetClassNameW")
var windowRect = windowUser32.NewProc("GetWindowRect")
var windowMonitor = windowUser32.NewProc("MonitorFromWindow")
var monitorInfo = windowUser32.NewProc("GetMonitorInfoW")
var windowDPI = windowUser32.NewProc("GetDpiForWindow")
var setWindowPosition = windowUser32.NewProc("SetWindowPos")

type desktopRect struct{ left, top, right, bottom int32 }
type desktopMonitorInfo struct {
	size          uint32
	monitor, work desktopRect
	flags         uint32
}

func ownDesktopWindow() uintptr {
	var found uintptr
	callback := syscall.NewCallback(func(hwnd, _ uintptr) uintptr {
		var pid uint32
		windowProcessID.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
		if pid != uint32(os.Getpid()) {
			return 1
		}
		var name [128]uint16
		windowClassName.Call(hwnd, uintptr(unsafe.Pointer(&name[0])), uintptr(len(name)))
		if windows.UTF16ToString(name[:]) == "wailsWindow" {
			found = hwnd
			return 0
		}
		return 1
	})
	enumDesktopWindows.Call(callback, 0)
	return found
}

// Use native physical coordinates for both the monitor work area and window.
// Wails SetPosition is work-area-relative while GetPosition is absolute on Windows.
func placeCompactWindow() {
	hwnd := ownDesktopWindow()
	if hwnd == 0 {
		return
	}
	monitor, _, _ := windowMonitor.Call(hwnd, 2) // MONITOR_DEFAULTTONEAREST
	info := desktopMonitorInfo{}
	info.size = uint32(unsafe.Sizeof(info))
	var rect desktopRect
	ok, _, _ := monitorInfo.Call(monitor, uintptr(unsafe.Pointer(&info)))
	if ok == 0 {
		return
	}
	ok, _, _ = windowRect.Call(hwnd, uintptr(unsafe.Pointer(&rect)))
	if ok == 0 {
		return
	}
	dpi, _, _ := windowDPI.Call(hwnd)
	if dpi == 0 {
		dpi = 96
	}
	margin := int32(12 * dpi / 96)
	x, y := compactPosition(info.work, rect, margin)
	setWindowPosition.Call(hwnd, 0, uintptr(x), uintptr(y), 0, 0, 0x15) // NOSIZE | NOZORDER | NOACTIVATE
}

func restoreWindowPosition(_ context.Context, x, y int) {
	if hwnd := ownDesktopWindow(); hwnd != 0 {
		setWindowPosition.Call(hwnd, 0, uintptr(x), uintptr(y), 0, 0, 0x15)
	}
}
