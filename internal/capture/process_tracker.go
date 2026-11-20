package capture

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Use NAME (argv[0]), not the short Linux comm name, which truncates long packages.
func parsePackagePIDs(text, pkg string) (map[string]bool, error) {
	out := map[string]bool{}
	pidColumn, nameColumn := -1, -1
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		if pidColumn < 0 {
			for i, v := range fields {
				if v == "PID" {
					pidColumn = i
				}
				if v == "NAME" {
					nameColumn = i
				}
			}
			continue
		}
		if nameColumn < 0 || len(fields) <= pidColumn || len(fields) <= nameColumn {
			continue
		}
		if _, e := strconv.Atoi(fields[pidColumn]); e != nil {
			continue
		}
		name := fields[nameColumn]
		if name == pkg || strings.HasPrefix(name, pkg+":") {
			out[fields[pidColumn]] = true
		}
	}
	if pidColumn < 0 || nameColumn < 0 {
		return nil, fmt.Errorf("设备进程列表格式不支持 PID,NAME，无法按应用过滤")
	}
	return out, nil
}
func packagePIDs(ctx context.Context, adb, serial, pkg string) (map[string]bool, error) {
	pids, _, e := packageSnapshot(ctx, adb, serial, pkg)
	return pids, e
}
func packageSnapshot(ctx context.Context, adb, serial, pkg string) (map[string]bool, string, error) {
	return (&processQuery{}).snapshot(ctx, adb, serial, pkg)
}

// Remember the working ps variant per device without holding a lock during ADB IO.
type processQuery struct {
	mu        sync.Mutex
	device    string
	preferred int
}

func (q *processQuery) snapshot(ctx context.Context, adb, serial, pkg string) (map[string]bool, string, error) {
	key := adb + "\x00" + serial
	q.mu.Lock()
	preferred := q.preferred
	if q.device != key {
		preferred = 0
	}
	q.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 9*time.Second)
	defer cancel()
	pids, system, used, err := queryProcessSnapshot(ctx, pkg, preferred, 2*time.Second, func(ctx context.Context, args []string) (string, error) {
		cmd := command(ctx, adb, append([]string{"-s", serial, "shell"}, args...)...)
		cmd.WaitDelay = 200 * time.Millisecond
		var stdout, stderr bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr
		e := cmd.Run()
		if e != nil {
			detail := strings.TrimSpace(stderr.String())
			if detail == "" {
				detail = "设备未返回错误详情"
			}
			return "", fmt.Errorf("%w (%s)", e, detail)
		}
		return stdout.String(), nil
	})
	if err == nil {
		q.mu.Lock()
		q.device, q.preferred = key, used
		q.mu.Unlock()
	}
	return pids, system, err
}
func queryPackageSnapshot(ctx context.Context, pkg string, run func([]string) (string, error)) (map[string]bool, string, error) {
	pids, system, _, err := queryProcessSnapshot(ctx, pkg, 0, 2*time.Second, func(_ context.Context, args []string) (string, error) { return run(args) })
	return pids, system, err
}

func queryProcessSnapshot(ctx context.Context, pkg string, preferred int, timeout time.Duration, run func(context.Context, []string) (string, error)) (map[string]bool, string, int, error) {
	var failures []error
	variants := [][]string{{"ps", "-A", "-o", "PID,NAME"}, {"ps", "-A"}}
	failed := func(err error) (map[string]bool, string, int, error) {
		return nil, "", 0, fmt.Errorf("读取应用进程失败：%w", errors.Join(append(failures, err)...))
	}
	for attempt := 0; attempt < 2; attempt++ {
		for offset := 0; offset < len(variants); offset++ {
			index := (preferred + offset) % len(variants)
			args := variants[index]
			if ctx.Err() != nil {
				return failed(ctx.Err())
			}
			commandCtx, cancel := context.WithTimeout(ctx, timeout)
			started := time.Now()
			text, e := run(commandCtx, args)
			if commandCtx.Err() != nil {
				e = errors.Join(commandCtx.Err(), e)
			}
			cancel()
			stage := "命令执行失败"
			var pids map[string]bool
			if e == nil {
				stage = "进程列表解析失败"
				pids, e = parsePackagePIDs(text, pkg)
			}
			if e != nil {
				if errors.Is(e, context.DeadlineExceeded) {
					stage = "查询超时"
				}
				failures = append(failures, fmt.Errorf("第 %d 轮 adb shell %s（%s，耗时 %s）：%w", attempt+1, strings.Join(args, " "), stage, time.Since(started).Round(time.Millisecond), e))
				continue
			}
			system, _ := parsePackagePIDs(text, "system_server")
			systemPID := ""
			for pid := range system {
				systemPID = pid
			}
			return pids, systemPID, index, nil
		}
		if attempt == 0 {
			select {
			case <-ctx.Done():
				return failed(ctx.Err())
			case <-time.After(150 * time.Millisecond):
			}
		}
	}
	return failed(nil)
}

