# 功能 — AI 源管理器

> 日期：2026-04-16
> 指令人：@moonseeker1
> 所属模块：modules/ai-sources/ai-sources-v1

## 描述
提供 AI 源的 CRUD 管理 UI 和后端逻辑，包括源列表展示、添加/编辑/删除源、切换当前源。

## 依赖
- source-provider（提供商适配）
- config.service（配置持久化）

## 实现逻辑
1. 加载已配置的 AI 源列表
2. 用户添加/编辑/删除源
3. 切换当前活跃源
4. 验证源连接

## 涉及文件
- `services/ai-sources/manager.ts` — 源管理器
- `renderer/components/settings/AISourcesSection.tsx` — AI 源设置 UI
- `renderer/components/settings/GitHubSection.tsx` — GitHub 设置
- `renderer/components/settings/GitCodeSection.tsx` — GitCode 设置
- `renderer/hooks/useAISources.ts` — AI 源 CRUD hook

## 变更
→ changelog.md
