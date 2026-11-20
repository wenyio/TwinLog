package main

import (
	"embed"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := NewApp()
	windowOptions := &windows.Options{}
	if root, err := os.UserConfigDir(); err == nil {
		// Keep the standard executable's existing profile even for renamed builds.
		windowOptions.WebviewUserDataPath = filepath.Join(root, "TwinLog.exe")
	}
	err := wails.Run(&options.App{Title: "TwinLog · 双路日志助手", Width: 1440, Height: 780, MinWidth: 1080, MinHeight: 640, Frameless: true,
		AssetServer: &assetserver.Options{Assets: assets}, BackgroundColour: &options.RGBA{R: 245, G: 247, B: 250, A: 255},
		OnStartup: app.startup, OnBeforeClose: app.beforeClose, OnShutdown: app.shutdown, Bind: []interface{}{app}, Windows: windowOptions,
	})
	if err != nil {
		println(err.Error())
	}
}
