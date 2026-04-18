# PRD [Bug 修复级] — dev/packaged 多实例共享远端 proxy 时 auth token 冲突

> 版本：bugfix-multi-token-registration-v1
> 日期：2026-04-16
> 指令人：@moonseeker1
> 归属模块：modules/remote-deploy
> 严重程度：High（后启动的实例完全不可用）
> 所属功能：features/remote-deploy
> 前置关联：bugfix-concurrent-instances-clientid-collision-v1（已修复 startAgent 杀进程问题）

## 问题描述

- **期望行为**：同一台 PC 上 dev 和 packaged 实例同时运行时，两者都能正常连接远端 proxy 进行对话
- **实际行为**：后启动的实例认证失败（401），远端 proxy 日志显示 10 次重试后 `authentication_failed`；`startAgent()` 检测到代理已运行时调用 `registerTokenOnRemote()` 但该方法未实现，导致运行时崩溃
- **复现步骤**：启动 dev 版连接远程 → 启动 packaged 版连接同一远程服务器 → packaged 版发送消息 → 401 认证失败

## 根因分析

| 问题 | 位置 | 影响 |
|------|------|------|
| Proxy 只支持单个 token | `remote-agent-proxy/src/server.ts` — `authToken: string`，比较用 `===` | 后启动实例的 token 被拒绝 |
| `registerTokenOnRemote()` 未实现 | `remote-deploy.service.ts:1543` — 调用不存在的方法 | 运行时 TypeError 崩溃 |
| WS client 使用错误 token | `remote-deploy.service.ts:2097` — `authToken: server.password \|\| ''` | 连接时发送 SSH 密码而非 auth token |

dev 和 packaged 共享同一 clientId → 同一 deployPath 和端口 → 共享同一个 proxy 进程。proxy 启动时只有一个 token（启动它的那个实例的），另一个实例的 token 不在白名单中。

## 修复方案

### 1. Proxy 端：支持多 token

- `authToken: string` → `authTokens: Set<string>`，启动时从 env var + `tokens.json` 加载
- 新增 HTTP 端点 `POST /tokens`（health port，port+1）用于运行时动态注册 token
- WebSocket 认证逻辑改为 `authTokens.has(token)`

### 2. 客户端：实现 token 注册 + 修复 WS auth

- 实现 `registerTokenOnRemote()`：通过 SSH curl 调用 `POST /tokens` 注册当前 token，并持久化到远端 `tokens.json`
- 修复 line 2097：`server.password` → `server.authToken`

### 3. Proxy 启动时加载 tokens.json

- `index.ts` 的 `loadConfig()` 读取 deploy 目录下 `tokens.json`，填入 config
- 支持 `REMOTE_AGENT_AUTH_TOKENS` 环境变量（逗号分隔）

## 变更文件

| 文件 | 变更 |
|------|------|
| `packages/remote-agent-proxy/src/types.ts` | 增加 `authTokens`、`tokensJsonPath` 字段 |
| `packages/remote-agent-proxy/src/server.ts` | authToken → authTokens Set，新增 /tokens 端点，新增文件 I/O |
| `packages/remote-agent-proxy/src/index.ts` | loadConfig 加载 tokens.json |
| `src/main/services/remote-deploy/remote-deploy.service.ts` | 实现 registerTokenOnRemote()，修复 WS auth token |

## 变更日志

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始 Bug 修复 PRD | @moonseeker1 |
