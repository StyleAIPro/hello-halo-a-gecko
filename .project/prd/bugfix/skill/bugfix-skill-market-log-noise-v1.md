# PRD [Bug 修复级] — 技能市场日志降噪

> 版本：bugfix-skill-market-log-noise-v1
> 日期：2026-05-06
> 指令人：用户
> 归属模块：modules/skill
> 严重程度：Minor（功能正常，但控制台日志噪音严重影响用户体验和问题排查效率）
> 所属功能：features/skill-market + features/skill-source + features/remote-deploy
> 状态：done
> 优先级：P1

## 问题描述

技能市场相关模块包含约 123 条 `console.log` / `console.warn` 语句，分布在 7 个文件中。这些日志在用户正常浏览市场、查看技能详情、安装技能、以及 GitCode/GitHub API 操作时会大量输出到控制台，形成"日志墙"，严重干扰用户体验和问题排查。

- **期望行为**：用户在正常使用技能市场时，控制台只显示实际错误（`console.error`），不显示内部处理过程的常规日志
- **实际行为**：每次加载市场列表、点击技能详情、安装技能时，控制台输出数十行内部处理日志（API 请求详情、目录扫描进度、文件下载过程等），淹没真正的错误信息

## 根因分析

技能市场在开发调试阶段使用了大量 `console.log` 记录内部处理过程，未在生产环境中做日志级别区分。所有内部处理日志与真正的错误日志混在同一级别输出，导致：

1. **正常操作产生大量日志**：市场列表加载、技能详情获取、安装流程中的每个步骤都有 `console.log` 输出
2. **警告级别滥用**：`console.warn` 用于记录正常的降级/回退操作（如分支回退、缓存未命中），这些不是真正的警告
3. **远程部署服务日志泄露**：`remote-deploy.service.ts` 中的批量命令结果和原始 stdout 输出对用户无价值
4. **技能管理器初始化日志**：`skill-manager.ts` 初始化时输出所有已加载技能的列表，属于调试信息

## 技术方案

### 核心策略

统一降级技能市场相关模块中的日志级别：

| 原始级别 | 处理方式 | 理由 |
|---------|---------|------|
| `console.log` | 降为 `console.debug` | 内部处理过程，仅在开发环境可见 |
| `console.warn` | 降为 `console.debug` | 正常降级/回退操作，不是真正的警告 |
| `console.error` | **保持不变** | 真正的错误，用户需要看到 |

> 注意：当前日志系统配置 `log.transports.file.level = 'info'`，`console.debug` 不会写入日志文件，但仍可在开发控制台中通过 `DEBUG=*` 查看。

### 逐文件修改方案

#### 文件 1：`src/main/services/skill/skill-market-service.ts`

| 操作 | 行号（约） | 当前内容 | 修改后 |
|------|-----------|---------|--------|
| 降级 | 244 | `console.log('[SkillMarket] Starting skill fetch...')` | `console.debug(...)` |
| 降级 | 270 | `console.log('[SkillMarket] Fetching from source...')` | `console.debug(...)` |
| 降级 | 301 | `console.log('[SkillMarket] Validating source...')` | `console.debug(...)` |
| 降级 | 304 | `console.log('[SkillMarket] Source valid...')` | `console.debug(...)` |
| 降级 | 312-314 | `console.log('[SkillMarket] Source config...')` | `console.debug(...)` |
| 降级 | 408 | `console.log('[SkillMarket] Downloading skill...')` | `console.debug(...)` |
| 降级 | 419 | `console.log('[SkillMarket] Download progress...')` | `console.debug(...)` |
| 降级 | 444 | `console.log('[SkillMarket] Download complete...')` | `console.debug(...)` |
| 降级 | 481 | `console.log('[SkillMarket] Listing skills...')` | `console.debug(...)` |
| 降级 | 502 | `console.log('[SkillMarket] Skills found...')` | `console.debug(...)` |
| 降级 | 524 | `console.log('[SkillMarket] Fetching content...')` | `console.debug(...)` |
| 降级 | 549 | `console.log('[SkillMarket] Content fetched...')` | `console.debug(...)` |
| 降级 | 557 | `console.log('[SkillMarket] Installing...')` | `console.debug(...)` |
| 降级 | 561 | `console.log('[SkillMarket] Install complete...')` | `console.debug(...)` |
| 降级 | 565 | `console.log('[SkillMarket] Install progress...')` | `console.debug(...)` |
| 降级 | 574 | `console.log('[SkillMarket] Uninstalling...')` | `console.debug(...)` |
| 降级 | 585 | `console.log('[SkillMarket] Uninstall complete...')` | `console.debug(...)` |
| 降级 | 589 | `console.log('[SkillMarket] Install status...')` | `console.debug(...)` |
| 降级 | 670-672 | `console.log('[SkillMarket] Category...')` | `console.debug(...)` |
| 降级 | 727 | `console.log('[SkillMarket] Search...')` | `console.debug(...)` |
| 降级 | 576-582 | `console.warn('[SkillMarket] ...')` | `console.debug(...)` |
| 降级 | 806 | `console.warn('[SkillMarket] ...')` | `console.debug(...)` |
| 降级 | 904 | `console.warn('[SkillMarket] ...')` | `console.debug(...)` |

