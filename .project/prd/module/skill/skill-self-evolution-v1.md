---
name: skill-self-evolution-v1
status: in-progress
created: 2026-04-28
author: Agent (subagent)
commander: 人
level: module
---

# 技能自进化系统 PRD

## 1. 元信息

| 字段 | 值 |
|------|-----|
| 名称 | skill-self-evolution-v1 |
| 级别 | module（模块级） |
| 归属模块 | modules/skill |
| 状态 | in-progress |
| 创建时间 | 2026-04-28 |
| 指令人 | 人 |
| 优先级 | P1 |
| 影响范围 | 全栈（主进程后端 + 前端 UI） |
| 预估工期 | 2-3 周 |

## 2. 需求分析

### 2.1 背景

当前 AICO-Bot 的技能系统支持技能的创建、安装、编辑和市场推送，但技能一旦创建便处于"静态"状态——没有自动化的使用效果评估、没有基于反馈的持续优化、没有技能版本迭代机制。用户需要手动分析对话、手动优化技能提示词、手动管理版本，这一过程效率低且依赖人工经验。

参考 Hermes Agent 的技能自进化架构，其核心设计理念是：

1. **技能即指令（Skill-as-Instruction）**：技能本质是注入 system_prompt 的结构化文本，通过优化文本即可优化技能行为
2. **双层反馈闭环**：运行时即时修补（Agent 发现问题立即修正）+ 离线深度优化（积累数据后批量演化）
3. **适应度函数驱动**：通过流程遵循度、结果正确性、简洁性三维度评估技能质量

AICO-Bot 已有的基础能力（ConversationAnalyzer、SimilarityCalculator、SkillGeneratorService、TempAgentSession）为自进化系统提供了良好的起点，但缺少关键的自动化闭环连接。

### 2.2 目标

构建一个**自驱动的**技能自进化系统，实现以下核心能力：

1. **使用追踪**：自动记录技能在 Agent 会话中的使用情况和效果
2. **后台分析**：定时分析对话模式，发现高频可复用模式并建议创建技能
3. **理论驱动的智能优化**：基于 DSPy/GEPA 框架（`@jaex/dstsx` TypeScript 移植），用多轮 Pareto 演化自动优化技能 prompt
4. **自迭代闭环**：通过三级置信度机制实现自动化演化，高置信度变更自动应用、低置信度需确认，无需人工逐一审核
5. **版本管理**：追踪技能演化历史，支持版本对比和回滚
6. **引导式反馈**：通过系统提示词引导 Agent 主动反馈技能使用效果

### 2.3 不做的（Out of Scope）

- 不做 embedding 向量索引（V2 考虑，V1 继续使用现有相似度计算）
- 不做技能间依赖和组合关系（V2 考虑）
- 不做技能市场推送自动化（已有独立功能）
- 不改变现有 SKILL.md / SKILL.yaml 格式
- 不引入 Python 运行时依赖（使用 `@jaex/dstsx` TypeScript 原生实现）

### 2.4 参考来源

| 借鉴点 | Hermes Agent 做法 | AICO-Bot 适配策略 |
|--------|-------------------|-------------------|
| 技能格式 | SKILL.md (YAML frontmatter + Markdown body) | 保持现有格式不变 |
| 演化引擎 | Python DSPy + GEPA 离线管线 | `@jaex/dstsx` TypeScript 原生移植（含 GEPA + MIPROv2） |
| 评估维度 | 流程遵循度 + 结果正确性 + 简洁性 | 复用三维度，通过 DSPy metric 函数评分 |
| 双层闭环 | 运行时修补 + 离线优化 | 运行时引导反馈 + 后台 GEPA 演化 |
| 自迭代策略 | 人工审核 PR | 三级置信度自动迭代（高自动/中静默/低确认） |
| 版本管理 | Git-based 版本控制 | 技能目录下 `versions/` 子目录快照 |
| 模式发现 | 手动触发分析 | 后台定时调度（复用 Scheduler） |

### 2.5 自迭代策略：三级置信度机制

系统不应成为"AI 生成建议 → 人当审核员"的低效模式。对于个人桌面应用场景，应尽可能自动化。

| 置信度 | 触发条件 | 行为 | 前端展示 |
|--------|---------|------|---------|
| **高（自动应用）** | 使用次数 >= 10，GEPA 演化评分提升 >= 30% | 自动 patch + 保存版本快照 + 发送通知 | 进化面板显示"已自动优化"通知 |
| **中（静默应用）** | 使用次数 >= 5，GEPA 演化评分提升 >= 15% | 自动应用 + 保存版本快照（可回滚） | 进化面板显示"已自动优化"，标注回滚入口 |
| **低（需确认）** | 低于上述阈值，或评分提升 < 15% | 弹出建议让用户确认后应用 | 进化面板"待确认"列表 |

所有自动应用的变更都保留版本快照，用户可随时回滚。

## 3. 技术方案

### 3.1 总体架构

