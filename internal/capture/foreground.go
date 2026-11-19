package capture

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"
)

var (
	foregroundComponent = regexp.MustCompile(`(?:^|[\s{])([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)/[A-Za-z0-9_.$]+`)
	foregroundLocked    = regexp.MustCompile(`(?:mShowingLockscreen|mKeyguardShowing|isStatusBarKeyguard|mDreamingLockscreen)\s*=\s*true\b`)
)

// ForegroundPackage only reads system state; it never launches or stops an app.
func ForegroundPackage(adb, serial string) (string, error) {
	if strings.TrimSpace(serial) == "" {
		return "", fmt.Errorf("请先选择 Android 设备")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	return queryForegroundPackage(func(args ...string) (string, error) {
		commandArgs := append([]string{"-s", serial, "shell", "dumpsys"}, args...)
		out, err := command(ctx, adb, commandArgs...).CombinedOutput()
		if ctx.Err() != nil {
			return "", fmt.Errorf("读取前台应用超时")
		}
		if err != nil {
			return "", fmt.Errorf("ADB: %w: %s", err, strings.TrimSpace(string(out)))
		}
		return string(out), nil
	})
}

func queryForegroundPackage(query func(...string) (string, error)) (string, error) {
	window, err := query("window")
	if err != nil {
		return "", err
	}
	// Some vendor versions only include the focus fields in the windows section.
	if !strings.Contains(window, "mCurrentFocus=") && !strings.Contains(window, "mFocusedApp=") {
		fallback, fallbackErr := query("window", "windows")
		if fallbackErr == nil {
			window += "\n" + fallback
		}
	}
	activity, activityErr := query("activity", "activities")
	pkg, err := parseForegroundPackage(activity, window)
	if err != nil && activityErr != nil {
		return "", fmt.Errorf("%w（Activity 查询失败：%v）", err, activityErr)
	}
	return pkg, err
}

func focusComponent(text, key string) string {
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), key+"=") {
			if match := foregroundComponent.FindStringSubmatch(line); match != nil {
				return match[1]
			}
		}
	}
	return ""
}

func parseForegroundPackage(activity, window string) (string, error) {
	unavailable := fmt.Errorf("无法确定前台应用，请解锁设备并打开目标应用后重试")
	if foregroundLocked.MatchString(window) {
		return "", unavailable
	}
	focus := focusComponent(window, "mCurrentFocus")
	focusedApp := focusComponent(window, "mFocusedApp")
	for _, line := range strings.Split(window, "\n") {
		line = strings.TrimSpace(line)
		if line == "mCurrentFocus=null" || (strings.HasPrefix(line, "mCurrentFocus=") && focus == "" && !strings.Contains(line, "InputMethod")) {
			return "", unavailable
		}
	}
	if focus == "com.android.systemui" || focusedApp == "com.android.systemui" {
		return "", unavailable
	}
	resumed := map[string]bool{}
	top := map[string]bool{}
	for _, line := range strings.Split(activity, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "mResumedActivity:") && !strings.HasPrefix(line, "ResumedActivity:") && !strings.HasPrefix(line, "topResumedActivity=") && !strings.HasPrefix(line, "mTopResumedActivity=") {
			continue
		}
		if match := foregroundComponent.FindStringSubmatch(line); match != nil {
			if match[1] == "com.android.systemui" {
				continue
			}
			resumed[match[1]] = true
			if strings.HasPrefix(line, "topResumedActivity=") || strings.HasPrefix(line, "mTopResumedActivity=") {
				top[match[1]] = true
			}
		}
	}
	// Window focus disambiguates multi-resume / split-screen. An IME window
	// cannot win unless it is also a resumed Activity.
	if resumed[focus] {
		return focus, nil
	}
	if resumed[focusedApp] {
		return focusedApp, nil
	}
	if len(top) == 1 {
		for pkg := range top {
			return pkg, nil
		}
	}
	if len(resumed) == 1 {
		for pkg := range resumed {
			return pkg, nil
		}
	}
	// Older systems may only expose the focused Activity in WindowManager.
	if len(resumed) == 0 && focusedApp != "" && focusedApp != "com.android.systemui" {
		return focusedApp, nil
	}
	return "", unavailable
}
