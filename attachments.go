package main

import (
	"context"
	"fmt"
	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
	"twinlog/internal/capture"
)

type attachmentTask struct {
	cancel context.CancelFunc
	done   chan struct{}
}

// Cover clipboard snapshot/encoding and native dialogs as well as disk copying.
func (a *App) lockIdleAttachments() error {
	a.attachmentTaskMu.Lock()
	if a.attachmentTask != nil {
		a.attachmentTaskMu.Unlock()
		return fmt.Errorf("附件正在导入，请完成或取消后重试")
	}
	return nil
}

func (a *App) beginAttachmentImport() (context.Context, func(), error) {
	a.attachmentTaskMu.Lock()
	defer a.attachmentTaskMu.Unlock()
	a.mu.Lock()
	closing := a.closing
	a.mu.Unlock()
	if closing {
		return nil, nil, fmt.Errorf("正在退出，请稍后重试")
	}
	if a.attachmentTask != nil {
		return nil, nil, fmt.Errorf("已有附件正在导入")
	}
	ctx, cancel := context.WithCancel(context.Background())
	task := &attachmentTask{cancel: cancel, done: make(chan struct{})}
	a.attachmentTask = task
	return ctx, func() {
		cancel()
		a.attachmentTaskMu.Lock()
		a.attachmentTask = nil
		close(task.done)
		a.attachmentTaskMu.Unlock()
	}, nil
}

func (a *App) CancelAttachmentImport() {
	a.attachmentTaskMu.Lock()
	defer a.attachmentTaskMu.Unlock()
	if a.attachmentTask != nil {
		a.attachmentTask.cancel()
	}
}

func (a *App) finishAttachmentImport() error {
	a.attachmentTaskMu.Lock()
	task := a.attachmentTask
	a.attachmentTaskMu.Unlock()
	if task == nil {
		return nil
	}
	answer, err := wruntime.MessageDialog(a.ctx, wruntime.MessageDialogOptions{Type: wruntime.QuestionDialog, Title: "附件正在导入", Message: "取消尚未完成的附件导入并继续退出？已完成的附件会保留。选择“否”可返回等待导入完成。", Buttons: []string{"Yes", "No"}, DefaultButton: "No", CancelButton: "No"})
	if err != nil {
		return err
	}
	if answer != "Yes" {
		return fmt.Errorf("请等待附件导入完成后再退出")
	}
	task.cancel()
	select {
	case <-task.done:
		return nil
	case <-time.After(5 * time.Second):
		return fmt.Errorf("正在取消附件导入，请稍后重试退出")
	}
}

func (a *App) ListAttachments(path string) ([]capture.Attachment, error) {
	return a.manager.ListAttachments(a.GetConfig().OutputDir, path)
}
func (a *App) ImportAttachmentFiles(path string) ([]capture.Attachment, error) {
	ctx, finish, err := a.beginAttachmentImport()
	if err != nil {
		return nil, err
	}
	defer finish()
	root := a.GetConfig().OutputDir
	if _, err = a.manager.ListAttachments(root, path); err != nil {
		return nil, err
	}
	paths, err := wruntime.OpenMultipleFilesDialog(a.ctx, wruntime.OpenDialogOptions{Title: "添加附件"})
	if err != nil {
		return nil, err
	}
	return a.manager.ImportAttachments(ctx, root, path, paths, func(p capture.AttachmentProgress) { wruntime.EventsEmit(a.ctx, "attachment-progress", p) })
}
func (a *App) PasteAttachments(path string) ([]capture.Attachment, error) {
	ctx, finish, err := a.beginAttachmentImport()
	if err != nil {
		return nil, err
	}
	defer finish()
	root := a.GetConfig().OutputDir
	if _, err = a.manager.ListAttachments(root, path); err != nil {
		return nil, err
	}
	return pasteAttachments(ctx, a.manager, root, path)
}
func (a *App) ClipboardAttachmentKind() (string, error) { return clipboardAttachmentKind() }
func (a *App) RenameAttachment(path, name, base string) error {
	if err := a.lockIdleAttachments(); err != nil {
		return err
	}
	defer a.attachmentTaskMu.Unlock()
	return a.manager.RenameAttachment(a.GetConfig().OutputDir, path, name, base)
}
func (a *App) RemoveAttachment(path, name string) error {
	if err := a.lockIdleAttachments(); err != nil {
		return err
	}
	defer a.attachmentTaskMu.Unlock()
	if _, err := a.manager.AttachmentPath(a.GetConfig().OutputDir, path, name); err != nil {
		return err
	}
	answer, err := wruntime.MessageDialog(a.ctx, wruntime.MessageDialogOptions{Type: wruntime.QuestionDialog, Title: "移除附件", Message: fmt.Sprintf("将附件 %s 移入回收站？原始来源文件不受影响。", name), Buttons: []string{"Yes", "No"}, DefaultButton: "No", CancelButton: "No"})
	if err != nil || answer != "Yes" {
		return err
	}
	return a.manager.RemoveAttachment(a.GetConfig().OutputDir, path, name)
}
func (a *App) OpenAttachment(path, name string, reveal bool) error {
	p, err := a.manager.AttachmentPath(a.GetConfig().OutputDir, path, name)
	if err != nil {
		return err
	}
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		if reveal {
			cmd = exec.Command("explorer.exe", "/select,", p)
		} else {
			return openAttachmentFile(p)
		}
	} else {
		if reveal {
			p = filepath.Dir(p)
		}
		program := "xdg-open"
		if runtime.GOOS == "darwin" {
			program = "open"
		}
		cmd = exec.Command(program, p)
	}
	if err = cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}
