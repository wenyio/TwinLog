# TwinLog · 双路日志助手

Windows 桌面工具，可单独或同时保存 MCU 串口和 Android logcat。Go + Wails + React + TypeScript，无数据库。

支持双路持续日志、按标题抓取、普通文本备注、Android 应用过滤、历史预览与 ZIP 导出，采用 [MIT 协议](LICENSE)。版本见界面及 `frontend/package.json`。

## 使用

运行 build/bin/TwinLog.exe。选择保存目录和至少一路设备，点击“连接设备”。只选串口或只选 Android 时，中间只显示对应的日志窗；两路都选时使用原来的布局偏好。可用下拉框中的“不连接串口”或“不连接 Android”清除该路选择。如需只抓某个 Android 应用，点击“加载应用”，输入/选择包名；留空表示全部应用。

启动时串口枚举立即开始，读取配置后并行查询历史记录和 Android 设备，各项完成后分别显示；历史目录读取慢或 ADB 响应慢时，其他列表仍可正常加载。

输入标题与备注，点击“开始抓取”；抓取中，顶部始终提供“停止并保存”。停止后点击“新建抓取”，在同一面板填写下一条的标题和备注。备注自动保存，停止后可在历史记录里补充。点击左侧记录，中间仅显示该条记录实际抓取的日志来源，并显示记录标题；大日志仅预览末尾最多 2000 行 / 256 KB，点击“打开记录目录”用文本工具查看全文。“返回实时”恢复当前设备的实时布局。

“设备连接 → 更多设置”中的“保存完整日志”默认开启，未连接时可修改。开启时从连接到断开持续写 `full`，不受手动抓取开始或停止影响；关闭时仍可实时预览，但只有手动抓取期间的日志会保存。不会删除已有的完整日志。

勾选记录导出 ZIP。附带完整日志前先断开连接；未保存完整日志的会话仍可导出抓取文件。正常退出会保存备注并停止采集。使用前关闭其他工具对同一串口的连接。

左侧“全选”可全选 / 取消全选，部分勾选时显示半选状态及数量。“删除”确认后把记录日志和备注移入保存目录下的 `.twinlog-trash/删除时间/`，不会永久擦除文件，也不影响会话的 `full` 完整日志。需找回时退出程序，参照该回收批次的 `restore.json` 将记录文件夹移回原路径；抓取期间禁止删除，当前抓取不能勾选。

目录：开启完整日志时，连接时间/full 下为所选路的 mcu.log 和/或 android.log；连接时间/抓取时间_标题 下保存所选路的同名日志，以及 notes.txt 和 record.json。session.json 保存连接信息。

MCU 行首格式：[2026-11-17 11:56:10.745] 。空行同样有时间戳，跨块半行不重复加；时间是电脑收到行首数据的时间。同一接收块多行可同时间。串口正文按接收字节保存，预览按 UTF-8 解码，异常字符不改写文件。

## 运行条件与边界

- Windows 10/11，WebView2 Runtime，设备 USB/ADB 驱动与调试授权。用户不需要 Go 或 Node.js 运行环境。
- ADB 默认从 PATH 查找；可在“更多设置”选择 Android SDK 的 platform-tools/adb.exe。不会清空 logcat 或重启全局 adb server。
- 仅串口不要求 ADB，Android 单路不要求串口。两路都选时，若一路连接失败，不会自动降为单路，可在错误提示中选择仅连接另一路。已连接的设备断线会停止会话并保留已保存日志，手动重连产生新目录。
- 应用过滤：普通 UID 按 UID 筛选；共享 UID 按包名匹配主进程和“包名:子进程”并按 PID 筛选，每 500ms 刷新，结合 system_server 启停记录跟随重启。需要设备提供 UID 格式和 PID,NAME 进程表；应用未运行时显示等待。轮询/系统事件存在延迟，极短命进程或已退出且无法确认归属的历史 PID 可能不在应用文件中；开启完整日志时，full/android.log 不受过滤影响。非包名前缀的自定义进程、隔离 UID 进程及系统代应用输出暂不归入应用文件。
- 串口无法补回打开前的数据，Android 只能读取尚未覆盖且有权限访问的缓存。首次连接会回放缓存，正式 Start 前请等回放稳定。
- 界面只保留最近 2000 行（另有字符上限）；上滚会固定该窗内容，可滚回底部或点击“回到最新”恢复跟随。暂停和清屏不影响保存。开启完整日志时，抓取期间重叠的内容会写入 `full` 和当前抓取两处。
- 缓冲约每秒刷新，正常停止同步文件；异常终止或断电可能损失尾部。保存错误会明确报错停止。
- 历史验证记录见 `docs`，各记录仅代表对应版本和环境；真实设备兼容性、串口热插拔与 8 小时稳定性仍需验证。