```
┌───────────────────────────────────────────────────────────────────────────┐
│                         技能自进化系统                                     │
│                                                                            │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │                      运行时闭环 (Runtime Loop)                      │  │
│  │                                                                      │  │
│  │  ┌──────────────────┐    ┌──────────────────┐    ┌───────────────┐  │  │
│  │  │ Agent 会话        │───►│ SkillUsageTracker│───►│  SQLite DB    │  │  │
│  │  │ (stream-processor)│    │  (使用追踪器)     │    │ (追踪数据)    │  │  │
│  │  └──────────────────┘    └──────────────────┘    └───────┬───────┘  │  │
│  │                                                          │          │  │
│  │  ┌──────────────────┐    ┌──────────────────┐            │          │  │
│  │  │ EvolutionGuidance│◄───│  SkillManager    │◄───────────┘          │  │
│  │  │  (进化引导提示词) │    │  (技能管理器)     │                       │  │
│  │  └──────────────────┘    └──────────────────┘                        │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │                  演化闭环 (GEPA Evolution Loop)                      │  │
│  │                                                                      │  │
│  │  ┌──────────────────────┐    ┌───────────────────────┐              │  │
│  │  │ BackgroundPattern    │───►│ SkillEvolutionEngine  │              │  │
│  │  │ Analyzer             │    │ (@jaex/dstsx GEPA)    │              │  │
│  │  │ (后台模式分析器)      │    │ (DSPy TypeScript)     │              │  │
│  │  └──────────────────────┘    └───────────┬───────────┘              │  │
│  │                                          │                           │  │
│  │            ┌─────────────────────────────┼──────────────────┐       │  │
│  │            │       三级置信度路由          │                  │       │  │
│  │            ▼                             ▼                  ▼       │  │
│  │     ┌────────────┐            ┌──────────────┐    ┌──────────────┐  │  │
│  │     │ 高置信度    │            │ 中置信度      │    │ 低置信度      │  │  │
│  │     │ 自动应用    │            │ 静默应用      │    │ 需确认        │  │  │
│  │     │ +通知      │            │ +可回滚       │    │ 用户审核      │  │  │
│  │     └──────┬─────┘            └──────┬───────┘    └──────┬───────┘  │  │
│  │            │                         │                    │          │  │
│  │            └─────────────┬───────────┘                    │          │  │
│  │                          ▼                                │          │  │
│  │              ┌──────────────────────┐                     │          │  │
│  │              │ SkillVersionManager  │◄────────────────────┘          │  │
│  │              │ (版本快照 + 回滚)     │                                │  │
│  │              └──────────────────────┘                                 │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  核心依赖:                                                                 │
│    → @jaex/dstsx (DSPy TypeScript 移植，含 GEPA + MIPROv2)                │
│    → ConversationAnalyzer / SimilarityCalculator (现有)                    │
│    → Scheduler / DatabaseManager / SkillManager (现有)                     │
└───────────────────────────────────────────────────────────────────────────┘
```

### 3.2 核心模块设计

#### 3.2.1 技能使用追踪器（SkillUsageTracker）

**职责**：在 Agent 会话中追踪技能使用情况，记录使用上下文和结果，为后续分析提供数据。

**集成点**：在 `stream-processor.ts` 的流事件处理中嵌入追踪逻辑。当检测到 Agent 使用了某个技能（通过 SDK 的 `skill` 工具调用），记录使用数据。

**数据结构**：

```typescript
/** 单次技能使用记录 */
interface SkillUsageRecord {
  id: string;                    // UUID
  skillId: string;               // 技能标识
  skillName: string;             // 技能名称
  conversationId: string;        // 对话 ID
  spaceId: string;               // 空间 ID
  triggeredAt: string;           // 触发时间 (ISO)
  triggerMode: 'slash-command' | 'auto-invoke' | 'injected';
  /** Agent 使用技能时的用户消息摘要 */
  userContext: string;
  /** Agent 执行的 tool 调用序列 */
  toolCalls: Array<{
    name: string;
    status: 'success' | 'error';
    duration?: number;
  }>;
  /** Agent 最终回复的摘要（前 200 字符） */
  agentResponseSummary: string;
  /** token 用量 */
  tokenUsage: {
    input: number;
    output: number;
  };
  /** 用户反馈 */
  userFeedback: 'positive' | 'negative' | 'neutral' | null;
  /** Agent 自评：流程遵循度 (0-1) */
  processCompliance: number | null;
  /** Agent 自评：结果正确性 (0-1) */
  resultCorrectness: number | null;
}

/** 技能使用统计聚合 */
interface SkillUsageStats {
  skillId: string;
  totalUses: number;
  successRate: number;           // 工具调用成功率
  avgProcessCompliance: number;  // 平均流程遵循度
  avgResultCorrectness: number;  // 平均结果正确性
  avgTokenCost: number;          // 平均 token 消耗
  positiveFeedbackRate: number;  // 正面反馈率
  lastUsedAt: string;
  usageTrend: 'increasing' | 'stable' | 'decreasing';
}
```

**追踪流程**：

1. 在 `stream-processor.ts` 处理 `tool_use` 事件时，检测 `Skill` 工具调用
2. 提取技能名称、触发方式、用户上下文
3. 在流结束后（`onComplete` 回调），收集 tool 调用结果和 token 用量
4. 异步写入 SQLite 数据库（不阻塞主流程）
5. 发送 `skill:usage-tracked` 事件到渲染进程，更新前端统计

**关键设计决策**：

- 追踪数据异步写入，不影响 Agent 会话性能
- 初版只追踪 `Skill` 工具调用（SDK 原生技能），后续可扩展到自定义技能
- `userFeedback` 字段通过对话后的用户行为推断（如：后续发 "不对" / "好的"），或通过前端反馈按钮主动收集

**接口**：

```typescript
class SkillUsageTracker {
  /** 记录技能使用 */
  recordUsage(params: {
    skillId: string;
    conversationId: string;
    spaceId: string;
    triggerMode: 'slash-command' | 'auto-invoke' | 'injected';
    userContext: string;
  }): void;

  /** 补充技能使用结果（流结束后调用） */
  completeUsage(params: {
    conversationId: string;
    toolCalls: Array<{ name: string; status: string; duration?: number }>;
    agentResponseSummary: string;
    tokenUsage: { input: number; output: number };
  }): void;

  /** 更新用户反馈 */
  updateFeedback(conversationId: string, feedback: 'positive' | 'negative' | 'neutral'): void;

  /** 获取技能使用统计 */
  getUsageStats(skillId: string, since?: string): SkillUsageStats;

  /** 获取技能使用历史记录 */
  getUsageHistory(skillId: string, limit?: number): SkillUsageRecord[];

  /** 获取所有技能的统计排行 */
  getStatsLeaderboard(limit?: number): SkillUsageStats[];
}
```

