# PRD [Bug 修复级] — Hyper Space 接口重复定义导致构建警告

> 版本：bugfix-hyper-space-duplicate-key-v1
> 日期：2026-04-17
> 指令人：@MoonSeeker
> 反馈人：@MoonSeeker
> 归属模块：modules/space
> 严重程度：Minor

## 问题描述
- **期望行为**：`src/preload/index.ts` 和 `src/renderer/api/index.ts` 中每个 Hyper Space 接口只定义一次，构建无警告
- **实际行为**：`createHyperSpace` 和 `getHyperSpaceStatus` 在两个文件中各被定义了两次，构建时出现 "Duplicate key" 警告
- **复现步骤**：
  1. 执行 `npm run build` 或 `npm run typecheck`
  2. 观察构建输出中的 "Duplicate identifier" / "Duplicate key" 警告

## 根因分析

两个文件中各存在两组 Hyper Space 接口定义，是功能迭代过程中旧版本定义未清理导致的。

### `src/preload/index.ts`

| 定义 | 位置 | 注释 | 参数 |
|------|------|------|------|
| 第一组（旧） | 第 781-782 行 | `// Hyper Space` | `input` |
| 第二组（新） | 第 1296-1297 行 | `// Hyper Space (Multi-Agent Collaboration)` | `params`（同名但参数名不同） |

两组均调用相同的 IPC 通道（`hyper-space:create` 和 `hyper-space:get-status`），功能完全重复。

### `src/renderer/api/index.ts`

| 定义 | 位置 | 注释 | HTTP 端点 | 参数 |
|------|------|------|-----------|------|
| 第一组（旧） | 第 231-250 行 | `// ===== Hyper Space =====` | `/api/spaces/hyper` 和 `/api/spaces/{id}/hyper-status` | 参数较少（`name, icon, customPath, spaceType, agents, orchestration`） |
| 第二组（新） | 第 2796-2829 行 | `// ===== Hyper Space (Multi-Agent Collaboration) =====` | `/api/hyper-space/create` 和 `/api/hyper-space/{id}/status` | 参数更完整（增加了 `remoteServerId, remotePath, useSshTunnel`） |

第二组是 Multi-Agent Collaboration 功能升级后的完整版本，HTTP 端点和参数都更完善。

## 修复方案

删除两个文件中较早的重复定义（第一组），保留后面的更完整版本（第二组）。

### 修改 1：`src/preload/index.ts` — 删除第 780-782 行

删除 `// Hyper Space` 注释下的 `createHyperSpace` 和 `getHyperSpaceStatus` 两行定义：

```typescript
// 删除以下内容（第 780-782 行）：
  // Hyper Space
  createHyperSpace: (input) => ipcRenderer.invoke('hyper-space:create', input),
  getHyperSpaceStatus: (spaceId) => ipcRenderer.invoke('hyper-space:get-status', spaceId),
```

保留第 1295-1297 行的完整版本。

### 修改 2：`src/renderer/api/index.ts` — 删除第 230-250 行

删除 `// ===== Hyper Space =====` 注释下的 `createHyperSpace` 和 `getHyperSpaceStatus` 两个方法定义：

```typescript
// 删除以下内容（第 230-250 行）：
  // ===== Hyper Space =====
  createHyperSpace: async (input: { ... }): Promise<ApiResponse> => { ... },
  getHyperSpaceStatus: async (spaceId: string): Promise<ApiResponse> => { ... },
```

保留第 2791-2829 行的完整版本。

## 影响范围
- [ ] 涉及 API 变更 → 无（仅删除重复定义，保留的版本不变）
- [ ] 涉及数据结构变更 → 无
- [x] 涉及功能设计变更 → 无（修复重复定义 bug，不改变功能设计）

## 验证方式

1. 执行 `npm run build`，确认构建输出中不再有 "Duplicate key" / "Duplicate identifier" 警告
2. 执行 `npm run typecheck`，确认类型检查通过
3. 执行 `npm run lint`，确认无 lint 错误
4. 在开发模式下验证 Hyper Space 的创建和状态查询功能正常

## 变更
| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-17 | 初始 PRD | @MoonSeeker |
