# PRD [Bug 修复级] — GitCode 技能市场大文件 Skill 安装超时

> 版本：bugfix-skill-download-too-slow-v1
> 日期：2026-04-24
> 指令人：用户
> 归属模块：modules/skill
> 严重程度：Major（多文件 skill 无法安装）
> 所属功能：features/skill-market + features/skill-source
> 状态：in-progress

## 问题描述

- **期望行为**：从 GitCode 技能市场安装任意 skill 时，在合理时间内（< 120s）完成安装
- **实际行为**：从 `AICO-Ascend/Ascend-Skills` 源安装部分 skill 时，安装超时（60s）。其他源的 skill 安装非常快
- **复现步骤**：
  1. 配置 GitCode PAT Token
  2. 在技能市场浏览 `AICO-Ascend/Ascend-Skills` 源的技能列表
  3. 安装 `cann-installer` 等包含 `input/` 目录的 skill
  4. 观察安装超时报错

## 根因分析

### 根因 1：60s 安装超时对于多文件 skill 不够

`installSkillFromMarket` 的 `INSTALL_TIMEOUT` 为 60s。对于有 50+ 文件（含子目录）的 skill，以当前 1s rate limit 计算：

- 开销 API 调用（downloadSkill + findSkillDirectoryPath + 目录列表）：约 5 次 = 约 5s
- 文件下载：N 个文件 x 1s rate limit = Ns
- 当 N + 开销 > 55 时，必定超过 60s 超时

`Ascend-Skills` 中的 `cann-installer` 等 skill 包含 `input/` 目录（测试数据、样本输入等），文件总数轻松超过 50。

### 根因 2：fetchSkillDirectoryContents 递归下载所有文件，无跳过机制

**文件**：`src/main/services/skill/gitcode-skill-source.service.ts`，`fetchSkillDirectoryContents` 函数

该函数递归遍历 skill 目录下的**所有**子目录，下载每一个文件。唯一的过滤是 `!item.name.startsWith('.')`（跳过隐藏目录）。

像 `input/`、`test/`、`tests/`、`output/`、`results/`、`samples/`、`__pycache__/` 等目录中的文件都会被下载，但这些文件对 skill 运行**不是必需的**。每个文件的下载都需要一次 API 调用 + 1s rate limit 等待。

### 根因 3：1s rate limit 对文件下载过于保守

GitCode API 限制为 50 次/分钟。当前 rate limiter 设置 `RATE_LIMIT_MIN_INTERVAL_MS = 1000`（1 秒间隔），有效吞吐量约 60 次/分钟，刚好在限制边缘。

对于文件下载操作（顺序、已知路径），1s 间隔过于保守。文件下载不是突发操作，不需要严格控制间隔。0.3s 间隔仍可控制在 200 次/分钟以下，对大多数 skill 安装场景足够（即使触发 429 限流也有重试机制）。

## 技术方案

### 修复 1：安装超时从 60s 增加到 120s

**文件**：`src/main/controllers/skill.controller.ts`

`installSkillFromMarket` 和 `installSkillMultiTarget` 中的 `INSTALL_TIMEOUT` 从 60000 改为 120000。

### 修复 2：fetchSkillDirectoryContents 跳过非必要目录

**文件**：`src/main/services/skill/gitcode-skill-source.service.ts`

在 `fetchSkillDirectoryContents` 中，遍历子目录时跳过以下目录名：

```typescript
const SKIP_DIRS = new Set([
  'input', 'output', 'outputs', 'results',
  'test', 'tests', '__pycache__',
  'node_modules', '.git', '.github',
  'samples', 'example', 'examples',
  'docs', 'assets', 'images', 'data',
]);
```

被跳过的目录仍然会被**计数**（在 onOutput 进度中显示 "Skipping non-essential directory: xxx"），但不下载其中的文件。

### 修复 3：降低文件下载阶段的 rate limit 间隔

**文件**：`src/main/services/skill/gitcode-skill-source.service.ts`

在 `GitCodeApiOptions` 中新增 `skipRateLimit?: boolean` 选项。当 `skipRateLimit: true` 时，`gitcodeApiFetch` 跳过 `_rateLimiter.acquire()`，直接发起请求（依赖 429 重试机制兜底）。

`fetchSkillFileContent` 调用 `gitcodeApiFetch` 时传入 `skipRateLimit: true`，使文件下载不受 1s 间隔限制。

## 涉及文件

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/main/controllers/skill.controller.ts` | 修改 | INSTALL_TIMEOUT 60s -> 120s |
| `src/main/services/skill/gitcode-skill-source.service.ts` | 修改 | 跳过非必要目录 + skipRateLimit 选项 + fetchSkillFileContent 使用 |
| `src/main/services/skill/github-skill-source.service.ts` | 修改 | 同步添加 SKIP_DIRS 过滤（GitHub 端也受益） |
| `.project/modules/skill/features/skill-source/changelog.md` | 更新 | 追加变更记录 |
| `.project/modules/skill/features/skill-market/changelog.md` | 更新 | 追加变更记录 |

## 开发前必读

| 分类 | 文档/文件 | 阅读目的 |
|------|----------|---------|
| 模块文档 | `.project/modules/skill/features/skill-source/changelog.md` | 了解 GitCode skill source 最近变更 |
| 模块文档 | `.project/modules/skill/features/skill-market/changelog.md` | 了解 skill market 最近变更 |
| 源码文件 | `src/main/controllers/skill.controller.ts` | 理解 `installSkillFromMarket` 和 `installSkillMultiTarget` 的超时机制 |
| 源码文件 | `src/main/services/skill/gitcode-skill-source.service.ts` | 理解 `fetchSkillDirectoryContents`、`fetchSkillFileContent`、`gitcodeApiFetch` 的实现和 rate limiter |
| 源码文件 | `src/main/services/skill/github-skill-source.service.ts` | 理解 GitHub 端的目录遍历逻辑，同步添加 SKIP_DIRS |
| 历史PRD | `.project/prd/bugfix/skill/bugfix-skill-install-hang-v1.md` | 了解 60s 超时机制的引入背景（本次修改从 60s 调到 120s） |
| 历史PRD | `.project/prd/bugfix/skill/bugfix-gitcode-rate-limiter-v1.md` | 了解 rate limiter 的设计参数和约束 |

## 验收标准

- [ ] 从 `AICO-Ascend/Ascend-Skills` 安装包含 `input/` 等大量文件的 skill 时，安装不再超时
- [ ] 被跳过的非必要目录在安装输出中显示 "Skipping non-essential directory: xxx"
- [ ] `cann-installer` 等 skill 安装成功且功能正常
- [ ] 只有 SKILL.md/yaml 和核心文件被下载到本地 skill 目录
- [ ] 其他源的 skill 安装速度不受影响
- [ ] `npm run typecheck && npm run lint && npm run build` 通过

## 变更记录

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-24 | 初始 Bug 修复 PRD | 用户 |