**统计**：18 处 `console.log` 降级 + 3 处 `console.warn` 降级 = 21 处修改
**保留**：7 处 `console.error` 不变

#### 文件 2：`src/main/controllers/skill.controller.ts`

| 操作 | 行号（约） | 修改说明 |
|------|-----------|---------|
| 降级 | 98-104 | `console.log` 列表加载日志 |
| 降级 | 134 | `console.log` 技能详情日志 |
| 降级 | 146 | `console.log` 技能内容日志 |
| 降级 | 285 | `console.log` 安装流程日志 |
| 降级 | 298-301 | `console.log` 安装详情日志 |
| 降级 | 336 | `console.log` 下载进度日志 |
| 降级 | 350 | `console.log` 卸载流程日志 |
| 降级 | 387 | `console.log` 安装结果日志 |
| 降级 | 1372-1375 | `console.log` 远程安装日志 |
| 降级 | 358 | `console.warn` 降级 |
| 降级 | 395 | `console.warn` 降级 |
| 降级 | 443 | `console.warn` 降级 |
| 降级 | 626 | `console.warn` 降级 |
| 降级 | 635-638 | `console.warn` 降级 |
| 降级 | 706 | `console.warn` 降级 |
| 降级 | 768 | `console.warn` 降级 |
| 降级 | 1421-1424 | `console.warn` 远程安装降级 |

**统计**：约 10 处 `console.log` 降级 + 约 10 处 `console.warn` 降级 = 约 20 处修改
**保留**：所有 `console.error` 不变

#### 文件 3：`src/main/services/skill/github-skill-source.service.ts`

| 操作 | 行号（约） | 修改说明 |
|------|-----------|---------|
| 降级 | 108 | `console.log` GitHub API 请求日志 |
| 降级 | 110-112 | `console.log` 分支探测日志 |
| 降级 | 121 | `console.log` 验证结果日志 |
| 降级 | 800 | `console.log` 目录扫描日志 |
| 降级 | 819 | `console.log` 仓库验证日志 |
| 降级 | 834 | `console.log` 验证结果日志 |
| 降级 | 859 | `console.log` 技能目录查找日志 |
| 降级 | 862 | `console.log` 路径匹配日志 |
| 降级 | 869-871 | `console.log` 目录遍历日志 |
| 降级 | 879 | `console.log` 文件内容获取日志 |
| 降级 | 915 | `console.log` 技能列表日志 |
| 降级 | 114-117 | `console.warn` API 错误降级 |
| 降级 | 825 | `console.warn` 仓库验证降级 |
| 降级 | 947 | `console.warn` 降级 |

**统计**：11 处 `console.log` 降级 + 3 处 `console.warn` 降级 = 14 处修改
**保留**：所有 `console.error` 不变

#### 文件 4：`src/main/services/skill/gitcode-skill-source.service.ts`

