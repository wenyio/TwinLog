//go:build !windows

package main

import (
	"context"
	"fmt"
	"twinlog/internal/capture"
)

func clipboardAttachmentKind() (string, error) { return "", nil }
func pasteAttachments(context.Context, *capture.Manager, string, string) ([]capture.Attachment, error) {
	return nil, fmt.Errorf("附件粘贴目前仅支持 Windows")
}
func openAttachmentFile(string) error { return fmt.Errorf("此平台不支持此打开方式") }
