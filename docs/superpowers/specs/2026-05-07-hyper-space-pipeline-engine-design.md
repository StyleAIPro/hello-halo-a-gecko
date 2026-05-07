# Hyper Space Pipeline Engine 设计规格

> 日期: 2026-05-07
> 状态: confirmed
> 指令人: StyleAIPro

## 1. 背景与目标

### 现状

AICO-Bot 的 Hyper Space 功能基于 Leader-Worker 模式，通过 WebSocket + SSH 隧道连接远程 NPU 服务器上的 Agent。现有实现存在以下痛点：

- **编排能力弱**：无法表达并行→串行→并行等复杂工作流
- **通信效率低**：Mailbox 基于文件 I/O，高并发时性能差
- **集群管理缺失**：无统一的服务器注册、健康检查、负载感知
- **可观测性差**：无法实时监控 20+ 服务器的执行状态

### 目标

设计一套 Pipeline Engine 驱动的多 Agent 协同系统，支持 20+ NPU 服务器集群的统一编排、高效通信、自动化管理和实时可视化。

### 场景特征

- 规模：20+ NPU 服务器，1:1 Agent 映射
- 任务类型：同构（训练/推理部署）为主，异构（精度调优）为辅
- 工作流：并行→串行汇总、并行→分析报告、并行→串行→并行迭代循环
- Agent 能力：自主编写配置/脚本并执行
- 交互方式：简单任务用对话，复杂部署用模板

## 2. 整体架构

系统分为四层，每层职责明确，通过接口通信：

```
┌─────────────────────────────────────────────────────────────┐
│                      Interaction Layer                       │
│         对话式入口 + 模板化入口 → 统一转为 PipelineSpec         │
└───────────────────────────┬─────────────────────────────────┘
                            │ PipelineSpec (JSON)
┌───────────────────────────▼─────────────────────────────────┐
│                      Pipeline Engine                         │
│         DAG 解析 → 阶段调度 → 依赖管理 → 迭代循环              │
└───────────────────────────┬─────────────────────────────────┘
                            │ TaskAssignment[]
┌───────────────────────────▼─────────────────────────────────┐
│                      Cluster Manager                         │
│    服务器注册/发现 → 健康检查 → 拓扑管理 → 任务路由              │
└───────────────────────────┬─────────────────────────────────┘
                            │ via Event Bus
┌───────────────────────────▼─────────────────────────────────┐
│                      Agent Layer                             │
│    Agent-N (NPU Worker) — 自主编写/执行 + 状态上报              │
└─────────────────────────────────────────────────────────────┘
```

**关键原则**：

- 每层只依赖下一层的接口，不跨层调用
- Pipeline Engine 不知道具体有哪些服务器，只管"这个阶段需要 N 个 Worker"
- Cluster Manager 不知道业务逻辑，只管"这个任务该路由到哪台服务器"
- Agent 不知道自己是 Pipeline 的一部分，只接收任务、执行、上报结果

## 3. Pipeline Engine

### 3.1 数据模型

```typescript
interface PipelineSpec {
  id: string
  name: string
  variables: Record<string, any>        // 模板变量，运行时填充
  stages: PipelineStage[]
  edges: StageEdge[]
  communicationPolicy?: {
    workerToWorker: boolean              // 默认 true
    allowedTargets?: string[]
  }
}

interface PipelineStage {
  id: string
  name: string
  mode: 'parallel' | 'sequential' | 'fan-out' | 'reduce'
  targetSelector?: string               // 目标服务器筛选，如 "npu-type:A100" / "all"
  maxConcurrency?: number
  taskPrompt: string                    // 发给 Agent 的任务指令模板
  retryPolicy?: {
    maxRetries: number
    retryOn: 'failure' | 'timeout' | 'any'
  }
  timeout?: number                      // 单个任务超时（秒）
}

interface StageEdge {
  from: string
  to: string
  condition?: 'on-success' | 'on-failure' | 'on-all-complete' | 'on-any-complete'
}
```

### 3.2 三种典型工作流

**模式 1：并行配置 → 统一执行**

```
[fan-out: 配置各服务器] → on-all-complete → [sequential: 启动训练]
```

**模式 2：并行执行 → 汇总分析**

```
[parallel: 各服务器跑推理] → on-all-complete → [reduce: 收集指标+生成报告]
```

**模式 3：迭代循环**

```
[parallel: 跑一轮训练] → on-all-complete → [reduce: 分析 loss]
  → on-success(精度达标) → [done]
  → on-failure(精度未达标) → loop-back → [parallel: 调参重跑]
```

迭代循环通过 `condition` 边实现。reduce 阶段产出结果后，根据条件决定走向完成还是回环到前面的阶段。DAG 引擎检测到回环边时自动处理迭代。

### 3.3 执行状态机

```
Pipeline: pending → running → completed / failed
  Stage:  pending → scheduling → running → completed / failed / skipped
    Task: pending → dispatched → running → completed / failed / retrying
```