#### 3.2.2 后台模式分析器（BackgroundPatternAnalyzer）

**职责**：定时扫描所有空间的对话历史，发现高频可复用模式，与已有技能匹配，建议创建新技能或优化已有技能。

**集成点**：作为 Scheduler 的一个定时任务运行。复用现有的 `ConversationAnalyzer` 和 `SimilarityCalculator`。

**数据结构**：

```typescript
/** 模式发现结果 */
interface PatternDiscovery {
  id: string;
  /** 发现时间 */
  discoveredAt: string;
  /** 模式类型：新技能建议 / 优化已有技能 */
  type: 'new-skill' | 'optimize-existing';
  /** 模式描述 */
  description: string;
  /** 模式出现频次 */
  frequency: number;
  /** 来源对话 ID 列表 */
  sourceConversationIds: string[];
  /** 可复用性评分 (0-1) */
  reusabilityScore: number;
  /** 匹配的已有技能（仅 optimize-existing 类型） */
  matchedSkillId?: string;
  /** 相似度分数 */
  similarityScore?: number;
  /** 状态 */
  status: 'pending' | 'accepted' | 'dismissed' | 'expired';
  /** 建议的技能草稿（AI 生成） */
  suggestedSkillDraft?: {
    name: string;
    description: string;
    triggerCommand: string;
    systemPrompt: string;
  };
  /** 过期时间 */
  expiresAt: string;
}

/** 模式分析配置 */
interface PatternAnalyzerConfig {
  /** 分析间隔，默认 "6h" */
  analysisInterval: string;
  /** 模式出现频次阈值，默认 5 */
  frequencyThreshold: number;
  /** 可复用性评分阈值，默认 0.7 */
  reusabilityThreshold: number;
  /** 分析的对话时间窗口（天），默认 7 */
  lookbackDays: number;
  /** 每次分析的最大对话数，默认 50 */
  maxConversationsPerRun: number;
  /** 是否启用，默认 false */
  enabled: boolean;
}
```

**分析流程**：

1. Scheduler 定时触发（默认每 6 小时）
2. 扫描所有空间最近 7 天的对话
3. 使用 `ConversationAnalyzer.analyzeConversations()` 分析每个对话
4. 按 `taskType` 聚合，计算频次
5. 频次 >= 阈值的模式，使用 `SimilarityCalculator` 检查是否与已有技能匹配
6. 未匹配的高频模式：建议创建新技能（复用 `SkillGeneratorService`）
7. 高相似度匹配：建议优化已有技能
8. 结果写入 SQLite，发送 `skill:pattern-discovered` 事件到前端

**关键设计决策**：

- 默认关闭（`enabled: false`），用户在设置中手动启用
- 分析在后台低优先级执行，不阻塞主流程
- 模式建议有 7 天有效期，过期自动清理
- 已接受/已拒绝的建议不会重复出现

**接口**：

```typescript
class BackgroundPatternAnalyzer {
  /** 初始化，注册 Scheduler 任务 */
  initialize(config?: Partial<PatternAnalyzerConfig>): void;

  /** 手动触发一次分析 */
  analyze(): Promise<PatternDiscovery[]>;

  /** 获取待处理建议列表 */
  getPendingSuggestions(limit?: number): PatternDiscovery[];

  /** 接受建议（创建技能或标记为优化候选） */
  acceptSuggestion(suggestionId: string): Promise<void>;

  /** 拒绝建议 */
  dismissSuggestion(suggestionId: string): void;

  /** 更新配置 */
  updateConfig(config: Partial<PatternAnalyzerConfig>): void;

  /** 获取配置 */
  getConfig(): PatternAnalyzerConfig;
}
```

#### 3.2.3 技能演化引擎（SkillEvolutionEngine）

**职责**：基于使用数据和反馈，使用 `@jaex/dstsx` 的 GEPA/MIPROv2 优化器对技能 system_prompt 进行多轮 Pareto 演化优化。这是整个自进化系统的核心引擎，具备理论基础（ICLR 2026 GEPA 论文）。

**核心依赖**：`@jaex/dstsx`（DSPy TypeScript 移植，已验证可用）

```typescript
import { GEPA, MIPROv2, ChainOfThought, settings } from "@jaex/dstsx";
```

**数据结构**：

```typescript
/** 技能演化建议 */
interface EvolutionSuggestion {
  id: string;
  skillId: string;
  /** 演化类型 */
  type: 'prompt-optimize' | 'add-examples' | 'add-error-handling' | 'restructure';
  /** 原始 system_prompt */
  originalPrompt: string;
  /** 优化后 system_prompt */
  optimizedPrompt: string;
  /** 优化说明（GEPA 生成的 diff 描述） */
  explanation: string;
  /** GEPA 评估得分（三维度） */
  scores: {
    baseline: FitnessScore;       // 优化前得分
    evolved: FitnessScore;        // 优化后得分
    improvement: number;          // 整体提升百分比
  };
  /** 基于的使用数据摘要 */
  usageDataSummary: string;
  /** 置信度级别 */
  confidence: 'high' | 'medium' | 'low';
  /** 创建时间 */
  createdAt: string;
  /** 状态 */
  status: 'pending' | 'auto-applied' | 'confirmed' | 'rejected' | 'rolled-back' | 'expired';
  /** 过期时间（14 天） */
  expiresAt: string;
}

/** GEPA 适应度评分（三维度，0-1） */
interface FitnessScore {
  processCompliance: number;  // 流程遵循度
  resultCorrectness: number;  // 结果正确性
  conciseness: number;        // 简洁性
  overall: number;            // 加权综合
}

/** 演化引擎配置 */
interface EvolutionEngineConfig {
  /** 最小使用次数阈值，达到后才考虑优化 */
  minUsageCount: number;           // 默认 10
  /** 低评分阈值，低于此值触发优化 */
  lowScoreThreshold: number;       // 默认 0.6
  /** GEPA 演化轮数 */
  gepaSteps: number;               // 默认 10
  /** GEPA 种群大小 */
  gepaGroupSize: number;           // 默认 6
  /** 自动生成建议的间隔 */
  suggestionInterval: string;      // 默认 "1d"
  /** 是否启用 */
  enabled: boolean;                // 默认 false
  /** LLM 配置（复用用户的 AI Source） */
  optimizerModel: string;          // 默认复用当前 AI Source
}
```

