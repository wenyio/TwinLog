package capture

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"go.bug.st/serial"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

type logFile struct {
	f *os.File
	w *bufio.Writer
}

func openLog(path string) (*logFile, error) {
	f, e := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
	if e != nil {
		return nil, e
	}
	return &logFile{f, bufio.NewWriterSize(f, 256*1024)}, nil
}
func (l *logFile) write(p []byte) error {
	if l == nil {
		return nil
	}
	_, e := l.w.Write(p)
	return e
}
func (l *logFile) flush() error {
	if l == nil {
		return nil
	}
	return l.w.Flush()
}
func (l *logFile) close() error {
	if l == nil {
		return nil
	}
	e := l.w.Flush()
	s := l.f.Sync()
	c := l.f.Close()
	return errors.Join(e, s, c)
}

type Manager struct {
	op                               sync.Mutex
	mu                               sync.Mutex
	emit                             func(string, any)
	connected                        bool
	config                           Config
	sessionDir                       string
	lastError                        string
	record                           *Record
	mcu, android, capMCU, capAndroid *logFile
	port                             serial.Port
	cmd                              *exec.Cmd
	cancel                           context.CancelFunc
	wg                               sync.WaitGroup
	stamp                            TimestampStream
	capFirst                         bool
	capPrefix                        string
	filter                           AndroidFilter
	previewMCU, previewAndroid       []byte
	mcuBytes, androidBytes           uint64
}

