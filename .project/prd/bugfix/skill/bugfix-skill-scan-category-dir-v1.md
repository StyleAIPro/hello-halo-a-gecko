---
timestamp: 2026-04-22
status: in-progress
level: bugfix
module: skill
instructed_by: MoonSeeker
---

# PRD: 技能市场扫描 — 分类目录结构优化

## 需求分析

### 问题描述

GitCode 技能仓库 `AICO-Ascend/Ascend-Skills` 使用分类目录结构（`Inference/`、`Operation/`、`Train/`），每个子目录下直接存放技能目录（如 `Inference/ais-bench/SKILL.md`），不存在 `skills/` 目录。此时扫描走 `findSkillDirs(repo, '/', token, 3)` 递归路径，对每个子目录逐一发起 API 请求，在当前速率限制（1s 间隔、最大 3 并发）下需 60-90 秒，用户界面表现为卡死/无响应。

作为对比，`Ascend/agent-skills` 有 `skills/` 目录，走 `listSkillsDir()` 快速路径，一次 API 调用即可列出全部技能。

### 根因分析

cbe2679 提交引入了 `Semaphore(3)` + `RateLimiter(1s gap)` 的并发控制，但存在两个致命问题：

**问题 1：Semaphore 死锁（根因）**

`findSkillDirs()` 的递归调用被包裹在 `withConcurrency()` 中（包含 semaphore 获取）。当根目录恰好有 ≥ 3 个子目录（如 Inference/、Operation/、Train/），`Promise.all` 启动 3 个回调，每个都通过 `withConcurrency` 占满 3 个 semaphore slot。每个回调内部的 `findSkillDirs` 又需要通过 `withConcurrency` 获取 semaphore 来做递归 API 调用 → **semaphore 耗尽，所有递归调用永久等待 → 完全卡死**。

```
findSkillDirs('/') — 3 个子目录 via Promise.all
├─ withConcurrency(findSkillDirs('Inference/'))  ← 占 slot 1/3
│   └─ withConcurrency(findSkillDirs('Inference/ais-bench/'))  ← 等待 slot → 死锁！
├─ withConcurrency(findSkillDirs('Operation/')) ← 占 slot 2/3
└─ withConcurrency(findSkillDirs('Train/'))     ← 占 slot 3/3
```

`Ascend/agent-skills` 不受影响，因为它有 `skills/` 目录，走 `listSkillsDir()` 快速路径，不会进入 `findSkillDirs('/')`。

**问题 2：无短路机制**

即使解决死锁，`findSkillDirs()` 对所有子目录无条件递归，分类目录下 N 个子目录需要 N 次递归 API 调用，全部可省略。

**问题 3：validateRepo 全量扫描**

`validateRepo()` 调用完整 `listSkillsFromRepo()`（含元数据获取），仅为判断 `skillCount > 0`，白白浪费 API 配额。

### 影响范围

- GitCode 技能市场：所有无 `skills/` 目录且根目录子目录数 ≥ 3 的仓库**完全卡死**（死锁）
- GitHub 技能市场：同样存在此模式（`findSkillDirs` 逻辑相同），影响较小但应同步修复
- `validateRepo()` 在验证阶段也会触发完整扫描（或死锁），白白浪费配额

## 技术方案

### 方案概述

三管齐下：
1. **Rate limiter 下沉到 `gitcodeApiFetch` 入口** — 所有 API 调用自动限速，从根本上避免嵌套 semaphore 死锁
2. **`findSkillDirs` 递归调用去掉 `withConcurrency` 包裹** — 不再有嵌套 semaphore 获取
3. **短路优化** — 发现首个含 SKILL.md 的子目录后，将同级目录批量提升为 skill 候选
4. **`validateRepo` 轻量化** — 采样探测替代全量扫描

### 核心改动

#### 1. Rate limiter 下沉 + 修复死锁

**修改文件**：`src/main/services/skill/gitcode-skill-source.service.ts`

将 rate limiter (`_rateLimiter.acquire()`) 从 `withConcurrency()` 移到 `gitcodeApiFetch()` 入口，确保所有 API 调用都经过限速，同时 `withConcurrency()` 仅保留 semaphore 做并发控制（不再重复限速）。

