//go:build windows

package main

import (
	"bytes"
	"context"
	"fmt"
	"golang.org/x/sys/windows"
	"image"
	"image/png"
	"runtime"
	"time"
	"twinlog/internal/capture"
	"unsafe"
)

var clipUser = windows.NewLazySystemDLL("user32.dll")
var clipKernel = windows.NewLazySystemDLL("kernel32.dll")
var clipShell = windows.NewLazySystemDLL("shell32.dll")
var clipGDI = windows.NewLazySystemDLL("gdi32.dll")
var clipOpen = clipUser.NewProc("OpenClipboard")
var clipClose = clipUser.NewProc("CloseClipboard")
var clipAvailable = clipUser.NewProc("IsClipboardFormatAvailable")
var clipGet = clipUser.NewProc("GetClipboardData")
var clipRegister = clipUser.NewProc("RegisterClipboardFormatW")
var clipLock = clipKernel.NewProc("GlobalLock")
var clipUnlock = clipKernel.NewProc("GlobalUnlock")
var clipSize = clipKernel.NewProc("GlobalSize")
var clipCopyMemory = clipKernel.NewProc("RtlMoveMemory")
var clipQuery = clipShell.NewProc("DragQueryFileW")
var clipGetObject = clipGDI.NewProc("GetObjectW")
var clipCreateDC = clipGDI.NewProc("CreateCompatibleDC")
var clipDeleteDC = clipGDI.NewProc("DeleteDC")
var clipGetBits = clipGDI.NewProc("GetDIBits")

const clipboardPixelLimit = 40_000_000

func pngClipboardFormat() uintptr {
	p, _ := windows.UTF16PtrFromString("PNG")
	v, _, _ := clipRegister.Call(uintptr(unsafe.Pointer(p)))
	return v
}
func clipHas(format uintptr) bool {
	if format == 0 {
		return false
	}
	v, _, _ := clipAvailable.Call(format)
	return v != 0
}
func clipboardAttachmentKind() (string, error) {
	if clipHas(15) {
		return "files", nil
	}
	if clipHas(pngClipboardFormat()) || clipHas(8) || clipHas(17) || clipHas(2) {
		return "image", nil
	}
	return "", nil
}
func openClipboard(ctx context.Context) error {
	for i := 0; i < 10; i++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		ok, _, _ := clipOpen.Call(0)
		if ok != 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(20 * time.Millisecond):
		}
	}
	return fmt.Errorf("剪贴板正被其他程序占用，请重试")
}

