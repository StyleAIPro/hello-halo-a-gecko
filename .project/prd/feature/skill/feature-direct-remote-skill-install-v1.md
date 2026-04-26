---
时间: 2026-04-25
状态: in-progress
指令人: @moonseeker1
PRD 级别: feature
---

# 功能名称

远程技能 Direct Upload 安装（支持 GitCode + GitHub fallback）

## 需求分析

### 背景

AICO-Bot 技能市场支持多目标安装（`installSkillMultiTarget`），用户可同时向本地和多个远程服务器安装技能。本地安装已具备完善的 fallback 机制（GitHub: npx + API 下载；GitCode: 直接 API 下载），但远程安装存在严重限制。

### 当前问题

| # | 问题 | 严重程度 | 说明 |
|---|------|---------|------|
| 1 | GitCode 技能无法远程安装 | Critical | `installRemoteSkill()` 硬编码 `npx skills add https://github.com/<repo>`，GitCode 源的技能无法安装到远程服务器 |
| 2 | 依赖远程 Node.js 环境 | Major | `npx skills add` 需要远程服务器安装 Node.js + npm + 网络访问 GitHub，缺少这些时安装静默失败 |
| 3 | 无 fallback 机制 | Major | 本地安装有 npx → API download 的 fallback，远程安装完全没有，npx 失败即失败 |
| 4 | 不传递 sourceType | Minor | `installSkillMultiTarget` 调用 `installRemoteSkill` 时只传 `remoteRepo` 和 `skillName`，未传 `sourceType`，远程无法区分来源 |

### 用户影响

- GitCode 技能市场用户无法将技能部署到远程服务器
- 无 Node.js 的远程服务器（如纯净 Linux 服务器）无法安装任何技能
- 远程安装失败率高于本地安装，用户体验不一致

## 技术方案

### 核心思路

**让远程安装复用本地的 SkillSourceAdapter 模式**：在本机通过 GitHub/GitCode API 下载技能文件到临时目录，然后通过 SSH base64 上传到远程服务器的 `~/.agents/skills/<skillId>/`（与 `syncLocalSkillToRemote` 类似，但不需要先本地安装）。

### 架构概览

```
现有流程（仅 GitHub npx）：
installSkillMultiTarget
    ↓ (remoteRepo, skillName)
installRemoteSkill
    ↓ SSH: npx skills add https://github.com/<repo>
    ↓ 失败 = 安装失败

新增流程（Direct Upload）：
installSkillMultiTarget
    ↓ (remoteRepo, skillName, sourceType, downloadResult)
installRemoteSkill  ← 新增参数: sourceType
    ├── GitHub + 远程有 Node.js → npx skills add（快速路径）
    ├── npx 失败 / GitCode / 无 Node.js → installRemoteSkillDirect
    │   ├── 本地: adapter.findSkillDirectoryPath()
    │   ├── 本地: adapter.fetchSkillDirectoryContents() → 写入临时目录
    │   ├── SSH: base64 上传到远程 ~/.agents/skills/<skillId>/
    │   └── 清理临时目录
    └── 全部失败 → 返回错误
```

### 1. RemoteDeployService — 重构 `installRemoteSkill`

**文件**：`src/main/services/remote-deploy/remote-deploy.service.ts`

修改方法签名，新增 `sourceType` 和可选的预下载文件参数：

```typescript
async installRemoteSkill(
  id: string,
  skillId: string,
  remoteRepo: string,
  skillName: string,
  onOutput?: (data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => void,
  options?: {
    sourceType?: 'github' | 'gitcode' | 'skills.sh';
    preDownloadedFiles?: Array<{ path: string; content: string }>;
  },
): Promise<{ success: boolean; error?: string }>
```

**决策逻辑**：

1. 如果 `sourceType === 'github'`（或未指定/`'skills.sh'`）：先尝试原有 `npx skills add` 方式
   - 成功 → 返回
   - 失败 → fallback 到 `installRemoteSkillDirect()`
