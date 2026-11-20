package main

import (
	"context"
	"errors"
	"testing"
)

func TestAttachmentTaskCancellationAndClose(t *testing.T) {
	a := &App{}
	ctx, finish, err := a.beginAttachmentImport()
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = a.beginAttachmentImport(); err == nil {
		t.Fatal("parallel import accepted")
	}
	if err = a.lockIdleAttachments(); err == nil {
		a.attachmentTaskMu.Unlock()
		t.Fatal("export/delete accepted during encoding")
	}
	a.CancelAttachmentImport()
	if !errors.Is(ctx.Err(), context.Canceled) {
		t.Fatal("import not canceled")
	}
	finish()
	if err = a.lockIdleAttachments(); err != nil {
		t.Fatal(err)
	}
	a.attachmentTaskMu.Unlock()
	a.closing = true
	if _, _, err = a.beginAttachmentImport(); err == nil {
		t.Fatal("import accepted during close confirmation")
	}
}
