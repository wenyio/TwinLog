# TwinLog 开发约定

## 项目

- Go + Wails v2 + React + TypeScript，Windows 优先，无数据库。
- 用户填写项只有标题和普通文本备注，保持最小设计。
- 入口：`app.go` 为桌面桥接，`internal/capture` 为采集与存储，`frontend/src` 为界面。
- 使用说明见 `README.md`，需求与验证记录见 `docs`；不要把历史验证结果当作当前验证结论。
- 修改前检查 Git 状态，保留用户或其他任务的无关修改。

## 版本与提交

- 版本使用 `主版本.次版本.修订号`，例如 `0.1.3`；交付新版 exe 时升级，不要求每个 commit 升级。
- 修复升修订号，新增功能升次版本，不兼容调整升主版本。
- 界面、`frontend/package.json`（含锁文件）和 Windows 产品版本保持一致，避免新增重复硬编码。
- 只提交当前任务相关文件，提交前检查暂存区和 `git diff --cached --check`。
- 提交说明使用 `feat:`、`fix:`、`docs:` 等前缀；不自动推送远程。
- 日志、设备数据、`.tools`、依赖目录、生成的绑定和构建产物不入库。

## 编译与验证

- 开发入口 `dev.ps1`，正式构建入口 `build.ps1`，产物 `build/bin/TwinLog.exe`。
- 优先使用 `.tools/go`，仅修改当前进程 PATH；遵循现有 Go、Wails 和 npm 锁定版本。
- Go 修改运行 `go test ./...` 和 `go vet ./...`。
- 界面修改在 `frontend` 运行 `npm.cmd run build`；抓取或滚动交互修改再运行对应的 `test:capture`、`test:scroll`。
- `wails build -s` 跳过前端构建，仅在确认 `frontend/dist` 已与当前源码同步时使用。
- 构建前确认运行中的程序不会阻止覆盖；有正在采集的进程时先正常保存并退出。
- 交付说明给出版本、commit、exe 路径，并区分构建、自动测试与实机验证，未验证项明确说明。

## 采集约定与经验

- 连接后持续写 `full`；Stop 只停止当前抓取，不停止完整日志。
- `full/android.log` 保存全部可访问的 logcat 输出，应用过滤只影响预览和抓取文件。
- MCU 逐行添加 `[yyyy-MM-dd HH:mm:ss.fff] ` 主机接收时间；正确处理空行、半行、跨块 CRLF 和尾部数据。
- 抓取目录使用“抓取时间_标题”，内部固定为 `mcu.log`、`android.log`、`notes.txt`、`record.json`；不得覆盖已有记录。
- 清屏与暂停预览不影响保存；预览内存有上限，大日志不整体读入内存。
- 不自动清空 logcat，不随意执行 `adb kill-server`，不删除用户日志。
- Windows Wails 确认框返回 `Yes` / `No`，不能用自定义中文按钮文字判断。
- 退出顺序：保存备注、确认退出、停止采集并关闭文件、退出；备注超时不能覆盖用户等待确认的阶段。
- 应用重启会改变 PID，共享 UID 需要进程归属判断，不能只在 Start 时绑定一次 PID。
- 纵向 Flex 布局避免输入框继承无约束的 `flex: 1`，明确最小高度与收缩规则。
- 目录毫秒需正确生成；不要为等待整行而无限缓存无换行数据。
