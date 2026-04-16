# PRD [Bug 修复级] — 编译错误：notification-channels 缺失 + v2Session 常量重赋值

> 版本：bugfix-build-errors-notification-v2session-v1
> 日期：2026-04-16
> 指令人：@moonseeker1
> 归属模块：shared/types + agent/send-message
> 严重程度：Critical（阻塞编译）

## 问题描述

构建失败，两个错误：
1. `Could not resolve "./notification-channels" from "src/shared/types/index.ts"` — 文件不存在但被 re-export
2. `This assignment will throw because "v2Session" is a constant` — send-message.ts:650 对 const 变量重新赋值

## 根因分析

1. `shared/types/index.ts:58` 导出 `./notification-channels`，但该文件不存在（可能被移动或删除）
2. `send-message.ts:434` 声明 `const v2Session = ...`，但在 650 行 auth retry 分支中再次 `v2Session = ...`

## 修复方案

1. 删除 `shared/types/index.ts` 中对不存在文件的 re-export
2. `send-message.ts:650` 将 `v2Session = ...` 改为 `let` 声明或重新用 `const` 声明新变量

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始 Bug 修复 PRD | @moonseeker1 |
