# 功能 — 终端界面

> 日期：2026-04-16
> 指令人：@moonseeker1
> 所属模块：modules/terminal/terminal-service-v1

## 描述
提供终端面板的前端 UI，包括终端输出渲染、共享终端面板和用户终端状态管理。

## 依赖
- terminal-gateway（后端终端服务）
- chat.store（Agent 终端输出转发）

## 实现逻辑
### 正常流程
1. 前端通过 WebSocket 连接终端
2. 渲染终端输出流
3. 用户在共享面板查看 Agent 终端

## 涉及文件
- `renderer/components/layout/TerminalPanel.tsx` — 终端面板
- `renderer/components/layout/SharedTerminalPanel.tsx` — 共享终端面板
- `renderer/components/TerminalOutput.tsx` — 终端输出渲染
- `renderer/stores/terminal.store.ts` — 终端状态
- `renderer/stores/user-terminal.store.ts` — 用户终端状态

## 变更
→ changelog.md
