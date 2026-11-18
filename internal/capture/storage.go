package capture

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode"
)

func AtomicWrite(path string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".twinlog-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, err = f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
func writeJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return AtomicWrite(path, b)
}
func writeRecord(path string, record Record) error {
	return writeJSON(path, struct {
		Title       string `json:"title"`
		StartedAt   string `json:"startedAt"`
		EndedAt     string `json:"endedAt"`
		Package     string `json:"package"`
		Source      string `json:"source,omitempty"`
		Interrupted bool   `json:"interrupted"`
		FilterGaps  bool   `json:"filterGaps,omitempty"`
	}{record.Title, record.StartedAt, record.EndedAt, record.Package, record.Source, record.Interrupted, record.FilterGaps})
}
func safeName(s string) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || strings.ContainsRune("<>:\"/\\|?*", r) {
			return '_'
		}
		return r
	}, s)
	r := []rune(s)
	if len(r) > 70 {
		r = r[:70]
	}
	s = strings.Trim(string(r), " .")
	if s == "" {
		s = "capture"
	}
	return s
}
func captureDirName(startedAt time.Time, title string) string {
	stamp := formatDirTime(startedAt)
	if title = strings.TrimSpace(title); title != "" {
		return stamp + "_" + safeName(title)
	}
	return stamp
}
func uniqueDir(root, name string) (string, error) {
	for i := 0; i < 10000; i++ {
		n := name
		if i > 0 {
			n = fmt.Sprintf("%s_%d", name, i)
		}
		p := filepath.Join(root, n)
		err := os.Mkdir(p, 0755)
		if err == nil {
			return p, nil
		}
		if !os.IsExist(err) {
			return "", err
		}
	}
	return "", fmt.Errorf("无法生成唯一目录")
}
func loadRecord(path string) (Record, error) {
	var r Record
	b, err := os.ReadFile(filepath.Join(path, "record.json"))
	if err != nil {
		return r, err
	}
	if err = json.Unmarshal(b, &r); err != nil {
		return r, err
	}
	r.Path = path
	notes, err := os.ReadFile(filepath.Join(path, "notes.txt"))
	if err != nil && !os.IsNotExist(err) {
		return r, err
	}
	r.Notes = string(notes)
	return r, nil
}
func (m *Manager) ListRecords(root string) ([]Record, error) {
	out := []Record{}
	if root == "" {
		return out, nil
	}
	if _, err := os.Stat(root); os.IsNotExist(err) {
		return out, nil
	}
	m.mu.Lock()
	active := ""
	if m.record != nil {
		active = m.record.Path
	}
	m.mu.Unlock()
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			return nil
		}
		if path != root && (strings.EqualFold(d.Name(), "full") || strings.EqualFold(d.Name(), ".twinlog-trash")) {
			return filepath.SkipDir
		}
		if _, e := os.Stat(filepath.Join(path, "record.json")); e != nil {
			return nil
		}
		r, e := loadRecord(path)
		if e != nil {
			return e
		}
		if r.EndedAt == "" && path != active {
			r.Interrupted = true
		}
		out = append(out, r)
		return filepath.SkipDir
	})
	sort.Slice(out, func(i, j int) bool { return out[i].StartedAt > out[j].StartedAt })
	return out, err
}
func (m *Manager) SaveNotes(path, notes string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, err := loadRecord(path); err != nil {
		return err
	}
	if err := AtomicWrite(filepath.Join(path, "notes.txt"), []byte(notes)); err != nil {
		return err
	}
	if m.record != nil && m.record.Path == path {
		m.record.Notes = notes
	}
	return nil
}

func (m *Manager) SaveTitle(path, title string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, err := loadRecord(path)
	if err != nil {
		return err
	}
	active := m.record != nil && m.record.Path == path
	if active {
		r = *m.record
	}
	r.Title = strings.TrimSpace(title)
	if err := writeRecord(filepath.Join(path, "record.json"), r); err != nil {
		return err
	}
	if active {
		m.record.Title = r.Title
	}
	return nil
}

func fullLogsDisabled(session string) bool {
	var meta struct {
		Config struct {
			SaveFullLogs *bool `json:"saveFullLogs"`
		} `json:"config"`
	}
	b, err := os.ReadFile(filepath.Join(session, "session.json"))
	return err == nil && json.Unmarshal(b, &meta) == nil &&
		meta.Config.SaveFullLogs != nil && !*meta.Config.SaveFullLogs
}

func ExportFilename(paths []string, now time.Time) (string, error) {
	fallback := "TwinLog_" + now.Format("20060102_150405") + ".zip"
	if len(paths) != 1 {
		return fallback, nil
	}
	r, err := loadRecord(paths[0])
	if err != nil {
		return "", err
	}
	title := strings.Trim(strings.TrimSpace(r.Title), " .")
	if title == "" {
		return fallback, nil
	}
	if ext := filepath.Ext(title); strings.EqualFold(ext, ".zip") {
		title = strings.TrimSuffix(title, ext)
	}
	name := safeName(title)
	// Windows reserves device names even with an extension.
	base, _, _ := strings.Cut(name, ".")
	if !filepath.IsLocal(strings.TrimRight(base, " ")) {
		name = "_" + name
	}
	return name + ".zip", nil
}

