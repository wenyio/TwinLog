package main

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

func TestConfirmRecordDeletion(t *testing.T) {
	dialogErr := errors.New("dialog failed")
	deleteErr := errors.New("system delete failed")
	for _, tc := range []struct {
		name, answer string
		askErr, want error
		delete       bool
	}{
		{name: "approved", answer: "Yes", want: deleteErr, delete: true},
		{name: "declined", answer: "No"},
		{name: "dismissed"},
		{name: "dialog error", answer: "Yes", askErr: dialogErr, want: dialogErr},
	} {
		t.Run(tc.name, func(t *testing.T) {
			deleted := false
			err := confirmRecordDeletion(2, func(opts wruntime.MessageDialogOptions) (string, error) {
				if opts.Type != wruntime.QuestionDialog || !reflect.DeepEqual(opts.Buttons, []string{"Yes", "No"}) ||
					opts.DefaultButton != "No" || opts.CancelButton != "No" || !strings.Contains(opts.Message, "2 条") {
					t.Fatalf("unexpected confirmation: %#v", opts)
				}
				return tc.answer, tc.askErr
			}, func() error {
				deleted = true
				return deleteErr
			})
			if deleted != tc.delete || err != tc.want {
				t.Fatalf("deleted=%v, error=%v; want %v, %v", deleted, err, tc.delete, tc.want)
			}
		})
	}
}