**GEPA 演化流程**：

```
1. 触发条件检查
   技能使用次数 >= minUsageCount 且平均评分 < lowScoreThreshold
         │
         ▼
2. 构建评估数据集（从 SQLite 提取最近 N 次使用记录）
   - 每条记录 = { task_input: 用户上下文, expected_output: 理想结果 }
   - 分割：70% train / 15% val / 15% holdout
         │
         ▼
3. 封装为 DSPy 模块（SkillModule）
   class SkillModule extends ChainOfThought {
     // skill_text（即 system_prompt body）是唯一的可优化参数
     // GEPA 通过修改这段文本并评估效果来实现演化
   }
         │
         ▼
4. 配置 LLM 适配器（复用用户的 AI Source API key）
   settings.configure({ lm: new Anthropic({ model: optimizerModel }) })
         │
         ▼
5. 运行 GEPA 演化
   const gepa = new GEPA({ numSteps: gepaSteps, groupSize: gepaGroupSize });
   const optimized = await gepa.compile(skillModule, trainset, metric);
   // 每轮：评估当前技能 → 生成 groupSize 个变体 → 评分 → 保留最优
         │
         ▼
6. Holdout 评估
   对比基线 vs 演化版本在 holdout 集上的三维度得分
   improvement = evolved.overall - baseline.overall
         │
         ▼
7. 三级置信度路由
   ┌─ improvement >= 30% 且 uses >= 10  →  高置信度 → 自动应用 + 通知
   ├─ improvement >= 15% 且 uses >= 5   →  中置信度 → 静默应用 + 可回滚
   └─ 其他                              →  低置信度 → 需用户确认
         │
         ▼
8. 保存版本快照 + 写入 SQLite + 通知前端
```

**适应度函数（metric）**：

```typescript
/** GEPA 使用的适应度函数，评估技能在特定任务上的表现 */
async function skillFitnessMetric(
  args: { skill_instructions: string; task_input: string; output: string },
  trace?: any
): Promise<number> {
  // 三维度评分（通过 LLM-as-judge）
  const scores = await llmJudge(args);
  // 加权综合：流程遵循度(0.4) + 结果正确性(0.4) + 简洁性(0.2)
  return scores.processCompliance * 0.4
       + scores.resultCorrectness * 0.4
       + scores.conciseness * 0.2;
}
```

**接口**：

```typescript
class SkillEvolutionEngine {
  /** 初始化，配置 LLM 适配器 */
  initialize(config?: Partial<EvolutionEngineConfig>): void;

  /** 使用 GEPA 演化指定技能（核心方法） */
  evolveSkill(skillId: string): Promise<EvolutionSuggestion | null>;

  /** 批量检查所有技能，对符合条件的触发演化 */
  runEvolutionCycle(): Promise<EvolutionSuggestion[]>;

  /** 获取待处理建议（低置信度需确认的） */
  getPendingSuggestions(skillId?: string): EvolutionSuggestion[];

  /** 确认应用建议（低置信度手动确认） */
  confirmSuggestion(suggestionId: string): Promise<boolean>;

  /** 拒绝建议 */
  rejectSuggestion(suggestionId: string): void;

  /** 获取技能的健康评分 */
  getSkillHealthScore(skillId: string): FitnessScore | null;

  /** 更新配置 */
  updateConfig(config: Partial<EvolutionEngineConfig>): void;
}
```

#### 3.2.4 技能版本管理器（SkillVersionManager）

**职责**：追踪技能演化历史，支持版本快照、对比和回滚。

**存储结构**：

```
~/.agents/skills/{skill-name}/
  ├── SKILL.md              # 当前生效的技能文件
  ├── SKILL.yaml            # (备用格式)
  ├── META.json             # 技能元数据（增加版本信息）
  └── versions/             # 版本历史目录
      ├── v1.0-2026-04-28T10-00-00/
      │   ├── SKILL.md      # 该版本的技能文件快照
      │   └── META.json     # 版本元数据（变更原因、评分等）
      ├── v1.1-2026-04-30T15-30-00/
      │   ├── SKILL.md
      │   └── META.json
      └── ...
```

**数据结构**：

```typescript
/** 版本元数据 */
interface SkillVersionMeta {
  /** 版本号，语义化（如 "1.0", "1.1", "2.0"） */
  version: string;
  /** 创建时间 */
  createdAt: string;
  /** 变更类型 */
  changeType: 'create' | 'optimize' | 'patch' | 'manual-edit' | 'rollback';
  /** 变更原因（人工或 AI 生成的描述） */
  changeReason: string;
  /** 关联的演化建议 ID（如有） */
  evolutionSuggestionId?: string;
  /** 变更前的版本号 */
  previousVersion: string;
  /** 该版本的健康评分快照 */
  healthScore?: {
    processCompliance: number;
    resultCorrectness: number;
    conciseness: number;
    overall: number;
  };
  /** 是否为当前版本 */
  isCurrent: boolean;
}

/** 版本对比结果 */
interface VersionDiff {
  versionA: SkillVersionMeta;
  versionB: SkillVersionMeta;
  /** system_prompt 的差异（简化 diff） */
  promptDiff: {
    additions: string[];
    deletions: string[];
    modifications: Array<{ before: string; after: string }>;
  };
}
```

**接口**：

