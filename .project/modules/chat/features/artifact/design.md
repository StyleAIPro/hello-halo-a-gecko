# 功能 — 产物展示

> 日期：2026-04-16
> 指令人：@moonseeker1
> 所属模块：modules/chat/chat-ui-v1

## 描述
管理 Agent 产生的产物（文件、图片、代码等）的展示和缓存，包括产物卡片、侧栏和树状视图。

## 依赖
- artifact.service（产物缓存服务）
- chat.store（消息关联）

## 实现逻辑
### 正常流程
1. Agent 工具调用产生产物文件
2. 产物服务缓存文件元数据
3. 前端渲染产物卡片或侧栏
4. 用户点击查看产物详情

## 涉及文件
- `renderer/components/artifact/ArtifactCard.tsx` — 产物卡片
- `renderer/components/artifact/ArtifactRail.tsx` — 产物侧栏
- `renderer/components/artifact/ArtifactTree.tsx` — 产物树
- `services/artifact.service.ts` — 产物服务
- `services/artifact-cache.service.ts` — 产物缓存
- `ipc/artifact.ts` — 产物 IPC

## 变更
→ changelog.md
