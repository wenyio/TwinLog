package capture

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestProcessQueryTimeoutLeavesFallbackBudget(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	calls := 0
	pids, _, preferred, err := queryProcessSnapshot(ctx, "com.example.app", 0, 20*time.Millisecond, func(cmdCtx context.Context, args []string) (string, error) {
		calls++
		if calls == 1 {
			<-cmdCtx.Done()
			return "", cmdCtx.Err()
		}
		if cmdCtx.Err() != nil || len(args) != 2 {
			t.Fatalf("fallback did not get fresh budget: %v %v", args, cmdCtx.Err())
		}
		return "PID NAME\n42 com.example.app\n", nil
	})
	if err != nil || !pids["42"] || preferred != 1 || calls != 2 {
		t.Fatalf("fallback: %v %d %d %v", pids, preferred, calls, err)
	}
	calls = 0
	_, _, _, err = queryProcessSnapshot(ctx, "com.example.app", preferred, time.Second, func(_ context.Context, args []string) (string, error) {
		calls++
		if len(args) != 2 {
			t.Fatalf("successful variant was not preferred: %v", args)
		}
		return "PID NAME\n42 com.example.app\n", nil
	})
	if err != nil || calls != 1 {
		t.Fatalf("preferred query: %d %v", calls, err)
	}
}

func TestProcessQueryDiagnosticsAndCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	calls := 0
	_, _, _, err := queryProcessSnapshot(ctx, "com.example.app", 0, 10*time.Millisecond, func(cmdCtx context.Context, _ []string) (string, error) {
		calls++
		if calls == 1 {
			<-cmdCtx.Done()
			return "", cmdCtx.Err()
		}
		cancel()
		return "", errors.New("device offline")
	})
	if !errors.Is(err, context.Canceled) || !errors.Is(err, context.DeadlineExceeded) || calls != 2 {
		t.Fatalf("lost errors or continued after cancel: %d %v", calls, err)
	}
	for _, detail := range []string{"adb shell ps -A -o PID,NAME", "查询超时", "耗时", "adb shell ps -A（", "device offline"} {
		if !strings.Contains(err.Error(), detail) {
			t.Fatalf("missing diagnostic %q: %v", detail, err)
		}
	}
}

func TestTrackerRetryDiagnosticsAndRecovery(t *testing.T) {
	m, _ := synthetic(t)
	defer m.mcu.close()
	defer m.android.close()
	m.filter.SetPIDs("1000", map[string]bool{"42": true})
	m.resetTrackerLocked("", true)
	for i, delay := range []time.Duration{2 * time.Second, 4 * time.Second, 8 * time.Second, 8 * time.Second} {
		m.applyProcessSnapshot(m.config.Package, nil, "", errors.New("query timeout"))
		if m.trackerFailures != i+1 || processQueryDelay(m.trackerFailures) != delay || len(m.filter.pids) != 0 {
			t.Fatalf("retry %d: %#v", i, m.State())
		}
		s := m.State()
		if s.FilterFailureAt == "" || !strings.Contains(s.FilterWarning, "最近成功：") || !strings.Contains(s.FilterWarning, delay.String()) {
			t.Fatalf("missing status: %#v", s)
		}
	}
	m.applyProcessSnapshot(m.config.Package, map[string]bool{"43": true}, "1400", nil)
	s := m.State()
	if s.FilterWarning != "" || s.FilterRecoveredAt == "" || s.FilterFailureAt != "" || processQueryDelay(m.trackerFailures) != 3*time.Second {
		t.Fatalf("recovery: %#v", s)
	}
	recovered := s.FilterRecoveredAt
	m.applyProcessSnapshot(m.config.Package, map[string]bool{"43": true}, "1400", nil)
	if m.State().FilterRecoveredAt != recovered {
		t.Fatal("healthy refresh restarted recovery notice")
	}
	m.applyProcessSnapshot(m.config.Package, nil, "", errors.New("new failure"))
	if m.State().FilterRecoveredAt != "" || m.trackerFailures != 1 {
		t.Fatal("new failure did not reset backoff")
	}
	m.resetTrackerLocked("", false)
	if m.trackerFailures != 0 || m.trackerRecoveredAt != "" || !m.trackerLastSuccess.IsZero() {
		t.Fatal("package switch kept previous diagnostics")
	}
}
