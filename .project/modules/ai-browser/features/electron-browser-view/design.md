# 功能 — Electron 浏览器视图

> 日期：2026-04-16
> 指令人：@moonseeker1
> 所属模块：modules/ai-browser/ai-browser-v1

## 描述
管理 Electron BrowserView 的创建、定位和销毁，作为 AI Browser 的渲染容器。提供右键上下文菜单和 Tab 上下文菜单。

## 依赖
- ai-browser context（CDP 连接）

## 实现逻辑
### 正常流程
1. AI Browser 初始化时创建 BrowserView
2. 将 BrowserView 附加到主窗口指定区域
3. CDP 协议连接 BrowserView
4. 右键/Tab 操作触发上下文菜单

## 涉及文件
- `services/browser-view.service.ts` — BrowserView 管理
- `services/browser-menu.service.ts` — 上下文菜单构建
- `ipc/browser.ts` — 浏览器 IPC handler
- `ipc/ai-browser.ts` — AI Browser IPC handler

## 变更
→ changelog.md
