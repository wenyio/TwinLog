package capture

import (
	"reflect"
	"testing"
	"unicode/utf16"
	"unsafe"
)

func TestShellDeleteSources(t *testing.T) {
	paths := []string{`C:\capture\记录一`, `C:\capture\run two`}
	got, err := shellDeleteSources(paths)
	want := utf16.Encode([]rune(paths[0] + "\x00" + paths[1] + "\x00\x00"))
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("invalid Shell source list: %v, %v", got, err)
	}
	for _, path := range []string{`relative\path`, `C:\capture\*`, `C:\capture\run?`, "C:\\bad\x00path"} {
		if _, err := shellDeleteSources([]string{path}); err == nil {
			t.Fatalf("accepted %q", path)
		}
	}
}

func TestShellFileOperationLayout(t *testing.T) {
	var op shellFileOperation
	want := [3]uintptr{8, 16, 18}
	if unsafe.Sizeof(uintptr(0)) == 8 {
		want = [3]uintptr{16, 32, 36}
	}
	if got := [3]uintptr{unsafe.Offsetof(op.from), unsafe.Offsetof(op.flags), unsafe.Offsetof(op.aborted)}; got != want {
		t.Fatalf("SHFILEOPSTRUCTW layout: got %v, want %v", got, want)
	}
}
