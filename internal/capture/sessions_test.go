package capture

import (
	"archive/zip"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestSessionArchive(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "session")
	if err := os.Mkdir(path, 0755); err != nil {
		t.Fatal(err)
	}
	meta := map[string]any{"startedAt": "2026-11-19T10:00:00Z", "title": "保留名称", "config": map[string]any{"baudRate": 115200}, "custom": "preserve"}
	if err := writeJSON(filepath.Join(path, "session.json"), meta); err != nil {
		t.Fatal(err)
	}
	m := NewManager(nil)
	items, err := m.ListSessions(root)
	if err != nil || len(items) != 1 || items[0].Archived {
		t.Fatalf("legacy: %+v %v", items, err)
	}
	m.connected, m.sessionDir = true, path
	if err := m.SetSessionArchived(root, path, true); err == nil {
		t.Fatal("archived connected session")
	}
	m.connected = false
	for _, invalid := range []string{root, t.TempDir(), filepath.Join(path, "record")} {
		if err := m.SetSessionArchived(root, invalid, true); err == nil {
			t.Fatalf("accepted %s", invalid)
		}
	}
	if err := m.SetSessionArchived(root, path, true); err != nil {
		t.Fatal(err)
	}
	// Reload through a fresh manager, then rename without losing the archive flag.
	m = NewManager(nil)
	if err := m.SaveSessionTitle(root, path, "新名称"); err != nil {
		t.Fatal(err)
	}
	items, err = m.ListSessions(root)
	if err != nil || len(items) != 1 || !items[0].Archived || items[0].Title != "新名称" {
		t.Fatalf("persist: %+v %v", items, err)
	}
	if err := m.SetSessionArchived(root, path, false); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(path, "session.json"))
	if err != nil {
		t.Fatal(err)
	}
	var restored map[string]any
	if err := json.Unmarshal(b, &restored); err != nil {
		t.Fatal(err)
	}
	if restored["archived"] != nil || restored["custom"] != "preserve" || restored["config"] == nil {
		t.Fatalf("metadata: %v", restored)
	}
	items, err = m.ListSessions(root)
	if err != nil || items[0].Archived {
		t.Fatalf("restore: %+v %v", items, err)
	}
}

func TestRecordArchive(t *testing.T) {
	root := t.TempDir()
	session := filepath.Join(root, "session")
	path := filepath.Join(session, "record")
	if err := os.MkdirAll(path, 0755); err != nil {
		t.Fatal(err)
	}
	if err := writeJSON(filepath.Join(session, "session.json"), map[string]any{"startedAt": "2026-11-19T10:00:00Z"}); err != nil {
		t.Fatal(err)
	}
	r := Record{Title: "原标题", StartedAt: "2026-11-19T10:00:00Z", EndedAt: "2026-11-19T10:01:00Z", Source: "mcu"}
	if err := writeRecord(filepath.Join(path, "record.json"), r); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "mcu.log"), []byte("保留日志"), 0600); err != nil {
		t.Fatal(err)
	}
	m := NewManager(nil)
	m.connected, m.sessionDir = true, session
	r.Path = path
	m.record = &r
	if err := m.SetRecordArchived(root, path, true); err == nil {
		t.Fatal("archived active record")
	}
	m.record = nil
	for _, invalid := range []string{root, session, t.TempDir(), filepath.Join(session, "full")} {
		if err := m.SetRecordArchived(root, invalid, true); err == nil {
			t.Fatalf("accepted %s", invalid)
		}
	}
	// An ended record can be archived even while its connection remains active.
	if err := m.SetRecordArchived(root, path, true); err != nil {
		t.Fatal(err)
	}
	m = NewManager(nil)
	if err := m.SaveTitle(path, "新标题"); err != nil {
		t.Fatal(err)
	}
	if err := m.SaveNotes(path, "保留备注"); err != nil {
		t.Fatal(err)
	}
	items, err := m.ListSessions(root)
	if err != nil || len(items) != 1 || items[0].Archived || len(items[0].Records) != 1 || !items[0].Records[0].Archived {
		t.Fatalf("reload: %+v %v", items, err)
	}
	if err := m.SetSessionArchived(root, session, true); err != nil {
		t.Fatal(err)
	}
	if err := m.SetSessionArchived(root, session, false); err != nil {
		t.Fatal(err)
	}
	r, err = loadRecord(path)
	if err != nil || !r.Archived || r.Title != "新标题" || r.Notes != "保留备注" {
		t.Fatalf("preserve: %+v %v", r, err)
	}
	if err := m.SetRecordArchived(root, path, false); err != nil {
		t.Fatal(err)
	}
	r, err = loadRecord(path)
	if err != nil || r.Archived {
		t.Fatalf("restore: %+v %v", r, err)
	}
	data, err := os.ReadFile(filepath.Join(path, "mcu.log"))
	if err != nil || string(data) != "保留日志" {
		t.Fatalf("log changed: %s %v", data, err)
	}
}

