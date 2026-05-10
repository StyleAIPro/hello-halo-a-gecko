# PRD [Bugfix] — 技能市场日志补充清理（warn 降级 + Raw stdout 删除）

| 字段 | 值 |
|------|------|
| 版本 | v1 |
| 日期 | 2026-05-07 |
| 指令人 | @misakamikoto |
| 模块 | main（Skill Market Service + Skill Controller + Remote Skill Manager） |
| 状态 | done |
| 优先级 | P2 |
| 影响范围 | 仅主进程日志输出 |

## 需求分析

### 背景

`bugfix-skill-market-log-noise-v1`（状态：done）已对技能市场 6 个文件的约 80 处 `console.log` 进行了 debug 降级，但 v1 的范围覆盖了 `github-skill-source.service.ts`、`gitcode-skill-source.service.ts`、`skill-manager.ts` 等文件，**未能完全清理**以下 3 个文件中残留的 `console.warn` 和部分 `console.log`。

### 问题

在用户正常使用技能市场时，以下 3 个文件仍会输出非致命的 `console.warn` 和噪声日志（如 stdout/stderr 转发、Raw stdout dump），干扰问题排查体验：

1. **`skill-market-service.ts`** — 4 处 `console.warn`（路径解析失败、PAT 未配置），这些属于正常降级场景，不是真正的警告
2. **`skill.controller.ts`** — 9 处 `console.warn`/`console.log`（stdout/stderr 转发、refresh 失败、超时中止、对话分析失败），均为非致命的内部处理日志
3. **`remote-skill-manager.ts`** — 3 处 `console.log`（批量命令执行信息 + Raw stdout dump），其中 Raw stdout 是用户明确要求删除的

### 期望行为

- 控制台只显示 `console.error`（真正的错误）
- 所有非致命的 `console.warn` 降级为 `console.debug`
- 用户明确要求的 `Raw stdout` 日志行整行删除
- 所有 `console.log`（stdout/stderr 转发、远程批量命令信息）降级为 `console.debug`

### 实际行为

- 正常浏览市场、安装技能、远程部署时仍输出 warn 级别日志
- 远程技能列表获取时输出 Raw stdout 内容 dump

## 技术方案

### 核心策略

| 原始级别 | 处理方式 | 理由 |
|---------|---------|------|
| `console.warn`（非致命） | 降为 `console.debug` | 正常降级/回退/超时场景，不是真正的警告 |
| `console.log`（stdout/stderr 转发） | 降为 `console.debug` | 进程输出转发，噪声大 |
| `console.log`（Raw stdout dump） | **整行删除** | 用户明确要求删除 |
| `console.error` | **保持不变** | 真正的错误，用户需要看到 |

### 逐文件修改方案

#### 文件 1：`src/main/services/skill/skill-market-service.ts`（4 处）

| 行号 | 当前日志 | 处理 | 理由 |
|------|---------|------|------|
| 576-582 | `console.warn('[SkillMarket] getSkillDetail: could not resolve path for ...')` | → `console.debug` | 路径解析失败是非致命情况，有 fallback 处理 |
| 585 | `console.warn('[SkillMarket] getSkillDetail: path resolution failed:', e.message)` | → `console.debug` | 同上，非致命 |
| 806 | `console.warn('[SkillMarketService] GitHub PAT not configured, listing without auth')` | → `console.debug` | 用户可能未配置 PAT，属于正常使用场景 |
| 904 | `console.warn('[SkillMarketService] GitCode PAT not configured, listing without auth')` | → `console.debug` | 同上 |

**统计**：4 处 `console.warn` → `console.debug`
**保留**：所有 `console.error`（skills.sh homepage error、API error、fetch 失败等）

#### 文件 2：`src/main/controllers/skill.controller.ts`（9 处）

| 行号 | 当前日志 | 处理 | 理由 |
|------|---------|------|------|
| 350 | `console.log('[SkillController] stdout:', content)` | → `console.debug` | stdout 转发，安装过程中噪声大 |
| 358 | `console.warn('[SkillController] stderr:', content)` | → `console.debug` | 已过滤 npm warn 的 stderr，非致命 |
| 395 | `console.warn('[SkillController] Failed to refresh skills:', refreshError)` | → `console.debug` | refresh 失败不致命，安装本身已成功 |
| 443 | `console.warn('[SkillController]', msg, '- aborting pending requests')` | → `console.debug` | 超时信息已在 onOutput 回调中通知用户 |
| 626 | `console.warn('[SkillController] Failed to download skill info for multi-target install:', e)` | → `console.debug` | 有 fallback 处理（返回 success: false） |
| 635-636 | `console.warn('[SkillController] Multi-target install timed out ...')` | → `console.debug` | 有 abort 逻辑处理超时 |
| 706 | `console.warn('[SkillController] Failed to refresh skills after multi-target install:', e)` | → `console.debug` | 安装已完成，refresh 失败不影响结果 |
| 781 | `console.warn('[SkillController] Failed to refresh skills after multi-target uninstall:', e)` | → `console.debug` | 卸载已完成，refresh 失败不影响结果 |
| 1434-1437 | `console.warn('[SkillController] Failed to analyze conversations ...')` | → `console.debug` | 有 fallback：create without analysis |

**统计**：1 处 `console.log` + 8 处 `console.warn` → `console.debug`，共 9 处
**保留**：所有 `console.error`

#### 文件 3：`src/main/services/remote/deploy/remote-skill-manager.ts`（3 处）

