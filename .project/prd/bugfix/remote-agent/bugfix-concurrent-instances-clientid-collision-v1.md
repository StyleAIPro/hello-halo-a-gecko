# PRD [Bug 修复级] — startAgent 杀掉已运行代理导致多实例 WebSocket 互踢

> 版本：bugfix-concurrent-instances-clientid-collision-v1
> 日期：2026-04-16
> 指令人：@moonseeker1
> 归属模块：modules/remote-deploy
> 严重程度：High（功能不可用）
> 所属功能：features/websocket-client

## 问题描述

- **期望行为**：同一台机器上同时运行 dev 版和 packaged 版，各自独立连接远程服务器
- **实际行为**：后启动/发消息的实例触发 `startAgent`，杀掉已运行的远程代理，所有其他实例的 WebSocket 同时断连
- **复现步骤**：启动 dev 版连接远程 → 启动 packaged 版发消息 → dev 版 WebSocket 断连

## 根因分析

`remote-deploy.service.ts` 的 `startAgent()` 检测到 agent 已运行时执行 `stopAgent()` → `startAgent()` 重启。远程代理本身支持多 WebSocket 连接（`Map<WebSocket, ...>` + `broadcastToAllClients`），不需要重启。多实例场景下，一个实例的 `startAgent` 杀掉代理会断开所有其他实例的连接。

## 修复方案

`startAgent()` 检测到 agent 已运行时：跳过 stop/start，仅注册当前 PC 的 auth token 后直接返回。

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始根因：startAgent 无条件重启 → 修改为跳过 | @moonseeker1 |