func NewManager(emit func(string, any)) *Manager { return &Manager{emit: emit} }
func (m *Manager) stateLocked() State {
	s := State{Connected: m.connected, Capturing: m.record != nil, SessionDir: m.sessionDir, Config: m.config, Error: m.lastError, McuBytes: m.mcuBytes, AndroidBytes: m.androidBytes}
	if m.record != nil {
		r := *m.record
		s.ActiveRecord = &r
	}
	return s
}
func (m *Manager) State() State { m.mu.Lock(); defer m.mu.Unlock(); return m.stateLocked() }
func (m *Manager) notify() {
	if m.emit != nil {
		m.emit("state", m.State())
	}
}
func (m *Manager) fail(err error) {
	if err == nil {
		return
	}
	m.mu.Lock()
	if !m.connected {
		m.mu.Unlock()
		return
	}
	m.lastError = err.Error()
	m.mu.Unlock()
	if m.emit != nil {
		m.emit("error", err.Error())
	}
	go m.disconnect(true)
}
func (m *Manager) Connect(c Config) error {
	m.op.Lock()
	defer m.op.Unlock()
	m.mu.Lock()
	busy := m.connected
	m.mu.Unlock()
	if busy {
		return fmt.Errorf("已经连接，请先断开")
	}
	if c.SerialPort == "" || c.AndroidSerial == "" || c.OutputDir == "" {
		return fmt.Errorf("请选择串口、Android 设备和保存目录")
	}
	if c.BaudRate <= 0 {
		return fmt.Errorf("波特率必须大于零")
	}
	if c.DataBits == 0 {
		c.DataBits = 8
	}
	if c.DataBits < 5 || c.DataBits > 8 {
		return fmt.Errorf("数据位必须在 5 到 8 之间")
	}
	if c.StopBits != 1 && c.StopBits != 2 {
		return fmt.Errorf("停止位仅支持 1 或 2")
	}
	parity := serial.NoParity
	switch c.Parity {
	case "", "none":
	case "odd":
		parity = serial.OddParity
	case "even":
		parity = serial.EvenParity
	default:
		return fmt.Errorf("不支持的校验位")
	}
	uid, e := resolveUID(c.ADBPath, c.AndroidSerial, c.Package)
	if e != nil {
		return e
	}
	status, e := adbOutput(c.ADBPath, "-s", c.AndroidSerial, "get-state")
	if e != nil {
		return e
	}
	if strings.TrimSpace(status) != "device" {
		return fmt.Errorf("Android 未就绪：%s", status)
	}
	help, e := adbOutput(c.ADBPath, "-s", c.AndroidSerial, "logcat", "--help")
	if e != nil {
		return e
	}
	if !strings.Contains(help, "uid") {
		return fmt.Errorf("设备 logcat 不支持 UID 格式，无法可靠过滤应用")
	}
	stops := serial.OneStopBit
	if c.StopBits == 2 {
		stops = serial.TwoStopBits
	}
	port, e := serial.Open(c.SerialPort, &serial.Mode{BaudRate: c.BaudRate, DataBits: c.DataBits, Parity: parity, StopBits: stops, InitialStatusBits: &serial.ModemOutputBits{DTR: c.DTR, RTS: c.RTS}})
	if e != nil {
		return fmt.Errorf("打开串口失败：%w", e)
	}
	if e = port.SetReadTimeout(250 * time.Millisecond); e != nil {
		port.Close()
		return e
	}
	if e = os.MkdirAll(c.OutputDir, 0755); e != nil {
		port.Close()
		return e
	}
	dir, e := uniqueDir(c.OutputDir, timeDir())
	if e != nil {
		port.Close()
		return e
	}
	if e = os.Mkdir(filepath.Join(dir, "full"), 0755); e != nil {
		port.Close()
		return e
	}
	mf, e := openLog(filepath.Join(dir, "full", "mcu.log"))
	if e != nil {
		port.Close()
		return e
	}
	af, e := openLog(filepath.Join(dir, "full", "android.log"))
	if e != nil {
		mf.close()
		port.Close()
		return e
	}
	ctx, cancel := context.WithCancel(context.Background())
	cmd := command(ctx, c.ADBPath, "-s", c.AndroidSerial, "logcat", "-b", "all", "-v", "threadtime", "-v", "uid", "*:V")
	cmd.WaitDelay = 2 * time.Second
	stdout, e := cmd.StdoutPipe()
	if e != nil {
		cancel()
		mf.close()
		af.close()
		port.Close()
		return e
	}
	stderr, e := cmd.StderrPipe()
	if e != nil {
		cancel()
		mf.close()
		af.close()
		port.Close()
		return e
	}
	if e = cmd.Start(); e != nil {
		cancel()
		mf.close()
		af.close()
		port.Close()
		return e
	}
	meta := map[string]any{"config": c, "startedAt": nowISO(), "timezone": time.Now().Format("MST -07:00"), "androidCommand": cmd.Args, "mcuTimestamp": "host receive time, line first byte"}
	if e = writeJSON(filepath.Join(dir, "session.json"), meta); e != nil {
		cancel()
		cmd.Wait()
		mf.close()
		af.close()
		port.Close()
		return e
	}
	m.mu.Lock()
	m.connected = true
	m.config = c
	m.sessionDir = dir
	m.lastError = ""
	m.port = port
	m.cmd = cmd
	m.cancel = cancel
	m.mcu = mf
	m.android = af
	m.stamp = TimestampStream{}
	m.filter.SetUID(uid)
	m.previewMCU = nil
	m.previewAndroid = nil
	m.mcuBytes = 0
	m.androidBytes = 0
	m.mu.Unlock()
	m.wg.Add(4)
	go func() { defer m.wg.Done(); m.readStream(ctx, "mcu", port) }()
	go func() {
		defer m.wg.Done()
		m.readStream(ctx, "android", stdout)
		if ctx.Err() == nil {
			m.fail(fmt.Errorf("Android 日志流已结束，请检查 USB 连接"))
		}
	}()
	go func() {
		defer m.wg.Done()
		buf := make([]byte, 4096)
		for {
			n, err := stderr.Read(buf)
			if n > 0 && ctx.Err() == nil {
				m.mu.Lock()
				m.lastError = "ADB: " + strings.TrimSpace(string(buf[:n]))
				m.mu.Unlock()
				m.notify()
			}
			if err != nil {
				return
			}
		}
	}()
	go func() { defer m.wg.Done(); m.pulse(ctx) }()
	m.notify()
	return nil
}
func (m *Manager) readStream(ctx context.Context, source string, r io.Reader) {
	buf := make([]byte, 64*1024)
	for {
		n, e := r.Read(buf)
		at := time.Now()
		if n > 0 {
			m.mu.Lock()
			if m.connected {
				e2 := m.ingestLocked(source, buf[:n], at)
				m.mu.Unlock()
				if e2 != nil {
					m.fail(fmt.Errorf("日志写入失败：%w", e2))
					return
				}
			} else {
				m.mu.Unlock()
			}
		}
		if ctx.Err() != nil {
			return
		}
		if e != nil {
			if !errors.Is(e, io.EOF) {
				m.fail(fmt.Errorf("%s 读取失败：%w", source, e))
			} else if source == "mcu" {
				m.fail(fmt.Errorf("串口连接已结束"))
			}
			return
		}
	}
}
func appendPreview(dst, data []byte) []byte {
	const max = 128 * 1024
	if len(data) >= max {
		return append(dst[:0], data[len(data)-max:]...)
	}
	if len(dst)+len(data) > max {
		drop := len(dst) + len(data) - max
		copy(dst, dst[drop:])
		dst = dst[:len(dst)-drop]
	}
	return append(dst, data...)
}
func (m *Manager) ingestLocked(source string, data []byte, at time.Time) error {
	if source == "mcu" {
		m.mcuBytes += uint64(len(data))
		p := m.stamp.Transform(data, at)
		if e := m.mcu.write(p); e != nil {
			return e
		}
		cp := p
		if m.capMCU != nil && m.capFirst && len(data) > 0 {
			m.capFirst = false
			if m.capPrefix != "" {
				cp = append([]byte(m.capPrefix), p...)
			} else if len(p) > 0 && p[0] == '\n' {
				cp = append([]byte(at.Format("[2006-01-02 15:04:05.000] ")), p...)
			}
		}
		if e := m.capMCU.write(cp); e != nil {
			return e
		}
		m.previewMCU = appendPreview(m.previewMCU, p)
		return nil
	}
	m.androidBytes += uint64(len(data))
	if e := m.android.write(data); e != nil {
		return e
	}
	p := m.filter.Feed(data)
	if e := m.capAndroid.write(p); e != nil {
		return e
	}
	m.previewAndroid = appendPreview(m.previewAndroid, p)
	return nil
}
func validPreview(p []byte) (string, []byte) {
	n := len(p)
	if n > 0 {
		start := n - 1
		for start > 0 && !utf8.RuneStart(p[start]) && n-start < utf8.UTFMax {
			start--
		}
		if !utf8.FullRune(p[start:]) {
			n = start
		}
	}
	return strings.ToValidUTF8(string(p[:n]), "�"), append([]byte(nil), p[n:]...)
}
func (m *Manager) pulse(ctx context.Context) {
	t := time.NewTicker(120 * time.Millisecond)
	defer t.Stop()
	last := time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			m.mu.Lock()
			a, tailA := validPreview(m.previewMCU)
			b, tailB := validPreview(m.previewAndroid)
			m.previewMCU = tailA
			m.previewAndroid = tailB
			var e error
			if time.Since(last) >= time.Second {
				e = errors.Join(m.mcu.flush(), m.android.flush(), m.capMCU.flush(), m.capAndroid.flush())
				last = time.Now()
			}
			m.mu.Unlock()
			if m.emit != nil {
				if a != "" {
					m.emit("logs", LogBatch{"mcu", a})
				}
				if b != "" {
					m.emit("logs", LogBatch{"android", b})
				}
			}
			m.notify()
			if e != nil {
				m.fail(e)
				return
			}
		}
	}
}
func (m *Manager) Disconnect() error { return m.disconnect(false) }
func (m *Manager) disconnect(interrupted bool) error {
	m.op.Lock()
	defer m.op.Unlock()
	m.mu.Lock()
	if !m.connected {
		m.mu.Unlock()
		return nil
	}
	cancel := m.cancel
	port := m.port
	cmd := m.cmd
	cancel()
	m.mu.Unlock()
	port.Close()
	m.wg.Wait()
	cmdErr := cmd.Wait()
	_ = cmdErr
	m.mu.Lock()
	defer m.mu.Unlock()
	var e error
	if m.record != nil {
		e = m.finishLocked(interrupted)
	}
	e = errors.Join(e, m.mcu.close(), m.android.close())
	m.mcu = nil
	m.android = nil
	m.connected = false
	m.port = nil
	m.cmd = nil
	metaPath := filepath.Join(m.sessionDir, "session.json")
	if b, readErr := os.ReadFile(metaPath); readErr == nil {
		var meta map[string]any
		if jsonErr := json.Unmarshal(b, &meta); jsonErr == nil {
			meta["endedAt"] = nowISO()
			meta["interrupted"] = interrupted
			meta["error"] = m.lastError
			e = errors.Join(e, writeJSON(metaPath, meta))
		}
	}
	if e != nil {
		m.lastError = e.Error()
	}
	go m.notify()
	return e
}
func (m *Manager) SetPackage(pkg string) error {
	m.op.Lock()
	defer m.op.Unlock()
	m.mu.Lock()
	if m.record != nil {
		m.mu.Unlock()
		return fmt.Errorf("抓取中不能切换应用")
	}
	c := m.config
	connected := m.connected
	m.mu.Unlock()
	uid := ""
	var e error
	if connected {
		uid, e = resolveUID(c.ADBPath, c.AndroidSerial, pkg)
		if e != nil {
			return e
		}
	}
	m.mu.Lock()
	m.config.Package = pkg
	m.filter.SetUID(uid)
	m.previewAndroid = nil
	m.mu.Unlock()
	m.notify()
	return nil
}
func (m *Manager) StartCapture(title, notes string) (Record, error) {
	m.op.Lock()
	defer m.op.Unlock()
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.connected {
		return Record{}, fmt.Errorf("请先连接设备")
	}
	if m.record != nil {
		return Record{}, fmt.Errorf("已有抓取正在进行")
	}
	title = strings.TrimSpace(title)
	if title == "" {
		return Record{}, fmt.Errorf("请输入标题")
	}
	dir, e := uniqueDir(m.sessionDir, timeDir()+"_"+safeName(title))
	if e != nil {
		return Record{}, e
	}
	a, e := openLog(filepath.Join(dir, "mcu.log"))
	if e != nil {
		return Record{}, e
	}
	b, e := openLog(filepath.Join(dir, "android.log"))
	if e != nil {
		a.close()
		return Record{}, e
	}
	r := Record{Path: dir, Title: title, Notes: notes, StartedAt: nowISO(), Package: m.config.Package}
	if e = AtomicWrite(filepath.Join(dir, "notes.txt"), []byte(notes)); e == nil {
		e = writeJSON(filepath.Join(dir, "record.json"), r)
	}
	if e != nil {
		a.close()
		b.close()
		return Record{}, e
	}
	m.capFirst = true
	m.capPrefix = m.stamp.Prefix()
	m.capMCU = a
	m.capAndroid = b
	m.record = &r
	go m.notify()
	return r, nil
}
func (m *Manager) finishLocked(interrupted bool) error {
	if m.record == nil {
		return nil
	}
	m.record.EndedAt = nowISO()
	m.record.Interrupted = interrupted
	e := errors.Join(m.capMCU.close(), m.capAndroid.close())
	m.capMCU = nil
	m.capAndroid = nil
	if e != nil {
		m.record.Interrupted = true
	}
	e = errors.Join(e, writeJSON(filepath.Join(m.record.Path, "record.json"), m.record))
	m.record = nil
	return e
}
func (m *Manager) StopCapture() (Record, error) {
	m.op.Lock()
	defer m.op.Unlock()
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.record == nil {
		return Record{}, fmt.Errorf("当前没有正在抓取的记录")
	}
	r := *m.record
	e := m.finishLocked(false)
	if stored, readErr := loadRecord(r.Path); readErr == nil {
		r = stored
	} else {
		r.EndedAt = nowISO()
		r.Interrupted = true
		e = errors.Join(e, readErr)
	}
	go m.notify()
	return r, e
}
