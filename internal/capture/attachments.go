package capture

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"
)

type Attachment struct {
	Name  string `json:"name"`
	Bytes int64  `json:"bytes"`
}

type AttachmentProgress struct {
	Path   string `json:"path"`
	Name   string `json:"name"`
	Copied int64  `json:"copied"`
	Total  int64  `json:"total"`
}

func (m *Manager) EmitAttachmentProgress(p AttachmentProgress) {
	if m.emit != nil {
		m.emit("attachment-progress", p)
	}
}

// Never hold the collector lock while copying files. Destructive operations and
// exports take this separate lock, while StopCapture remains available.
func (m *Manager) lockAttachments() error {
	if !m.attachmentMu.TryLock() {
		return fmt.Errorf("附件操作进行中，请完成或取消后重试")
	}
	return nil
}

func attachmentRecord(root, path string) (string, error) {
	if root == "" || path == "" {
		return "", fmt.Errorf("开始抓取后可添加附件")
	}
	r, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	p, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(r, p)
	parts := strings.Split(rel, string(os.PathSeparator))
	if err != nil || len(parts) != 2 || parts[0] == ".." || strings.EqualFold(parts[0], "full") || strings.EqualFold(parts[0], ".twinlog-trash") || strings.EqualFold(parts[1], "full") {
		return "", fmt.Errorf("记录不在当前保存目录内")
	}
	r, err = filepath.EvalSymlinks(r)
	if err != nil {
		return "", err
	}
	p = filepath.Join(r, rel)
	if err = directDir(filepath.Dir(p)); err != nil {
		return "", err
	}
	if err = directDir(p); err != nil {
		return "", err
	}
	st, err := os.Lstat(filepath.Join(p, "record.json"))
	if err != nil || !st.Mode().IsRegular() {
		return "", fmt.Errorf("记录信息无效")
	}
	if _, err = loadRecord(p); err != nil {
		return "", err
	}
	return p, nil
}

func attachmentDir(root, path string, create bool) (string, error) {
	p, err := attachmentRecord(root, path)
	if err != nil {
		return "", err
	}
	dir := filepath.Join(p, "attachments")
	if create {
		if err = os.Mkdir(dir, 0755); err != nil && !os.IsExist(err) {
			return "", err
		}
	}
	if err = directDir(dir); err != nil {
		return "", err
	}
	return dir, nil
}

func validAttachmentName(name string) error {
	if name == "" || name != strings.TrimSpace(name) || strings.HasSuffix(name, ".") || name == "." || name == ".." || len(utf16.Encode([]rune(name))) > 255 || strings.HasPrefix(strings.ToLower(name), ".twinlog-") {
		return fmt.Errorf("文件名不能为空、不能以空格或句点结尾，且最多 255 个 UTF-16 字符")
	}
	for _, r := range name {
		if unicode.IsControl(r) || strings.ContainsRune("<>:"+string(rune(34))+"/"+string(rune(92))+"|?*", r) {
			return fmt.Errorf("文件名含 Windows 不允许的字符")
		}
	}
	base := strings.ToUpper(strings.SplitN(name, ".", 2)[0])
	base = strings.TrimRight(base, " ")
	if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" || base == "CLOCK$" || (len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && base[3] >= '0' && base[3] <= '9') || base == "COM¹" || base == "COM²" || base == "COM³" || base == "LPT¹" || base == "LPT²" || base == "LPT³" {
		return fmt.Errorf("不能使用 Windows 保留文件名")
	}
	return nil
}

func attachmentFile(dir, name string) (string, error) {
	if err := validAttachmentName(name); err != nil {
		return "", err
	}
	p := filepath.Join(dir, name)
	st, err := os.Lstat(p)
	if err != nil {
		return "", err
	}
	if !st.Mode().IsRegular() {
		return "", fmt.Errorf("附件不是普通文件")
	}
	resolved, err := filepath.EvalSymlinks(p)
	if err != nil {
		return "", err
	}
	if !samePath(resolved, p) {
		return "", fmt.Errorf("附件不能是链接")
	}
	return p, nil
}

func (m *Manager) ListAttachments(root, path string) ([]Attachment, error) {
	out := []Attachment{}
	dir, err := attachmentDir(root, path, false)
	if os.IsNotExist(err) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if validAttachmentName(entry.Name()) != nil {
			continue
		}
		if _, err := attachmentFile(dir, entry.Name()); err != nil {
			continue
		}
		st, err := entry.Info()
		if err != nil {
			return nil, err
		}
		out = append(out, Attachment{entry.Name(), st.Size()})
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return out, nil
}

