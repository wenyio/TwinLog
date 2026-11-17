# TwinLog · 双路日志助手

Windows 桌面工具，同时保存 MCU 串口和 Android logcat。Go + Wails + React + TypeScript，无数据库。

## 使用

运行 build/bin/TwinLog.exe。选择串口、Android 设备和保存目录，点击“连接并持续采集”。如需只抓某个应用，选择设备后点击“加载应用”，输入/选择包名；留空表示全部应用。

输入标题与备注，Start 开始，Stop 保存当前抓取。Stop 后完整日志继续记录；点击左侧“新建抓取”开始下一条。备注自动保存，停止后可在历史记录里补充。历史日志点击“打开记录日志”用文本工具查看，上方两窗始终是实时预览。

勾选记录导出 ZIP。附带完整日志前先断开连接；正常退出会保存备注并停止采集。使用前关闭 SuperCom 对同一串口的连接。

目录：连接时间/full 下为 mcu.log 和 android.log；连接时间/抓取时间_标题 下为 mcu.log、android.log、notes.txt 和 record.json。session.json 保存连接信息。

MCU 行首格式：[2026-11-17 11:56:10.745] 。空行同样有时间戳，跨块半行不重复加；时间是电脑收到行首数据的时间。同一接收块多行可同时间。串口正文按接收字节保存，预览按 UTF-8 解码，异常字符不改写文件。

## 运行条件与边界

- Windows 10/11，WebView2 Runtime，设备 USB/ADB 驱动与调试授权。用户不需要 Go 或 Node.js 运行环境。
- ADB 默认从 PATH 查找；可在“更多设置”选择 Android SDK 的 platform-tools/adb.exe。不会清空 logcat 或重启全局 adb server。
- 第一版需两路设备都就绪才能连接。断线停止会话并保留已保存日志，手动重连产生新目录。
- 应用过滤使用包 UID，支持同 UID 的普通多进程和重启。需要设备支持 logcat UID 输出；共享 UID 拒绝单独过滤，隔离 UID 进程及系统代应用输出不属于这一过滤范围。full/android.log 保留系统上下文。
- 串口无法补回打开前的数据，Android 只能读取尚未覆盖且有权限访问的缓存。首次连接会回放缓存，正式 Start 前请等回放稳定。
- 界面只保留最近 2000 行（另有字符上限）；暂停滚动、清屏不影响保存。采集期间数据同时写 full 和当前抓取，磁盘保存两份抓取内容。
- 缓冲约每秒刷新，正常停止同步文件；异常终止或断电可能损失尾部。保存错误会明确报错停止。
- 首版已完成模拟数据自动测试及 Windows 构建/启动检查，尚未完成真实 P19/串口热插拔、8 小时稳定性验证。

## 开发与构建

需要 Go、Node.js/npm、Wails v2。本次使用 Go 1.27.4、Wails 2.17.1；Go 放在项目 .tools/go，不修改系统 PATH。

在当前 PowerShell 将 .tools/go/bin 和用户 go/bin 加入 PATH，运行：

    go install github.com/wailsapp/wails/v2/cmd/wails@v2.17.1
    wails dev
    wails build
    go test ./...
    go vet ./...

官方 Go 源不通时，可对当前终端设置 GOPROXY=https://goproxy.cn,direct。前端使用 npm lockfile；离线交付需提前准备 WebView2、ADB 及驱动。

## 代码入口

- main.go、app.go：桌面窗口、桥接、选择目录、配置和退出保存。
- internal/capture：设备枚举、双路采集、时间戳、UID 过滤、文件保存和 ZIP。
- frontend/src：React 界面和类型化桥接。
- docs/需求方案.md：确认后的最小需求。

本项目仅在本地保存日志，不自动上传。
