# 功能 — 搜索功能

> 日期：2026-04-16
> 指令人：@moonseeker1
> 所属模块：modules/chat/chat-ui-v1

## 描述
提供对话内容的搜索和定位能力，包括搜索面板、消息内高亮、搜索结果导航和快捷键支持。

## 依赖
- search.service（后端搜索服务）
- chat.store（对话消息数据）

## 实现逻辑
### 正常流程
1. 用户打开搜索面板（快捷键）
2. 输入搜索关键词
3. 后端搜索匹配消息
4. 前端高亮匹配结果
5. 用户在结果间导航跳转

## 涉及文件
- `renderer/components/search/SearchPanel.tsx` — 搜索面板
- `renderer/components/search/SearchHighlightBar.tsx` — 高亮条
- `renderer/components/search/SearchIcon.tsx` — 搜索图标
- `renderer/stores/search.store.ts` — 搜索状态
- `renderer/hooks/useSearchNavigation.ts` — 搜索导航
- `renderer/hooks/useSearchShortcuts.ts` — 搜索快捷键
- `services/search.service.ts` — 搜索后端服务
- `ipc/search.ts` — 搜索 IPC

## 变更
→ changelog.md