2. 如果 `sourceType === 'gitcode'`：跳过 npx，直接走 `installRemoteSkillDirect()`
3. 如果提供了 `preDownloadedFiles`：直接上传到远程，无需再次下载

### 2. RemoteDeployService — 新增 `installRemoteSkillDirect`

**文件**：`src/main/services/remote-deploy/remote-deploy.service.ts`

新增私有方法 `installRemoteSkillDirect()`，在本机通过 adapter 下载技能文件并 SSH 上传到远程服务器：

```typescript
private async installRemoteSkillDirect(
  id: string,
  skillId: string,
  remoteRepo: string,
  skillName: string,
  sourceType: 'github' | 'gitcode' | 'skills.sh',
  onOutput?: (data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => void,
  signal?: AbortSignal,
): Promise<{ success: boolean; error?: string }>
```

**实现步骤**：

1. 获取服务器配置 + 建立 SSH 连接（复用 `ensureFreshConnection`）
2. 通过 `sourceType` 选择对应的 adapter（`GITHUB_ADAPTER` 或 `GITCODE_ADAPTER`）
3. 在本机调用 `adapter.findSkillDirectoryPath()` 定位技能目录
4. 在本机调用 `adapter.fetchSkillDirectoryContents()` 下载所有文件
5. 下载文件写入本地临时目录（`os.tmpdir()/aico-skill-upload-<timestamp>/`）
6. SSH 执行 `mkdir -p ~/.agents/skills/<skillId>/`
7. 逐文件 base64 编码后通过 SSH 写入远程（复用 `syncLocalSkillToRemote` 的 base64 模式）
8. 清理本地临时目录
9. 通过 `onOutput` 回调报告每个文件的进度

**注意**：adapter（`findSkillDirectoryPath` / `fetchSkillDirectoryContents`）的引用从 `skill.controller.ts` 导出或提取为共享模块，确保 `remote-deploy.service.ts` 能调用。考虑到 adapter 是在 `skill.controller.ts` 中定义的闭包函数，最简方案是将 adapter 的核心调用逻辑内联或提取为独立函数。

### 3. SkillController — 修改 `installSkillMultiTarget`

**文件**：`src/main/controllers/skill.controller.ts`

在远程安装分支中传递 `sourceType` 给 `installRemoteSkill`：

```typescript
// 当前代码（line 594-601）
const result = await remoteDeployService.installRemoteSkill(
  target.serverId,
  skillId,
  remoteRepo,
  skillName,
  remoteOnOutput,
);

// 修改为
const result = await remoteDeployService.installRemoteSkill(
  target.serverId,
  skillId,
  remoteRepo,
  skillName,
  remoteOnOutput,
  { sourceType: downloadResult.sourceType },
);
```

### 4. 导出 Adapter 核心逻辑

**文件**：`src/main/controllers/skill.controller.ts` + `src/main/services/remote-deploy/remote-deploy.service.ts`

为避免 `remote-deploy.service.ts` 直接依赖 `skill.controller.ts`（循环依赖风险），将 adapter 类型定义和实例导出为共享模块。两种方案：

**方案 A（推荐）**：在 `skill.controller.ts` 中将 `GITHUB_ADAPTER` 和 `GITCODE_ADAPTER` 以及 `SkillSourceAdapter` 类型导出，`remote-deploy.service.ts` 按需动态 import：

```typescript
// skill.controller.ts — 导出
export type { SkillSourceAdapter };
export { GITHUB_ADAPTER, GITCODE_ADAPTER };

// remote-deploy.service.ts — 动态 import
const { GITHUB_ADAPTER, GITCODE_ADAPTER } = await import('../controllers/skill.controller');
```

**方案 B**：提取 adapter 到独立的 `src/main/services/skill/skill-source-adapter.ts` 文件，两个模块共同引用。

### 5. 超时与取消

- Direct upload 路径应支持 `AbortSignal`，超时时取消本地的 API 下载请求
- SSH 上传阶段使用 `executeWithTimeout` 防止单个文件上传卡死

## 开发前必读

