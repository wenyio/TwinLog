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
	ctx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	return queryPackageSnapshot(ctx, pkg, func(args []string) (string, error) {
		cmd := command(ctx, adb, append([]string{"-s", serial, "shell"}, args...)...)
		var stdout, stderr bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr
		e := cmd.Run()
		if e != nil {
			detail := strings.TrimSpace(stderr.String())
			if detail == "" {
				detail = "设备未返回错误详情"
			}
			return "", fmt.Errorf("adb shell %s: %w (%s)", strings.Join(args, " "), e, detail)
		}
		return stdout.String(), nil
	})
}
func queryPackageSnapshot(ctx context.Context, pkg string, run func([]string) (string, error)) (map[string]bool, string, error) {
	var failures []error
	for attempt := 0; attempt < 2; attempt++ {
		for _, args := range [][]string{{"ps", "-A", "-o", "PID,NAME"}, {"ps", "-A"}} {
			if ctx.Err() != nil {
				return nil, "", ctx.Err()
			}
			text, e := run(args)
			if e != nil {
				failures = append(failures, e)
				continue
			}
			pids, e := parsePackagePIDs(text, pkg)
			if e != nil {
				failures = append(failures, e)
				continue
			}
			system, _ := parsePackagePIDs(text, "system_server")
			systemPID := ""
			for pid := range system {
				systemPID = pid
			}
			return pids, systemPID, nil
		}
		if attempt == 0 {
			select {
			case <-ctx.Done():
				return nil, "", ctx.Err()
			case <-time.After(150 * time.Millisecond):
			}
		}
	}
	return nil, "", fmt.Errorf("读取应用进程失败（已尝试备用查询及重试）：%w", errors.Join(failures...))
}
func (m *Manager) trackProcesses(ctx context.Context) {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.mu.Lock()
			pkg := m.config.Package
			adb := m.config.ADBPath
			serial := m.config.AndroidSerial
			needed := m.filter.pidOnly
			m.mu.Unlock()
			if !needed || pkg == "" {
				continue
			}
			pids, systemPID, e := packageSnapshot(ctx, adb, serial, pkg)
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
		if m.trackerError == "" {
			m.recordFilterEventLocked("unavailable", err.Error())
		}
		m.trackerError = err.Error()
		if m.record != nil {
			m.record.FilterGaps = true
		}
		m.filter.UpdatePIDs(map[string]bool{})
		m.filter.systemPID = ""
		return
	}
	if m.trackerError != "" {
		m.recordFilterEventLocked("recovered", "")
	}
	m.trackerError = ""
	m.filter.UpdatePIDs(pids)
	m.filter.systemPID = systemPID
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
