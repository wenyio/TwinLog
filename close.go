package main

import wruntime "github.com/wailsapp/wails/v2/pkg/runtime"

func exitDialogOptions() wruntime.MessageDialogOptions {
	// Windows ignores custom button captions and returns the canonical Yes/No.
	return wruntime.MessageDialogOptions{
		Type: wruntime.QuestionDialog, Title: "结束采集",
		Message: "退出会停止当前抓取并断开两路采集。确定退出？",
		Buttons: []string{"Yes", "No"}, DefaultButton: "No", CancelButton: "No",
	}
}

// Only quit after explicit approval and successful file/collector shutdown.
func finishClose(confirm func() (bool, error), disconnect func() error, quit func(), report func(error)) bool {
	approved, err := confirm()
	if err != nil {
		report(err)
		return false
	}
	if !approved {
		return false
	}
	if err = disconnect(); err != nil {
		report(err)
		return false
	}
	quit()
	return true
}
