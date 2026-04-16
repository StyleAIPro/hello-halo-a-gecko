# Bug 记录 — remote-deploy

## BUG-001: Proxy 健康状态不实时更新
- **日期**：2026-04-16
- **严重程度**：Major
- **发现人**：@zhaoyinqi
- **问题**：期望 proxy 挂掉后 UI 自动更新状态并尝试恢复；实际 proxy 挂掉后 UI 一直显示绿色"Bot Proxy OK"
- **根因**：`detectAgentInstalled()` 只在部署/连接时调用，无后台周期健康检查
- **修复**：新增 `startHealthMonitor()` 30 秒周期检查，`tryAutoRecoverProxy()` 自动恢复，`checkDeployFilesIntegrity()` 文件完整性检查，UI 健康告警横幅
- **影响文档**：
  - [x] design.md
  - [ ] api/

---

## BUG-002: 远程 WebSocket 认证 token 不一致导致连接失败
- **日期**：2026-04-17
- **严重程度**：Critical
- **发现人**：@zhaoyinqi
- **问题**：远程空间对话时 WebSocket 认证必然失败，远程服务器日志报 `Authentication failed via Authorization header, closing connection`
- **根因**：`createWsClient` 方法传的 `authToken` 是 `server.password`（SSH 密码），而 Proxy 启动时环境变量 `REMOTE_AGENT_AUTH_TOKEN` 用的是 `server.authToken`（随机 UUID），两端 token 不一致
- **修复**：将 `createWsClient` 中 `authToken: server.password || ''` 改为 `authToken: server.authToken`，与服务端保持一致
- **影响文档**：
  - [ ] design.md
  - [ ] api/

---

## BUG-003: SDK 安装命令模板字符串未插值导致安装错误版本
- **日期**：2026-04-17
- **严重程度**：Critical
- **发现人**：@zhaoyinqi
- **问题**：远程部署时 npm 安装了最新版本（如 0.2.111）而非项目要求的 `REQUIRED_SDK_VERSION`（如 0.2.104）
- **根因**：3 处 npm install 命令使用了 JavaScript 单引号字符串（`'...'`）而非反引号模板字符串（`` `...` ``），`${REQUIRED_SDK_VERSION}` 未被插值，远程 shell 收到空版本号，npm 默认安装了最新版
- **修复**：将第 1163、1168、3250 行的单引号字符串改为反引号模板字符串，确保版本号正确插值
- **影响文档**：
  - [ ] design.md
  - [ ] api/

---

## BUG-004: checkAgentInstalled 未做版本精确匹配导致 UI 状态错误
- **日期**：2026-04-17
- **严重程度**：Critical
- **发现人**：@zhaoyinqi
- **问题**：即使远程安装了错误版本的 SDK，`checkAgentInstalled` 仍返回 `sdkInstalled: true`，UI 显示绿色正常状态，误导用户
- **根因**：`checkAgentInstalled` 方法只检查 SDK 是否安装（目录是否存在 / 能否读取 package.json），不检查版本号是否与 `REQUIRED_SDK_VERSION` 一致
- **修复**：增加 `version === REQUIRED_SDK_VERSION` 精确匹配校验，不匹配时设置 `sdkVersionMismatch: true`，UI 据此显示版本不匹配警告
- **影响文档**：
  - [ ] design.md
  - [ ] api/

---

## 统计
| 严重程度 | 数量 |
|---------|------|
| Critical | 3 |
| Major | 1 |
| Minor | 0 |
