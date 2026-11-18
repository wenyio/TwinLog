package capture

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"go.bug.st/serial"
)

// The test executable stands in for adb, including its long-running logcat process.
func TestMain(m *testing.M) {
	if os.Getenv("TWINLOG_FAKE_ADB") == "1" && len(os.Args) >= 4 && os.Args[1] == "-s" {
		switch os.Args[3] {
		case "get-state":
			fmt.Println("device")
		case "logcat":
			if slices.Contains(os.Args, "--help") {
				fmt.Println("uid")
			} else {
				fmt.Print(androidTestLine)
				time.Sleep(30 * time.Second)
			}
		}
		return
	}
	os.Exit(m.Run())
}

const androidTestLine = "11-17 01:02:03.000 10123 100 101 D APP: android only\n"

type testSerialPort struct {
	serial.Port
	*io.PipeReader
}

func (p testSerialPort) Read(b []byte) (int, error) { return p.PipeReader.Read(b) }
func (p testSerialPort) Close() error               { return p.PipeReader.Close() }

func TestSingleSourceSession(t *testing.T) {
	adb, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("TWINLOG_FAKE_ADB", "1")
	for _, source := range []string{"mcu", "android"} {
		for _, full := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/full=%t", source, full), func(t *testing.T) {
				root := t.TempDir()
				c := Config{OutputDir: root, SaveFullLogs: full}
				other := "mcu"
				want := androidTestLine
				reader, writer := io.Pipe()
				t.Cleanup(func() { _ = reader.Close(); _ = writer.Close() })
				if source == "mcu" {
					c.SerialPort = "fake port"
					c.ADBPath = filepath.Join(root, "missing-adb")
					c.Package = "unused.android.package"
					other = "android"
					want = "serial only\n"
				} else {
					c.AndroidSerial = "fake device"
					c.ADBPath = adb
				}
				m := NewManager(nil)
				t.Cleanup(func() { _ = m.Disconnect() })
				if err := m.connect(c, func(Config) (serial.Port, error) {
					if source == "android" {
						t.Fatal("Android-only connection tried to open a serial port")
					}
					return testSerialPort{PipeReader: reader}, nil
				}); err != nil {
					t.Fatal(err)
				}
				// Disable timing dependence on the start of the fake logcat stream.
				if source == "android" {
					waitForBytes(t, m, source)
				} else if m.State().FilterStatus != "" {
					t.Fatal("serial-only connection reported an Android filter")
				}
				r, err := m.StartCapture("single source", "notes")
				if err != nil || r.Source != source || r.Package != "" {
					t.Fatalf("record: %+v, %v", r, err)
				}
				if source == "mcu" {
					if _, err := writer.Write([]byte(want)); err != nil {
						t.Fatal(err)
					}
					waitForBytes(t, m, source)
				} else {
					m.mu.Lock()
					err = m.ingestLocked(source, []byte(want), time.Now())
					m.mu.Unlock()
					if err != nil {
						t.Fatal(err)
					}
				}
				if _, err := m.StopCapture(); err != nil {
					t.Fatal(err)
				}
				logs, err := m.ReadRecordLogs(r.Path, 0)
				if err != nil {
					t.Fatal(err)
				}
				got := logs.Android.Text
				if source == "mcu" {
					got = logs.MCU.Text
				}
				if !strings.HasSuffix(got, want) || (source == "mcu" && !strings.HasPrefix(got, "[")) {
					t.Fatalf("unexpected capture preview: %q", got)
				}
				if err := m.Disconnect(); err != nil {
					t.Fatal(err)
				}
				if _, err := os.Stat(filepath.Join(r.Path, other+".log")); !os.IsNotExist(err) {
					t.Fatalf("inactive capture log: %v", err)
				}
				fullDir := filepath.Join(m.State().SessionDir, "full")
				if full {
					if b, err := os.ReadFile(filepath.Join(fullDir, source+".log")); err != nil || !strings.HasSuffix(string(b), want) {
						t.Fatalf("full log: %q, %v", b, err)
					}
					if _, err := os.Stat(filepath.Join(fullDir, other+".log")); !os.IsNotExist(err) {
						t.Fatalf("inactive full log: %v", err)
					}
				} else if _, err := os.Stat(fullDir); !os.IsNotExist(err) {
					t.Fatalf("full logs disabled: %v", err)
				}
				dest := filepath.Join(root, "export.zip")
				if err := m.Export([]string{r.Path}, dest, true); err != nil {
					t.Fatal(err)
				}
				z, err := zip.OpenReader(dest)
				if err != nil {
					t.Fatal(err)
				}
				defer z.Close()
				for _, f := range z.File {
					if strings.HasSuffix(f.Name, "/"+other+".log") {
						t.Fatalf("export included inactive source: %s", f.Name)
					}
				}
				if err := os.Remove(filepath.Join(r.Path, source+".log")); err != nil {
					t.Fatal(err)
				}
				if _, err := m.ReadRecordLogs(r.Path, 0); err == nil {
					t.Fatal("missing active log should still be an error")
				}
			})
		}
	}
}

