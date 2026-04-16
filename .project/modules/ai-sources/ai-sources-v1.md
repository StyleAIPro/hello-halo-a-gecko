# 模块 — AI 源管理 ai-sources-v1

> 版本：ai-sources-v1
> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源架构：无（初始版本）

## 职责

管理 AI 模型提供商的配置和认证，包括 GitHub Models、GitCode AI、OpenAI 兼容 API 等。提供统一的凭证管理和模型选择能力。

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    AI Sources Module                             │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐     │
│  │   manager     │  │ auth-loader  │  │    providers/       │     │
│  │ (源管理器)     │ │ (认证加载)    │ │  (提供商适配)        │     │
│  └──────────────┘  └──────────────┘  └────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘

外部依赖:
  → config.service (配置持久化)
  → github-auth.service (GitHub 认证)
  → gitcode-auth.service (GitCode 认证)
  → secure-storage.service (凭证加密存储)
```

## 对外接口

### IPC Handle 通道

| 方法 | 通道名 | 输入 | 输出 | 说明 |
|------|--------|------|------|------|
| getAISources | `ai-sources:get` | 无 | `{ success, data }` | 获取 AI 源列表 |
| saveAISource | `ai-sources:save` | `{ source }` | `{ success }` | 保存 AI 源配置 |
| deleteAISource | `ai-sources:delete` | `{ sourceId }` | `{ success }` | 删除 AI 源 |
| testAISource | `ai-sources:test` | `{ source }` | `{ success, data }` | 测试 AI 源连接 |

## 内部组件

| 组件 | 职责 | 文件 |
|------|------|------|
| manager | AI 源管理器（CRUD、切换） | `services/ai-sources/manager.ts` |
| auth-loader | 认证信息加载器 | `services/ai-sources/auth-loader.ts` |
| providers | 提供商适配器（GitHub/GitCode/OpenAI 等） | `services/ai-sources/providers/` |
| AISourcesSection | AI 源设置 UI | `renderer/components/settings/AISourcesSection.tsx` |
| GitHubSection | GitHub 认证设置 | `renderer/components/settings/GitHubSection.tsx` |
| GitCodeSection | GitCode 认证设置 | `renderer/components/settings/GitCodeSection.tsx` |
| ai-source-provider | 共享类型定义 | `shared/interfaces/ai-source-provider.ts` |
| ai-sources | 共享类型定义 | `shared/types/ai-sources.ts` |

### 归属 Hooks

| Hook | 职责 | 文件 |
|------|------|------|
| useAISources | AI 源 CRUD 编排 | `renderer/hooks/useAISources.ts` |

### 归属 IPC Handler

| Handler | 文件 |
|---------|------|
| gitcode | `ipc/gitcode.ts` |
| github | `ipc/github.ts` |

## 功能列表

| 功能 | 状态 | 文档 |
|------|------|------|
| source-provider | 已完成 | features/source-provider/design.md |
| source-manager | 已完成 | features/source-manager/design.md |

## 绑定的 API

- 无

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始模块文档 | @moonseeker1 |
