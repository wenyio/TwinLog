package capture

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func TestProcessQueryFallbackAndRetry(t *testing.T) {
	table := "USER PID PPID VSZ RSS WCHAN ADDR S NAME\nu0 9637 1 0 0 0 0 S com.example.shared\nroot 1400 1 0 0 0 0 S system_server\n"
	calls := 0
	pids, system, e := queryPackageSnapshot(context.Background(), "com.example.shared", func(args []string) (string, error) {
		calls++
		if calls == 1 {
			return "", errors.New("exit status 1")
		}
		return table, nil
	})
	if e != nil || calls != 2 || !pids["9637"] || system != "1400" {
		t.Fatalf("fallback %v %s %d %v", pids, system, calls, e)
	}
	calls = 0
	pids, _, e = queryPackageSnapshot(context.Background(), "com.example.shared", func(args []string) (string, error) {
		calls++
		if calls < 3 {
			return "", fmt.Errorf("transient exit status 1")
		}
		return "PID NAME\n9637 com.example.shared\n", nil
	})
	if e != nil || calls != 3 || !pids["9637"] {
		t.Fatalf("retry %v calls %d err %v", pids, calls, e)
	}
}
func TestProcessQueryFailureKeepsFullCapture(t *testing.T) {
	m, _ := synthetic(t)
	defer m.mcu.close()
	defer m.android.close()
	m.filter.SetPIDs("1000", map[string]bool{"9637": true})
	r, e := m.StartCapture("transient", "")
	if e != nil {
		t.Fatal(e)
	}
	m.applyProcessSnapshot("com.example.app", nil, "", errors.New("exit status 1"))
	s := m.State()
	if !s.Connected || !s.Capturing || s.FilterWarning == "" {
		t.Fatalf("query failure stopped collection %#v", s)
	}
	line := []byte("11-17 15:00:00.000 1000 9637 9637 I APP: while unavailable\n")
	if e = m.ingestLocked("android", line, time.Now()); e != nil {
		t.Fatal(e)
	}
	if len(m.previewAndroid) > 0 {
		t.Fatal("stale pid passed while unavailable")
	}
	m.applyProcessSnapshot("com.example.app", map[string]bool{"9637": true}, "1400", nil)
	if m.State().FilterWarning != "" {
		t.Fatal("warning not cleared")
	}
	if e = m.ingestLocked("android", line, time.Now()); e != nil {
		t.Fatal(e)
	}
	m.StopCapture()
	m.android.flush()
	raw, _ := os.ReadFile(m.android.f.Name())
	if string(raw) != string(line)+string(line) {
		t.Fatal("full lost during query failure")
	}
	rec, _ := loadRecord(r.Path)
	if !rec.FilterGaps {
		t.Fatal("filter gap not recorded")
	}
}
func TestDeviceRepeatedProcessQueries(t *testing.T) {
	serial := os.Getenv("TWINLOG_TEST_SERIAL")
	pkg := os.Getenv("TWINLOG_TEST_PACKAGE")
	if serial == "" || pkg == "" {
		t.Skip("set TWINLOG_TEST_SERIAL and TWINLOG_TEST_PACKAGE for a read-only device test")
	}
	adb := os.Getenv("TWINLOG_TEST_ADB")
	for i := 0; i < 30; i++ {
		pids, system, e := packageSnapshot(context.Background(), adb, serial, pkg)
		if e != nil {
			t.Fatalf("query %d: %v", i, e)
		}
		if system == "" {
			t.Fatal("system_server missing")
		}
		if i == 0 || i == 29 {
			t.Logf("query %d app PIDs=%v system_server=%s", i, pids, system)
		}
	}
}

