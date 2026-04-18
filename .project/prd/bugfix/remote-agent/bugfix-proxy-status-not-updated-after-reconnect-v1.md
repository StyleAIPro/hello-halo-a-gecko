# Bugfix: connectServer 重连后不检测代理状态，UI 错误显示"代理已停止"

**版本**: v1
**模块**: remote-agent
**功能**: remote-deploy
**日期**: 2026-04-16
**状态**: 已确认

## 问题描述

SSH 重连服务器后，`proxyRunning` 状态不会被刷新，导致 UI 始终显示"Bot 代理已停止"，即使代理实际在运行。

## 复现步骤

1. 添加远程服务器并成功部署 SDK
2. 关闭应用后重新打开
3. 应用自动重连服务器（或手动点击连接）
4. UI 显示"Bot 代理已停止"，即使代理进程实际在运行

## 根因分析

`connectServer()` 方法（`remote-deploy.service.ts:671`）建立 SSH 连接后只更新 `status: 'connected'`，**不调用 `detectAgentInstalled()`**。

`proxyRunning` 仅在以下两个时机被设置：
1. `addServer()` — 首次添加服务器时
2. `updateAgent()` — 手动更新代理后

导致每次应用重启/重连后 `proxyRunning` 保持旧值或 `undefined`，前端 badge 判断逻辑（`server.assignedPort && server.status === 'connected'`）命中，显示"已停止"。

## 影响范围

- 文件：`src/main/services/remote-deploy/remote-deploy.service.ts`
- 文件：`src/main/ipc/remote-server.ts`
- 文档：`.project/modules/remote-agent/features/remote-deploy/bugfix.md`、`changelog.md`

## 修复方案

在 `connectServer()` 成功连接并解析端口后，调用 `detectAgentInstalled()` 检测代理状态：

```
connectServer()
  ├─ ensureSshConnectionInternal()
  ├─ resolvePort()（如果需要）
  ├─ updateServer({ status: 'connected' })
+ └─ detectAgentInstalled()  ← 新增：连接后自动检测代理状态
```

同时将 `remote-server:connect` IPC handler 改为返回更新后的完整服务器信息（包含 `proxyRunning`）。
