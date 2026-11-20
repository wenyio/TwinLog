package capture

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func attachmentFixture(t *testing.T) (*Manager, string, Record) {
	t.Helper()
	m, root := synthetic(t)
	m.cancel = func() {}
	t.Cleanup(func() { _ = m.Disconnect() })
	r, err := m.StartCapture("附件测试", "")
	if err != nil {
		t.Fatal(err)
	}
	return m, root, r
}
func TestAttachmentImportRenameAndExport(t *testing.T) {
	m, root, r := attachmentFixture(t)
	ctx := context.Background()
	source := filepath.Join(t.TempDir(), "现场截图.png")
	content := []byte{0, 1, 2, 255, 13, 10}
	if err := os.WriteFile(source, content, 0644); err != nil {
		t.Fatal(err)
	}
	items, err := m.ImportAttachments(ctx, root, r.Path, []string{source, source}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 || items[1].Name != "现场截图_1.png" {
		t.Fatalf("items: %+v", items)
	}
	if err = m.RenameAttachment(root, r.Path, items[0].Name, "蓝牙超时"); err != nil {
		t.Fatal(err)
	}
	if err = m.RenameAttachment(root, r.Path, items[1].Name, "蓝牙超时"); err == nil {
		t.Fatal("overwrote collision")
	}
	if err = m.RenameAttachment(root, r.Path, "蓝牙超时.png", ""); err == nil {
		t.Fatal("empty base accepted")
	}
	if _, err = m.SaveAttachment(ctx, root, r.Path, "Case.txt", strings.NewReader("case"), 4); err != nil {
		t.Fatal(err)
	}
	if err = m.RenameAttachment(root, r.Path, "Case.txt", "case"); err != nil {
		t.Fatal("case-only rename", err)
	}
	if got, err := os.ReadFile(source); err != nil || !bytes.Equal(got, content) {
		t.Fatal("source changed", err)
	}
	if _, err = m.StopCapture(); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(t.TempDir(), "export.zip")
	if err = m.ExportSelection(root, []string{r.Path}, nil, dest); err != nil {
		t.Fatal(err)
	}
	z, err := zip.OpenReader(dest)
	if err != nil {
		t.Fatal(err)
	}
	defer z.Close()
	found := false
	for _, f := range z.File {
		if f.Name == "attachments/蓝牙超时.png" {
			in, e := f.Open()
			if e != nil {
				t.Fatal(e)
			}
			got, e := io.ReadAll(in)
			in.Close()
			if e != nil || !bytes.Equal(got, content) {
				t.Fatal("bad archive content", e)
			}
			found = true
		}
	}
	if !found {
		t.Fatal("renamed attachment absent from ZIP")
	}
}

type cancelAttachmentReader struct{ cancel context.CancelFunc }

func (r cancelAttachmentReader) Read(p []byte) (int, error) {
	copy(p, "partial")
	r.cancel()
	return 7, nil
}

type brokenAttachmentReader struct{}

func (brokenAttachmentReader) Read(p []byte) (int, error) {
	copy(p, "partial")
	return 7, errors.New("disk read failed")
}
func TestAttachmentFailureCleanupAndValidation(t *testing.T) {
	m, root, r := attachmentFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	if _, err := m.SaveAttachment(ctx, root, r.Path, "取消.bin", cancelAttachmentReader{cancel}, 100); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, err := m.SaveAttachment(context.Background(), root, r.Path, "失败.bin", brokenAttachmentReader{}, 100); err == nil {
		t.Fatal("missing read failure")
	}
	if _, err := m.SaveAttachment(context.Background(), root, r.Path, "大小.bin", strings.NewReader("a"), 2); err == nil {
		t.Fatal("size mismatch accepted")
	}
	entries, err := os.ReadDir(filepath.Join(r.Path, "attachments"))
	if err != nil || len(entries) != 0 {
		t.Fatalf("partial files: %v %v", entries, err)
	}
	for _, name := range []string{"../escape.png", "CON.txt", "LPT1", "bad:name", "尾部.", ".twinlog-hidden", "COM¹.png"} {
		if _, err := m.SaveAttachment(context.Background(), root, r.Path, name, strings.NewReader(""), 0); err == nil {
			t.Errorf("accepted %q", name)
		}
	}
	if _, err = m.ImportAttachments(context.Background(), root, r.Path, []string{t.TempDir()}, nil); err == nil {
		t.Fatal("directory accepted")
	}
	if _, err = m.SaveAttachment(context.Background(), root, filepath.Dir(r.Path), "escape", strings.NewReader(""), 0); err == nil {
		t.Fatal("session accepted")
	}
	missing := filepath.Join(root, "session", "missing")
	if _, err = m.SaveAttachment(context.Background(), root, missing, "escape", strings.NewReader(""), 0); err == nil {
		t.Fatal("missing record accepted")
	}
}

type blockingAttachmentReader struct {
	started chan struct{}
	release chan struct{}
	first   bool
}

func (r *blockingAttachmentReader) Read(p []byte) (int, error) {
	if !r.first {
		r.first = true
		close(r.started)
		<-r.release
		copy(p, "x")
		return 1, nil
	}
	return 0, io.EOF
}
func TestAttachmentCopyDoesNotBlockStop(t *testing.T) {
	m, root, r := attachmentFixture(t)
	reader := &blockingAttachmentReader{started: make(chan struct{}), release: make(chan struct{})}
	done := make(chan error, 1)
	go func() {
		_, err := m.SaveAttachment(context.Background(), root, r.Path, "large.bin", reader, 1)
		done <- err
	}()
	<-reader.started
	defer func() {
		close(reader.release)
		if err := <-done; err != nil {
			t.Error(err)
		}
	}()
	stopped := make(chan error, 1)
	go func() { _, err := m.StopCapture(); stopped <- err }()
	select {
	case err := <-stopped:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("StopCapture blocked by copy")
	}
	if err := m.ExportSelection(root, []string{r.Path}, nil, filepath.Join(t.TempDir(), "busy.zip")); err == nil {
		t.Fatal("export raced active copy")
	}
	if err := m.deleteRecords(root, []string{r.Path}, func([]string) error { t.Fatal("deletion reached shell"); return nil }); err == nil {
		t.Fatal("delete raced active copy")
	}
	if err := m.RenameAttachment(root, r.Path, "large.bin", "next"); err == nil {
		t.Fatal("rename raced copy")
	}
}
