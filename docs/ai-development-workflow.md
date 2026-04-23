# VibeCoding 开发工作流

> Agent 执行细则见 [vibecoding-doc-standard.md](./vibecoding-doc-standard.md)
> 编码规范见 [Development-Standards-Guide.md](./Development-Standards-Guide.md)

## 流程总览

```
需求 → PRD → 文档预读 → 编码 → 自测 → 文档更新 → 提交
 人    Agent    Agent    Agent  人+Agent   Agent   人审核
```

## 步骤

### 1. 需求提出（人）

人描述需求（新功能 / Bug / 重构），Agent 用 AskUserQuestion 补充：归属模块、优先级、影响范围。

### 2. PRD 编写（Agent subagent）

1. 判断级别：bugfix / feature / module / project
2. 搜索 `.project/prd/` 已有 PRD，存在则升版本
3. **搜索模块文档**：subagent 必须搜索 `.project/modules/` 找到相关模块的概述文档、功能 design.md / changelog.md / bugfix.md
4. **搜索 API 文档**：subagent 必须搜索 `.project/api/` 找到相关 API 文档
5. **Subagent 独立写 PRD**（中文），包含：元信息、需求分析、技术方案、**开发前必读（分类表格）**、涉及文件、验收标准
   - 「开发前必读」必须分四类：**模块设计文档**、**源码文件**、**API 文档**、**编码规范**
   - 每项注明阅读目的，参考 `vibecoding-doc-standard.md` PRD 模板
6. 人确认 → PRD 状态改为 `confirmed`

### 3. 文档预读（Agent）

读取 PRD「开发前必读」中列出的所有文档，建立上下文，确认技术方案。**跳过此步骤 = 违规。**

### 4. 编码（Agent）

1. PRD 状态 → `in-progress`
2. 按 PRD 技术方案编码
3. 每个文件编辑后：`npx eslint --fix <file>` + re-read 确认逻辑未被覆盖
4. 更新 PRD「涉及文件」为实际修改清单

### 5. 自测（Agent + 人）

- Agent：`npm run typecheck && npm run lint && npm run build`
- 涉及新用户可见文本：`npm run i18n`
- 人：按 PRD 验收标准逐条测试
- 不通过 → 回步骤 2 更新 PRD

### 6. 文档更新（Agent）

精准增量更新（只更新 PRD 涉及文件对应的文档）：

| 更新目标 | 触发条件 |
|----------|---------|
| 功能 changelog.md | 每次 |
| 功能 bugfix.md | bug 修复时 |
| 模块设计文档 | 涉及文件变化时 |
| API 文档 | 接口签名变化时 |
| 全局 CHANGELOG | 每次 |

### 7. 提交（Agent 提交，人审核）

**一个 PRD = 一个逻辑 commit。**

```
<type>(<scope>): <中文简述>

- 改了什么、为什么改
- PRD: .project/prd/bugfix/skill/bugfix-xxx-v1.md
```

| PRD 规模 | 提交策略 |
|----------|---------|
| 小（单 bug / 单功能） | 1 commit |
| 中（2-3 层变更） | 代码 + 文档各 1 commit |
| 大（跨模块重构） | 每个子任务 1 commit |

**禁止**：不相关变更堆叠、空提交、不引用 PRD。

### 8. 收尾

- PRD 状态 → `done`，验收标准全部打勾
- Agent 生成变更摘要：做了什么、改了哪些文件、验收结果、待跟进

## 防遗忘机制

| 层级 | 机制 | 用途 |
|------|------|------|
| Session 内 | TaskList | 进度追踪 |
| Session 间 | Changelog + 变更摘要 | 上下文传递 |
| 长期 | Agent Memory | 偏好与决策 |
| PRD 闭环 | 状态 + 验收标准 | 避免重复/遗漏 |

## 变更

| 时间 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-18T16:00:00+08:00 | 初始版本 | @MoonSeeker |
| 2026-04-18T17:30:00+08:00 | 精简为工作流速查卡 | @MoonSeeker |
| 2026-04-18T19:00:00+08:00 | 步骤 2 增加模块文档搜索要求，「开发前必读」改为分类结构 | @MoonSeeker |
