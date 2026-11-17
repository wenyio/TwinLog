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
	"sync"
	"time"
	"twinlog/internal/capture"
)

type App struct {
	ctx          context.Context
	manager      *capture.Manager
	mu           sync.Mutex
	config       capture.Config
	settings     string
	closing      bool
	closeAllowed bool
}

func NewApp() *App {
	root, _ := os.UserConfigDir()
	home, _ := os.UserHomeDir()
	a := &App{settings: filepath.Join(root, "TwinLog", "settings.json"), config: capture.Config{ADBPath: "adb", OutputDir: filepath.Join(home, "Documents", "TwinLog"), BaudRate: 115200, DataBits: 8, StopBits: 1, Parity: "none"}}
	if b, e := os.ReadFile(a.settings); e == nil {
		_ = json.Unmarshal(b, &a.config)
	}
	a.manager = capture.NewManager(func(event string, p any) {
		if a.ctx != nil {
			wruntime.EventsEmit(a.ctx, event, p)
		}
	})
	return a
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
	a.mu.Unlock()
	wruntime.EventsEmit(ctx, "before-close")
	go func() {
		time.Sleep(8 * time.Second)
		a.mu.Lock()
		waiting := a.closing && !a.closeAllowed
		a.closing = false
		a.mu.Unlock()
		if waiting {
			wruntime.EventsEmit(ctx, "error", "退出尚未完成，请检查备注保存或退出确认")
		}
	}()
	return true
}
func (a *App) ConfirmClose(ok bool) {
	if !ok {
		a.mu.Lock()
		a.closing = false
		a.mu.Unlock()
		return
	}
	go func() {
		if a.manager.State().Connected {
			answer, e := wruntime.MessageDialog(a.ctx, wruntime.MessageDialogOptions{Type: wruntime.QuestionDialog, Title: "结束采集", Message: "退出会停止当前抓取并断开两路采集。确定退出？", Buttons: []string{"继续采集", "保存并退出"}, DefaultButton: "继续采集", CancelButton: "继续采集"})
			if e != nil || answer != "保存并退出" {
				a.mu.Lock()
				a.closing = false
				a.mu.Unlock()
				return
			}
		}
		if e := a.manager.Disconnect(); e != nil {
			wruntime.EventsEmit(a.ctx, "error", e.Error())
		}
		a.mu.Lock()
		a.closeAllowed = true
		a.mu.Unlock()
		wruntime.Quit(a.ctx)
	}()
}
func (a *App) shutdown(ctx context.Context) { _ = a.manager.Disconnect() }
func (a *App) GetConfig() capture.Config    { a.mu.Lock(); defer a.mu.Unlock(); return a.config }
func (a *App) SaveConfig(c capture.Config) error {
	a.mu.Lock()
	defer a.mu.Unlock()
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
func (a *App) StopCapture() (capture.Record, error)              { return a.manager.StopCapture() }
func (a *App) SaveNotes(path, notes string) error                { return a.manager.SaveNotes(path, notes) }
func (a *App) ListRecords(root string) ([]capture.Record, error) { return a.manager.ListRecords(root) }
func (a *App) ExportRecords(paths []string, includeFull bool) (string, error) {
	path, e := wruntime.SaveFileDialog(a.ctx, wruntime.SaveDialogOptions{Title: "导出抓取记录", DefaultFilename: "TwinLog_" + time.Now().Format("20060102_150405") + ".zip", Filters: []wruntime.FileFilter{{DisplayName: "ZIP 压缩包", Pattern: "*.zip"}}})
	if e != nil || path == "" {
		return "", e
	}
	if filepath.Ext(path) != ".zip" {
		path += ".zip"
	}
	if e = a.manager.Export(paths, path, includeFull); e != nil {
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
