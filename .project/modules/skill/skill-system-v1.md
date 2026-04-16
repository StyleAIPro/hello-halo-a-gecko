# 模块 — 技能系统 skill-system-v1

> 版本：skill-system-v1
> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源架构：无（初始版本）

## 职责

管理 AI Agent 的技能（Skill）生命周期，包括技能编辑器、技能市场、技能源管理（GitHub/GitCode）、技能存储和技能会话。技能是预构建的 Agent 能力扩展，可通过市场安装或本地创建。

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                       Skill Module                               │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐     │
│  │ skill-manager │  │  skill-store │  │ skill-market-service│     │
│  │ (技能管理器)   │  │ (技能存储)   │  │ (市场服务)          │     │
│  └──────────────┘  └──────────────┘  └────────────────────┘     │
│                                                                  │
│  ┌──────────────────┐  ┌─────────────────────────────────┐      │
│  │ skill-generator   │  │     skill-source-services       │      │
│  │ (技能生成/编辑)    │  │  (GitHub/GitCode 技能源)         │      │
│  └──────────────────┘  └─────────────────────────────────┘      │
│                                                                  │
│  ┌──────────────────┐  ┌─────────────────────────────────┐      │
│  │ skill-conversation│ │    temp-agent-session             │     │
│  │ (技能对话分析)     │ │   (临时 Agent 会话)               │     │
│  └──────────────────┘  └─────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────────┘

外部依赖:
  → github-auth.service (GitHub API 认证)
  → gitcode-auth.service (GitCode API 认证)
  → space.service (工作空间管理)
  → config.service (配置读取)
```

## 对外接口

### IPC Handle 通道

| 方法 | 通道名 | 输入 | 输出 | 说明 |
|------|--------|------|------|------|
| listSkills | `skill:list` | 无 | `{ success, data: Skill[] }` | 列出已安装技能 |
| installSkill | `skill:install` | `{ source, name }` | `{ success, data? }` | 从源安装技能 |
| uninstallSkill | `skill:uninstall` | `{ skillId }` | `{ success }` | 卸载技能 |

### Renderer Event 通道

| 通道名 | 数据 | 说明 |
|--------|------|------|
| `skill:installed` | `Skill` | 技能安装成功 |
| `skill:uninstalled` | `{ skillId }` | 技能卸载 |

## 内部组件

| 组件 | 职责 | 文件 |
|------|------|------|
| skill-manager | 技能管理器（安装/卸载/启用/禁用） | `services/skill/skill-manager.ts` |
| skill-store | 技能持久化存储 | `services/skill/skill-store.ts` |
| skill-market-service | 技能市场（浏览/搜索/安装） | `services/skill/skill-market-service.ts` |
| skill-generator | 技能编辑器后端（生成/修改技能） | `services/skill/skill-generator.ts` |
| github-skill-source | GitHub 技能源（拉取/安装） | `services/skill/github-skill-source.service.ts` |
| gitcode-skill-source | GitCode 技能源（拉取/安装） | `services/skill/gitcode-skill-source.service.ts` |
| skill-conversation | 技能对话分析（从对话提取技能模式） | `services/skill/skill-conversation.service.ts` |
| conversation-analyzer | 对话模式分析器 | `services/skill/conversation-analyzer.ts` |
| similarity-calculator | 技能相似度计算 | `services/skill/similarity-calculator.ts` |
| temp-agent-session | 临时 Agent 会话（技能执行） | `services/skill/temp-agent-session.ts` |
| SkillEditor | 技能编辑器 UI | `renderer/components/skill/SkillEditor/` |
| SkillLibrary | 技能库 UI | `renderer/components/skill/SkillLibrary.tsx` |
| SkillMarket | 技能市场 UI | `renderer/components/skill/SkillMarket.tsx` |
| SkillPage | 技能页面 | `renderer/pages/skill/SkillPage.tsx` |
| skill.store | 技能前端状态 | `renderer/stores/skill/skill.store.ts` |
| skill-types | 技能共享类型 | `shared/skill/skill-types.ts` |

### 归属 Hooks

| Hook | 职责 | 文件 |
|------|------|------|
| — | 无专属 hook | — |

### 归属 IPC Handler

| Handler | 文件 |
|---------|------|
| skill | `ipc/skill.ts` |

## 功能列表

| 功能 | 状态 | 文档 |
|------|------|------|
| skill-editor | 已完成 | features/skill-editor/design.md |
| skill-market | 已完成 | features/skill-market/design.md |
| skill-source | 已完成 | features/skill-source/design.md |

## 绑定的 API

- 无（通过 IPC 通道暴露接口）

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始模块文档 | @moonseeker1 |