每层状态独立推进。Pipeline 只关心 Stage 状态，Stage 只关心 Task 状态。

## 4. Cluster Manager

### 4.1 服务器数据模型

```typescript
interface NpuServer {
  id: string
  name: string
  host: string
  port: number
  status: 'online' | 'offline' | 'busy' | 'error'

  capabilities: {
    npuType: string                     // "A100" / "H100" / "910B"
    memory: number                      // 显存 GB
    computeType: string[]               // ["training", "inference", "tuning"]
  }

  connection: {
    type: 'websocket' | 'ssh'
    sshTunnel?: { host: string; port: number; user: string }
    lastHeartbeat: number
  }

  load: {
    runningTasks: number
    gpuUtilization?: number             // 0-100，Agent 上报
    memoryUsed?: number
  }
}
```

### 4.2 核心职责

**心跳与健康检查**：
- Agent 每 30 秒通过 WebSocket 上报心跳 + 负载指标
- 连续 3 次未收到心跳 → 标记 `offline`
- 心跳恢复 → 自动 `online`，断线期间的任务标记为 `interrupted`

**任务路由**：

```typescript
// Pipeline Engine 调用 acquireWorkers 获取可用服务器
const workers = clusterManager.acquireWorkers({
  selector: 'capabilities.npuType=A100 & capabilities.computeType~training',
  count: 5,
  strategy: 'least-loaded'
})
```

路由策略支持 `capability` / `least-loaded` / `round-robin`，从静态配置升级为基于实时负载的动态路由。

**拓扑持久化**：
- 存储位置：`~/.aico-bot/spaces/{spaceId}/cluster.json`
- 重启后自动恢复
- 新增/移除服务器通过 UI 或对话指令操作

### 4.3 与现有架构的关系

- **复用** `services/remote/ws/` 的 WebSocket 连接管理
- **复用** `services/remote/ssh/` 的 SSH 隧道
- **替换** 现有 `space.remoteServerId` 的单一服务器引用，升级为服务器集群管理

## 5. 通信机制（Event Bus）

### 5.1 架构

所有 Agent 在远程 NPU 服务器上，通过 WebSocket 连接到本地主进程。通信路径：

```
远程 Agent ──WebSocket──► 本地主进程 Event Bus ──WebSocket──► 目标 Agent / Leader
```

主进程作为消息中继，不做消息拦截，但做权限控制和审计日志。

### 5.2 三种通信模式

**模式 1：Agent → Leader（任务完成上报，最高频）**

```typescript
await mcpTools.report_result({
  stageId: 'stage-train',
  taskId: 'task-001',
  status: 'completed',
  result: { loss: 0.023, accuracy: 0.967 },
  artifacts: ['/output/model-v2.bin']
})
```

Agent 不需要知道"通知谁"，只管上报结果。Pipeline Engine 根据 DAG 边的依赖关系自动决定下一步。

**模式 2：Agent → Agent（直接通信）**

```typescript
await mcpTools.send_message({
  to: 'agent-2',
  subject: 'share-checkpoint',
  body: '第一轮训练 checkpoint 路径: /ckpt/round1.bin，请加载'
})
```

适用场景：中间产物传递、调优协作、故障求助、数据同步。

**模式 3：Leader → Agent（广播指令）**

```typescript
await mcpTools.broadcast({
  targetSelector: 'all',
  message: '基于汇总结果，调整学习率为 0.001，开始第二轮训练'
})
```

### 5.3 Worker ↔ Worker 通信规则

- 所有 Worker 间消息经过主进程 Event Bus 中继，不允许直连
- 原因：NPU 服务器之间网络不一定互通；复用现有 WS 连接；主进程可做权限控制和审计
- 默认允许 Worker ↔ Worker 通信，Pipeline 可通过 `communicationPolicy` 配置限制

### 5.4 与现有组件的改动

| 现有组件 | 改动 |
|---------|------|
| `hyper-space-mcp.ts` | 增强为 3 种通信工具：`report_result`、`send_message`、`broadcast` |
| `mailbox.ts`（文件存储） | 废弃，功能迁移到内存 Event Bus |
| `orchestrator.ts` | 任务完成回调改为监听 Event Bus 事件 |
| `remote/ws/` WebSocket | 复用，新增消息类型 |

## 6. Interaction Layer

### 6.1 对话式入口

用户用自然语言描述任务，Leader Agent 解析意图并生成 PipelineSpec：

1. 识别意图
2. 查询 Cluster Manager 获取在线服务器
3. 生成 PipelineSpec
4. 展示简化版确认界面给用户
5. 用户确认后提交 Pipeline Engine 执行

### 6.2 模板化入口

```typescript
interface PipelineTemplate {
  id: string
  name: string
  description: string
  variables: TemplateVariable[]
  spec: PipelineSpec              // 带 {{variable}} 占位符
}

interface TemplateVariable {
  key: string
  label: string
  type: 'text' | 'select' | 'server-selector'
  defaultValue?: string
  options?: string[]
  required: boolean
}
```

