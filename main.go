package main

import (
	"embed"
	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := NewApp()
	err := wails.Run(&options.App{Title: "TwinLog · 双路日志助手", Width: 1440, Height: 780, MinWidth: 1080, MinHeight: 640,
		AssetServer: &assetserver.Options{Assets: assets}, BackgroundColour: &options.RGBA{R: 245, G: 247, B: 250, A: 255},
		OnStartup: app.startup, OnBeforeClose: app.beforeClose, OnShutdown: app.shutdown, Bind: []interface{}{app},
	})
	if err != nil {
		println(err.Error())
	}
}
