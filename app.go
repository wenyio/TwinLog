package main

import (
	"context"
	"encoding/json"
	"fmt"
	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
	"twinlog/internal/capture"
)

type App struct {
	ctx           context.Context
	manager       *capture.Manager
	mu            sync.Mutex
	config        capture.Config
	settings      string
	closing       bool
	awaitingNotes bool
	closeRequest  uint64
	closeAllowed  bool
}

func NewApp() *App {
	root, _ := os.UserConfigDir()
	home, _ := os.UserHomeDir()
	settings := filepath.Join(root, "TwinLog", "settings.json")
	a := &App{settings: settings, config: loadConfig(settings, filepath.Join(home, "Documents", "TwinLog"))}
	a.manager = capture.NewManager(func(event string, p any) {
		if a.ctx != nil {
			wruntime.EventsEmit(a.ctx, event, p)
		}
	})
	return a
}

func loadConfig(settings, outputDir string) capture.Config {
	c := capture.Config{ADBPath: "adb", OutputDir: outputDir, BaudRate: 115200, DataBits: 8, StopBits: 1, Parity: "none", SaveFullLogs: true}
	if b, e := os.ReadFile(settings); e == nil {
		_ = json.Unmarshal(b, &c)
	}
	c.PreviewLines = capture.NormalizePreviewLines(c.PreviewLines)
	return c
}
func (a *App) startup(ctx context.Context) { a.ctx = ctx }
func (a *App) beforeClose(ctx context.Context) bool {
	a.mu.Lock()
	if a.closeAllowed {
		a.mu.Unlock()
		return false
	}
	if a.closing {
		a.mu.Unlock()
		return true
	}
	a.closing = true
	a.awaitingNotes = true
	a.closeRequest++
	request := a.closeRequest
	a.mu.Unlock()
	wruntime.EventsEmit(ctx, "before-close")
	go func() {
		time.Sleep(8 * time.Second)
		a.mu.Lock()
		waiting := a.closing && a.awaitingNotes && a.closeRequest == request
		if waiting {
			a.closing = false
			a.awaitingNotes = false
		}
		a.mu.Unlock()
		if waiting {
			wruntime.EventsEmit(ctx, "error", "标题或备注尚未保存，请稍后重试退出")
		}
	}()
	return true
}
func (a *App) ConfirmClose(ok bool) {
	a.mu.Lock()
	if !a.closing || !a.awaitingNotes {
		a.mu.Unlock()
		return
	}
	a.awaitingNotes = false
	if !ok {
		a.closing = false
		a.mu.Unlock()
		return
	}
	a.mu.Unlock()
	go func() {
		exited := finishClose(func() (bool, error) {
			if !a.manager.State().Connected {
				return true, nil
			}
			answer, e := wruntime.MessageDialog(a.ctx, exitDialogOptions())
			return answer == "Yes", e
		}, a.manager.Disconnect, func() {
			a.mu.Lock()
			a.closeAllowed = true
			a.mu.Unlock()
			wruntime.Quit(a.ctx)
		}, func(e error) { wruntime.EventsEmit(a.ctx, "error", e.Error()) })
		if !exited {
			a.mu.Lock()
			a.closing = false
			a.mu.Unlock()
		}
	}()
}
func (a *App) shutdown(ctx context.Context) { _ = a.manager.Disconnect() }
func (a *App) GetConfig() capture.Config    { a.mu.Lock(); defer a.mu.Unlock(); return a.config }
func (a *App) SaveConfig(c capture.Config) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	c.PreviewLines = capture.NormalizePreviewLines(c.PreviewLines)
	if e := os.MkdirAll(filepath.Dir(a.settings), 0755); e != nil {
		return e
	}
	b, e := json.MarshalIndent(c, "", "  ")
	if e != nil {
		return e
	}
	if e = capture.AtomicWrite(a.settings, b); e != nil {
		return e
	}
	a.config = c
	return nil
}
func (a *App) GetState() capture.State                          { return a.manager.State() }
func (a *App) ListPorts() ([]capture.PortInfo, error)           { return capture.ListPorts() }
func (a *App) ListDevices(adb string) ([]capture.Device, error) { return capture.ListDevices(adb) }
func (a *App) ListPackages(adb, serial string) ([]string, error) {
	return capture.ListPackages(adb, serial)
}
func (a *App) ForegroundPackage(adb, serial string) (string, error) {
	return capture.ForegroundPackage(adb, serial)
}
func (a *App) SelectDirectory() (string, error) {
	return wruntime.OpenDirectoryDialog(a.ctx, wruntime.OpenDialogOptions{Title: "选择日志保存目录"})
}
func (a *App) SelectADB() (string, error) {
	return wruntime.OpenFileDialog(a.ctx, wruntime.OpenDialogOptions{Title: "选择 adb", Filters: []wruntime.FileFilter{{DisplayName: "ADB", Pattern: "adb.exe;adb"}}})
}
func (a *App) Connect(c capture.Config) error {
	if e := a.SaveConfig(c); e != nil {
		return e
	}
	return a.manager.Connect(c)
}
func (a *App) Disconnect() error { return a.manager.Disconnect() }
func (a *App) SetPackage(pkg string) error {
	if e := a.manager.SetPackage(pkg); e != nil {
		return e
	}
	c := a.GetConfig()
	c.Package = pkg
	return a.SaveConfig(c)
}
func (a *App) StartCapture(title, notes string) (capture.Record, error) {
	return a.manager.StartCapture(title, notes)
}
func (a *App) StopCapture() (capture.Record, error) { return a.manager.StopCapture() }
func (a *App) SaveNotes(path, notes string) error   { return a.manager.SaveNotes(path, notes) }
func (a *App) SaveTitle(path, title string) error   { return a.manager.SaveTitle(path, title) }
func (a *App) SaveResult(path, result string) error { return a.manager.SaveResult(path, result) }
func (a *App) ListSessions(root string) ([]capture.Session, error) {
	return a.manager.ListSessions(root)
}
func (a *App) SaveSessionTitle(path, title string) error {
	return a.manager.SaveSessionTitle(a.GetConfig().OutputDir, path, title)
}
func (a *App) SetSessionArchived(path string, archived bool) error {
	return a.manager.SetSessionArchived(a.GetConfig().OutputDir, path, archived)
}
func (a *App) SetRecordArchived(path string, archived bool) error {
	return a.manager.SetRecordArchived(a.GetConfig().OutputDir, path, archived)
}
func (a *App) ReadRecordLogs(path string) (capture.RecordLogs, error) {
	return a.manager.ReadRecordLogs(path, a.GetConfig().PreviewLines)
}
func (a *App) ReadFullLogs(session string) (capture.RecordLogs, error) {
	c := a.GetConfig()
	return a.manager.ReadFullLogs(c.OutputDir, session, c.PreviewLines)
}
func (a *App) DeleteSessionLogs(path string, fullOnly bool) error {
	return a.manager.RemoveSessionLogs(a.GetConfig().OutputDir, path, fullOnly, func(s capture.Session) (bool, error) {
		title := "删除连接"
		message := fmt.Sprintf("确定删除连接 %s？\n本次连接的整个目录将移入回收站，包括 %d 条记录及备注、连接信息和目录内其他文件。", filepath.Base(s.Path), len(s.Records))
		if s.Full != nil {
			message += "\n完整日志也将一并删除。"
		}
		if fullOnly {
			title = "删除完整日志"
			message = fmt.Sprintf("确定删除连接 %s 的完整日志？\n仅将 full 目录移入回收站，保留连接、记录和备注。", filepath.Base(s.Path))
		}
		answer, err := wruntime.MessageDialog(a.ctx, wruntime.MessageDialogOptions{
			Type: wruntime.QuestionDialog, Title: title, Message: message,
			Buttons: []string{"Yes", "No"}, DefaultButton: "No", CancelButton: "No",
		})
		return answer == "Yes", err
	})
}
func (a *App) DeleteRecords(paths []string) error {
	root := a.GetConfig().OutputDir
	return confirmRecordDeletion(len(paths), func(opts wruntime.MessageDialogOptions) (string, error) {
		return wruntime.MessageDialog(a.ctx, opts)
	}, func() error {
		return a.manager.DeleteRecords(root, paths)
	})
}