// Snapshot on one OS thread and release the clipboard before copying or encoding.
func clipboardSnapshot(ctx context.Context) (paths []string, pngData []byte, bitmap *image.NRGBA, err error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err = openClipboard(ctx); err != nil {
		return
	}
	defer clipClose.Call()
	if clipHas(15) {
		h, _, _ := clipGet.Call(15)
		if h == 0 {
			err = fmt.Errorf("读取剪贴板文件失败")
			return
		}
		count, _, _ := clipQuery.Call(h, 0xffffffff, 0, 0)
		if count > 4096 {
			err = fmt.Errorf("一次最多粘贴 4096 个文件")
			return
		}
		for i := uintptr(0); i < count; i++ {
			n, _, _ := clipQuery.Call(h, i, 0, 0)
			if n == 0 || n > 32767 {
				err = fmt.Errorf("剪贴板文件路径无效")
				return
			}
			buf := make([]uint16, n+1)
			got, _, _ := clipQuery.Call(h, i, uintptr(unsafe.Pointer(&buf[0])), n+1)
			if got != n {
				err = fmt.Errorf("读取剪贴板文件路径失败")
				return
			}
			paths = append(paths, windows.UTF16ToString(buf))
		}
		return
	}
	format := pngClipboardFormat()
	if clipHas(format) {
		h, _, _ := clipGet.Call(format)
		n, _, _ := clipSize.Call(h)
		if h == 0 || n == 0 || n > 256*1024*1024 {
			err = fmt.Errorf("剪贴板图片为空或超过 256 MB")
			return
		}
		p, _, _ := clipLock.Call(h)
		if p == 0 {
			err = fmt.Errorf("读取剪贴板图片失败")
			return
		}
		pngData = make([]byte, int(n))
		clipCopyMemory.Call(uintptr(unsafe.Pointer(&pngData[0])), p, n)
		clipUnlock.Call(h)
		return
	}
	if !clipHas(2) && !clipHas(8) && !clipHas(17) {
		err = fmt.Errorf("剪贴板中没有可用图片或本地文件")
		return
	}
	// Windows synthesizes CF_BITMAP from DIB/DIBV5. GDI handles palettes,
	// bitfields, row padding and bottom-up images; output is a top-down DIB.
	h, _, _ := clipGet.Call(2)
	if h == 0 {
		err = fmt.Errorf("无法读取此剪贴板图片格式")
		return
	}
	var bm struct {
		Type, Width, Height, WidthBytes int32
		Planes, BitsPixel               uint16
		Bits                            uintptr
	}
	ok, _, _ := clipGetObject.Call(h, unsafe.Sizeof(bm), uintptr(unsafe.Pointer(&bm)))
	if ok == 0 || bm.Width <= 0 || bm.Height <= 0 || int64(bm.Width)*int64(bm.Height) > clipboardPixelLimit {
		err = fmt.Errorf("剪贴板图片尺寸无效或超过 4000 万像素")
		return
	}
	info := struct {
		Size                   uint32
		Width, Height          int32
		Planes, BitCount       uint16
		Compression, SizeImage uint32
		XPels, YPels           int32
		ClrUsed, ClrImportant  uint32
	}{Size: 40, Width: bm.Width, Height: -bm.Height, Planes: 1, BitCount: 32}
	pixels := make([]byte, int(bm.Width)*int(bm.Height)*4)
	dc, _, _ := clipCreateDC.Call(0)
	if dc == 0 {
		err = fmt.Errorf("无法创建图片转换上下文")
		return
	}
	defer clipDeleteDC.Call(dc)
	lines, _, _ := clipGetBits.Call(dc, h, 0, uintptr(bm.Height), uintptr(unsafe.Pointer(&pixels[0])), uintptr(unsafe.Pointer(&info)), 0)
	if lines != uintptr(bm.Height) {
		err = fmt.Errorf("剪贴板图片转换失败")
		return
	}
	// BI_RGB's fourth byte is reserved, not an alpha channel. CF_BITMAP is opaque.
	for i := 0; i < len(pixels); i += 4 {
		pixels[i], pixels[i+2] = pixels[i+2], pixels[i]
		pixels[i+3] = 255
	}
	bitmap = &image.NRGBA{Pix: pixels, Stride: int(bm.Width) * 4, Rect: image.Rect(0, 0, int(bm.Width), int(bm.Height))}
	return
}

type clipboardPNGReader struct {
	ctx context.Context
	*bytes.Reader
}

func (r clipboardPNGReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.Reader.Read(p)
}
func pasteAttachments(ctx context.Context, m *capture.Manager, root, path string) ([]capture.Attachment, error) {
	paths, data, bitmap, err := clipboardSnapshot(ctx)
	if err != nil {
		return nil, err
	}
	if len(paths) > 0 {
		return m.ImportAttachments(ctx, root, path, paths, func(p capture.AttachmentProgress) { m.EmitAttachmentProgress(p) })
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	if bitmap != nil {
		var buffer bytes.Buffer
		if err = png.Encode(contextPNGWriter{ctx: ctx, w: &buffer}, bitmap); err != nil {
			return nil, err
		}
		data = buffer.Bytes()
	} else {
		cfg, e := png.DecodeConfig(bytes.NewReader(data))
		if e != nil {
			return nil, fmt.Errorf("剪贴板 PNG 无效: %w", e)
		}
		if cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > clipboardPixelLimit {
			return nil, fmt.Errorf("剪贴板图片超过 4000 万像素")
		}
		if _, e = png.Decode(clipboardPNGReader{ctx, bytes.NewReader(data)}); e != nil {
			return nil, fmt.Errorf("剪贴板 PNG 不完整: %w", e)
		}
	}
	at := time.Now()
	name := fmt.Sprintf("截图_%s_%03d.png", at.Format("20060102_150405"), at.Nanosecond()/1000000)
	item, err := m.SaveAttachment(ctx, root, path, name, bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, err
	}
	return []capture.Attachment{item}, nil
}

func openAttachmentFile(path string) error {
	// Pass a filename to the registered system handler without a command shell.
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	verb, _ := windows.UTF16PtrFromString("open")
	v, _, _ := clipShell.NewProc("ShellExecuteW").Call(0, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(p)), 0, 0, 1)
	if v <= 32 {
		return fmt.Errorf("无法打开附件，系统可能没有关联应用（%d）", v)
	}
	return nil
}