```typescript
class SkillVersionManager {
  /** 保存当前版本快照 */
  saveSnapshot(skillId: string, changeType: SkillVersionMeta['changeType'], changeReason: string): Promise<string>;

  /** 获取技能的版本历史 */
  getVersionHistory(skillId: string): SkillVersionMeta[];

  /** 获取指定版本的技能文件内容 */
  getVersionContent(skillId: string, version: string): string | null;

  /** 对比两个版本 */
  diffVersions(skillId: string, versionA: string, versionB: string): VersionDiff | null;

  /** 回滚到指定版本 */
  rollback(skillId: string, targetVersion: string, changeReason?: string): Promise<boolean>;

  /** 获取当前版本号 */
  getCurrentVersion(skillId: string): string | null;
}
```

#### 3.2.5 自进化系统提示词（EvolutionGuidance）

**职责**：注入到 Agent 的 system_prompt 中，引导 Agent 在使用技能时主动反馈使用效果，在完成复杂任务后主动沉淀技能。

**注入方式**：在 `system-prompt.ts` 的 `buildSystemPrompt()` 函数中，当检测到有已安装技能时，追加一段自进化引导指令。

**引导内容设计**：

```
## 技能使用反馈

你安装了以下技能。在使用技能时请注意：

1. **使用后评估**：每次使用技能完成任务后，简要评估技能是否有效帮助你完成任务。
   - 如果技能指引不准确或缺失关键步骤，在思考过程中记录具体问题。
   - 如果技能指引与当前任务场景不匹配，记录不匹配的原因。

2. **技能发现**：在完成一个多步骤的复杂任务后，思考该任务模式是否值得沉淀为可复用技能。
   - 判断标准：是否涉及 3+ 个工具调用、是否有清晰的步骤序列、是否可能再次出现。

注意：不需要在回复中明确提及以上评估过程，只需在思考（thinking）中自然地进行即可。
```

**关键设计决策**：

- 引导指令仅在 thinking 块中生效，不影响用户可见的回复质量
- 通过 `stream-processor.ts` 的 thinking 块内容来提取评估结果
- 评估结果作为 `SkillUsageRecord` 的补充信息，异步写入数据库

#### 3.2.6 前端自进化面板

**职责**：在技能页面增加自进化相关的 UI 面板，展示统计数据、演化建议、版本历史。

**页面结构变更**：

在 `SkillPage.tsx` 的 Tab Bar 中新增第四个 Tab：`evolution`（技能进化）。

```
技能页面 Tab 布局：
├── library (技能库)        -- 已有
├── market (技能市场)       -- 已有
├── editor (技能生成器)     -- 已有
└── evolution (技能进化)    -- 新增
```

**进化面板子视图**：

1. **使用统计视图**（默认）：
   - 技能使用排行（柱状图，按使用次数/成功率排序）
   - 单个技能的使用趋势（折线图，按天）
   - 技能健康评分雷达图（流程遵循度、结果正确性、简洁性）

2. **演化建议视图**：
   - 后台模式分析发现的建议列表（卡片式，标注类型/频次/相似度）
   - 技能优化建议列表（卡片式，标注评分提升预估）
   - 每条建议的操作按钮：接受 / 拒绝 / 查看详情

3. **版本历史视图**（选中技能后显示）：
   - 版本时间线（垂直时间轴）
   - 版本对比（并排 diff 视图）
   - 回滚按钮

4. **设置视图**：
   - 后台分析开关和间隔配置
   - 演化引擎开关和阈值配置
   - Agent 反馈引导开关

**前端状态扩展**（`skill.store.ts`）：

```typescript
// 新增到 SkillState
interface SkillEvolutionState {
  // 使用统计
  usageStats: SkillUsageStats[];
  usageStatsLoading: boolean;
  selectedSkillUsageHistory: SkillUsageRecord[];

  // 演化建议
  patternSuggestions: PatternDiscovery[];
  evolutionSuggestions: EvolutionSuggestion[];
  suggestionsLoading: boolean;

  // 版本管理
  selectedSkillVersionHistory: SkillVersionMeta[];
  versionDiff: VersionDiff | null;
  versionDiffLoading: boolean;

  // 配置
  evolutionConfig: {
    analyzerEnabled: boolean;
    analyzerInterval: string;
    engineEnabled: boolean;
    engineMinUsage: number;
    feedbackGuidanceEnabled: boolean;
  } | null;

  // 进化面板子视图
  evolutionSubView: 'stats' | 'suggestions' | 'versions' | 'settings';
}
```

### 3.3 数据模型 / Schema

#### 3.3.1 SQLite 表设计

在 `aico-bot.db` 中新增 `skill_evolution` 命名空间的迁移。

**表 1：`skill_usage_records`** — 技能使用记录

```sql
CREATE TABLE IF NOT EXISTS skill_usage_records (
  id              TEXT PRIMARY KEY,
  skill_id        TEXT NOT NULL,
  skill_name      TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  space_id        TEXT NOT NULL,
  triggered_at    TEXT NOT NULL,       -- ISO 8601
  trigger_mode    TEXT NOT NULL DEFAULT 'slash-command',
  user_context    TEXT,
  tool_calls      TEXT,               -- JSON: Array<{name, status, duration}>
  agent_response  TEXT,               -- Agent 回复摘要
  token_input     INTEGER DEFAULT 0,
  token_output    INTEGER DEFAULT 0,
  user_feedback   TEXT,               -- 'positive' | 'negative' | 'neutral' | NULL
  process_compliance REAL,            -- 0-1, Agent 自评
  result_correctness REAL,            -- 0-1, Agent 自评
  completed_at    TEXT,               -- ISO 8601
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_sur_skill_id ON skill_usage_records(skill_id);
CREATE INDEX idx_sur_space_id ON skill_usage_records(space_id);
CREATE INDEX idx_sur_triggered_at ON skill_usage_records(triggered_at);
```