func processQueryDelay(failures int) time.Duration {
	switch failures {
	case 0:
		return 3 * time.Second
	case 1:
		return 2 * time.Second
	case 2:
		return 4 * time.Second
	default:
		return 8 * time.Second
	}
}
func (m *Manager) trackProcesses(ctx context.Context) {
	for {
		m.mu.Lock()
		delay := processQueryDelay(m.trackerFailures)
		m.mu.Unlock()
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
			m.mu.Lock()
			pkg := m.config.Package
			adb := m.config.ADBPath
			serial := m.config.AndroidSerial
			needed := m.filter.pidOnly
			m.mu.Unlock()
			if !needed || pkg == "" {
				continue
			}
			pids, systemPID, e := m.processQuery.snapshot(ctx, adb, serial, pkg)
			if ctx.Err() != nil {
				return
			}
			m.applyProcessSnapshot(pkg, pids, systemPID, e)
		}
	}
}
func (m *Manager) applyProcessSnapshot(pkg string, pids map[string]bool, systemPID string, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.config.Package != pkg || !m.filter.pidOnly {
		return
	}
	if err != nil {
		m.setTrackerErrorLocked(err.Error())
		if m.record != nil {
			m.record.FilterGaps = true
		}
		m.filter.UpdatePIDs(map[string]bool{})
		m.filter.systemPID = ""
		return
	}
	if m.trackerError != "" {
		m.trackerRecoveredAt = nowISO()
		m.recordFilterEventLocked("recovered", fmt.Sprintf("连续失败 %d 次，不可用持续 %s", m.trackerFailures, time.Since(m.trackerSince).Round(time.Second)))
	}
	m.trackerError = ""
	m.trackerFailures = 0
	m.trackerSince = time.Time{}
	m.trackerLastSuccess = time.Now()
	m.filter.UpdatePIDs(pids)
	m.filter.systemPID = systemPID
}

func (m *Manager) resetTrackerLocked(warning string, shared bool) {
	m.trackerError = ""
	m.trackerSince, m.trackerLastSuccess = time.Time{}, time.Time{}
	m.trackerFailures = 0
	m.trackerRecoveredAt = ""
	if warning != "" {
		m.setTrackerErrorLocked(warning)
	} else if shared {
		m.trackerLastSuccess = time.Now()
	}
}

func (m *Manager) setTrackerErrorLocked(detail string) {
	status := "retry"
	if m.trackerError == "" {
		m.trackerSince = time.Now()
		status = "unavailable"
	}
	m.trackerError = detail
	m.trackerRecoveredAt = ""
	m.trackerFailures++
	m.recordFilterEventLocked(status, fmt.Sprintf("连续失败 %d 次，下次查询等待 %s；%s", m.trackerFailures, processQueryDelay(m.trackerFailures), detail))
}
func (m *Manager) recordFilterEventLocked(status, detail string) {
	if m.sessionDir == "" {
		return
	}
	event := map[string]string{"at": nowISO(), "event": "application_filter", "status": status, "package": m.config.Package, "detail": detail}
	if m.record != nil {
		event["capture"] = m.record.Path
	}
	b, e := json.Marshal(event)
	if e != nil {
		return
	}
	f, e := os.OpenFile(filepath.Join(m.sessionDir, "events.jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if e != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(append(b, '\n'))
}