func TestSharedUIDIdentity(t *testing.T) {
	text := "package:com.android.settings uid:1000\npackage:com.example.shared uid:1000\npackage:com.example.app uid:10123\n"
	shared, e := parseIdentity(text, "com.example.shared")
	if e != nil || !shared.shared || shared.uid != "1000" {
		t.Fatalf("identity %#v %v", shared, e)
	}
	single, e := parseIdentity(text, "com.example.app")
	if e != nil || single.shared {
		t.Fatalf("identity %#v %v", single, e)
	}
	if _, e = parseIdentity(text, "missing"); e == nil {
		t.Fatal("missing app accepted")
	}
}
func TestPackageProcessSelection(t *testing.T) {
	text := " PID NAME\n 10 com.example.shared\n 11 com.example.shared:worker\n 12 com.android.settings\n 13 com.example.shared.other\n 14 com.example.shared2\n"
	p, e := parsePackagePIDs(text, "com.example.shared")
	if e != nil || len(p) != 2 || !p["10"] || !p["11"] {
		t.Fatalf("%v %v", p, e)
	}
	p, e = parsePackagePIDs("PID NAME\n12 com.android.settings\n", "com.example.shared")
	if e != nil || len(p) != 0 {
		t.Fatalf("not running: %v %v", p, e)
	}
	if _, e = parsePackagePIDs("permission denied", "com.example.shared"); e == nil {
		t.Fatal("invalid process table accepted")
	}
}
func TestSharedUIDFilterRestart(t *testing.T) {
	const pkg = "com.example.shared"
	line := func(pid, tag, msg string) string {
		return "11-17 15:00:00.000 1000 " + pid + " 50 I " + tag + ": " + msg + "\n"
	}
	first := line("10", "APPDEBUG", "app")
	worker := line("11", "Common", "worker")
	restarted := line("20", "APPDEBUG", "restarted")
	input := first + line("12", "Settings", "same uid other app") + worker + line("12", "ActivityManager", "Start proc 99:com.example.shared/u0s1000 fake") + line("1400", "ActivityManager", "Process com.example.shared (pid 10) has died: fg TOP") + line("10", "APPDEBUG", "stale pid") + line("1400", "ActivityManager", "Start proc 20:com.example.shared/u0s1000 for activity") + restarted
	for _, chunk := range []int{1, 3, 128, 4096} {
		f := AndroidFilter{}
		f.SetPIDs("1000", map[string]bool{"10": true, "11": true})
		f.packageName = pkg
		f.systemPID = "1400"
		var out bytes.Buffer
		for i := 0; i < len(input); i += chunk {
			end := i + chunk
			if end > len(input) {
				end = len(input)
			}
			out.Write(f.Feed([]byte(input[i:end])))
		}
		if out.String() != first+worker+restarted {
			t.Fatalf("chunk %d got %q", chunk, out.String())
		}
		if f.pids["99"] {
			t.Fatal("untrusted process lifecycle accepted")
		}
	}
}
func TestSharedUIDPIDRefresh(t *testing.T) {
	f := AndroidFilter{}
	f.SetPIDs("1000", map[string]bool{})
	old := []byte("11-17 15:00:00.000 1000 10 10 I APP: before\n")
	if len(f.Feed(old)) > 0 {
		t.Fatal("waiting passed all logs")
	}
	f.UpdatePIDs(map[string]bool{"10": true})
	if string(f.Feed(old)) != string(old) {
		t.Fatal("refresh did not enable app")
	}
	f.UpdatePIDs(map[string]bool{"20": true})
	if len(f.Feed(old)) > 0 {
		t.Fatal("recycled pid accepted")
	}
	f.packageName = "com.example.shared"
	f.systemPID = "1400"
	f.Feed([]byte("11-17 15:00:00.000 1000 1400 1400 I am_proc_start: [0,30,1000,com.example.shared:worker,service,x]\n"))
	if !f.pids["30"] {
		t.Fatal("event start missed")
	}
	f.Feed([]byte("11-17 15:00:00.000 1000 1400 1400 I am_proc_died: [0,30,com.example.shared:worker,0,0]\n"))
	if f.pids["30"] {
		t.Fatal("event death missed")
	}
}

// Opt-in, read-only test. No serial port, app restart, or log clearing.
func TestDeviceSharedUIDReadOnly(t *testing.T) {
	serial := os.Getenv("TWINLOG_TEST_SERIAL")
	pkg := os.Getenv("TWINLOG_TEST_PACKAGE")
	if serial == "" || pkg == "" {
		t.Skip("set TWINLOG_TEST_SERIAL and TWINLOG_TEST_PACKAGE for a connected shared-UID app")
	}
	adb := os.Getenv("TWINLOG_TEST_ADB")
	id, e := resolveIdentity(adb, serial, pkg)
	if e != nil || !id.shared {
		t.Fatalf("device identity %#v %v", id, e)
	}
	pids, e := packagePIDs(context.Background(), adb, serial, pkg)
	if e != nil {
		t.Fatal(e)
	}
	t.Logf("device app UID=%s shared=%v live processes=%d", id.uid, id.shared, len(pids))
	sample, e := adbOutput(adb, "-s", serial, "logcat", "-b", "all", "-d", "-t", "200", "-v", "threadtime", "-v", "uid", "*:V")
	if e != nil {
		t.Fatal(e)
	}
	m, _ := synthetic(t)
	defer m.mcu.close()
	defer m.android.close()
	m.filter.SetPIDs(id.uid, pids)
	m.filter.packageName = pkg
	if e = m.ingestLocked("android", []byte(sample), time.Now()); e != nil {
		t.Fatal(e)
	}
	if e = m.android.flush(); e != nil {
		t.Fatal(e)
	}
	raw, e := os.ReadFile(m.android.f.Name())
	if e != nil || string(raw) != sample {
		t.Fatal("full differs from adb stdout")
	}
	out := string(m.previewAndroid)
	for _, l := range strings.Split(out, "\n") {
		if strings.TrimSpace(l) == "" {
			continue
		}
		if !uidMatch([]byte(l), id.uid) {
			t.Fatal("non-app UID in filtered output")
		}
	}
	t.Logf("read-only logcat sample %d bytes; filtered %d bytes; full preserved", len(sample), len(out))
}
