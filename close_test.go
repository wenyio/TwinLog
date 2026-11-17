package main

import (
	"errors"
	"reflect"
	"testing"
)

func TestExitConfirmation(t *testing.T) {
	opts := exitDialogOptions()
	if !reflect.DeepEqual(opts.Buttons, []string{"Yes", "No"}) || opts.DefaultButton != "No" || opts.CancelButton != "No" {
		t.Fatalf("native button mapping: %#v", opts)
	}
	for _, tc := range []struct {
		name, answer       string
		dialogErr, stopErr error
		want               bool
		calls              []string
	}{
		{"Windows Yes", "Yes", nil, nil, true, []string{"confirm", "stop", "quit"}},
		{"Windows No", "No", nil, nil, false, []string{"confirm"}},
		{"dialog error", "", errors.New("dialog failed"), nil, false, []string{"confirm", "report"}},
		{"save error", "Yes", nil, errors.New("disk failed"), false, []string{"confirm", "stop", "report"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls []string
			got := finishClose(func() (bool, error) { calls = append(calls, "confirm"); return tc.answer == "Yes", tc.dialogErr }, func() error { calls = append(calls, "stop"); return tc.stopErr }, func() { calls = append(calls, "quit") }, func(error) { calls = append(calls, "report") })
			if got != tc.want || !reflect.DeepEqual(calls, tc.calls) {
				t.Fatalf("exit=%v calls=%v", got, calls)
			}
		})
	}
}

func TestLateOrDuplicateNotesAcknowledgementIsIgnored(t *testing.T) {
	a := &App{closing: true}
	a.ConfirmClose(true)
	if !a.closing || a.closeAllowed {
		t.Fatal("unexpected transition")
	}
	a.awaitingNotes = true
	a.ConfirmClose(false)
	if a.closing || a.awaitingNotes {
		t.Fatal("failed notes save should cancel exit")
	}
}
