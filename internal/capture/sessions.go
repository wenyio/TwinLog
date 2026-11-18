package capture

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

type FullLog struct {
	Path   string `json:"path"`
	Source string `json:"source,omitempty"`
	Bytes  int64  `json:"bytes"`
}

type Session struct {
	Path      string   `json:"path"`
	StartedAt string   `json:"startedAt"`
	Group     string   `json:"group,omitempty"`
	Title     string   `json:"title,omitempty"`
	Managed   bool     `json:"managed"`
	Records   []Record `json:"records"`
	Full      *FullLog `json:"full"`
}

type SessionChoice struct {
	Title        string `json:"title"`
	ExistingPath string `json:"existingPath"`
}

type sessionMetadata struct {
	StartedAt string
	Group     string
}

func readSessionMetadata(path string) (sessionMetadata, bool) {
	var meta sessionMetadata
	file := filepath.Join(path, "session.json")
	if st, err := os.Lstat(file); err != nil || !st.Mode().IsRegular() {
		return meta, false
	}
	b, err := os.ReadFile(file)
	if err != nil || json.Unmarshal(b, &meta) != nil {
		return meta, false
	}
	if meta.Group == "" {
		meta.Group = filepath.Base(path)
	}
	_, err = time.Parse(time.RFC3339Nano, meta.StartedAt)
	return meta, err == nil
}

const sessionNamesFile = ".twinlog-session-names.json"

func readSessionNames(root string) (map[string]string, error) {
	names := map[string]string{}
	path := filepath.Join(root, sessionNamesFile)
	st, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return names, nil
	}
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() {
		return nil, fmt.Errorf("会话名称文件不是普通文件: %s", path)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal(b, &names); err != nil || names == nil {
		return nil, fmt.Errorf("会话名称文件格式无效: %s", path)
	}
	return names, nil
}

func validateSessionTitle(title string) (string, error) {
	title = strings.TrimSpace(title)
	if len([]rune(title)) > 100 || strings.ContainsAny(title, "\r\n") {
		return "", fmt.Errorf("会话名称须为一行，最多 100 个字符")
	}
	return title, nil
}

func writeSessionTitle(root, group, title string) error {
	names, err := readSessionNames(root)
	if err != nil {
		return err
	}
	if title == "" {
		delete(names, group)
	} else {
		names[group] = title
	}
	return writeJSON(filepath.Join(root, sessionNamesFile), names)
}

func (m *Manager) SaveSessionTitle(root, path, title string) error {
	m.op.Lock()
	defer m.op.Unlock()
	title, err := validateSessionTitle(title)
	if err != nil {
		return err
	}
	p, err := managedSession(root, path)
	if err != nil {
		return err
	}
	meta, ok := readSessionMetadata(p)
	if !ok {
		return fmt.Errorf("会话信息无效: %s", path)
	}
	return writeSessionTitle(filepath.Dir(p), meta.Group, title)
}

func fullLogInfo(path string) *FullLog {
	dir, err := os.Lstat(path)
	if err != nil || !dir.IsDir() {
		return nil
	}
	var total int64
	var sources []string
	for _, source := range []string{"mcu", "android"} {
		if st, err := os.Lstat(filepath.Join(path, source+".log")); err == nil && st.Mode().IsRegular() {
			sources = append(sources, source)
			total += st.Size()
		}
	}
	if len(sources) == 0 {
		return nil
	}
	f := &FullLog{Path: path, Bytes: total}
	if len(sources) == 1 {
		f.Source = sources[0]
	}
	return f
}