| 行号 | 当前日志 | 处理 | 理由 |
|------|---------|------|------|
| 69-70 | `console.log('[RemoteDeployService] Listing skills on ...')` | → `console.debug` | 远程操作过程日志，对用户无价值 |
| 73-74 | `console.log('[RemoteDeployService] Batch command result: exitCode=...')` | → `console.debug` | 批量命令执行详情，对用户无价值 |
| 77 | `console.log('[RemoteDeployService] Raw stdout (first 500 chars): ...')` | **删除整行** | 用户明确要求删除，Raw stdout dump 无任何调试价值 |

**统计**：2 处 `console.log` → `console.debug` + 1 行删除
**保留**：所有 `console.error`

### 不修改的文件

以下文件属于 skill 源层、推送层或已在 v1 中处理过，不在本 PRD 范围内：

| 文件 | 不修改理由 |
|------|-----------|
| `github-skill-source.service.ts` | skill 源层，非市场层，v1 已处理 |
| `gitcode-skill-source.service.ts` | 同上，v1 已处理 |
| `github-skill-push.ts` / `gitcode-skill-push.ts` | skill 推送操作，非市场浏览 |
| `gitcode-skill-fetch.ts` / `github-skill-fetch.ts` | skill 文件获取，非市场浏览 |
| `gitcode-skill-api.ts` | API 层，非市场层 |
| `skill-manager.ts` | v1 已处理 |
| `remote-deploy.service.ts` | v1 已处理（Batch command + Raw stdout 位于该文件的副本已删除） |

### 不做的事

- **不做全量 `createLogger` 替换**（与 v1 保持一致，纯降级操作）
- **不修改日志级别配置**（生产 info、开发 debug，保持不变）
- **不修改渲染进程代码**（仅涉及主进程服务端文件）
- **不新增日志系统组件**（纯日志级别调整）

## 开发前必读

### 模块设计文档

| # | 文件 | 阅读目的 |
|---|------|---------|
| 1 | `.project/prd/bugfix/skill/bugfix-skill-market-log-noise-v1.md` | 了解 v1 已完成的日志降级范围，避免重复工作 |
| 2 | `.project/modules/skill/features/skill-market/design.md` | 了解技能市场模块架构和日志使用约定 |
| 3 | `.project/modules/skill/features/skill-market/changelog.md` | 了解最近变更，避免回归 |

### 源码文件

| # | 文件路径 | 阅读目的 |
|---|---------|---------|
| 1 | `src/main/services/skill/skill-market-service.ts`（L576-585, L806, L904） | 确认 4 处 warn 的上下文和 fallback 逻辑 |
| 2 | `src/main/controllers/skill.controller.ts`（L350, L358, L395, L443, L626, L635, L706, L781, L1434） | 确认 9 处 warn/log 的上下文和 fallback 逻辑 |
| 3 | `src/main/services/remote/deploy/remote-skill-manager.ts`（L69-77） | 确认 3 处 log 的上下文，特别是 Raw stdout 行 |

### 编码规范

| # | 文档 | 阅读目的 |
|---|------|---------|
| 1 | `docs/Development-Standards-Guide.md` | 了解 TypeScript strict、编辑后 re-read 确认逻辑未被覆盖 |

## 涉及文件

| # | 文件路径 | 变更类型 | 说明 |
|---|---------|---------|------|
| 1 | `src/main/services/skill/skill-market-service.ts` | 修改 | 4 处 `console.warn` → `console.debug` |
| 2 | `src/main/controllers/skill.controller.ts` | 修改 | 1 处 `console.log` + 8 处 `console.warn` → `console.debug` |
| 3 | `src/main/services/remote/deploy/remote-skill-manager.ts` | 修改 | 2 处 `console.log` → `console.debug` + 1 行删除（Raw stdout） |

**合计**：14 处 `console.warn`/`console.log` → `console.debug` + 1 行删除

## 验收标准

### 日志降噪

- [ ] 浏览技能市场、查看技能详情时，控制台无 `[SkillMarket]` 前缀的 warn 级别日志（路径解析失败、PAT 未配置等降级为 debug）
- [ ] 安装/卸载技能时，控制台无 `[SkillController]` 前缀的 warn/log 级别日志（stdout/stderr 转发、refresh 失败、超时等降级为 debug）
- [ ] 多目标安装/卸载时，控制台无 `[SkillController]` 前缀的 warn 级别日志（download 失败、超时、refresh 失败等降级为 debug）
- [ ] 创建技能时（带对话分析），分析失败不输出 warn 级别日志
- [ ] 远程技能列表获取时，控制台无 `[RemoteDeployService] Batch command result` 和 `Raw stdout` 日志

### 功能完整性

- [ ] 所有 `console.error` 日志保持不变，真正的错误仍然正常输出
- [ ] 技能市场所有功能正常工作：列表加载、详情查看、安装、卸载、搜索
- [ ] 远程部署的技能列表获取功能正常工作
- [ ] skill.controller.ts 中的 `onOutput` 回调不受影响（只改 console 级别，不改回调逻辑）

### 代码质量

- [ ] `npm run typecheck && npm run build` 通过
- [ ] 编辑文件后执行了 re-read 确认逻辑未被覆盖（Windows 行尾问题）
- [ ] 应用正常启动，无崩溃或白屏

## 变更记录

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-05-07 | 初始版本：3 个文件 14 处 warn/log 降级 + 1 行 Raw stdout 删除 | @misakamikoto |
