package capture

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func historyRecord(t *testing.T, root, name string) string {
	t.Helper()
	p := filepath.Join(root, "session", name)
	if err := os.MkdirAll(p, 0755); err != nil {
		t.Fatal(err)
	}
	if err := writeJSON(filepath.Join(p, "record.json"), Record{Title: name, StartedAt: "2026-11-17T10:00:00Z", EndedAt: "2026-11-17T10:01:00Z"}); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"mcu.log", "android.log", "notes.txt"} {
		if err := os.WriteFile(filepath.Join(p, name), []byte("保留内容\n"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	return p
}

func TestExportNamesUseCurrentTitlesWithoutMovingRecords(t *testing.T) {
	root := t.TempDir()
	m := NewManager(nil)
	paths := []string{
		historyRecord(t, root, "first"),
		historyRecord(t, root, "second"),
		historyRecord(t, root, "third"),
		historyRecord(t, root, "fourth"),
	}
	stamp := time.Date(2026, 11, 17, 10, 0, 0, 123000000, time.FixedZone("CST", 8*60*60))
	titles := []string{"新/Title", "新?title", "", "新/Title"}
	for i, path := range paths {
		r, err := loadRecord(path)
		if err != nil {
			t.Fatal(err)
		}
		r.StartedAt = stamp.Add(time.Duration(i) * time.Millisecond).Format(time.RFC3339Nano)
		if err := writeJSON(filepath.Join(path, "record.json"), r); err != nil {
			t.Fatal(err)
		}
		if err := m.SaveTitle(path, titles[i]); err != nil {
			t.Fatal(err)
		}
	}
	dest := filepath.Join(root, "export.zip")
	if err := m.ExportSelection(root, append(paths, paths[0]), nil, dest); err != nil {
		t.Fatal(err)
	}
	z, err := zip.OpenReader(dest)
	if err != nil {
		t.Fatal(err)
	}
	defer z.Close()
	if len(z.File) != 16 {
		t.Fatalf("unexpected number of ZIP entries: %d", len(z.File))
	}
	for i, dir := range []string{"20261117_100000_新_Title", "20261117_100000_新_title_1", "20261117_100000", "20261117_100000_新_Title_2"} {
		p := "session/" + dir + "/"
		for _, name := range []string{"mcu.log", "android.log", "notes.txt"} {
			f, err := z.Open(p + name)
			if err != nil {
				t.Fatal(err)
			}
			f.Close()
		}
		f, err := z.Open(p + "record.json")
		if err != nil {
			t.Fatal(err)
		}
		var r Record
		err = json.NewDecoder(f).Decode(&r)
		f.Close()
		if err != nil || r.Title != titles[i] {
			t.Fatalf("metadata for %q: %+v, %v", dir, r, err)
		}
		if _, err := os.Stat(filepath.Join(paths[i], "mcu.log")); err != nil {
			t.Fatal("source directory changed:", err)
		}
	}
}

func TestExportFilename(t *testing.T) {
	root := t.TempDir()
	path := historyRecord(t, root, "initial")
	m := NewManager(nil)
	now := time.Date(2026, 11, 18, 10, 11, 12, 0, time.UTC)
	const fallback = "TwinLog_20261118_101112.zip"
	cases := []struct{ title, want string }{
		{"  最新标题  ", "最新标题.zip"},
		{"Log/Android:MCU?", "Log_Android_MCU_.zip"},
		{"Result.ZIP", "Result.zip"},
		{strings.Repeat("a", 71), strings.Repeat("a", 70) + ".zip"},
		{"  ", fallback},
		{"...", fallback},
	}
	if !filepath.IsLocal("CON") {
		cases = append(cases, struct{ title, want string }{"CON.txt", "_CON.txt.zip"})
	}
	for _, tc := range cases {
		if err := m.SaveTitle(path, tc.title); err != nil {
			t.Fatal(err)
		}
		if got, err := ExportFilename([]string{path}, now); err != nil || got != tc.want {
			t.Errorf("title %q: got %q, %v; want %q", tc.title, got, err, tc.want)
		}
	}
	for _, paths := range [][]string{nil, {path, filepath.Join(root, "another")}} {
		if got, err := ExportFilename(paths, now); err != nil || got != fallback {
			t.Errorf("paths %v: got %q, %v; want %q", paths, got, err, fallback)
		}
	}
	if _, err := ExportFilename([]string{filepath.Join(root, "missing")}, now); !os.IsNotExist(err) {
		t.Fatalf("missing record: got %v", err)
	}
}

func TestHistoryLogPreview(t *testing.T) {
	m := NewManager(nil)
	p := historyRecord(t, t.TempDir(), "record")
	var text strings.Builder
	for i := 0; i < 3500; i++ {
		fmt.Fprintf(&text, "第 %04d 行日志\r\n", i)
	}
	if err := os.WriteFile(filepath.Join(p, "android.log"), []byte(text.String()), 0644); err != nil {
		t.Fatal(err)
	}
	logs, err := m.ReadRecordLogs(p, 0)
	if err != nil {
		t.Fatal(err)
	}
	if logs.MCU.Text != "保留内容\n" || logs.MCU.Truncated {
		t.Fatalf("small log: %+v", logs.MCU)
	}
	if !logs.Android.Truncated || logs.Android.Bytes != int64(text.Len()) || !strings.HasPrefix(logs.Android.Text, "第 1500 行日志") || !strings.HasSuffix(logs.Android.Text, "第 3499 行日志\r\n") {
		t.Fatal("line-limited preview did not preserve the expected tail")
	}
	for _, size := range []int{1000, 5000, 10000} {
		logs, err := m.ReadRecordLogs(p, size)
		if err != nil {
			t.Fatal(err)
		}
		wantStart := fmt.Sprintf("第 %04d 行日志", max(0, 3500-size))
		if !strings.HasPrefix(logs.Android.Text, wantStart) || logs.Android.Truncated != (size < 3500) {
			t.Fatalf("unexpected %d-line preview", size)
		}
	}
	long := strings.Repeat("串口", previewBytes)
	if err := os.WriteFile(filepath.Join(p, "mcu.log"), []byte(long), 0644); err != nil {
		t.Fatal(err)
	}
	logs, err = m.ReadRecordLogs(p, 10000)
	if err != nil {
		t.Fatal(err)
	}
	if !logs.MCU.Truncated || len(logs.MCU.Text) > previewBytes || !utf8.ValidString(logs.MCU.Text) || strings.ContainsRune(logs.MCU.Text, '�') {
		t.Fatal("unbounded or broken UTF-8 preview")
	}
	if _, err := m.ReadRecordLogs(filepath.Dir(p), 0); err == nil {
		t.Fatal("accepted non-record folder")
	}
}

func TestDeleteRecordsValidatesBeforeCallingShell(t *testing.T) {
	root := t.TempDir()
	a, b := historyRecord(t, root, "one"), historyRecord(t, root, "two")
	full := historyRecord(t, root, "full")
	outside := historyRecord(t, t.TempDir(), "outside")
	oldTrash := historyRecord(t, root, "old-trash")
	trashRoot := filepath.Join(root, ".twinlog-trash")
	if err := os.Mkdir(trashRoot, 0755); err != nil {
		t.Fatal(err)
	}
	oldTrashDir := filepath.Join(trashRoot, "old-trash")
	if err := os.Rename(oldTrash, oldTrashDir); err != nil {
		t.Fatal(err)
	}
	session := historyRecord(t, root, "nested-session")
	if err := os.WriteFile(filepath.Join(session, "session.json"), []byte("{}"), 0644); err != nil {
		t.Fatal(err)
	}
	for _, p := range []*string{&root, &a, &b} {
		resolved, err := filepath.EvalSymlinks(*p)
		if err != nil {
			t.Fatal(err)
		}
		*p = resolved
	}
	m := NewManager(nil)
	unexpectedDelete := func(paths []string) error {
		t.Fatalf("called shell with unvalidated paths: %q", paths)
		return nil
	}
	for _, path := range []string{full, outside, filepath.Dir(a), session, oldTrashDir, filepath.Join(root, "missing")} {
		if err := m.deleteRecords(root, []string{a, path}, unexpectedDelete); err == nil {
			t.Fatalf("accepted %q", path)
		}
	}
	m.record = &Record{Path: a}
	if err := m.deleteRecords(root, []string{b}, unexpectedDelete); err == nil {
		t.Fatal("deleted while capturing")
	}
	m.record = nil
	shellErr := fmt.Errorf("simulated shell error")
	err := m.deleteRecords(root, []string{a, b, a}, func(paths []string) error {
		if !reflect.DeepEqual(paths, []string{a, b}) {
			t.Fatalf("wrong targets: %q", paths)
		}
		if !m.mu.TryLock() {
			t.Fatal("continuous log writers blocked during shell operation")
		}
		m.mu.Unlock()
		return shellErr
	})
	if err != shellErr {
		t.Fatalf("shell error was not returned: %v", err)
	}
	for _, path := range []string{a, b, full, oldTrashDir} {
		if _, err := os.Stat(filepath.Join(path, "mcu.log")); err != nil {
			t.Fatalf("log changed in %q: %v", path, err)
		}
	}
}
