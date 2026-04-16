# 功能 — hyper-space

> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源 PRD：无（初始文档化）
> 所属模块：modules/space/space-management-v1

## 描述
Hyper Space 多智能体工作空间的创建与管理。Hyper Space（`spaceType: 'hyper'`）是 Space 的特殊类型，包含一个 Leader Agent（强制本地）和多个 Worker Agent（可本地或远程）。Leader 负责任务规划、组织和分发，Worker 负责具体执行。编排配置（`OrchestrationConfig`）定义 Agent 间的协作模式。系统通过 `agentOrchestrator` 创建 Agent 团队，每个 Agent 拥有独立的会话视图。

## 依赖
- `src/shared/types/hyper-space.ts` — `AgentConfig`、`OrchestrationConfig`、`CreateHyperSpaceInput`、`SpaceType` 类型定义，`createOrchestrationConfig()` 工厂函数
- `src/main/services/agent/orchestrator.ts` — `agentOrchestrator` 单例，`createTeam()`、`getTeamBySpace()`、`getTeamStatus()`
- `src/main/services/space.service.ts` — `createHyperSpace()`、`updateHyperSpaceAgents()`、`getHyperSpaceStatus()`
- `src/renderer/components/space/HyperSpaceCreationDialog.tsx` — 创建对话框 UI
- `src/renderer/components/space/AgentPanel.tsx` — Agent 侧边栏面板
- `src/renderer/components/space/HyperSpaceMembers.tsx` — 成员展示组件
- `src/renderer/components/space/TaskBoardPanel.tsx` — 任务看板面板
- `src/renderer/stores/chat.store.ts` — `activeAgentId`、`activatedAgentIds` 状态

## 实现逻辑

### 正常流程

**创建 Hyper Space（`createHyperSpace()`）**
1. 验证至少有一个 Leader Agent（`agents.filter(a => a.role === 'leader')`）
2. 生成 UUID 作为空间 ID，创建标准空间目录结构
3. 调用 `createOrchestrationConfig()` 构建编排配置（含默认值填充）
4. 写入 `meta.json`，标记 `spaceType: 'hyper'`、`claudeSource: 'local'`，包含 agents 和 orchestration
5. 注册到内存索引 + 持久化磁盘
6. 调用 `agentOrchestrator.createTeam()` 创建 Agent 团队（spaceId、agents、config）
7. 返回 Space 对象

**更新 Hyper Space Agent（`updateHyperSpaceAgents()`）**
1. 验证空间存在且 `spaceType === 'hyper'`
2. 验证至少一个 Leader Agent
3. 更新 entry 中的 agents 和 updatedAt
4. 持久化索引 + 更新 meta.json
5. 返回更新后的 Space 对象（含 preferences）

**获取 Hyper Space 状态（`getHyperSpaceStatus()`）**
1. 验证空间存在且 `spaceType === 'hyper'`
2. 通过 `agentOrchestrator.getTeamBySpace()` 获取团队
3. 通过 `agentOrchestrator.getTeamStatus()` 获取详细状态
4. 返回 `{ isHyper, teamStatus }`

**前端创建对话框（`HyperSpaceCreationDialog`）**
1. 默认预置一个 Leader Agent（本地，能力：组织/管理/任务规划/项目管理）
2. 支持添加 Worker Agent：选择本地或远程类型
3. 远程 Worker 自动填充服务器环境信息（IP、用户名、密码）
4. 远程 Worker 预设默认能力（NPU操作/模型推理/模型训练/AI计算优化）
5. 提交后调用 `api.createHyperSpace()`

**前端 Agent 面板（`AgentPanel`）**
1. Leader 置顶显示，带皇冠图标
2. Worker 按添加顺序排列，激活态显示蓝色脉冲点
3. 点击 Agent 切换独立的会话视图（`setActiveAgentId`）
4. 支持运行时动态添加 Worker

### 异常流程
1. **缺少 Leader Agent** — `createHyperSpace()` 返回 `null`，日志记录错误
2. **非 Hyper Space 调用更新** — `updateHyperSpaceAgents()` 验证 `spaceType` 不匹配，返回 `null`
3. **团队不存在** — `getHyperSpaceStatus()` 返回 `{ isHyper: true, teamStatus: null }`

## 涉及 API
- IPC `space:create`（`spaceType: 'hyper'`） — 创建 Hyper Space
- IPC `space:update`（agents 字段） — 更新 Agent 配置

## 涉及数据
- `~/.aico-bot/spaces/{id}/.aico-bot/meta.json` — `spaceType`、`agents[]`、`orchestration`
- `src/shared/types/hyper-space.ts` — Agent 和编排配置类型定义

## 变更
-> changelog.md
