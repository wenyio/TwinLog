# 参与 TwinLog 开发

欢迎提交问题反馈和 Pull Request。项目以 Windows 为主，使用 Go + Wails v2 + React + TypeScript，保持标题、普通文本备注和文件存储的最小设计。

## 反馈问题

请说明 TwinLog 版本、Windows 版本、复现步骤、预期与实际行为。涉及设备时补充串口参数、Android 版本、ADB 版本及是否启用应用过滤。日志只提供脱敏的最小片段，不上传真实设备序列号、凭据或业务数据。

## 修改与验证

1. 按 [README](README.md#开发与构建) 准备环境，从 `main` 创建工作分支。
2. 修改前阅读 [AGENTS.md](AGENTS.md)，保持变更范围明确，避免混入格式整理或生成文件。
3. Go 修改运行 `go test ./...`、`go vet ./...`；前端修改运行 `npm.cmd run build`，抓取或滚动交互还需运行 `test:capture`、`test:scroll`。新克隆后先构建前端以生成 Go 嵌入资源。
4. 提交使用 `feat:`、`fix:`、`docs:` 等前缀；提交前运行 `git diff --cached --check`。
5. Pull Request 说明解决的问题、行为变化、实际验证结果与未验证项。历史验证记录不能代替本次验证。

无需连接真实设备即可运行默认自动测试。实机测试须显式设置 README 中说明的环境变量；请勿清空用户日志或重启全局 ADB 服务。日志、设备数据、依赖、生成的 Wails 绑定、`.tools` 和构建产物不入库。

提交贡献即表示你有权按项目的 [MIT 协议](LICENSE) 提供这些内容。
