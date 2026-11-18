package capture

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var shFileOperation = windows.NewLazySystemDLL("shell32.dll").NewProc("SHFileOperationW")

// The SDK packs SHFILEOPSTRUCTW on 32-bit Windows. The unused output fields
// are byte arrays to avoid Go inserting alignment padding on that platform.
type shellFileOperation struct {
	owner   windows.HWND
	kind    uint32
	from    *uint16
	to      *uint16
	flags   uint16
	_       [(unsafe.Sizeof(uintptr(0)) - 4) / 2]byte
	aborted [4]byte // The caller refreshes the record list even on cancellation.
	_       [2 * unsafe.Sizeof(uintptr(0))]byte
}

func shellDeleteSources(paths []string) ([]uint16, error) {
	var from []uint16
	for _, path := range paths {
		if !filepath.IsAbs(path) || strings.ContainsAny(path, "*?") {
			return nil, fmt.Errorf("Windows 无法按此路径删除记录: %s", path)
		}
		p, err := windows.UTF16FromString(path)
		if err != nil {
			return nil, err
		}
		from = append(from, p...)
	}
	return append(from, 0), nil
}

func deleteWithShell(paths []string) error {
	const (
		foDelete               = 3
		fofNoConfirmation      = 0x0010
		fofAllowUndo           = 0x0040
		fofNoConnectedElements = 0x2000
		fofWantNukeWarning     = 0x4000
		deOpCancelled          = 0x75
	)
	from, err := shellDeleteSources(paths)
	if err != nil {
		return err
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := windows.CoInitializeEx(0, windows.COINIT_APARTMENTTHREADED); err != nil && err != syscall.Errno(1) { // S_FALSE: COM is already initialized.
		return fmt.Errorf("无法初始化 Windows 文件操作: %w", err)
	}
	defer windows.CoUninitialize()
	owner := windows.GetForegroundWindow()
	var pid uint32
	if _, err := windows.GetWindowThreadProcessId(owner, &pid); err != nil || pid != uint32(os.Getpid()) {
		owner = 0
	}
	op := shellFileOperation{
		owner: owner,
		kind:  foDelete,
		from:  &from[0],
		// TwinLog already confirmed the batch. Still let Windows warn if it cannot recycle it.
		flags: fofNoConfirmation | fofAllowUndo | fofNoConnectedElements | fofWantNukeWarning,
	}
	code, _, _ := shFileOperation.Call(uintptr(unsafe.Pointer(&op)))
	switch uint32(code) {
	case 0, deOpCancelled, uint32(windows.ERROR_CANCELLED):
		return nil
	default:
		return fmt.Errorf("Windows 删除记录失败（错误代码 0x%X）", uint32(code))
	}
}
