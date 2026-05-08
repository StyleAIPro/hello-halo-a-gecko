# PRD [Bugfix] — RemoteDeployService 日志 warn 降噪

| 字段 | 值 |
|------|------|
| 版本 | bugfix-remote-deploy-warn-noise-v1 |
| 日期 | 2026-05-06 |
| 作者 | @misakamikoto |
| 模块 | modules/remote-deploy |
| 状态 | done |
| 优先级 | P2 |
| 影响范围 | 仅主进程 |

## 问题描述

`src/main/services/remote-deploy/remote-deploy.service.ts` 中共有 20 处 `console.warn` 调用。这些 warn 日志覆盖远程服务器的正常运维流程——部署、健康检查、token 注册、端口探测等。它们记录的是**非关键性的降级/回退/探测失败**信息，属于开发调试用途，不应出现在生产环境日志中。

当前问题：这些 warn 通过 `Object.assign(console, log.functions)` 被重定向到 electron-log 文件，与真正的异常和错误混在一起，降低了日志可读性，干扰问题排查。

## 技术方案

将 `remote-deploy.service.ts` 中全部 20 处 `console.warn` 替换为 `console.debug`。`console.debug` 在 electron-log 默认级别下不会写入日志文件，但在开发控制台中仍然可见（Chrome DevTools 过滤器可选 debug 级别查看）。

### 修改规则

1. **`console.warn` → `console.debug`**：全文共 20 处，全部替换
2. **`console.error` 保持不变**：16 处 error 日志不动，这些是真正的异常
3. **`console.log` 不触碰**：仅处理 warn 级别

### 20 处 console.warn 明细

| # | 行号 | 消息摘要 | 场景 |
|---|------|---------|------|
| 1 | 208 | Operation watchdog triggered | 更新操作超时看门狗触发 |
| 2 | 434 | Port resolution failed | 端口解析失败 |
| 3 | 512-515 | Failed to restart proxy | 重启 proxy 失败 |
| 4 | 525-528 | Failed to start proxy | 启动 proxy 失败 |
| 5 | 536 | Auto-detect failed | 自动检测失败 |
| 6 | 855 | Port resolution failed on reconnect | 重连时端口解析失败 |
| 7 | 891-894 | Agent detection failed after connect | 连接后 Agent 检测失败 |
| 8 | 1196 | Failed to create npx symlink | 创建 npx 符号链接失败 |
| 9 | 1814 | Dependency check failed | 依赖检查失败（将执行 npm install） |
| 10 | 1856 | Could not read remote build info | 读取远程构建信息失败 |
| 11 | 2039 | No port assigned | 未分配端口，无法注册 token |
| 12 | 2046 | No auth token | 无 auth token，跳过注册 |
| 13 | 2063-2066 | Token registration returned failure | Token 注册返回失败 |
| 14 | 2069-2071 | Could not parse token registration response | 无法解析 token 注册响应 |
| 15 | 2082 | Failed to persist token to tokens.json | Token 持久化失败 |
| 16 | 2438 | Immediate health check failed | 立即健康检查失败 |
| 17 | 2789 | health check failed | 定期健康检查失败 |
| 18 | 3155 | Failed to read remote package.json | 读取远程 package.json 失败 |
| 19 | 3379 | Failed to create npx symlink | 创建 npx 符号链接失败（部署流程中的重复） |
| 20 | 3634-3637 | Failed to parse skill content for remote skill | 解析远程技能内容失败 |

## 不需要修改的日志

以下 `console.error` 调用保持不变（共 16 处），它们记录的是需要关注的真正异常：

- 捕获到未预期异常且无法正常恢复的场景
- SDK 初始化失败、进程启动失败等严重错误
- 任何导致远程服务器不可用或数据丢失的错误

`console.log` 调用不在本次修改范围内。

## 涉及文件

| # | 文件路径 | 变更类型 |
|---|---------|---------|
| 1 | `src/main/services/remote-deploy/remote-deploy.service.ts` | 修改（20 处 warn→debug） |

## 验收标准

- [ ] `remote-deploy.service.ts` 中不再存在 `console.warn` 调用
- [ ] 全部 20 处已替换为 `console.debug`，消息内容不变
- [ ] 全部 16 处 `console.error` 保持原样未修改
- [ ] `console.log` 调用未被改动
- [ ] 远程部署、健康检查、token 注册等功能行为不变（仅日志级别变化）
- [ ] `npm run typecheck && npm run lint && npm run build` 通过

## 变更记录

| 日期 | 内容 | 作者 |
|------|------|------|
| 2026-05-06 | 初始版本 | @misakamikoto |
