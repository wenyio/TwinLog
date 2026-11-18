package capture

import (
	"archive/zip"
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTimestampChunkBoundaries(t *testing.T) {
	at := time.Date(2026, 11, 17, 11, 56, 10, 745000000, time.FixedZone("CST", 8*3600))
	stamp := "[2026-11-17 11:56:10.745] "
	input := []byte("hello\r\n\r\n世界\nlast")
	want := stamp + "hello\r\n" + stamp + "\r\n" + stamp + "世界\n" + stamp + "last"
	for split := 0; split <= len(input); split++ {
		var s TimestampStream
		got := append(s.Transform(input[:split], at), s.Transform(input[split:], at)...)
		if string(got) != want {
			t.Fatalf("split %d: %q", split, got)
		}
	}
}
func TestUIDFilterRestartAndLongLine(t *testing.T) {
	input := "11-17 11:56:10.745 10123 100 101 D APP: first\n11-17 11:56:10.746 1000 200 201 I SYS: other\n11-17 11:56:10.747 u0_a123 400 401 D APP: " + strings.Repeat("x", 100000) + "\n"
	want := strings.Split(input, "\n")[0] + "\n" + strings.Split(input, "\n")[2] + "\n"
	for _, chunk := range []int{1, 2, 7, 33, 255, 4096} {
		f := AndroidFilter{}
		f.SetUID("10123")
		var out bytes.Buffer
		for i := 0; i < len(input); i += chunk {
			end := i + chunk
			if end > len(input) {
				end = len(input)
			}
			out.Write(f.Feed([]byte(input[i:end])))
		}
		if out.String() != want {
			t.Fatalf("chunk %d got %d want %d", chunk, out.Len(), len(want))
		}
	}
}
func synthetic(t *testing.T) (*Manager, string) {
	t.Helper()
	root := t.TempDir()
	session := filepath.Join(root, "session")
	if e := os.Mkdir(session, 0755); e != nil {
		t.Fatal(e)
	}
	a, b, e := openFullLogs(session, true, "")
	if e != nil {
		t.Fatal(e)
	}
	m := NewManager(nil)
	m.connected = true
	m.sessionDir = session
	m.mcu = a
	m.android = b
	m.config.SerialPort = "COM1"
	m.config.AndroidSerial = "test"
	m.config.Package = "com.example.app"
	m.config.SaveFullLogs = true
	m.filter.SetUID("10123")
	return m, root
}
func TestFullCaptureNotesExport(t *testing.T) {
	m, root := synthetic(t)
	at := time.Date(2026, 11, 17, 11, 56, 10, 745000000, time.UTC)
	if e := m.ingestLocked("mcu", []byte("before\npartial"), at); e != nil {
		t.Fatal(e)
	}
	beforeAndroid := "11-17 11:56:10.744 10123 100 101 D APP: before\n"
	if e := m.ingestLocked("android", []byte(beforeAndroid), at); e != nil {
		t.Fatal(e)
	}
	r, e := m.StartCapture("中文/标题", "initial")
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(filepath.Base(r.Path), "/") {
		t.Fatal("unsafe name")
	}
	app := "11-17 11:56:10.745 10123 100 101 D APP: wanted\n"
	sys := "11-17 11:56:10.746 1000 200 201 I SYS: context\n"
	if e = m.ingestLocked("mcu", []byte(" tail\r\n\nend"), at); e != nil {
		t.Fatal(e)
	}
	if e = m.ingestLocked("android", []byte(app+sys), at); e != nil {
		t.Fatal(e)
	}
	preview := m.drainPreviewsLocked()
	if preview[0].RecordPath != "" || !strings.Contains(preview[0].Text, "before") || preview[1].Text != beforeAndroid+app ||
		preview[2].RecordPath != r.Path || preview[3].RecordPath != r.Path {
		t.Fatalf("incorrect preview scope: %+v", preview)
	}
	if e = m.SaveNotes(r.Path, "更新备注"); e != nil {
		t.Fatal(e)
	}
	if _, e = m.StopCapture(); e != nil {
		t.Fatal(e)
	}
	if e = m.ingestLocked("mcu", []byte(" after"), at); e != nil {
		t.Fatal(e)
	}
	m.mcu.close()
	m.android.close()
	m.connected = false
	b, _ := os.ReadFile(filepath.Join(r.Path, "android.log"))
	if string(b) != app || preview[3].Text != string(b) {
		t.Fatalf("capture android %q", b)
	}
	b, _ = os.ReadFile(filepath.Join(m.sessionDir, "full", "android.log"))
	if string(b) != beforeAndroid+app+sys {
		t.Fatal("full filtered")
	}
	b, _ = os.ReadFile(filepath.Join(r.Path, "mcu.log"))
	if preview[2].Text != string(b) || strings.Contains(string(b), "before") || strings.Contains(string(b), "after") || !strings.HasPrefix(string(b), "[2026-11-17 11:56:10.745]  tail") {
		t.Fatalf("MCU boundary: %q", b)
	}
	records, e := m.ListRecords(root)
	if e != nil || len(records) != 1 || records[0].Notes != "更新备注" || records[0].Interrupted {
		t.Fatalf("records %#v %v", records, e)
	}
	dest := filepath.Join(root, "export.zip")
	if e = m.Export([]string{r.Path}, dest, true); e != nil {
		t.Fatal(e)
	}
	z, e := zip.OpenReader(dest)
	if e != nil {
		t.Fatal(e)
	}
	defer z.Close()
	if len(z.File) != 6 {
		t.Fatalf("zip entries %d", len(z.File))
	}
	if e = m.Export([]string{r.Path}, filepath.Join(r.Path, "bad.zip"), false); e == nil {
		t.Fatal("export into source should fail")
	}
}

func TestCaptureTitleCanBeBlankAndUpdated(t *testing.T) {
	m, root := synthetic(t)
	t.Cleanup(func() { _ = errors.Join(m.mcu.close(), m.android.close(), m.capMCU.close(), m.capAndroid.close()) })
	r, err := m.StartCapture(" \t\n", "initial notes")
	if err != nil {
		t.Fatal(err)
	}
	start, err := time.Parse(time.RFC3339Nano, r.StartedAt)
	if err != nil || r.Title != "" || filepath.Base(r.Path) != formatDirTime(start) {
		t.Fatalf("unexpected untitled capture: %+v, %v", r, err)
	}
	if err = m.SaveTitle(r.Path, "  抓取中修改  "); err != nil {
		t.Fatal(err)
	}
	if state := m.State(); state.ActiveRecord.Title != "抓取中修改" || state.ActiveRecord.Path != r.Path {
		t.Fatalf("active record not updated: %+v", state.ActiveRecord)
	}
	if err = m.SaveNotes(r.Path, "updated notes"); err != nil {
		t.Fatal(err)
	}
	stopped, err := m.StopCapture()
	if err != nil || stopped.Title != "抓取中修改" || stopped.Notes != "updated notes" || stopped.EndedAt == "" {
		t.Fatalf("stop did not retain edits: %+v, %v", stopped, err)
	}
	if err = m.SaveTitle(r.Path, " \t "); err != nil {
		t.Fatal(err)
	}
	records, err := NewManager(nil).ListRecords(root)
	if err != nil || len(records) != 1 || records[0].Title != "" || records[0].Notes != stopped.Notes ||
		records[0].Path != r.Path || records[0].EndedAt != stopped.EndedAt {
		t.Fatalf("historical edit did not preserve record: %+v, %v", records, err)
	}
}

func TestCaptureWithoutFullLogs(t *testing.T) {
	m, root := synthetic(t)
	t.Cleanup(func() { _ = errors.Join(m.mcu.close(), m.android.close()) })
	legacy, err := m.StartCapture("with full logs", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.StopCapture(); err != nil {
		t.Fatal(err)
	}
	legacySession := m.sessionDir
	if err = errors.Join(m.mcu.close(), m.android.close()); err != nil {
		t.Fatal(err)
	}
	m.sessionDir = filepath.Join(root, "capture-only")
	if err = os.Mkdir(m.sessionDir, 0755); err != nil {
		t.Fatal(err)
	}
	m.config.SaveFullLogs = false
	m.mcu, m.android, err = openFullLogs(m.sessionDir, m.config.SaveFullLogs, "")
	if err != nil || m.mcu != nil || m.android != nil {
		t.Fatalf("unexpected full log writers: %v", err)
	}
	if err = writeJSON(filepath.Join(m.sessionDir, "session.json"), map[string]any{"config": m.config}); err != nil {
		t.Fatal(err)
	}
	stamp := time.Date(2026, 11, 17, 1, 2, 3, 0, time.UTC)
	app := "11-17 01:02:03.000 10123 100 101 D APP: wanted\n"
	sys := "11-17 01:02:03.000 1000 200 201 I SYS: other\n"
	ingest := func(source, text string) {
		t.Helper()
		if err := m.ingestLocked(source, []byte(text), stamp); err != nil {
			t.Fatal(err)
		}
	}
	ingest("mcu", "before\npartial")
	ingest("android", strings.Replace(app, "wanted", "before", 1))
	r, err := m.StartCapture("capture only", "")
	if err != nil {
		t.Fatal(err)
	}
	ingest("mcu", " tail\r\n")
	ingest("android", app+sys)
	if _, err = m.StopCapture(); err != nil {
		t.Fatal(err)
	}
	ingest("mcu", "after\n")
	ingest("android", strings.Replace(app, "wanted", "after", 1))
	for name, want := range map[string]string{"mcu.log": "[2026-11-17 01:02:03.000]  tail\r\n", "android.log": app} {
		got, err := os.ReadFile(filepath.Join(r.Path, name))
		if err != nil || string(got) != want {
			t.Fatalf("%s: got %q, %v; want %q", name, got, err, want)
		}
	}
	if !strings.Contains(string(m.previewMCU), "after") || !strings.Contains(string(m.previewAndroid), "after") || bytes.Contains(m.previewAndroid, []byte(sys)) {
		t.Fatal("preview did not continue with the active filter")
	}
	if _, err = os.Stat(filepath.Join(m.sessionDir, "full")); !os.IsNotExist(err) {
		t.Fatalf("full directory must not exist, got %v", err)
	}
	m.connected = false
	dest := filepath.Join(root, "mixed.zip")
	if err = m.Export([]string{legacy.Path, r.Path}, dest, true); err != nil {
		t.Fatal(err)
	}
	z, err := zip.OpenReader(dest)
	if err != nil {
		t.Fatal(err)
	}
	defer z.Close()
	entries := map[string]bool{}
	for _, f := range z.File {
		entries[f.Name] = true
	}
	if !entries[filepath.Base(legacySession)+"/full/android.log"] ||
		!entries[filepath.Base(m.sessionDir)+"/"+filepath.Base(r.Path)+"/android.log"] || len(entries) != 11 {
		t.Fatalf("unexpected mixed export: %v", entries)
	}
}

func TestUTF8PreviewBoundary(t *testing.T) {
	raw := []byte("a中文")
	for i := 1; i < len(raw); i++ {
		s, tail := validPreview(raw[:i])
		s2, tail2 := validPreview(append(tail, raw[i:]...))
		if s+s2 != string(raw) || len(tail2) != 0 {
			t.Fatalf("split %d got %q", i, s+s2)
		}
	}
}
func TestInterruptedRecoveryAndAtomicReplace(t *testing.T) {
	dir := t.TempDir()
	r := Record{Title: "unfinished", StartedAt: nowISO()}
	if e := writeJSON(filepath.Join(dir, "record.json"), r); e != nil {
		t.Fatal(e)
	}
	if e := AtomicWrite(filepath.Join(dir, "notes.txt"), []byte("first")); e != nil {
		t.Fatal(e)
	}
	if e := AtomicWrite(filepath.Join(dir, "notes.txt"), []byte("second")); e != nil {
		t.Fatal(e)
	}
	m := NewManager(nil)
	rs, e := m.ListRecords(dir)
	if e != nil || len(rs) != 1 || !rs[0].Interrupted || rs[0].Notes != "second" {
		t.Fatalf("%#v %v", rs, e)
	}
}
func TestSustainedCaptureWrite(t *testing.T) {
	m, _ := synthetic(t)
	defer m.mcu.close()
	defer m.android.close()
	r, e := m.StartCapture("throughput", "")
	if e != nil {
		t.Fatal(e)
	}
	line := []byte("11-17 11:56:10.745 10123 100 101 D APP: " + strings.Repeat("x", 210) + "\n")
	block := bytes.Repeat(line, 256)
	start := time.Now()
	const count = 256
	for i := 0; i < count; i++ {
		if e = m.ingestLocked("android", block, time.Now()); e != nil {
			t.Fatal(e)
		}
	}
	if _, e = m.StopCapture(); e != nil {
		t.Fatal(e)
	}
	if e = m.android.flush(); e != nil {
		t.Fatal(e)
	}
	want := int64(len(block) * count)
	for _, p := range []string{filepath.Join(r.Path, "android.log"), filepath.Join(m.sessionDir, "full", "android.log")} {
		st, e := os.Stat(p)
		if e != nil || st.Size() != want {
			t.Fatalf("size %s %v", p, e)
		}
	}
	if len(m.previewAndroid) > 128*1024 {
		t.Fatal("unbounded preview")
	}
	elapsed := time.Since(start)
	t.Logf("%.1f MiB input, duplicated full+capture, %.1f MiB/s, elapsed %v", float64(want)/(1<<20), float64(want)/(1<<20)/elapsed.Seconds(), elapsed)
}
func TestEmptyCaptureAndSplitCRLF(t *testing.T) {
	m, _ := synthetic(t)
	defer m.mcu.close()
	defer m.android.close()
	at := time.Date(2026, 11, 17, 1, 2, 3, 0, time.UTC)
	m.ingestLocked("mcu", []byte("partial"), at)
	r, e := m.StartCapture("empty", "")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = m.StopCapture(); e != nil {
		t.Fatal(e)
	}
	st, _ := os.Stat(filepath.Join(r.Path, "mcu.log"))
	if st.Size() != 0 {
		t.Fatal("empty capture has phantom timestamp")
	}
	m.ingestLocked("mcu", []byte("\r"), at)
	r, e = m.StartCapture("split-crlf", "")
	if e != nil {
		t.Fatal(e)
	}
	m.ingestLocked("mcu", []byte("\nnext"), at)
	m.StopCapture()
	b, _ := os.ReadFile(filepath.Join(r.Path, "mcu.log"))
	if !bytes.HasPrefix(b, []byte("[2026-11-17 01:02:03.000] \n")) {
		t.Fatalf("untimestamped first line %q", b)
	}
}
