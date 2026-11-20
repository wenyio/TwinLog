package capture

import (
	"archive/zip"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestExportScopeLayout(t *testing.T) {
	root := t.TempDir()
	m := NewManager(nil)
	a := historyRecord(t, root, "first")
	b := historyRecord(t, root, "second")
	otherRoot := filepath.Join(root, "other")
	c := historyRecord(t, otherRoot, "third")
	otherSession := filepath.Join(root, "other-connection")
	if err := os.Rename(filepath.Dir(c), otherSession); err != nil {
		t.Fatal(err)
	}
	c = filepath.Join(otherSession, "third")
	session, other := filepath.Dir(a), filepath.Dir(c)
	for _, s := range []string{session, other} {
		if err := writeJSON(filepath.Join(s, "session.json"), map[string]string{"title": "复测/连接", "startedAt": "2026-11-20T16:00:00+08:00"}); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(filepath.Join(s, "full"), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(s, "full", "android.log"), []byte("all logs"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(a, "attachments"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(a, "attachments", "现场.txt"), []byte("attachment"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(session, "events.jsonl"), []byte("event"), 0600); err != nil {
		t.Fatal(err)
	}
	stamp := time.Date(2026, 11, 20, 18, 0, 0, 0, time.FixedZone("CST", 8*60*60))
	for _, tc := range []struct {
		name        string
		paths, full []string
		connection  bool
		filename    string
		prefixes    map[string]string
	}{
		{"single", []string{a, a}, nil, false, "first.zip", map[string]string{a: "", filepath.Join(session, "session.json"): "session.json", filepath.Join(session, "events.jsonl"): "events.jsonl"}},
		{"single with full", []string{a}, []string{session, session}, false, "first.zip", map[string]string{a: "", filepath.Join(session, "full"): "full", filepath.Join(session, "session.json"): "session.json", filepath.Join(session, "events.jsonl"): "events.jsonl"}},
		{"one-record connection", []string{a}, nil, true, "复测_连接.zip", map[string]string{a: "20261117_100000_first", filepath.Join(session, "session.json"): "session.json", filepath.Join(session, "events.jsonl"): "events.jsonl"}},
		{"connection", []string{a, b}, []string{session}, true, "复测_连接.zip", map[string]string{a: "20261117_100000_first", b: "20261117_100000_second", filepath.Join(session, "full"): "full", filepath.Join(session, "session.json"): "session.json", filepath.Join(session, "events.jsonl"): "events.jsonl"}},
		{"batch within connection", []string{a, b}, nil, false, "复测_连接.zip", map[string]string{a: "20261117_100000_first", b: "20261117_100000_second", filepath.Join(session, "session.json"): "session.json", filepath.Join(session, "events.jsonl"): "events.jsonl"}},
		{"connections with same name", []string{a, c}, []string{session, other}, false, "TwinLog_20261120_180000.zip", map[string]string{a: "复测_连接_1/20261117_100000_first", c: "复测_连接/20261117_100000_third", filepath.Join(session, "full"): "复测_连接_1/full", filepath.Join(other, "full"): "复测_连接/full", filepath.Join(session, "session.json"): "复测_连接_1/session.json", filepath.Join(other, "session.json"): "复测_连接/session.json", filepath.Join(session, "events.jsonl"): "复测_连接_1/events.jsonl"}},
		{"full only", nil, []string{session}, false, "复测_连接.zip", map[string]string{filepath.Join(session, "full"): "full", filepath.Join(session, "session.json"): "session.json", filepath.Join(session, "events.jsonl"): "events.jsonl"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			name, err := ExportSelectionFilename(tc.paths, tc.full, stamp, tc.connection)
			if err != nil || name != tc.filename {
				t.Fatalf("filename %q, %v; want %q", name, err, tc.filename)
			}
			dest := filepath.Join(t.TempDir(), name)
			if err := m.ExportSelection(root, tc.paths, tc.full, dest, tc.connection); err != nil {
				t.Fatal(err)
			}
			want := map[string]string{}
			for source, prefix := range tc.prefixes {
				err := filepath.WalkDir(source, func(path string, entry os.DirEntry, err error) error {
					if err != nil {
						return err
					}
					if entry.IsDir() {
						return nil
					}
					rel, err := filepath.Rel(source, path)
					if err != nil {
						return err
					}
					data, err := os.ReadFile(path)
					if err != nil {
						return err
					}
					want[filepath.ToSlash(filepath.Join(prefix, rel))] = string(data)
					return nil
				})
				if err != nil {
					t.Fatal(err)
				}
			}
			z, err := zip.OpenReader(dest)
			if err != nil {
				t.Fatal(err)
			}
			defer z.Close()
			got := map[string]string{}
			for _, f := range z.File {
				in, err := f.Open()
				if err != nil {
					t.Fatal(err)
				}
				data, err := io.ReadAll(in)
				in.Close()
				if err != nil {
					t.Fatal(err)
				}
				if _, exists := got[f.Name]; exists {
					t.Fatalf("duplicate ZIP entry %q", f.Name)
				}
				got[f.Name] = string(data)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("archive mismatch:\ngot %v\nwant %v", got, want)
			}
		})
	}
}
