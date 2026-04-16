# 功能 — 内容画布

> 日期：2026-04-16
> 指令人：@moonseeker1
> 所属模块：modules/chat/chat-ui-v1

## 描述
管理多标签内容画布，支持在不同的内容视图（对话、终端、Diff、工具结果等）之间切换。每个会话可以打开多个视图标签。

## 依赖
- chat.store（会话状态）

## 实现逻辑
### 正常流程
1. Agent 工具调用触发新视图打开
2. 画布标签栏显示当前打开的视图
3. 用户点击标签切换视图
4. 视图关闭时回到主对话标签

## 涉及文件
- `renderer/components/canvas/CanvasTabs.tsx` — 标签栏
- `renderer/components/canvas/ContentCanvas.tsx` — 内容容器
- `renderer/components/canvas/viewers/` — 各类视图渲染器
- `renderer/stores/canvas.store.ts` — 画布状态管理
- `renderer/hooks/useCanvasLifecycle.ts` — 画布生命周期

## 变更
→ changelog.md
