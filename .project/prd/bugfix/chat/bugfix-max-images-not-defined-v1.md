# PRD [Bug 修复级] — InputArea MAX_IMAGES 未定义导致崩溃

> 版本：bugfix-max-images-not-defined-v1
> 日期：2026-04-16
> 指令人：@moonseeker1
> 反馈人：@moonseeker1
> 归属模块：modules/chat
> 严重程度：Critical
> 所属功能：features/input-area

## 问题描述

- **期望行为**：InputArea 组件正常渲染
- **实际行为**：页面打开即崩溃，报 `ReferenceError: MAX_IMAGES is not defined`
- **复现步骤**：打开任意聊天页面

## 根因分析

`MAX_IMAGES` 在 `src/renderer/hooks/useImageAttachments.ts:15` 定义为局部常量（未 export），`InputArea.tsx:453` 在 props 中使用了 `MAX_IMAGES` 但没有导入。

可能是添加 `maxImages` prop 时遗漏了 export 和 import。

## 修复方案

从 `useImageAttachments.ts` 导出 `MAX_IMAGES`，在 `InputArea.tsx` 中导入。

## 影响范围

- [ ] 涉及 API 变更 → 否
- [ ] 涉及数据结构变更 → 否
- [ ] 涉及功能设计变更 → 否

## 验证方式

打开聊天页面，InputArea 正常渲染无崩溃。

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始 Bug 修复 PRD | @moonseeker1 |
