package capture

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

const previewBytes = 256 * 1024
const previewLines = 2000

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
func readLogPreview(path string) (LogPreview, error) {
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
	_, err = f.ReadAt(b, start)
	if err != nil && err != io.EOF {
		return p, err
	}
	p.Truncated = start > 0
	if start > 0 {
		// Prefer whole lines, but still show the tail of a single very long line.
		if i := strings.IndexByte(string(b), '\n'); i >= 0 && i < len(b)-1 {
			b = b[i+1:]
		} else {
			for len(b) > 0 && !utf8.RuneStart(b[0]) {
				b = b[1:]
			}
		}
	}
	text := strings.ToValidUTF8(string(b), "�")
	lines := strings.Split(strings.TrimSuffix(text, "\n"), "\n")
	if len(lines) > previewLines {
		text = strings.Join(lines[len(lines)-previewLines:], "\n")
		if len(b) > 0 && b[len(b)-1] == '\n' {
			text += "\n"
		}
		p.Truncated = true
	}
	p.Text = text
	return p, nil
}

func (m *Manager) ReadRecordLogs(path string) (RecordLogs, error) {
	r, err := loadRecord(path)
	if err != nil {
		return RecordLogs{}, err
	}
	var logs RecordLogs
	if r.Source != "android" {
		logs.MCU, err = readLogPreview(filepath.Join(path, "mcu.log"))
		if err != nil {
			return RecordLogs{}, fmt.Errorf("读取 MCU 日志: %w", err)
		}
	}
	if r.Source != "mcu" {
		logs.Android, err = readLogPreview(filepath.Join(path, "android.log"))
		if err != nil {
			return RecordLogs{}, fmt.Errorf("读取 Android 日志: %w", err)
		}
	}
	return logs, nil
}

// Records are moved, never erased. The full session logs remain in place.
func (m *Manager) TrashRecords(root string, paths []string) (string, error) {
	if len(paths) == 0 {
		return "", fmt.Errorf("请选择需要删除的记录")
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.record != nil {
		return "", fmt.Errorf("请先停止当前抓取")
	}
	validated := []string{}
	seen := map[string]bool{}
	for _, path := range paths {
		p, e := filepath.Abs(path)
		if e != nil {
			return "", e
		}
		p, e = filepath.EvalSymlinks(p)
		if e != nil {
			return "", e
		}
		rel, e := filepath.Rel(root, p)
		parts := strings.Split(rel, string(os.PathSeparator))
		// A capture is a direct child of a session under the configured root.
		if e != nil || len(parts) != 2 || parts[0] == ".." || strings.EqualFold(parts[0], ".twinlog-trash") || strings.EqualFold(parts[1], "full") {
			return "", fmt.Errorf("记录不在当前保存目录内: %s", path)
		}
		if _, e = loadRecord(p); e != nil {
			return "", e
		}
		if _, e = os.Stat(filepath.Join(p, "session.json")); !os.IsNotExist(e) {
			return "", fmt.Errorf("不能删除会话目录: %s", path)
		}
		key := strings.ToLower(p)
		if !seen[key] {
			validated = append(validated, p)
			seen[key] = true
		}
	}
	trash := filepath.Join(root, ".twinlog-trash")
	if st, e := os.Lstat(trash); e == nil && (st.Mode()&os.ModeSymlink != 0 || !st.IsDir()) {
		return "", fmt.Errorf("回收目录不是普通目录")
	}
	if err = os.MkdirAll(trash, 0755); err != nil {
		return "", err
	}
	resolvedTrash, err := filepath.EvalSymlinks(trash)
	if err != nil {
		return "", err
	}
	if !strings.EqualFold(resolvedTrash, trash) {
		return "", fmt.Errorf("回收目录不能指向其他位置")
	}
	batch, err := uniqueDir(trash, timeDir())
	if err != nil {
		return "", err
	}
	type move struct{ from, to string }
	origins := map[string]string{}
	for i, path := range validated {
		origins[fmt.Sprintf("%d_%s", i+1, filepath.Base(path))] = path
	}
	if err = writeJSON(filepath.Join(batch, "restore.json"), origins); err != nil {
		return "", err
	}
	moved := []move{}
	for i, path := range validated {
		dest := filepath.Join(batch, fmt.Sprintf("%d_%s", i+1, filepath.Base(path)))
		if err = os.Rename(path, dest); err != nil {
			for j := len(moved) - 1; j >= 0; j-- {
				if rollback := os.Rename(moved[j].to, moved[j].from); rollback != nil {
					return batch, fmt.Errorf("删除失败: %v；部分记录保留在 %s: %w", err, batch, rollback)
				}
			}
			return "", err
		}
		moved = append(moved, move{path, dest})
	}
	return batch, nil
}
