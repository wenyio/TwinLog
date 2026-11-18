package capture

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
	}
	stamp := "2026-11-17T10:00:00.123+08:00"
	titles := []string{"新/Title", "新?title", ""}
	for i, path := range paths {
		r, err := loadRecord(path)
		if err != nil {
			t.Fatal(err)
		}
		r.StartedAt = stamp
		if err := writeJSON(filepath.Join(path, "record.json"), r); err != nil {
			t.Fatal(err)
		}
		if err := m.SaveTitle(path, titles[i]); err != nil {
			t.Fatal(err)
		}
	}
	dest := filepath.Join(root, "export.zip")
	if err := m.Export(append(paths, paths[0]), dest, false); err != nil {
		t.Fatal(err)
	}
	z, err := zip.OpenReader(dest)
	if err != nil {
		t.Fatal(err)
	}
	defer z.Close()
	if len(z.File) != 12 {
		t.Fatalf("unexpected number of ZIP entries: %d", len(z.File))
	}
	for i, dir := range []string{"20261117_100000_123_新_Title", "20261117_100000_123_新_title_1", "20261117_100000_123"} {
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

func TestTrashRecordsPreservesLogsAndSkipsListing(t *testing.T) {
	root := t.TempDir()
	a, b := historyRecord(t, root, "one"), historyRecord(t, root, "two")
	full := filepath.Join(root, "session", "full")
	if err := os.MkdirAll(full, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(full, "mcu.log"), []byte("full retained"), 0644); err != nil {
		t.Fatal(err)
	}
	m := NewManager(nil)
	// Validate every target before moving any record.
	if _, err := m.TrashRecords(root, []string{a, full}); err == nil {
		t.Fatal("accepted full logs")
	}
	if _, err := os.Stat(a); err != nil {
		t.Fatal("moved record before validating batch")
	}
	m.record = &Record{Path: a}
	if _, err := m.TrashRecords(root, []string{b}); err == nil {
		t.Fatal("deleted while capturing")
	}
	m.record = nil
	batch, err := m.TrashRecords(root, []string{a, b, a})
	if err != nil {
		t.Fatal(err)
	}
	for i, original := range []string{a, b} {
		if _, err := os.Stat(original); !os.IsNotExist(err) {
			t.Fatalf("original still exists: %v", err)
		}
		path := filepath.Join(batch, fmt.Sprintf("%d_%s", i+1, filepath.Base(original)))
		r, err := loadRecord(path)
		if err != nil || r.Notes != "保留内容\n" {
			t.Fatalf("notes not retained: %+v %v", r, err)
		}
		logs, err := m.ReadRecordLogs(path, 0)
		if err != nil || logs.MCU.Text != "保留内容\n" || logs.Android.Text != "保留内容\n" {
			t.Fatal("logs not retained", err)
		}
	}
	if b, err := os.ReadFile(filepath.Join(full, "mcu.log")); err != nil || string(b) != "full retained" {
		t.Fatal("full logs changed", err)
	}
	if b, err := os.ReadFile(filepath.Join(batch, "restore.json")); err != nil || !strings.Contains(string(b), "1_one") {
		t.Fatal("restore mapping missing", err)
	}
	records, err := m.ListRecords(root)
	if err != nil || len(records) != 0 {
		t.Fatalf("trashed records listed: %+v %v", records, err)
	}
	outside := historyRecord(t, t.TempDir(), "outside")
	if _, err := m.TrashRecords(root, []string{outside}); err == nil {
		t.Fatal("accepted record outside root")
	}
}
