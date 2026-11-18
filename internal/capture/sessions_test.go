package capture

import (
	"archive/zip"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

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
	if err = z.Close(); err != nil || !reflect.DeepEqual(entries, map[string]bool{"old/full/android.log": true, "old/session.json": true}) || len(z.File) != 2 {
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
