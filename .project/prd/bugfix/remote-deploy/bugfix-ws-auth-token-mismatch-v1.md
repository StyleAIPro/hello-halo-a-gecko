# PRD [Bug 修复级] — 远程 WebSocket 认证 token 不一致导致连接失败

> 版本：bugfix-ws-auth-token-mismatch-v1
> 日期：2026-04-17
> 指令人：@zhaoyinqi
> 反馈人：@zhaoyinqi
> 归属模块：modules/remote-agent
> 严重程度：Critical

## 问题描述

- **期望行为**：远程空间对话时，本地 WebSocket 客户端应使用正确的认证 token 连接远程 Proxy 服务，连接成功后正常收发消息。
- **实际行为**：远程空间对话时 WebSocket 认证必然失败，远程服务器日志报错：`Authentication failed via Authorization header, closing connection`，导致无法与远程 Agent 通信。
- **复现步骤**：
  1. 添加一个远程服务器（配置 SSH 连接信息）
  2. 创建一个远程空间，连接该服务器
  3. 部署 Agent 代码并启动 Proxy
  4. 在该远程空间发送一条消息
  5. 观察远程服务器日志，出现认证失败错误

## 根因分析

在 `src/main/services/remote-deploy/remote-deploy.service.ts` 中，`createWsClient` 方法（约第 2471 行）创建 WebSocket 客户端时传入的 `authToken` 取值为 `server.password || ''`（即 SSH 密码）。

而远程 Proxy 服务启动时（约第 1794 行）通过环境变量 `REMOTE_AGENT_AUTH_TOKEN` 传的是 `server.authToken`（一个随机 UUID，在 `addServer` 时由 `this.generateAuthToken()` 生成）。

两端使用的 token 来源不同：客户端用 SSH 密码，服务端用随机 UUID，导致认证必然失败。

**涉及代码位置**：
- `createWsClient` 方法中 `authToken: server.password || ''`（客户端侧，约第 2471 行）
- Proxy 启动时 `REMOTE_AGENT_AUTH_TOKEN` 环境变量设置为 `server.authToken`（服务端侧，约第 1794 行）

## 修复方案

将 `createWsClient` 中的 `authToken` 从 `server.password || ''` 改为 `server.authToken`，使客户端连接时使用与服务端一致的认证 token。

**具体改动**：
- 文件：`src/main/services/remote-deploy/remote-deploy.service.ts`
- 位置：`createWsClient` 方法
- 改动：`authToken: server.password || ''` → `authToken: server.authToken`

## 影响范围

- [ ] 涉及 API 变更 → 无
- [ ] 涉及数据结构变更 → 无
- [ ] 涉及功能设计变更 → 无

## 验证方式

1. 添加远程服务器并完成部署
2. 在远程空间发送消息，确认 WebSocket 连接成功建立（远程服务器日志无认证失败错误）
3. 确认消息正常发送和接收，流式回复正常显示
4. 断开重连场景：断开后重新连接远程空间，再次发送消息，确认认证仍然正常

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-17 | 初始 Bug 修复 PRD | @zhaoyinqi |