## 开发与构建

在 Windows PowerShell 中构建。需要 Go（最低版本见 `go.mod`，本地开发使用 1.27.4）、Node.js 22 LTS/npm，以及 Wails 2.17.1。Wails 的 Windows 开发环境要求见 [官方文档](https://wails.io/docs/gettingstarted/installation)。

如果把 Go 解压到 `.tools/go`，开发和构建脚本会优先使用它，只修改当前进程 PATH；也可以使用 PATH 中的 Go。仓库不包含 Go、ADB、设备驱动或 WebView2 安装包。

首次准备（在仓库根目录运行）：

```powershell
if (Test-Path .tools/go/bin/go.exe) {
    $env:PATH = "$PWD/.tools/go/bin;" + $env:PATH
}
$env:PATH = "$env:USERPROFILE/go/bin;" + $env:PATH
go install github.com/wailsapp/wails/v2/cmd/wails@v2.17.1
Push-Location frontend
npm.cmd ci
npm.cmd run build
Pop-Location
```

先生成前端资源，是因为 Go 通过 `go:embed` 嵌入 `frontend/dist`；该目录不入库，新克隆后直接运行 `go test ./...` 会缺少资源。

```powershell
# 开发窗口
./dev.ps1

# 正式构建（先正常保存并退出运行中的 TwinLog）
./build.ps1
```

正式产物为 `build/bin/TwinLog.exe`。前端依赖以 `frontend/package-lock.json` 为准，使用 `npm.cmd ci` 安装；Go 和 Wails 依赖以 `go.mod`、`go.sum` 为准。官方 Go 源不通时，可对当前终端设置 `$env:GOPROXY = "https://goproxy.cn,direct"`。离线使用需提前准备 WebView2、ADB 及驱动。

## 自动验证

在首次准备完成、Go 已加入当前终端 PATH 后运行：

```powershell
go test ./...
go vet ./...
Push-Location frontend
npm.cmd run build
npm.cmd run test:startup
npm.cmd run test:capture
npm.cmd run test:scroll
Pop-Location
```

界面测试在 Windows 使用已安装的 Microsoft Edge 和模拟 Wails 桥接，不连接设备。Go 实机测试默认跳过；需要手动设置 `TWINLOG_TEST_SERIAL`、`TWINLOG_TEST_ADB`（adb 路径）和 `TWINLOG_TEST_PACKAGE`（设备上的共享 UID 应用包名）后才会运行。实机测试只读查询进程和 logcat，不打开串口、不清空日志或重启应用。

`test:startup` 检查生产前端资源，运行前需先执行 `npm.cmd run build`；覆盖配置/历史/ADB 查询等待、查询失败隔离，以及启动扫描迟到时不能覆盖新目录的记录。

## 代码入口

- main.go、app.go：桌面窗口、桥接、选择目录、配置和退出保存。
- internal/capture：设备枚举、双路采集、时间戳、UID 过滤、文件保存和 ZIP。
- frontend/src：React 界面和类型化桥接。
- docs/需求方案.md：确认后的最小需求。

本项目仅在本地保存日志，不自动上传。

## 参与贡献

欢迎通过 GitHub Issues 反馈问题或提交 Pull Request。请参考 [贡献指南](CONTRIBUTING.md) 和 [开发约定](AGENTS.md)。反馈时请使用脱敏的最小日志片段，避免上传设备序列号、账号信息或业务数据。

## 开源协议

本项目采用 [MIT License](LICENSE)，允许使用、修改和商业分发，分发时须保留版权声明及许可文本。第三方依赖仍遵循各自的许可证。