用户通过 UI 填表 → 变量填入模板 → 生成 PipelineSpec → 执行。

### 6.3 统一入口

```
对话入口 → Leader Agent 解析 → PipelineSpec → Pipeline Engine
模板入口 → 变量填充模板    → PipelineSpec → Pipeline Engine
```

Pipeline Engine 不关心 PipelineSpec 来源。对话生成的 PipelineSpec 可另存为模板。

### 6.4 模板管理

- 存储位置：`~/.aico-bot/spaces/{spaceId}/pipeline-templates/`
- 预置常用模板（训练部署、推理部署、精度调优），用户可自定义

## 7. 可视化与可观测性

### 7.1 Dashboard 布局

- 顶部：Pipeline 进度条 + 阶段状态（completed / running / pending）
- 左侧：服务器状态网格（名称、NPU 型号、状态、进度百分比）
- 右侧：选中 Agent 的实时日志面板

### 7.2 数据推送

```
远程 Agent → WS: heartbeat + status + log_lines + progress
  → 主进程 Event Bus → 过滤+聚合
  → IPC/WS → 前端 Zustand Store → React 组件更新
```

### 7.3 三层可观测数据

| 层级 | 数据 | 推送频率 | 用途 |
|------|------|---------|------|
| Pipeline 级 | stage 状态变化、整体进度 | 事件驱动 | 进度条、阶段状态 |
| Agent 级 | 心跳、GPU 利用率、任务进度 | 30 秒 + 事件驱动 | 服务器状态网格 |
| 日志级 | stdout/stderr 输出 | 流式（节流 500ms） | 实时日志面板 |

### 7.4 Agent 状态上报

```typescript
await mcpTools.report_status({
  progress: 0.87,
  gpuUtilization: 92,
  metrics: { loss: 0.098, epoch: 2 },
  logTail: 'last 10 lines...'
})
```

### 7.5 关键交互

- 点击服务器卡片 → 展开该 Agent 的实时日志和详细指标
- Pipeline 阶段卡片 → 展开看到该阶段下所有 Task 的状态列表
- 失败/错误高亮 → 红色标记，点击查看错误详情和重试选项
- 迭代循环 → 每一轮指标对比折线图（如 loss 随迭代轮次变化）

## 8. 文件结构与改动范围

### 新增文件

```
src/main/services/agent/
├── pipeline/
│   ├── pipeline-engine.ts        # DAG 解析、阶段调度、依赖管理
│   ├── pipeline-spec.ts          # PipelineSpec / Stage / Edge 类型定义
│   └── pipeline-execution.ts     # 单次 Pipeline 执行的状态机
├── cluster/
│   ├── cluster-manager.ts        # 服务器注册、健康检查、负载管理
│   └── server-router.ts          # 基于 selector + strategy 的任务路由
├── event-bus.ts                  # 内存事件总线，替代文件 Mailbox
└── hyper-space-mcp.ts            # 增强：report_result / send_message / broadcast

src/shared/types/
├── pipeline.ts                   # PipelineSpec 等共享类型
└── cluster.ts                    # NpuServer 等共享类型

src/renderer/
├── stores/
│   └── hyper-space.store.ts      # Pipeline + 集群状态管理
├── pages/hyper-space/
│   ├── pipeline-dashboard.tsx    # Pipeline 进度 + 阶段状态
│   ├── cluster-grid.tsx          # 服务器状态网格
│   └── agent-log-panel.tsx       # 实时日志面板
└── api/
    └── index.ts                  # 新增 hyperSpace API
```

### 修改文件

| 文件 | 改动内容 |
|------|---------|
| `orchestrator.ts` | 任务分发改为调用 Pipeline Engine |
| `mailbox.ts` | 废弃，功能迁移到 Event Bus |
| `taskboard.ts` | 保留，改为从 Pipeline Engine 读写状态 |
| `preload/index.ts` | 新增 Hyper Space 相关 IPC 通道 |
| `api/transport.ts` | 新增 methodMap 条目 |
| `api/index.ts` | 新增 `api.hyperSpace.*` |

### 向后兼容

- 单 Agent 对话不受影响，Pipeline 只在 Hyper Space 模式下激活
- 现有远程连接基础设施完全复用
- 旧的 `space.remoteServerId` 单服务器模式继续工作，集群模式是新选项

## 9. 实现优先级

```
Phase 1: Event Bus + Cluster Manager     ← 解决通信和集群管理
Phase 2: Pipeline Engine (核心)           ← DAG 调度引擎
Phase 3: 交互层（对话 + 模板）             ← 用户体验
Phase 4: 可视化 Dashboard                 ← 前端展示
```

Phase 1 完成后即可替代文件 Mailbox，改善通信效率。Phase 2 是核心。Phase 3/4 可并行。
