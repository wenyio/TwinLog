package capture

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestParseForegroundPackage(t *testing.T) {
	const app = "com.example.app"
	const resumed = "mResumedActivity: ActivityRecord{123 u0 com.example.app/.MainActivity t8}"
	const window = "mCurrentFocus=Window{123 u0 com.example.app/com.example.app.MainActivity}\nmFocusedApp=ActivityRecord{123 u0 com.example.app/.MainActivity t8}"
	for _, tt := range []struct {
		name, activity, window, want string
	}{
		{"normal", resumed, window, app},
		{"modern", "topResumedActivity=ActivityRecord{123 u0 com.example.app/.MainActivity t8}", window, app},
		{"CRLF and full class", "  ResumedActivity: ActivityRecord{1 u0 com.example.app/com.example.app.MainActivity t8}\r\n", window, app},
		{"IME", resumed, "mCurrentFocus=Window{1 u0 com.ime/.InputMethod}\nmFocusedApp=ActivityRecord{1 u0 com.example.app/.MainActivity t8}", app},
		{"IME window title", resumed, "mCurrentFocus=Window{1 u0 InputMethod}", app},
		{"split screen", resumed + "\nmResumedActivity: ActivityRecord{2 u0 com.other/.Main t9}", "mCurrentFocus=Window{2 u0 com.other/.Main}", "com.other"},
		{"top resumed disambiguates", resumed + "\ntopResumedActivity=ActivityRecord{2 u0 com.other/.Main t9}", "", "com.other"},
		{"old window fallback", "unknown output", window, app},
		{"launcher", "mResumedActivity: ActivityRecord{1 u0 com.launcher/.Home t1}", "mCurrentFocus=Window{1 u0 com.launcher/.Home}", "com.launcher"},
		{"locked", resumed, window + "\nmShowingLockscreen=true", ""},
		{"keyguard", resumed, window + "\nmKeyguardShowing = true", ""},
		{"unlocked", resumed, window + "\nmShowingLockscreen=false", app},
		{"notification shade", resumed, "mCurrentFocus=Window{1 u0 NotificationShade}", ""},
		{"system UI", resumed, "mCurrentFocus=Window{1 u0 com.android.systemui/.Panel}", ""},
		{"transition", resumed, "mCurrentFocus=null", ""},
		{"ambiguous", resumed + "\nmResumedActivity: ActivityRecord{2 u0 com.other/.Main t9}", "", ""},
		{"no activity", "", "mCurrentFocus=Window{1 u0 com.ime/.InputMethod}", ""},
		{"empty", "", "", ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseForegroundPackage(tt.activity, tt.window)
			if got != tt.want || (err != nil) != (tt.want == "") {
				t.Fatalf("got %q, %v; want %q", got, err, tt.want)
			}
		})
	}
}

func TestForegroundQueryFallbackAndErrors(t *testing.T) {
	var calls []string
	pkg, err := queryForegroundPackage(func(args ...string) (string, error) {
		key := strings.Join(args, " ")
		calls = append(calls, key)
		switch key {
		case "window":
			return "WindowManager", nil
		case "window windows":
			return "mFocusedApp=ActivityRecord{1 u0 com.example/.Main t1}", nil
		default:
			return "", errors.New("unsupported")
		}
	})
	if err != nil || pkg != "com.example" || !reflect.DeepEqual(calls, []string{"window", "window windows", "activity activities"}) {
		t.Fatalf("fallback: %q, %v, %v", pkg, err, calls)
	}
	failure := errors.New("device offline")
	pkg, err = queryForegroundPackage(func(...string) (string, error) { return "", failure })
	if pkg != "" || !errors.Is(err, failure) {
		t.Fatalf("offline: %q, %v", pkg, err)
	}
	// A lock flag in the general dump must survive a vendor-section fallback.
	pkg, err = queryForegroundPackage(func(args ...string) (string, error) {
		if len(args) == 1 {
			return "mShowingLockscreen=true", nil
		}
		return "mFocusedApp=ActivityRecord{1 u0 com.example/.Main t1}", nil
	})
	if pkg != "" || err == nil {
		t.Fatalf("locked fallback: %q, %v", pkg, err)
	}
	if _, err := ForegroundPackage("missing-adb", ""); err == nil {
		t.Fatal("empty device accepted")
	}
}