| 类别 | 文件路径 | 阅读目的 |
|------|---------|---------|
| 模块设计文档 | `.project/modules/skill/skill-system-v1.md` | 理解技能系统整体架构和模块职责 |
| 功能设计文档 | `.project/modules/skill/features/skill-market/design.md` | 理解技能安装流程（含远程安装部分）和 IPC 通道 |
| 功能设计文档 | `.project/modules/skill/features/skill-source/design.md` | 理解技能源管理（GitHub/GitCode）的职责划分 |
| 功能变更记录 | `.project/modules/skill/features/skill-source/changelog.md` | 了解技能源最近的 bug 修复（SKIP_DIRS、AbortSignal 透传等） |
| 功能变更记录 | `.project/modules/skill/features/skill-market/changelog.md` | 了解技能市场最近的 bug 修复（安装超时、级联失败等） |
| 源码文件 | `src/main/controllers/skill.controller.ts` | 核心文件：`SkillSourceAdapter` 定义、`installSkillMultiTarget`、`installSkillFromSource` 实现 |
| 源码文件 | `src/main/services/remote-deploy/remote-deploy.service.ts` (line 3726-3866) | `installRemoteSkill` + `syncLocalSkillToRemote` 实现 |
| 源码文件 | `src/main/services/skill/github-skill-source.service.ts` | GitHub adapter 核心方法：`findSkillDirectoryPath`、`fetchSkillDirectoryContents` |
| 源码文件 | `src/main/services/skill/gitcode-skill-source.service.ts` | GitCode adapter 核心方法：`findSkillDirectoryPath`、`fetchSkillDirectoryContents` |
| 已有 PRD | `.project/prd/feature/skill/sync-from-remote-v1.md` | 参考类似功能（远端文件同步）的 IPC 通道和实现模式 |
| 编码规范 | `docs/Development-Standards-Guide.md` | TypeScript strict、IPC 通道常量化、命名规范 |
| 文档管理 | `docs/vibecoding-doc-standard.md` | PRD 格式、变更记录更新规范 |

## 涉及文件

| # | 文件 | 改动类型 | 说明 |
|---|------|---------|------|
| 1 | `src/main/services/remote-deploy/remote-deploy.service.ts` | 修改 + 新增 | 重构 `installRemoteSkill` 新增 `options.sourceType` 参数 + 新增 `installRemoteSkillDirect` 私有方法（本机 API 下载→SSH 上传） |
| 2 | `src/main/controllers/skill.controller.ts` | 修改 | 导出 `SkillSourceAdapter` 类型 + `GITHUB_ADAPTER`/`GITCODE_ADAPTER` 实例 + `installSkillMultiTarget` 传递 `sourceType` |

> **实际**：无需修改 IPC 通道、preload、renderer API 或前端 UI。`skill:install-multi` 的 IPC 接口和前端调用方式不变，只是远程安装内部实现从 "npx only" 变为 "npx + direct upload fallback"。

## 验收标准

- [x] **GitCode 远程安装**：从 GitCode 源安装技能到远程服务器，走 Direct Upload，文件完整（SKILL.md + META.json + 其他文件）
- [x] **GitHub 远程安装（npx 成功）**：从 GitHub 源安装技能到有 Node.js 的远程服务器，优先走 npx 路径且成功
- [x] **GitHub 远程安装（npx 失败 fallback）**：从 GitHub 源安装技能到无 Node.js 的远程服务器，自动 fallback 到 direct upload 并成功
- [x] **本地安装不受影响**：本地安装流程（npx + fallback）行为不变，无回归
- [x] **多目标并行安装**：同时选择本地 + 远程安装，两者并行执行互不干扰
- [x] **进度输出**：direct upload 过程中前端能看到文件下载和上传进度
- [x] **临时文件清理**：finally 块中清理本地临时目录
- [x] **超时处理**：SSH 上传使用 `executeWithTimeout` 30s 防卡死
- [x] **`npm run build` 通过**
- [ ] **`npm run typecheck` 通过**
- [ ] **`npm run lint` 通过**
- [ ] **`npm run build` 通过**
