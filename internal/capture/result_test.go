package capture

import (
	"archive/zip"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRecordResultPersistence(t *testing.T) {
	root := t.TempDir()
	path := historyRecord(t, root, "legacy")
	m := NewManager(nil)
	r, err := loadRecord(path)
	if err != nil || r.Result != "" {
		t.Fatalf("legacy: %+v %v", r, err)
	}
	before, err := os.ReadFile(filepath.Join(path, "mcu.log"))
	if err != nil {
		t.Fatal(err)
	}
	m.record = &r
	if err := m.SaveResult(path, "PASS"); err == nil {
		t.Fatal("marked active capture")
	}
	m.record = nil
	if err := m.SaveResult(path, "invalid"); err == nil {
		t.Fatal("accepted invalid result")
	}
	for _, result := range []string{"PASS", "FAIL", ""} {
		if err := m.SaveResult(path, result); err != nil {
			t.Fatal(err)
		}
		if err := m.SaveTitle(path, "新标题"); err != nil {
			t.Fatal(err)
		}
		if err := m.SaveNotes(path, "新备注"); err != nil {
			t.Fatal(err)
		}
		if err := m.SetRecordArchived(root, path, true); err != nil {
			t.Fatal(err)
		}
		records, err := NewManager(nil).ListRecords(root)
		if err != nil || len(records) != 1 {
			t.Fatalf("reload: %v %v", records, err)
		}
		r = records[0]
		if r.Result != result || r.Title != "新标题" || r.Notes != "新备注" || !r.Archived {
			t.Fatalf("lost metadata: %+v", r)
		}
		if err := m.SetRecordArchived(root, path, false); err != nil {
			t.Fatal(err)
		}
	}
	after, err := os.ReadFile(filepath.Join(path, "mcu.log"))
	if err != nil || string(after) != string(before) {
		t.Fatal("marking changed source logs")
	}
	// An interrupted record can still receive a manual conclusion.
	r.EndedAt = ""
	r.Interrupted = true
	if err := writeRecord(filepath.Join(path, "record.json"), r); err != nil {
		t.Fatal(err)
	}
	if err := m.SaveResult(path, "FAIL"); err != nil {
		t.Fatal(err)
	}
	r, err = loadRecord(path)
	if err != nil || !r.Interrupted || r.Result != "FAIL" {
		t.Fatalf("interrupted: %+v %v", r, err)
	}
}

func TestResultExport(t *testing.T) {
	root := t.TempDir()
	m := NewManager(nil)
	paths := []string{historyRecord(t, root, "pass"), historyRecord(t, root, "fail"), historyRecord(t, root, "pending")}
	now := time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	results := []string{"PASS", "FAIL", ""}
	for i, path := range paths {
		if err := m.SaveResult(path, results[i]); err != nil {
			t.Fatal(err)
		}
		if err := m.SaveTitle(path, "重连验证.zip"); err != nil {
			t.Fatal(err)
		}
		want := "重连验证" + resultSuffix(results[i]) + ".zip"
		if got, err := ExportFilename([]string{path}, now); err != nil || got != want {
			t.Fatalf("name %q, %v; want %q", got, err, want)
		}
	}
	if got, err := ExportFilename(paths, now); err != nil || got != "TwinLog_20261120_100000.zip" {
		t.Fatalf("batch: %q %v", got, err)
	}
	dest := filepath.Join(root, "mixed.zip")
	if err := m.Export(paths, dest, false); err != nil {
		t.Fatal(err)
	}
	archive, err := zip.OpenReader(dest)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	found := map[string]bool{}
	for _, file := range archive.File {
		if !strings.HasSuffix(file.Name, "/record.json") {
			continue
		}
		stream, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(stream)
		stream.Close()
		if err != nil {
			t.Fatal(err)
		}
		var r Record
		if err := json.Unmarshal(data, &r); err != nil {
			t.Fatal(err)
		}
		dir := filepath.Base(filepath.Dir(file.Name))
		if !strings.HasSuffix(dir, "_重连验证.zip"+resultSuffix(r.Result)) {
			t.Fatalf("directory does not match metadata: %s %+v", dir, r)
		}
		found[r.Result] = true
	}
	if len(found) != 3 {
		t.Fatalf("missing results: %v", found)
	}
	if err := m.SaveTitle(paths[0], ""); err != nil {
		t.Fatal(err)
	}
	if got, err := ExportFilename(paths[:1], now); err != nil || got != "TwinLog_20261120_100000_PASS.zip" {
		t.Fatalf("untitled: %q %v", got, err)
	}
}