func TestSessionManagement(t *testing.T) {
	root := t.TempDir()
	makeSession := func(name, stamp string, record bool) string {
		t.Helper()
		p := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Join(p, "full"), 0755); err != nil {
			t.Fatal(err)
		}
		if err := writeJSON(filepath.Join(p, "session.json"), map[string]string{"startedAt": stamp}); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(p, "full", "android.log"), []byte("unfiltered\n"), 0600); err != nil {
			t.Fatal(err)
		}
		if record {
			r := filepath.Join(p, "record")
			if err := os.Mkdir(r, 0755); err != nil {
				t.Fatal(err)
			}
			if err := writeJSON(filepath.Join(r, "record.json"), Record{Title: "record", StartedAt: stamp, EndedAt: stamp}); err != nil {
				t.Fatal(err)
			}
		}
		return p
	}
	m := NewManager(nil)
	old := makeSession("old", "2026-11-18T09:00:00+08:00", true)
	active := makeSession("active", "2026-11-18T03:00:00Z", false)
	outside := filepath.Join(root, ".twinlog-trash")
	makeSession(".twinlog-trash", "2026-11-18T12:00:00Z", true)
	m.connected, m.sessionDir = true, active
	sessions, err := m.ListSessions(root)
	if err != nil || len(sessions) != 2 || sessions[0].Path != active || len(sessions[0].Records) != 0 ||
		sessions[0].Full == nil || sessions[0].Full.Source != "android" || sessions[0].Full.Bytes != 11 || len(sessions[1].Records) != 1 {
		t.Fatalf("list: %+v, %v", sessions, err)
	}
	logs, err := m.ReadFullLogs(root, old, 1000)
	if err != nil || logs.Android.Text != "unfiltered\n" || logs.MCU.Bytes != 0 {
		t.Fatalf("logs: %+v, %v", logs, err)
	}
	dest := filepath.Join(root, "full.zip")
	if err = m.ExportSelection(root, nil, []string{old, old}, dest); err != nil {
		t.Fatal(err)
	}
	z, err := zip.OpenReader(dest)
	if err != nil {
		t.Fatal(err)
	}
	entries := map[string]bool{}
	for _, f := range z.File {
		entries[f.Name] = true
	}
	if err = z.Close(); err != nil || !reflect.DeepEqual(entries, map[string]bool{"full/android.log": true, "session.json": true}) || len(z.File) != 2 {
		t.Fatalf("full-only export: %v, %v", entries, err)
	}
	if err = m.ExportSelection(root, nil, []string{active}, dest); err == nil {
		t.Fatal("exported active full log")
	}
	approve := func(Session) (bool, error) { return true, nil }
	remove := func(paths []string) error {
		if !reflect.DeepEqual(paths, []string{filepath.Join(old, "full")}) {
			t.Fatalf("wrong removal scope: %v", paths)
		}
		return os.Rename(paths[0], filepath.Join(root, "recycled-full"))
	}
	for _, p := range []string{active, outside, root, filepath.Join(old, "record"), t.TempDir()} {
		if err = m.removeSessionLogs(root, p, true, approve, remove); err == nil {
			t.Fatalf("accepted invalid or active target %q", p)
		}
	}
	if err = m.removeSessionLogs(root, old, true, approve, remove); err != nil {
		t.Fatal(err)
	}
	sessions, err = m.ListSessions(root)
	if err != nil || len(sessions) != 2 || sessions[1].Full != nil || len(sessions[1].Records) != 1 {
		t.Fatalf("after full removal: %+v, %v", sessions, err)
	}
	if err = m.ExportSelection(root, []string{filepath.Join(old, "record")}, nil, filepath.Join(root, "records.zip")); err != nil {
		t.Fatal(err)
	}
	if err = m.removeSessionLogs(root, old, false, func(s Session) (bool, error) {
		if s.Full != nil || len(s.Records) != 1 {
			t.Fatalf("confirmation scope: %+v", s)
		}
		return true, nil
	}, func(paths []string) error {
		if !reflect.DeepEqual(paths, []string{old}) {
			t.Fatalf("wrong session target: %v", paths)
		}
		return os.Rename(paths[0], filepath.Join(root, ".twinlog-trash", "old"))
	}); err != nil {
		t.Fatal(err)
	}
	sessions, err = m.ListSessions(root)
	if err != nil || len(sessions) != 1 || sessions[0].Path != active || sessions[0].Title != "" {
		t.Fatalf("legacy sessions after removal: %+v, %v", sessions, err)
	}
	if err := m.SaveSessionTitle(root, active, "连接补名"); err != nil {
		t.Fatal(err)
	}
	sessions, err = m.ListSessions(root)
	if err != nil || len(sessions) != 1 || sessions[0].Title != "连接补名" {
		t.Fatalf("legacy session name: %+v, %v", sessions, err)
	}
}