| 操作 | 行号（约） | 修改说明 |
|------|-----------|---------|
| 降级 | 156 | `console.log` GitCode API 请求日志 |
| 降级 | 434 | `console.log` 目录扫描日志 |
| 降级 | 448 | `console.log` 技能目录查找日志 |
| 降级 | 458-465 | `console.log` 文件内容获取日志 |
| 降级 | 489 | `console.log` 技能列表日志 |
| 降级 | 721 | `console.log` 仓库验证日志 |
| 降级 | 728-735 | `console.log` 验证详情日志 |
| 降级 | 206-208 | `console.warn` API 错误降级 |
| 降级 | 409 | `console.warn` 目录查找降级 |
| 降级 | 440 | `console.warn` 路径匹配降级 |
| 降级 | 454 | `console.warn` 文件获取降级 |
| 降级 | 495 | `console.warn` 降级 |
| 降级 | 919 | `console.warn` 降级 |
| 降级 | 922 | `console.warn` 降级 |
| 降级 | 1023 | `console.warn` 降级 |
| 降级 | 1025 | `console.warn` 降级 |
| 降级 | 1064 | `console.warn` 降级 |
| 降级 | 1076 | `console.warn` 降级 |
| 降级 | 1082 | `console.warn` 降级 |

**统计**：约 10 处 `console.log` 降级 + 11 处 `console.warn` 降级 = 约 21 处修改
**保留**：所有 `console.error` 不变
**注意**：lines 180, 399, 405, 413, 417, 596 已是 `console.debug`，无需修改

#### 文件 5：`src/main/services/remote-deploy/remote-deploy.service.ts`

| 操作 | 行号（约） | 修改说明 |
|------|-----------|---------|
| **删除** | ~3549 | `console.log('[RemoteDeployService] Batch command result: exitCode=...')` |
| **删除** | ~3551 | `console.log('[RemoteDeployService] Raw stdout (first 500 chars): ...')` |

**统计**：删除 2 行
**理由**：批量命令结果和原始 stdout 输出属于调试信息，对用户完全无价值，直接删除

#### 文件 6：`src/main/services/skill/skill-manager.ts`

| 操作 | 行号（约） | 修改说明 |
|------|-----------|---------|
| 降级 | 62-68 | `console.log` 初始化日志（`Initialized with N skills`）→ `console.debug` |
| 降级 | 123 | `console.warn` 解析失败日志（`Failed to parse skill`）→ `console.debug` |

**保留（不修改）**：
- line 424: `console.log` 安装技能 — 用户实际操作
- line 443: `console.log` 卸载技能 — 用户实际操作
- line 469: `console.log` 切换技能启用状态 — 用户实际操作
- 所有 `console.error` — 真正的错误

**统计**：1 处 `console.log` 降级 + 1 处 `console.warn` 降级 = 2 处修改

### 不需要修改的日志

以下日志保持原级别不变：

| 文件 | 级别 | 理由 |
|------|------|------|
| 所有文件 | `console.error` | 真正的错误和异常，用户需要看到 |
| `skill-manager.ts` L424 | `console.log`（安装技能） | 用户实际操作，具有审计价值 |
| `skill-manager.ts` L443 | `console.log`（卸载技能） | 用户实际操作，具有审计价值 |
| `skill-manager.ts` L469 | `console.log`（切换启用状态） | 用户实际操作，具有审计价值 |
| `gitcode-skill-source.service.ts` L180,399,405,413,417,596 | 已是 `console.debug` | 无需修改 |

### 不做的事

- **不做全量 `createLogger` 替换**（与 `feat-log-noise-reduction-v1` PRD 保持一致，不做大规模重写）
- **不修改日志级别配置**（生产 info、开发 debug，保持不变）
- **不修改渲染进程代码**（仅涉及主进程服务端文件）
- **不新增日志文件或日志系统组件**（纯日志级别降级）

## 开发前必读

### 模块设计文档

| # | 文件 | 阅读目的 |
|---|------|---------|
| 1 | `.project/modules/skill/features/skill-market/design.md` | 了解技能市场模块架构和日志使用约定 |
| 2 | `.project/modules/skill/features/skill-source/design.md` | 了解 GitHub/GitCode skill source 的实现设计 |
| 3 | `.project/modules/skill/features/skill-market/changelog.md` | 了解最近变更，避免回归 |
| 4 | `.project/modules/skill/features/skill-market/bugfix.md` | 了解已知问题，避免重复踩坑 |
| 5 | `.project/modules/skill/features/skill-source/changelog.md` | 了解 skill source 最近变更 |
| 6 | `.project/modules/skill/features/skill-source/bugfix.md` | 了解 skill source 已知问题 |

