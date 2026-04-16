# 功能 — 外观设置

> 日期：2026-04-16
> 指令人：@moonseeker1
> 所属模块：modules/settings/settings-v1

## 描述
管理应用外观配置，包括主题切换、语言选择等。

## 依赖
- config.service（配置持久化）
- i18n（国际化）

## 实现逻辑
1. 用户切换主题（亮色/暗色/系统）
2. 用户选择语言
3. 保存偏好到配置

## 涉及文件
- `renderer/components/settings/AppearanceSection.tsx` — 外观设置 UI

## 变更
→ changelog.md
