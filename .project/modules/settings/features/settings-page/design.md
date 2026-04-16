# 功能 — 设置页面

> 日期：2026-04-16
> 指令人：@moonseeker1
> 所属模块：modules/settings/settings-v1

## 描述
提供应用设置的主页面，包含导航栏和各设置分区的容器。

## 依赖
- config.service（配置读写）

## 实现逻辑
1. 渲染设置页面布局
2. 根据导航切换设置分区
3. 各分区独立加载和保存配置

## 涉及文件
- `renderer/pages/SettingsPage.tsx` — 设置页面
- `renderer/components/settings/SettingsNav.tsx` — 导航
- `renderer/components/settings/nav-config.ts` — 导航配置
- `renderer/components/settings/types.ts` — 类型定义

## 变更
→ changelog.md