func availableAttachmentName(dir, name string) (string, error) {
	if err := validAttachmentName(name); err != nil {
		return "", err
	}
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	for i := 0; i < 10000; i++ {
		candidate := name
		if i > 0 {
			suffix := fmt.Sprintf("_%d%s", i, ext)
			stem := []rune(base)
			for len(stem) > 0 && len(utf16.Encode(append(append([]rune{}, stem...), []rune(suffix)...))) > 255 {
				stem = stem[:len(stem)-1]
			}
			candidate = string(stem) + suffix
		}
		if err := validAttachmentName(candidate); err != nil {
			return "", err
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return "", err
		}
		exists := false
		for _, e := range entries {
			if strings.EqualFold(e.Name(), candidate) {
				exists = true
				break
			}
		}
		if !exists {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("无法生成唯一附件名")
}

func (m *Manager) ImportAttachments(ctx context.Context, root, path string, sources []string, progress func(AttachmentProgress)) ([]Attachment, error) {
	if err := m.lockAttachments(); err != nil {
		return nil, err
	}
	defer m.attachmentMu.Unlock()
	dir, err := attachmentDir(root, path, true)
	if err != nil {
		return nil, err
	}
	imported := []Attachment{}
	for _, source := range sources {
		if err = ctx.Err(); err != nil {
			return imported, err
		}
		st, e := os.Lstat(source)
		if e != nil {
			return imported, e
		}
		if !st.Mode().IsRegular() {
			return imported, fmt.Errorf("仅支持普通文件，不支持文件夹或链接: %s", filepath.Base(source))
		}
		f, e := os.Open(source)
		if e != nil {
			return imported, e
		}
		opened, e := f.Stat()
		if e != nil || !os.SameFile(st, opened) {
			f.Close()
			return imported, fmt.Errorf("来源文件已变化")
		}
		item, e := saveAttachment(ctx, dir, filepath.Base(source), f, st.Size(), func(n int64) {
			if progress != nil {
				progress(AttachmentProgress{path, filepath.Base(source), n, st.Size()})
			}
		})
		f.Close()
		if e != nil {
			return imported, e
		}
		imported = append(imported, item)
	}
	return imported, nil
}

func (m *Manager) SaveAttachment(ctx context.Context, root, path, name string, reader io.Reader, total int64) (Attachment, error) {
	if err := m.lockAttachments(); err != nil {
		return Attachment{}, err
	}
	defer m.attachmentMu.Unlock()
	dir, err := attachmentDir(root, path, true)
	if err != nil {
		return Attachment{}, err
	}
	return saveAttachment(ctx, dir, name, reader, total, func(n int64) { m.EmitAttachmentProgress(AttachmentProgress{path, name, n, total}) })
}

func saveAttachment(ctx context.Context, dir, name string, reader io.Reader, total int64, progress func(int64)) (Attachment, error) {
	name, err := availableAttachmentName(dir, name)
	if err != nil {
		return Attachment{}, err
	}
	f, err := os.CreateTemp(dir, ".twinlog-attachment-*")
	if err != nil {
		return Attachment{}, err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	var copied int64
	buf := make([]byte, 256*1024)
	last := time.Time{}
	for {
		if err = ctx.Err(); err != nil {
			break
		}
		var n int
		n, err = reader.Read(buf)
		if n > 0 {
			var written int
			written, errWrite := f.Write(buf[:n])
			copied += int64(written)
			if errWrite != nil {
				err = errWrite
				break
			}
			if progress != nil && time.Since(last) >= 100*time.Millisecond {
				progress(copied)
				last = time.Now()
			}
		}
		if err == io.EOF {
			err = nil
			break
		}
		if err != nil {
			break
		}
	}
	if err == nil {
		err = ctx.Err()
	}
	if err == nil && total >= 0 && copied != total {
		err = fmt.Errorf("来源文件大小已变化，请重新添加")
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return Attachment{}, err
	}
	if err = moveAttachment(tmp, filepath.Join(dir, name)); err != nil {
		return Attachment{}, fmt.Errorf("保存附件失败: %w", err)
	}
	if progress != nil {
		progress(copied)
	}
	return Attachment{name, copied}, nil
}

func (m *Manager) RenameAttachment(root, path, name, base string) error {
	if err := m.lockAttachments(); err != nil {
		return err
	}
	defer m.attachmentMu.Unlock()
	dir, err := attachmentDir(root, path, false)
	if err != nil {
		return err
	}
	source, err := attachmentFile(dir, name)
	if err != nil {
		return err
	}
	ext := filepath.Ext(name)
	if strings.TrimSpace(base) == "" {
		return fmt.Errorf("文件名不能为空")
	}
	next := base + ext
	if err = validAttachmentName(next); err != nil {
		return err
	}
	if next == name {
		return nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.Name() != name && strings.EqualFold(e.Name(), next) {
			return fmt.Errorf("已存在同名附件，请使用其他名称")
		}
	}
	return moveAttachment(source, filepath.Join(dir, next))
}

func (m *Manager) AttachmentPath(root, path, name string) (string, error) {
	dir, err := attachmentDir(root, path, false)
	if err != nil {
		return "", err
	}
	return attachmentFile(dir, name)
}

func (m *Manager) RemoveAttachment(root, path, name string) error {
	if err := m.lockAttachments(); err != nil {
		return err
	}
	defer m.attachmentMu.Unlock()
	p, err := m.AttachmentPath(root, path, name)
	if err != nil {
		return err
	}
	return deleteWithShell([]string{p})
}