func (m *Manager) ListSessions(root string) ([]Session, error) {
	out := []Session{}
	if root == "" {
		return out, nil
	}
	entries, err := os.ReadDir(root)
	if os.IsNotExist(err) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	names, err := readSessionNames(root)
	if err != nil {
		return nil, err
	}
	byPath := map[string]*Session{}
	for _, entry := range entries {
		if !entry.IsDir() || strings.EqualFold(entry.Name(), "full") || strings.EqualFold(entry.Name(), ".twinlog-trash") {
			continue
		}
		path := filepath.Join(root, entry.Name())
		if meta, ok := readSessionMetadata(path); ok {
			byPath[path] = &Session{Path: path, StartedAt: meta.StartedAt, Group: meta.Group, Title: names[meta.Group], Managed: true, Records: []Record{}, Full: fullLogInfo(filepath.Join(path, "full"))}
		}
	}
	records, err := m.ListRecords(root)
	if err != nil {
		return nil, err
	}
	for _, record := range records {
		path := filepath.Dir(record.Path)
		if byPath[path] == nil {
			byPath[path] = &Session{Path: path, StartedAt: record.StartedAt}
		}
		byPath[path].Records = append(byPath[path].Records, record)
	}
	for _, session := range byPath {
		out = append(out, *session)
	}
	sort.Slice(out, func(i, j int) bool {
		a, _ := time.Parse(time.RFC3339Nano, out[i].StartedAt)
		b, _ := time.Parse(time.RFC3339Nano, out[j].StartedAt)
		if a.Equal(b) {
			return out[i].Path > out[j].Path
		}
		return a.After(b)
	})
	return out, nil
}

// Managed operations accept only a direct session below the configured root.
func managedSession(root, path string) (string, error) {
	if root == "" || path == "" {
		return "", fmt.Errorf("未指定日志保存目录或会话")
	}
	r, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	p, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	name := filepath.Base(p)
	if !samePath(filepath.Dir(p), r) || strings.EqualFold(name, "full") || strings.EqualFold(name, ".twinlog-trash") {
		return "", fmt.Errorf("会话不在当前保存目录内: %s", path)
	}
	r, err = filepath.EvalSymlinks(r)
	if err != nil {
		return "", err
	}
	p = filepath.Join(r, name)
	if err := directDir(p); err != nil {
		return "", err
	}
	if _, ok := readSessionMetadata(p); !ok {
		return "", fmt.Errorf("会话信息无效: %s", path)
	}
	return p, nil
}

func samePath(a, b string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

func sameResolvedPath(path, canonical string) bool {
	p, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	p, err = filepath.EvalSymlinks(p)
	return err == nil && samePath(p, canonical)
}

func directDir(path string) error {
	st, err := os.Lstat(path)
	if err != nil {
		return err
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return err
	}
	if !st.IsDir() || !samePath(resolved, path) {
		return fmt.Errorf("不是普通目录: %s", path)
	}
	return nil
}

func (m *Manager) RemoveSessionLogs(root, path string, fullOnly bool, confirm func(Session) (bool, error)) error {
	return m.removeSessionLogs(root, path, fullOnly, confirm, deleteWithShell)
}

func (m *Manager) removeSessionLogs(root, path string, fullOnly bool, confirm func(Session) (bool, error), remove func([]string) error) error {
	m.op.Lock()
	defer m.op.Unlock()
	p, err := managedSession(root, path)
	if err != nil {
		return err
	}
	state := m.State()
	if state.Connected && sameResolvedPath(state.SessionDir, p) {
		return fmt.Errorf("请先断开此会话的设备连接")
	}
	meta, _ := readSessionMetadata(p)
	s := Session{Path: p, StartedAt: meta.StartedAt, Full: fullLogInfo(filepath.Join(p, "full"))}
	target := p
	if fullOnly {
		if s.Full == nil {
			return fmt.Errorf("完整日志不存在")
		}
		target = s.Full.Path
		if err = directDir(target); err != nil {
			return err
		}
	} else if s.Records, err = m.ListRecords(p); err != nil {
		return err
	}
	before, err := os.Lstat(target)
	if err != nil {
		return err
	}
	ok, err := confirm(s)
	if err != nil || !ok {
		return err
	}
	// Refuse a link or a replaced directory even if it appeared during confirmation.
	if err = directDir(target); err != nil {
		return err
	}
	if after, err := os.Lstat(target); err != nil || !os.SameFile(before, after) {
		return fmt.Errorf("待删除目录已变化: %s", target)
	}
	return remove([]string{target})
}

func (m *Manager) ReadFullLogs(root, session string, lines int) (RecordLogs, error) {
	p, err := managedSession(root, session)
	if err != nil {
		return RecordLogs{}, err
	}
	dir := filepath.Join(p, "full")
	if err = directDir(dir); err != nil {
		return RecordLogs{}, err
	}
	f := fullLogInfo(dir)
	if f == nil {
		return RecordLogs{}, fmt.Errorf("完整日志不存在")
	}
	return readSourceLogs(f.Path, f.Source, lines)
}