**表 2：`skill_pattern_discoveries`** — 模式发现建议

```sql
CREATE TABLE IF NOT EXISTS skill_pattern_discoveries (
  id                      TEXT PRIMARY KEY,
  type                    TEXT NOT NULL,       -- 'new-skill' | 'optimize-existing'
  description             TEXT NOT NULL,
  frequency               INTEGER NOT NULL,
  source_conversation_ids TEXT,               -- JSON: string[]
  reusability_score       REAL NOT NULL,
  matched_skill_id        TEXT,
  similarity_score        REAL,
  suggested_draft         TEXT,               -- JSON: {name, description, triggerCommand, systemPrompt}
  status                  TEXT NOT NULL DEFAULT 'pending',
  created_at              TEXT NOT NULL,
  expires_at              TEXT NOT NULL
);

CREATE INDEX idx_spd_status ON skill_pattern_discoveries(status);
```

**表 3：`skill_evolution_suggestions`** — 演化优化建议

```sql
CREATE TABLE IF NOT EXISTS skill_evolution_suggestions (
  id                      TEXT PRIMARY KEY,
  skill_id                TEXT NOT NULL,
  type                    TEXT NOT NULL,       -- 'prompt-optimize' | 'add-examples' | etc.
  original_prompt         TEXT NOT NULL,
  optimized_prompt        TEXT NOT NULL,
  explanation             TEXT,
  estimated_improvement   TEXT,               -- JSON: {processCompliance, resultCorrectness, conciseness}
  usage_data_summary      TEXT,
  status                  TEXT NOT NULL DEFAULT 'pending',
  created_at              TEXT NOT NULL,
  expires_at              TEXT NOT NULL
);

CREATE INDEX idx_ses_skill_id ON skill_evolution_suggestions(skill_id);
CREATE INDEX idx_ses_status ON skill_evolution_suggestions(status);
```

### 3.4 闭环流程

#### 3.4.1 运行时追踪闭环

```
用户发送消息 "帮我提交代码"
    │
    ▼
Agent 接收消息，匹配技能 "git-commit"
    │
    ▼
Agent 使用 Skill 工具执行技能 ──────────► SkillUsageTracker.recordUsage()
    │                                          │
    │                                          ▼
    │                                     写入 SQLite
    │
    ▼
Agent 完成任务，返回结果 ───────────────► SkillUsageTracker.completeUsage()
    │                                          │
    │                                          ▼
    │                                     更新 SQLite 记录
    │
    ▼
用户评价（正面/负面/无反馈）──────────► SkillUsageTracker.updateFeedback()
                                               │
                                               ▼
                                          前端统计更新
```

#### 3.4.2 演化闭环（GEPA 驱动）

```
Scheduler 触发（每 6h）或手动触发
    │
    ▼
BackgroundPatternAnalyzer.analyze()
    │
    ├─► 扫描最近 7 天对话
    │
    ├─► ConversationAnalyzer 分析每个对话
    │
    ├─► 聚合高频模式（频次 >= 5）
    │
    ├─► SimilarityCalculator 匹配已有技能
    │
    ├─► [新模式] → 建议创建新技能 → PatternDiscovery(type='new-skill')
    │
    └─► [高相似] → 建议优化已有技能 → PatternDiscovery(type='optimize-existing')
              │
              ▼
         SkillEvolutionEngine.runEvolutionCycle()
              │
              ├─► 检查每个技能的使用数据（使用次数、评分）
              │
              ├─► 对符合条件的技能调用 evolveSkill()
              │
              │    ┌──────────────────────────────────────┐
              │    │     GEPA 演化流程                     │
              │    │  1. 从 SQLite 提取评估数据集           │
              │    │  2. train/val/holdout 分割             │
              │    │  3. 封装为 DSPy SkillModule            │
              │    │  4. GEPA 多轮 Pareto 演化              │
              │    │     每轮：生成变体 → 评分 → 保留最优    │
              │    │  5. Holdout 集上对比基线 vs 演化版      │
              │    └──────────────────────────────────────┘
              │
              ▼
         三级置信度路由
              │
    ┌─────────┼─────────┐
    ▼         ▼         ▼
  高置信度   中置信度   低置信度
  自动应用   静默应用   需确认
    │         │         │
    └────┬────┘         │
         ▼              ▼
  SkillVersionManager   前端待确认列表
  .saveSnapshot()            │
  + 通知前端            用户确认 → apply
                             用户拒绝 → reject
```

### 3.5 前端改动

#### 3.5.1 新增文件

| 文件 | 说明 |
|------|------|
| `src/renderer/components/skill/EvolutionPanel.tsx` | 进化面板主组件（包含统计/建议/版本/设置四个子视图） |
| `src/renderer/components/skill/UsageStatsView.tsx` | 使用统计视图 |
| `src/renderer/components/skill/SuggestionsView.tsx` | 演化建议视图 |
| `src/renderer/components/skill/VersionHistoryView.tsx` | 版本历史视图 |
| `src/renderer/components/skill/EvolutionSettingsView.tsx` | 进化设置视图 |
| `src/renderer/components/skill/SkillHealthBadge.tsx` | 技能健康评分徽章（显示在技能库列表中） |

#### 3.5.2 修改文件

| 文件 | 改动 |
|------|------|
| `src/renderer/pages/skill/SkillPage.tsx` | Tab Bar 新增 "evolution" Tab |
| `src/renderer/stores/skill/skill.store.ts` | 新增 evolution 相关状态和 actions |
| `src/renderer/api/transport.ts` | 新增 evolution 相关事件监听 |
| `src/renderer/api/index.ts` | 新增 `api.skillEvolution.*` 方法导出 |
| `src/preload/index.ts` | 暴露 evolution 相关 IPC 方法 |

#### 3.5.3 国际化

新增 `skill.evolution.*` 相关 i18n key（中文 + 英文优先，其余语言 AI 翻译）。

