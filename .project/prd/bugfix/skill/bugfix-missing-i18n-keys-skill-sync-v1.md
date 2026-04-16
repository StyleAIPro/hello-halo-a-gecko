# PRD [Bug 修复级] — SSH 旧连接 close 事件导致新连接失效（skill sync 失败）

> 版本：bugfix-missing-i18n-keys-skill-sync-v1
> 日期：2026-04-16
> 指令人：@moonseeker1
> 归属模块：modules/remote-deploy
> 严重程度：High（功能不可用）
> 所属功能：features/skill-library

## 问题描述

- **期望行为**：同步 skill 到远程服务器成功
- **实际行为**：报 `Error: Not connected`
- **复现步骤**：连接远程服务器 → 点击 Sync to Server → 选择技能同步

## 根因分析

`SSHManager.connect()` 清理旧连接时调用 `this.client.end()`，然后立即创建新 SSHClient。旧 client 的 `'close'` 事件是异步的，会在新 client 的 `'ready'` 事件触发**之后**才到达。

`'close'` handler 中 `this.client = null` 引用的是 SSHManager 实例的当前 client（此时已经是新 client），导致新连接被意外销毁：

```
1. disconnect() → oldClient.end()
2. connect() → newClient.connect()
3. newClient 'ready' → _ready = true ✓
4. oldClient 'close' → _ready = false, this.client = null ✗ (销毁了新连接)
5. executeCommand() → !this.client → throw "Not connected"
```

## 修复方案

在 `SSHManager.connect()` 中，为每个 client 绑定事件时捕获 client 引用，`'close'` 和 `'error'` handler 只处理当前活跃 client 的事件，忽略旧 client 的延迟事件。

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始 Bug 修复 PRD | @moonseeker1 |