func (m *Manager) Export(paths []string, destination string, includeFull bool) error {
	return m.exportLogs(paths, nil, destination, includeFull)
}

func (m *Manager) ExportSelection(root string, paths, fullSessions []string, destination string) error {
	fullDirs := make([]string, 0, len(fullSessions))
	for _, session := range fullSessions {
		p, err := managedSession(root, session)
		if err != nil {
			return err
		}
		dir := filepath.Join(p, "full")
		if err = directDir(dir); err != nil {
			return fmt.Errorf("完整日志不可导出: %w", err)
		}
		if fullLogInfo(dir) == nil {
			return fmt.Errorf("完整日志不存在: %s", dir)
		}
		fullDirs = append(fullDirs, dir)
	}
	return m.exportLogs(paths, fullDirs, destination, false)
}

func (m *Manager) exportLogs(paths, fullDirs []string, destination string, includeFull bool) error {
	if len(paths) == 0 && len(fullDirs) == 0 {
		return fmt.Errorf("请选择需要导出的记录")
	}
	state := m.State()
	dest, err := filepath.Abs(destination)
	if err != nil {
		return err
	}
	dirs := map[string]string{}
	sessions := map[string]bool{}
	usedPrefixes := map[string]bool{}
	for _, path := range paths {
		p, e := filepath.Abs(path)
		if e != nil {
			return e
		}
		p, e = filepath.EvalSymlinks(p)
		if e != nil {
			return e
		}
		if state.ActiveRecord != nil && sameResolvedPath(state.ActiveRecord.Path, p) {
			return fmt.Errorf("请先停止当前抓取")
		}
		if _, exists := dirs[p]; exists {
			continue
		}
		r, e := loadRecord(p)
		if e != nil {
			return e
		}
		session := filepath.Dir(p)
		name := filepath.Base(p)
		if startedAt, e := time.Parse(time.RFC3339Nano, r.StartedAt); e == nil {
			name = captureDirName(startedAt, r.Title)
		}
		base := filepath.Join(filepath.Base(session), name)
		prefix := base
		for i := 1; usedPrefixes[strings.ToLower(prefix)]; i++ {
			prefix = fmt.Sprintf("%s_%d", base, i)
		}
		usedPrefixes[strings.ToLower(prefix)] = true
		dirs[p] = prefix
		sessions[session] = true
	}
	if includeFull {
		for s := range sessions {
			full := filepath.Join(s, "full")
			if _, e := os.Lstat(full); os.IsNotExist(e) && fullLogsDisabled(s) {
				continue
			}
			fullDirs = append(fullDirs, full)
		}
	}
	for _, dir := range fullDirs {
		s := filepath.Dir(dir)
		if state.Connected && (sameResolvedPath(state.SessionDir, s) || sameResolvedPath(s, state.SessionDir)) {
			return fmt.Errorf("导出完整日志前请先断开此会话的设备连接")
		}
		dirs[dir] = filepath.Join(filepath.Base(s), "full")
		sessions[s] = true
	}
	for dir := range dirs {
		rel, e := filepath.Rel(dir, dest)
		if e == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
			return fmt.Errorf("导出文件不能位于待打包目录中")
		}
	}
	f, err := os.CreateTemp(filepath.Dir(dest), ".twinlog-export-*.zip")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	zw := zip.NewWriter(f)
	add := func(path, name string) error {
		in, e := os.Open(path)
		if e != nil {
			return e
		}
		defer in.Close()
		st, e := in.Stat()
		if e != nil {
			return e
		}
		h, e := zip.FileInfoHeader(st)
		if e != nil {
			return e
		}
		h.Name = filepath.ToSlash(name)
		h.Method = zip.Deflate
		w, e := zw.CreateHeader(h)
		if e != nil {
			return e
		}
		_, e = io.Copy(w, in)
		return e
	}
	for dir, prefix := range dirs {
		err = filepath.WalkDir(dir, func(path string, d fs.DirEntry, e error) error {
			if e != nil {
				return e
			}
			if d.Type()&os.ModeSymlink != 0 {
				return fmt.Errorf("不打包符号链接: %s", path)
			}
			if d.IsDir() {
				return nil
			}
			if strings.HasPrefix(d.Name(), ".twinlog-") {
				return nil
			}
			rel, e := filepath.Rel(dir, path)
			if e != nil {
				return e
			}
			return add(path, filepath.Join(prefix, rel))
		})
		if err != nil {
			break
		}
	}
	if err == nil {
		for s := range sessions {
			for _, name := range []string{"session.json", "events.jsonl"} {
				if _, e := os.Stat(filepath.Join(s, name)); e == nil {
					if err = add(filepath.Join(s, name), filepath.Join(filepath.Base(s), name)); err != nil {
						break
					}
				}
			}
			if err != nil {
				break
			}
		}
	}
	if e := zw.Close(); err == nil {
		err = e
	}
	if e := f.Sync(); err == nil {
		err = e
	}
	if e := f.Close(); err == nil {
		err = e
	}
	if err != nil {
		return err
	}
	return os.Rename(tmp, dest)
}
func nowISO() string  { return time.Now().Format(time.RFC3339Nano) }
func timeDir() string { return formatDirTime(time.Now()) }
func formatDirTime(t time.Time) string {
	return t.Format("20060102_150405") + fmt.Sprintf("_%03d", t.Nanosecond()/1000000)
}