func confirmRecordDeletion(count int, ask func(wruntime.MessageDialogOptions) (string, error), remove func() error) error {
	if count == 0 {
		return fmt.Errorf("请选择需要删除的记录")
	}
	answer, err := ask(wruntime.MessageDialogOptions{
		Type: wruntime.QuestionDialog, Title: "删除记录",
		Message: fmt.Sprintf("确定删除选中的 %d 条记录？\n记录日志和备注会一并删除，通常可从 Windows 回收站还原。完整日志和会话目录保留。", count),
		Buttons: []string{"Yes", "No"}, DefaultButton: "No", CancelButton: "No",
	})
	if err != nil || answer != "Yes" {
		return err
	}
	return remove()
}
func (a *App) ExportLogs(paths, fullSessions []string) (string, error) {
	name, e := capture.ExportFilename(paths, time.Now())
	if e != nil {
		return "", e
	}
	path, e := wruntime.SaveFileDialog(a.ctx, wruntime.SaveDialogOptions{Title: "导出日志", DefaultFilename: name, Filters: []wruntime.FileFilter{{DisplayName: "ZIP 压缩包", Pattern: "*.zip"}}})
	if e != nil || path == "" {
		return "", e
	}
	if !strings.EqualFold(filepath.Ext(path), ".zip") {
		path += ".zip"
	}
	if e = a.manager.ExportSelection(a.GetConfig().OutputDir, paths, fullSessions, path); e != nil {
		return "", e
	}
	return path, nil
}
func (a *App) OpenFolder(path string) error {
	st, e := os.Stat(path)
	if e != nil {
		return e
	}
	if !st.IsDir() {
		return fmt.Errorf("目录不存在")
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("explorer.exe", filepath.Clean(path))
	case "darwin":
		cmd = exec.Command("open", path)
	default:
		cmd = exec.Command("xdg-open", path)
	}
	if e = cmd.Start(); e != nil {
		return e
	}
	go cmd.Wait()
	return nil
}
