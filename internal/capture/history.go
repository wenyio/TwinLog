package capture

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

const previewBytes = 2 * 1024 * 1024

type LogPreview struct {
	Text      string `json:"text"`
	Bytes     int64  `json:"bytes"`
	Truncated bool   `json:"truncated"`
}

type RecordLogs struct {
	MCU     LogPreview `json:"mcu"`
	Android LogPreview `json:"android"`
}

// Read only a bounded tail; never load an entire historical log into memory.
func readLogPreview(path string, lines int) (LogPreview, error) {
	f, err := os.Open(path)
	if err != nil {
		return LogPreview{}, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return LogPreview{}, err
	}
	p := LogPreview{Bytes: st.Size()}
	start := max(int64(0), st.Size()-previewBytes)
	b := make([]byte, st.Size()-start)
	n, err := f.ReadAt(b, start)
	if err != nil && err != io.EOF {
		return p, err
	}
	b = b[:n]
	p.Truncated = start > 0
	if start > 0 {
		// Prefer whole lines, but still show the tail of a single very long line.
		if i := bytes.IndexByte(b, '\n'); i >= 0 && i < len(b)-1 {
			b = b[i+1:]
		} else {
			for len(b) > 0 && !utf8.RuneStart(b[0]) {
				b = b[1:]
			}
		}
	}
	end := len(b)
	if end > 0 && b[end-1] == '\n' {
		end--
	}
	for i := 0; i < lines; i++ {
		end = bytes.LastIndexByte(b[:end], '\n')
		if end < 0 {
			break
		}
		if i == lines-1 {
			b = b[end+1:]
			p.Truncated = true
		}
	}
	p.Text = strings.ToValidUTF8(string(b), "�")
	return p, nil
}

func (m *Manager) ReadRecordLogs(path string, lines int) (RecordLogs, error) {
	r, err := loadRecord(path)
	if err != nil {
		return RecordLogs{}, err
	}
	return readSourceLogs(path, r.Source, lines)
}

func readSourceLogs(path, source string, lines int) (RecordLogs, error) {
	var logs RecordLogs
	var err error
	lines = NormalizePreviewLines(lines)
	if source != "android" {
		logs.MCU, err = readLogPreview(filepath.Join(path, "mcu.log"), lines)
		if err != nil {
			return RecordLogs{}, fmt.Errorf("读取 MCU 日志: %w", err)
		}
	}
	if source != "mcu" {
		logs.Android, err = readLogPreview(filepath.Join(path, "android.log"), lines)
		if err != nil {
			return RecordLogs{}, fmt.Errorf("读取 Android 日志: %w", err)
		}
	}
	return logs, nil
}

func (m *Manager) DeleteRecords(root string, paths []string) error {
	return m.deleteRecords(root, paths, deleteWithShell)
}

func (m *Manager) deleteRecords(root string, paths []string, remove func([]string) error) error {
	if err := m.lockAttachments(); err != nil {
		return err
	}
	defer m.attachmentMu.Unlock()
	if len(paths) == 0 {
		return fmt.Errorf("请选择需要删除的记录")
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return err
	}
	// Block a new capture while the shell may be waiting for confirmation,
	// without holding the lock used by the continuous log writers.
	m.op.Lock()
	defer m.op.Unlock()
	m.mu.Lock()
	capturing := m.record != nil
	m.mu.Unlock()
	if capturing {
		return fmt.Errorf("请先停止当前抓取")
	}
	validated := []string{}
	seen := map[string]bool{}
	for _, path := range paths {
		p, e := filepath.Abs(path)
		if e != nil {
			return e
		}
		p, e = filepath.EvalSymlinks(p)
		if e != nil {
			return e
		}
		rel, e := filepath.Rel(root, p)
		parts := strings.Split(rel, string(os.PathSeparator))
		// A capture is a direct child of a session under the configured root.
		if e != nil || len(parts) != 2 || parts[0] == ".." || strings.EqualFold(parts[0], ".twinlog-trash") || strings.EqualFold(parts[0], "full") || strings.EqualFold(parts[1], "full") {
			return fmt.Errorf("记录不在当前保存目录内: %s", path)
		}
		if _, e = loadRecord(p); e != nil {
			return e
		}
		if _, e = os.Stat(filepath.Join(p, "session.json")); !os.IsNotExist(e) {
			return fmt.Errorf("不能删除会话目录: %s", path)
		}
		key := strings.ToLower(p)
		if !seen[key] {
			validated = append(validated, p)
			seen[key] = true
		}
	}
	return remove(validated)
}