func waitForBytes(t *testing.T, m *Manager, source string) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		s := m.State()
		if (source == "mcu" && s.McuBytes != 0) || (source == "android" && s.AndroidBytes != 0) {
			return
		}
	}
	t.Fatalf("no %s data: %+v", source, m.State())
}

func TestConnectRequiresAtLeastOneSource(t *testing.T) {
	m := NewManager(nil)
	if err := m.Connect(Config{OutputDir: t.TempDir()}); err == nil || m.State().Connected {
		t.Fatalf("connection without devices: %v", err)
	}
}

func TestIndependentConnections(t *testing.T) {
	root := t.TempDir()
	m := NewManager(nil)
	t.Cleanup(func() { _ = m.Disconnect() })
	c := Config{OutputDir: root, SerialPort: "fake port", SaveFullLogs: true}
	connect := func(text string) (string, string) {
		t.Helper()
		reader, writer := io.Pipe()
		defer writer.Close()
		defer reader.Close()
		if err := m.connect(c, func(Config) (serial.Port, error) {
			return testSerialPort{PipeReader: reader}, nil
		}); err != nil {
			t.Fatal(err)
		}
		dir := m.State().SessionDir
		r, err := m.StartCapture(text, "")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write([]byte(text + "\n")); err != nil {
			t.Fatal(err)
		}
		waitForBytes(t, m, "mcu")
		if err := m.Disconnect(); err != nil {
			t.Fatal(err)
		}
		return dir, r.Path
	}
	first, r1 := connect("first")
	second, r2 := connect("second")
	if first == second || filepath.Dir(r1) != first || filepath.Dir(r2) != second {
		t.Fatalf("connection directories were reused: %s %s", first, second)
	}
	for dir, text := range map[string]string{first: "first", second: "second"} {
		b, err := os.ReadFile(filepath.Join(dir, "full", "mcu.log"))
		if err != nil || !strings.HasSuffix(string(b), text+"\n") || strings.Count(string(b), "\n") != 1 {
			t.Fatalf("full log %s: %q, %v", dir, b, err)
		}
	}
	if err := m.SaveSessionTitle(root, second, "  重命名后  "); err != nil {
		t.Fatal(err)
	}
	sessions, err := NewManager(nil).ListSessions(root)
	if err != nil || len(sessions) != 2 {
		t.Fatalf("connections: %+v, %v", sessions, err)
	}
	for _, session := range sessions {
		if session.Path == second && session.Title != "重命名后" {
			t.Fatalf("renamed: %+v", session)
		}
		if session.Path == first && session.Title != "" {
			t.Fatalf("other connection changed: %+v", session)
		}
	}
	if err := m.SaveSessionTitle(root, r1, "不是连接"); err == nil {
		t.Fatal("renamed a record")
	}
	if err := m.SaveSessionTitle(root, second, ""); err != nil {
		t.Fatal(err)
	}
}