## 4. 开发前必读

| 分类 | 文档 | 阅读目的 |
|------|------|---------|
| 模块设计文档 | `.project/modules/skill/skill-system-v1.md` | 理解技能系统整体架构、组件职责和对外接口 |
| 功能设计文档 | `.project/modules/skill/features/skill-editor/design.md` | 理解技能编辑器的实现方式和 Agent 辅助编辑流程 |
| 功能设计文档 | `.project/modules/skill/features/skill-market/design.md` | 理解技能市场机制和安装流程 |
| 功能设计文档 | `.project/modules/skill/features/skill-source/design.md` | 理解技能源（GitHub/GitCode）管理方式 |
| 功能设计文档 | `.project/modules/agent/features/stream-processing/design.md` | 理解流式处理核心引擎，确定追踪器的嵌入点 |
| 功能设计文档 | `.project/modules/agent/features/message-send/design.md` | 理解消息发送流程，确定使用数据收集时机 |
| 源码文件 | `src/main/services/agent/stream-processor.ts` | 理解流事件处理细节，确定 SkillUsageTracker 集成方式 |
| 源码文件 | `src/main/services/agent/system-prompt.ts` | 理解 system_prompt 构建方式，确定 EvolutionGuidance 注入点 |
| 源码文件 | `src/main/services/skill/skill-manager.ts` | 理解技能加载/安装/卸载流程 |
| 源码文件 | `src/main/services/skill/conversation-analyzer.ts` | 理解对话分析能力，复用于模式发现 |
| 源码文件 | `src/main/services/skill/similarity-calculator.ts` | 理解相似度计算逻辑 |
| 源码文件 | `src/main/services/skill/temp-agent-session.ts` | 理解临时 Agent 会话创建方式，复用于演化引擎 |
| 源码文件 | `src/main/services/skill/skill-generator.ts` | 理解技能生成逻辑，复用于模式发现后的技能创建 |
| 源码文件 | `src/main/services/skill/skill-conversation.service.ts` | 理解技能对话会话管理 |
| 源码文件 | `src/main/platform/scheduler/types.ts` | 理解 Scheduler 的 Job 定义和执行机制 |
| 源码文件 | `src/main/platform/scheduler/schedule.ts` | 理解调度计算逻辑 |
| 源码文件 | `src/main/platform/store/database-manager.ts` | 理解 SQLite 数据库管理和迁移机制 |
| 源码文件 | `src/main/platform/store/types.ts` | 理解 DatabaseManager 接口和 Migration 定义 |
| 源码文件 | `src/main/ipc/skill.ts` | 理解现有 Skill IPC 通道，确定新增通道命名规范 |
| 源码文件 | `src/main/services/agent/sdk-config.ts` | 理解技能如何通过 junction link 合并到 SDK 路径 |
| 源码文件 | `src/shared/skill/skill-types.ts` | 理解现有技能类型定义，确定新增类型放置位置 |
| 源码文件 | `src/renderer/stores/skill/skill.store.ts` | 理解前端 Skill 状态管理，确定状态扩展方式 |
| 源码文件 | `src/renderer/pages/skill/SkillPage.tsx` | 理解技能页面结构，确定 Tab 扩展方式 |
| 编码规范 | `docs/Development-Standards-Guide.md` | TypeScript strict、IPC 常量化、命名规范等 |
| 文档规范 | `docs/vibecoding-doc-standard.md` | 文档管理规范 |
| 外部依赖 | `node_modules/@jaex/dstsx/dist/index.d.ts` | DSPy TypeScript 移植的类型定义，理解 GEPA/MIPROv2 API |
| 外部依赖 | `node_modules/@jaex/dstsx/README.md` | `@jaex/dstsx` 使用文档和示例 |

## 5. 涉及文件

### 5.1 新建文件

| 文件路径 | 说明 |
|---------|------|
| `src/shared/skill/skill-evolution-types.ts` | 进化系统共享类型定义 |
| `src/main/services/skill/evolution-store.ts` | 进化数据 SQLite 存储层 |
| `src/main/services/skill/skill-fitness.ts` | GEPA 适应度函数（三维度启发式评分） |
| `src/main/services/skill/skill-module.ts` | DSPy SkillModule 封装（技能 prompt → DSPy 可优化模块） |
| `src/main/services/skill/skill-usage-tracker.ts` | 技能使用追踪器（单例） |
| `src/main/services/skill/evolution-confidence.ts` | 三级置信度评估与路由逻辑 |
| `src/main/services/skill/skill-version-manager.ts` | 技能版本管理器（磁盘快照 + 回滚） |
| `src/main/services/skill/evolution-guidance.ts` | 自进化系统提示词构建 |
| `src/main/services/skill/background-pattern-analyzer.ts` | 后台模式分析器（跨空间扫描） |
| `src/main/services/skill/skill-evolution-engine.ts` | 技能演化引擎（GEPA 驱动） |
| `src/main/services/skill/evolution-init.ts` | 进化系统初始化模块 |
| `src/renderer/stores/skill/skill-evolution.store.ts` | 前端进化面板 Zustand Store |
| `src/renderer/components/skill/EvolutionPanel.tsx` | 进化面板主组件（含 5 Tab） |

### 5.2 修改文件

| 文件路径 | 改动说明 |
|---------|---------|
| `src/main/services/agent/stream-processor.ts` | 嵌入 SkillUsageTracker 的 recordUsage 调用 |
| `src/main/services/agent/system-prompt.ts` | 注入 EvolutionGuidance 引导指令 |
| `src/main/bootstrap/extended.ts` | 初始化进化系统 + 注册 IPC handlers |
| `src/main/ipc/skill.ts` | 新增 18 个 evolution 相关 IPC 通道 |
| `src/preload/index.ts` | 暴露 invoke 方法到 window.aicoBot |
| `src/renderer/stores/skill/skill.store.ts` | 扩展 currentView 类型增加 evolution |
| `src/renderer/pages/skill/SkillPage.tsx` | Tab Bar 新增 evolution Tab |