`findSkillDirs()` 中的递归调用不再包裹 `withConcurrency()`，避免嵌套 semaphore 获取导致死锁：

```typescript
// 之前（死锁）：
const sub = await withConcurrency(() => findSkillDirs(repo, subPath, token, maxDepth - 1));

// 之后（无死锁）：
const sub = await findSkillDirs(repo, subPath, token, maxDepth - 1);
```

**为什么安全**：`gitcodeApiFetch()` 入口已有 rate limiter（1s gap），API 调用天然串行化，不会出现突发并发。

#### 2. `findSkillDirs` 短路优化

**修改文件**：
- `src/main/services/skill/gitcode-skill-source.service.ts`
- `src/main/services/skill/github-skill-source.service.ts`

在 `findSkillDirs()` 的 `Promise.all` 回调中，一旦发现某个子目录包含 SKILL.md（`sub.length > 0`），设置 `foundCategory = true` 并将该层所有同级目录作为 skill 候选返回：

```typescript
if (sub.length > 0 && !foundCategory) {
    foundCategory = true;
    results.push(...sub);
    const promotedSiblings = dirs
      .filter((d) => d.name !== dir.name)
      .map((d) => ({ path: ..., name: d.name }));
    results.push(...promotedSiblings);
}
```

以 Inference/ 下 13 个子目录为例，优化后仅需 2 次 API 调用（列目录 + 检查第一个子目录的 SKILL.md），剩余 12 个直接提升为候选。

#### 3. `validateRepo` 轻量化

**修改文件**：
- `src/main/services/skill/gitcode-skill-source.service.ts`
- `src/main/services/skill/github-skill-source.service.ts`

验证阶段不再调用 `listSkillsFromRepo()`，改为：
1. 检查 `skills/` 目录 → 有则直接从目录列表计数（1 次 API）
2. 无 `skills/` → 采样最多 3 个根目录，探测第一个子目录是否含 SKILL.md，按比例估算总数（最多 ~5 次 API）

**效果**：验证从死锁/60-90 秒 → 5-10 秒完成。

### 涉及文件（预估）

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/main/services/skill/gitcode-skill-source.service.ts` | 修改 | `findSkillDirs` 短路 + `validateRepo` 轻量化 |
| `src/main/services/skill/github-skill-source.service.ts` | 修改 | 同步修改 GitHub 端 |
| `.project/modules/skill/features/skill-source/changelog.md` | 更新 | 追加变更记录 |
| `.project/modules/skill/features/skill-source/bugfix.md` | 更新 | 追加 bug 记录 |

### 开发前必读

| 分类 | 文档/文件 | 阅读目的 |
|------|----------|---------|
| 源码文件 | `src/main/services/skill/gitcode-skill-source.service.ts` | 理解 `findSkillDirs`（L336）、`listSkillsDir`（L317）、`listSkillsFromRepo`（L568）、`validateRepo`（L818）的实现逻辑 |
| 源码文件 | `src/main/services/skill/github-skill-source.service.ts` | 理解 GitHub 端同名函数实现，确认逻辑一致性 |
| 模块文档 | `.project/modules/skill/features/skill-source/changelog.md` | 了解最近变更，避免回归 |
| 模块文档 | `.project/modules/skill/features/skill-source/bugfix.md` | 了解已知问题，避免重复踩坑 |
| 模块文档 | `.project/modules/skill/features/skill-source/design.md` | 理解技能来源整体架构设计 |
| 编码规范 | `docs/Development-Standards-Guide.md` | TypeScript strict、命名规范 |

## 验收标准

- [ ] `AICO-Ascend/Ascend-Skills`（分类目录结构，根目录 3 子目录）添加时不再卡死，有进度条
- [ ] `Ascend/agent-skills`（有 `skills/` 目录）行为不变，仍走快速路径
- [ ] `validateRepo` 对分类目录仓库在 10 秒内返回，且 `skillCount > 0`
- [ ] `validateRepo` 对无技能仓库返回 `skillCount: 0` 和 error 信息
- [ ] GitCode 端和 GitHub 端行为一致
- [ ] `npm run typecheck && npm run lint && npm run build` 通过
- [ ] 新增/修改的用户可见文本已执行 `npm run i18n`（如无新增文本则跳过）
