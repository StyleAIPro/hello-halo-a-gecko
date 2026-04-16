# PRD [Bug 修复级] — getOrCreateV2Session 中 sessionId 未定义

> 版本：bugfix-sessionid-not-defined-v1
> 日期：2026-04-16
> 指令人：@moonseeker1
> 归属模块：modules/agent
> 严重程度：Critical
> 所属功能：features/sdk-session

## 问题描述

- **期望行为**：发送消息正常创建/复用 V2 Session
- **实际行为**：发送消息崩溃，报 `ReferenceError: sessionId is not defined`
- **复现步骤**：发送任意消息

## 根因分析

`session-manager.ts:656` 日志中引用了 `sessionId`，但该变量不存在于当前作用域。这是最近"参数对象化"重构（`GetOrCreateSessionOptions`）时遗漏的，应改为 `options.sessionId`。

## 修复方案

`session-manager.ts:656`：`${sessionId}` → `${options.sessionId}`

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始 Bug 修复 PRD | @moonseeker1 |