### 5.3 新增 IPC 通道

| 通道名 | 方向 | 说明 |
|--------|------|------|
| `skill:evolution:usage-stats` | handle | 获取技能使用统计排行 |
| `skill:evolution:skill-stats` | handle | 获取单个技能的详细统计 |
| `skill:evolution:skill-history` | handle | 获取技能使用历史记录 |
| `skill:evolution:pattern-suggestions` | handle | 获取模式发现建议列表 |
| `skill:evolution:accept-pattern` | handle | 接受模式发现建议 |
| `skill:evolution:dismiss-pattern` | handle | 拒绝模式发现建议 |
| `skill:evolution:suggestions` | handle | 获取演化优化建议列表 |
| `skill:evolution:generate-suggestion` | handle | 为指定技能生成优化建议 |
| `skill:evolution:accept-suggestion` | handle | 接受演化建议并应用 |
| `skill:evolution:reject-suggestion` | handle | 拒绝演化建议 |
| `skill:evolution:version-history` | handle | 获取技能版本历史 |
| `skill:evolution:version-content` | handle | 获取指定版本内容 |
| `skill:evolution:version-diff` | handle | 对比两个版本 |
| `skill:evolution:rollback` | handle | 回滚到指定版本 |
| `skill:evolution:config:get` | handle | 获取进化系统配置 |
| `skill:evolution:config:update` | handle | 更新进化系统配置 |
| `skill:evolution:analyze-now` | handle | 手动触发后台分析 |
| `skill:evolution:usage-tracked` | event | 技能使用记录事件（渲染进程监听） |
| `skill:evolution:pattern-discovered` | event | 新模式发现事件（渲染进程监听） |

## 6. 验收标准

### 6.1 技能使用追踪

- [ ] Agent 会话中使用技能时，SQLite 中正确写入使用记录（包含技能名、触发方式、tool 调用结果、token 用量）
- [ ] 使用记录异步写入，不影响 Agent 会话响应速度（写入延迟 < 100ms）
- [ ] 前端技能库列表中每个技能旁显示使用次数和健康评分徽章
- [ ] 点击技能详情可查看使用历史和统计趋势

### 6.2 后台模式分析

- [ ] 用户可在进化设置中启用后台分析，配置分析间隔（支持 "1h" / "6h" / "1d" / "1w"）
- [ ] 启用后，Scheduler 按配置间隔自动执行模式分析
- [ ] 频次 >= 5 且可复用性评分 >= 0.7 的高频模式生成"创建新技能"建议
- [ ] 与已有技能相似度 >= 0.7 的高频模式生成"优化已有技能"建议
- [ ] 建议在 7 天后自动过期，已接受/已拒绝的建议不重复出现
- [ ] 支持手动触发一次分析

### 6.3 技能演化引擎（GEPA 驱动）

- [ ] `@jaex/dstsx` 的 GEPA 和 MIPROv2 可正常实例化和调用
- [ ] 技能使用次数 >= 10 且平均评分 < 0.6 时，自动触发 GEPA 演化
- [ ] GEPA 演化使用 train/val/holdout 三分割，不使用训练数据评估
- [ ] 适应度函数正确实现三维度评分（流程遵循度 0.4 + 结果正确性 0.4 + 简洁性 0.2）
- [ ] 高置信度变更（提升 >= 30% 且使用 >= 10 次）自动应用并通知用户
- [ ] 中置信度变更（提升 >= 15% 且使用 >= 5 次）静默应用，可回滚
- [ ] 低置信度变更需用户在前端确认后应用
- [ ] 所有自动应用的变更均保留版本快照，用户可一键回滚
- [ ] LLM 适配器复用用户已配置的 AI Source API key，无需额外配置
- [ ] 演化过程中断（应用退出/崩溃）后，下次启动可恢复

### 6.4 技能版本管理

- [ ] 技能创建、优化、回滚时自动保存版本快照到 `versions/` 子目录
- [ ] 每个版本快照包含 SKILL.md 和版本元数据（版本号、变更类型、变更原因、健康评分）
- [ ] 前端展示版本时间线，支持查看任意历史版本的内容
- [ ] 支持任意两个版本的 diff 对比
- [ ] 支持一键回滚到历史版本

### 6.5 自进化引导

- [ ] 有已安装技能时，Agent 的 system_prompt 中包含自进化引导指令
- [ ] Agent 在 thinking 块中自然地进行技能使用评估
- [ ] 引导指令不影响用户可见的回复质量
- [ ] 用户可在进化设置中关闭引导功能

### 6.6 前端进化面板

- [ ] 技能页面新增"技能进化"Tab
- [ ] 统计视图展示技能使用排行（柱状图）和单个技能的使用趋势（折线图）
- [ ] 建议视图展示模式发现和优化建议，支持接受/拒绝操作
- [ ] 版本历史视图展示时间线，支持 diff 对比和回滚
- [ ] 设置视图支持配置后台分析、演化引擎、引导功能
- [ ] 所有用户可见文本使用 i18n，支持中英文

### 6.7 代码质量

- [ ] `npm run typecheck` 通过
- [ ] `npm run lint` 通过
- [ ] `npm run build` 通过
- [ ] `npm run i18n` 通过（新增 i18n key 提取和翻译）

### 6.8 文档更新

- [ ] 更新 `.project/modules/skill/skill-system-v1.md` 模块文档（新增内部组件）
- [ ] 更新 `.project/modules/skill/features/skill-editor/changelog.md`（版本管理相关）
- [ ] 更新 `.project/modules/agent/features/stream-processing/changelog.md`（追踪器集成）
- [ ] 更新 `.project/changelog/CHANGELOG.md`（全局变更记录）