### 源码文件

| # | 文件路径 | 阅读目的 |
|---|---------|---------|
| 1 | `src/main/services/skill/skill-market-service.ts` | 确认所有 `console.log`/`console.warn`/`console.error` 位置 |
| 2 | `src/main/controllers/skill.controller.ts` | 确认所有日志位置和级别 |
| 3 | `src/main/services/skill/github-skill-source.service.ts` | 确认 GitHub API 相关日志位置 |
| 4 | `src/main/services/skill/gitcode-skill-source.service.ts` | 确认 GitCode API 相关日志位置 |
| 5 | `src/main/services/remote-deploy/remote-deploy.service.ts` (line ~3549-3551) | 确认待删除的两行 Raw stdout 日志 |
| 6 | `src/main/services/skill/skill-manager.ts` | 确认初始化日志和用户操作日志的区分 |

### API 文档

| # | 文件 | 阅读目的 |
|---|------|---------|
| 1 | `.project/modules/skill/skill-system-v1.md` | 了解技能系统整体架构 |

### 编码规范

| # | 文档 | 阅读目的 |
|---|------|---------|
| 1 | `docs/Development-Standards-Guide.md` | 了解 TypeScript strict、命名规范、编辑后 eslint --fix 流程 |

## 涉及文件

| # | 文件路径 | 变更类型 | 说明 |
|---|---------|---------|------|
| 1 | `src/main/services/skill/skill-market-service.ts` | 修改 | 18 处 `console.log` + 3 处 `console.warn` 降为 `console.debug` |
| 2 | `src/main/controllers/skill.controller.ts` | 修改 | 约 10 处 `console.log` + 约 10 处 `console.warn` 降为 `console.debug` |
| 3 | `src/main/services/skill/github-skill-source.service.ts` | 修改 | 11 处 `console.log` + 3 处 `console.warn` 降为 `console.debug` |
| 4 | `src/main/services/skill/gitcode-skill-source.service.ts` | 修改 | 约 10 处 `console.log` + 11 处 `console.warn` 降为 `console.debug` |
| 5 | `src/main/services/remote-deploy/remote-deploy.service.ts` | 修改 | 删除 2 行 `console.log`（Batch command result + Raw stdout） |
| 6 | `src/main/services/skill/skill-manager.ts` | 修改 | 1 处 `console.log` + 1 处 `console.warn` 降为 `console.debug` |

## 验收标准

### 日志降噪

- [ ] 浏览技能市场列表时，控制台无 `[SkillMarket]` 前缀的 `log`/`warn` 级别日志输出
- [ ] 查看技能详情时，控制台无技能内容获取相关的 `log`/`warn` 级别日志输出
- [ ] 安装技能时，控制台无 API 请求详情、目录扫描、文件下载过程的 `log`/`warn` 级别日志输出
- [ ] 卸载技能时，控制台无内部处理过程的 `log`/`warn` 级别日志输出
- [ ] GitHub 源操作时，控制台无 `github-skill-source` 相关的 `log`/`warn` 级别日志输出
- [ ] GitCode 源操作时，控制台无 `gitcode-skill-source` 相关的 `log`/`warn` 级别日志输出
- [ ] 远程部署时，控制台不再出现 `[RemoteDeployService] Batch command result` 和 `Raw stdout` 日志
- [ ] `skill-manager.ts` 初始化时不再输出 `Initialized with N skills` 的 info 级别日志

### 功能完整性

- [ ] 所有 `console.error` 日志保持不变，真正的错误仍然正常输出
- [ ] 用户安装/卸载/切换技能时，`skill-manager.ts` 的用户操作日志（L424, L443, L469）保持 `console.log` 输出
- [ ] 技能市场所有功能正常工作：列表加载、详情查看、安装、卸载、搜索
- [ ] GitHub/GitCode 源的技能获取功能正常工作

### 代码质量

- [ ] `npm run typecheck && npm run lint && npm run build` 通过
- [ ] 编辑文件后执行了 `npx eslint --fix <file>` 并 re-read 确认逻辑未被覆盖
- [ ] 应用正常启动，无崩溃或白屏

## 变更记录

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-05-06 | 初始版本：技能市场 6 个文件约 80 处日志降级 + 2 行删除 | 用户 |
