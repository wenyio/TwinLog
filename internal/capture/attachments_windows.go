//go:build windows

package capture

import "golang.org/x/sys/windows"

// A same-volume rename with no replace flag works on NTFS and exFAT.
func moveAttachment(from, to string) error {
	a, err := windows.UTF16PtrFromString(from)
	if err != nil {
		return err
	}
	b, err := windows.UTF16PtrFromString(to)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(a, b, 0)
}
