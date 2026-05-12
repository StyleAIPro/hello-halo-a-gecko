# PRD: 修复 Skill 会话服务硬编码 Space ID

## 元信息

- **时间**: 2026-05-11
- **状态**: done
- **优先级**: P2
- **指令人**: moonseeker
- **影响范围**: 仅后端（Skill 会话服务）

## 问题描述

`skill-conversation.service.ts` 中的 `SKILL_SPACE_ID` 常量通过 `getSkillSpaceId()` 动态获取值。该函数来自 `space.service`，内部依赖 `space.service` 中另一个同名常量 `SKILL_SPACE_ID = 'aico-bot-skill-creator'`。

虽然当前 `getSkillSpaceId()` 仅是简单的值透传，但这种间接引用引入了不必要的耦合：
- 如果 `space.service` 的 space ID 生成规则发生变化（例如改为动态拼接或引入配置项），skill 会话服务将悄无声息地受到影响
- 模块间依赖链变长，不利于独立理解和维护
- 代码审查时需要跨文件追踪才能确认实际值

## 根因分析

`skill-conversation.service.ts` 在初始化时调用 `getSkillSpaceId()` 获取 skill space ID，而该值在 `space.service` 中本身就是一个硬编码常量 `'aico-bot-skill-creator'`。多了一层无意义的函数间接调用，且引入了对 `space.service` 内部实现的隐式依赖。

## 技术方案

1. 将 `const SKILL_SPACE_ID = getSkillSpaceId()` 改为 `const SKILL_SPACE_ID = 'aico-bot-skill-creator'`，直接硬编码 skill space ID
2. 移除未使用的 import：从 `../space.service` 的导入中删除 `getSkillSpaceId`（保留 `getOrCreateSkillSpace`）

## 开发前必读

| 类别 | 文件 | 阅读目的 |
|------|------|---------|
| 源码文件 | `src/main/services/skill/skill-conversation.service.ts` | 理解 SKILL_SPACE_ID 的使用方式和上下文 |
| 源码文件 | `src/main/services/space.service.ts` | 确认 getSkillSpaceId 的返回值和 SKILL_SPACE_ID 常量定义 |

## 涉及文件

| 文件 | 变更类型 |
|------|---------|
| `src/main/services/skill/skill-conversation.service.ts` | 修改：硬编码 SKILL_SPACE_ID，移除未使用的 import |

## 验收标准

- [x] `SKILL_SPACE_ID` 硬编码为 `'aico-bot-skill-creator'`，与 `space.service` 中原值一致
- [x] `getSkillSpaceId` 已从 import 中移除
- [x] `getOrCreateSkillSpace` 仍正常导入（该文件其他位置使用）
- [x] TypeScript 类型检查通过（无新增错误）
- [x] 构建通过

## 附注

当前工作区中还有以下未提交文件属于 `ai-source-proxy-toggle` PRD（`.project/prd/feature/ai-source-proxy-toggle/ai-source-proxy-toggle-v1.md`）的遗漏涉及文件，这些文件均为 `validateApi` / `fetchModels` 传递 `useProxy` 参数的 IPC/HTTP 链路文件：

| 文件 | 遗漏原因 |
|------|---------|
| `src/preload/index.ts` | preload 层传递 useProxy 参数 |
| `src/renderer/api/index.ts` | 渲染器 API 层传递 useProxy 参数 |
| `src/main/ipc/config.ts` | IPC handler 层传递 useProxy 参数 |
| `src/main/controllers/config.controller.ts` | HTTP controller 层传递 useProxy 参数 |
| `src/main/http/routes/index.ts` | HTTP 路由层传递 useProxy 参数 |
| `src/main/services/agent/helpers.ts` | getApiCredentials / getApiCredentialsForSource 传递 useProxy |
| `src/main/services/agent/sdk-config.ts` | resolveCredentialsForSdk 传递 useProxy |
| `src/main/services/agent/mcp-manager.ts` | testMcpConnections 传递 useProxy |
| `src/main/services/agent/types.ts` | ApiCredentials 接口增加 useProxy 字段 |
| `.project/modules/ai-sources/features/source-manager/changelog.md` | changelog 更新 |

提交时应将上述文件与本 PRD 的变更分开：本 PRD 的变更独立提交，引用本 PRD 路径；上述遗漏文件应与 ai-source-proxy-toggle PRD 的原始涉及文件合并为一个 commit，引用 ai-source-proxy-toggle PRD 路径。
