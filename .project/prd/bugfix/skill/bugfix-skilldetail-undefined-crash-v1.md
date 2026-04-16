# PRD [Bug 修复级] — SkillDetail 组件 skill 为 undefined 导致崩溃

> 版本：bugfix-skilldetail-undefined-crash-v1
> 日期：2026-04-16
> 指令人：@moonseeker1
> 归属模块：modules/skill
> 严重程度：Medium（页面白屏，ErrorBoundary 捕获）
> 所属功能：features/skill-library

## 问题描述

- **期望行为**：技能库页面正常渲染，未选中技能时显示空状态
- **实际行为**：`Cannot read properties of undefined (reading 'spec')`，页面白屏被 ErrorBoundary 捕获
- **复现步骤**：选中一个 skill → 卸载该 skill 或切换筛选条件使 skill 从列表消失

## 根因分析

`SkillLibrary.tsx:528` 使用 `activeSkills.find(...)!` 非空断言将 skill 传给 `SkillDetail`。当 `selectedSkillId` 存在但对应 skill 不在 `activeSkills` 中时（卸载、刷新、筛选切换），`find` 返回 `undefined`，`SkillDetail` 访问 `skill.spec.name` 崩溃。

## 修复方案

移除 `!` 非空断言，用 IIFE 包裹 `SkillDetail` 渲染，skill 不存在时降级为空状态提示。

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始 Bug 修复 PRD | @moonseeker1 |
