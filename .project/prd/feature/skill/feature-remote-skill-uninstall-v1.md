---
时间: 2026-05-04
状态: in-progress
指令人: @moonseeker1
PRD 级别: feature
---

# 功能名称

远程服务器 Skill 卸载完善

## 需求分析

### 背景

AICO-Bot 支持通过 `skill:uninstall-multi` IPC 通道从本地和远程服务器卸载技能。`SkillMarket.tsx` 中已有远程卸载的 UI 入口（环境行中的 `Remove` 按钮），`remote-deploy.service.ts` 中已有 `uninstallRemoteSkill()` 方法。但远程卸载功能**不完整**，会导致卸载后远程 Agent 仍能使用已删除的技能。

### 当前问题

| # | 问题 | 严重程度 | 说明 |
|---|------|---------|------|
| 1 | Symlink 残留 | P0 | `uninstallRemoteSkill()` 只删除 `~/.agents/skills/<skillId>` 和 `~/.claude/skills/<skillId>`，不清理 `~/.agents/claude-config/skills/<skillId>` 下的 symlink，SDK 仍能通过 symlink 发现并使用已删除的技能 |
| 2 | 无 proxy 重载机制 | P0 | 卸载后远程 proxy（`remote-agent-proxy`）不会重新加载 skill 配置。如果有活跃 SDK session，技能仍缓存在内存中。`buildSdkOptions()` 中的 symlink 清理和重建只在**新会话创建时**执行，已有会话不受影响 |
| 3 | 无卸载确认 | P1 | `SkillMarket.tsx` 中远程卸载按钮点击后直接执行，无确认对话框。远程操作不可逆，用户可能误操作 |
| 4 | SkillLibrary 远程视图无卸载入口 | P1 | `SkillLibrary.tsx` 中远程技能详情面板只有「Download to Local」和「View Skill Files」按钮，没有卸载按钮。用户只能从 SkillMarket 卸载远程技能 |

### 根因分析

1. **Symlink 残留**：`uninstallRemoteSkill()` 只执行了 `rm -rf` 删除源目录，而 `claude-manager.ts` 的 `buildSdkOptions()` 会在 `~/.agents/claude-config/skills/` 下创建指向源目录的 symlink。删除源目录后 symlink 变为悬空（dangling），但不会被自动清理（清理逻辑只在 `buildSdkOptions` 运行时触发）。
2. **无 proxy 重载**：当前远程 proxy 的 `ClientMessage` 类型不支持 skill 重载命令。`buildSdkOptions()` 在每次创建新会话时会重建 symlink，但已有会话中的技能列表是在会话创建时注入到 system prompt 的，卸载后不会更新。
3. **无确认对话框**：`handleUninstallFromTarget()` 直接调用 `api.skillUninstallMulti()`，没有弹出确认。
4. **SkillLibrary UI 缺失**：`SkillDetail` 组件在 `isRemote` 模式下不渲染操作按钮区域（只有 `isRemote` 为 false 时才显示 toggle/export/uninstall 按钮）。

## 技术方案

### 核心思路

1. **完善后端卸载逻辑**：在 `uninstallRemoteSkill()` 中增加 symlink 清理（通过 SSH 命令）
2. **提供 proxy 重载机制**：卸载后通过 SSH 重启远程 proxy 进程（复用已有的 `restartAgentWithNewConfig()`），使下次会话创建时重新扫描 skill 目录
3. **增加卸载确认对话框**：在 `SkillMarket.tsx` 中增加确认弹窗
4. **增加 SkillLibrary 卸载入口**：在远程技能详情面板增加卸载按钮

### 架构概览

```
当前流程（不完整）：
SkillMarket handleUninstallFromTarget
    ↓ api.skillUninstallMulti()
uninstallSkillMultiTarget (controller)
    ↓ uninstallRemoteSkill (service)
    ↓ SSH: rm -rf ~/.agents/skills/<id> && rm -rf ~/.claude/skills/<id>
    × symlink 残留、proxy 未重载

修复后流程：
SkillMarket / SkillLibrary
    ↓ 确认对话框
    ↓ api.skillUninstallMulti()
uninstallSkillMultiTarget (controller)
    ↓ uninstallRemoteSkill (service) ← 完善
    │   ├── SSH: rm -rf ~/.agents/skills/<id>
    │   ├── SSH: rm -rf ~/.claude/skills/<id>
    │   ├── SSH: rm -f ~/.agents/claude-config/skills/<id>  ← 新增
    │   └── SSH: 清理 .claude/skills 下的悬空链接           ← 新增
    ↓ restartAgentIfRunning (service) ← 新增调用
    ↓ SSH: 停止 proxy + 启动 proxy
    ↓ 刷新远程 skill 列表
```

### 1. 完善 `uninstallRemoteSkill()` — symlink 清理

**文件**：`src/main/services/remote-deploy/remote-deploy.service.ts`（line 4356）

在现有 `rm -rf` 命令之后，增加 symlink 清理逻辑：

```typescript
// 现有：删除源目录
const removeCmd = [
  `rm -rf ${remoteHome}/.agents/skills/${skillId}`,
  `rm -rf ${remoteHome}/.claude/skills/${skillId}`,
].join(' && ');

// 新增：清理 symlink（使用 -f 避免目标不存在时报错）
const cleanSymlinksCmd = [
  `rm -f ${remoteHome}/.agents/claude-config/skills/${skillId}`,
  // 清理 .claude/skills 目录下可能的悬空链接
  // find + xargs 只删除指向已删除目录的 symlink
  `find ${remoteHome}/.agents/claude-config/.claude/skills/ -maxdepth 1 -type l ! -exec test -e {} \\; -delete 2>/dev/null || true`,
].join(' && ');
```

将两个命令合并执行（或顺序执行），确保源目录和 symlink 均被清理。

### 2. 新增 `restartAgentIfRunning()` — proxy 重载

**文件**：`src/main/services/remote-deploy/remote-deploy.service.ts`

新增方法 `restartAgentIfRunning()`，在卸载后重启远程 proxy（如果正在运行）：

```typescript
async restartAgentIfRunning(
  id: string,
  onOutput?: (data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => void,
): Promise<void>
```

**实现逻辑**：

1. 通过 SSH 检查 proxy 进程是否在运行（复用 `restartAgentWithNewConfig` 中的 `pgrep -f` 检查）
2. 如果正在运行：调用已有的 `stopAgent(id)` + `startAgent(id)` 重启
3. 如果未运行：跳过（下次启动时会自动重建 symlink）
4. 通过 `onOutput` 输出重启状态

**为什么选择重启而非 WebSocket 命令重载**：

- 远程 proxy 当前没有 skill 重载的 WebSocket 命令，新增命令需要修改 `ClientMessage` 类型、`server.ts` 消息处理、`claude-manager.ts` skill 重建逻辑等多个文件
- skill 合并和 symlink 创建（`buildSdkOptions()` 中的逻辑）只在会话创建时执行，重载需要完全重建 symlink 并重新注入 system prompt，复杂度高
- 重启是最简单可靠的方案，且已有 `restartAgentWithNewConfig()` 可复用。重启耗时通常在 2-5 秒内，对用户体验影响小

### 3. 修改 `uninstallSkillMultiTarget()` — 卸载后重载

**文件**：`src/main/controllers/skill.controller.ts`（line 663）

在远程卸载分支中，卸载成功后调用 proxy 重载：

```typescript
// 现有
const result = await remoteDeployService.uninstallRemoteSkill(
  target.serverId, appId, remoteOnOutput,
);
results[key] = result;

// 新增：卸载成功后重启 proxy
if (result.success) {
  try {
    await remoteDeployService.restartAgentIfRunning(target.serverId, remoteOnOutput);
  } catch (e) {
    // 重启失败不影响卸载结果，仅输出警告
    remoteOnOutput?.({ type: 'stderr', content: `[remote] Warning: proxy restart failed, skills may not take effect until next restart\n` });
  }
}
```

### 4. SkillMarket.tsx — 增加卸载确认对话框

**文件**：`src/renderer/components/skill/SkillMarket.tsx`（line 481）

在 `handleUninstallFromTarget()` 中增加确认逻辑：

```typescript
const [uninstallConfirm, setUninstallConfirm] = useState<{ skill: RemoteSkillItem; env: EnvStatus } | null>(null);

const handleUninstallFromTarget = async (skill: RemoteSkillItem, env: EnvStatus) => {
  // 远程卸载需要确认
  if (env.type === 'remote') {
    setUninstallConfirm({ skill, env });
    return;
  }
  // 本地卸载直接执行（已有逻辑）
  await doUninstall(skill, env);
};

const doUninstall = async (skill: RemoteSkillItem, env: EnvStatus) => {
  setUninstallConfirm(null);
  // ... 现有卸载逻辑 ...
};
```

新增确认弹窗组件（使用已有的 UI 组件库）：

```tsx
{uninstallConfirm && (
  <ConfirmDialog
    title={t('Uninstall Skill')}
    message={t('Are you sure you want to uninstall this skill from {name}?', {
      name: uninstallConfirm.env.name,
    })}
    confirmText={t('Uninstall')}
    cancelText={t('Cancel')}
    onConfirm={() => doUninstall(uninstallConfirm.skill, uninstallConfirm.env)}
    onCancel={() => setUninstallConfirm(null)}
  />
)}
```

### 5. SkillLibrary.tsx — 远程视图增加卸载按钮

**文件**：`src/renderer/components/skill/SkillLibrary.tsx`（line 1340）

在 `SkillDetail` 组件的远程区域（`{isRemote && (...)}`）增加卸载按钮：

```tsx
{isRemote && (
  <div className="pt-4 border-t border-border space-y-2">
    {/* 卸载按钮 */}
    {onUninstall && (
      <button
        onClick={onUninstall}
        className="flex items-center gap-2 w-full px-4 py-2 bg-red-500/10 text-red-400 hover:bg-red-500/20 rounded-lg text-sm font-medium transition-colors"
      >
        <Trash2 className="w-4 h-4" />
        {t('Uninstall from Server')}
      </button>
    )}
    {/* 下载到本地（已有） */}
    {onSyncFromServer && (
      <button ...>
        ...
        {syncFromRemoteLoading ? t('Downloading...') : t('Download to Local')}
      </button>
    )}
    {/* 查看文件（已有） */}
    <button ...>
      ...
      {t('View Skill Files')}
    </button>
  </div>
)}
```

在 `SkillLibrary` 主组件中，为远程模式传递 `onUninstall` 回调：

```typescript
// 在 SkillDetail 的 props 中
onUninstall={selectedSource.type === 'remote' ? () => handleRemoteUninstall(selectedSkillId!) : undefined}
```

新增 `handleRemoteUninstall()` 方法（参考 `SkillMarket.tsx` 的实现，调用 `api.skillUninstallMulti()` 并处理确认）。

## 开发前必读

| 类别 | 文件路径 | 阅读目的 |
|------|---------|---------|
| 模块设计文档 | `.project/modules/skill/skill-system-v1.md` | 理解技能系统整体架构、IPC 通道、组件职责 |
| 模块设计文档 | `.project/modules/remote-agent/remote-agent-v1.md` | 理解远程 Agent 架构、SSH/WS/proxy 各层职责 |
| 功能设计文档 | `.project/modules/skill/features/skill-market/design.md` | 理解技能市场 UI 和安装/卸载流程 |
| 已有 PRD | `.project/prd/feature/skill/feature-direct-remote-skill-install-v1.md` | 参考远程安装的技术方案和 IPC 模式 |
| 已有 PRD | `.project/prd/feature/skill/sync-from-remote-v1.md` | 参考远程文件同步的 IPC 通道和实现模式 |
| 已有 PRD | `.project/prd/bugfix/remote-agent/bugfix-remote-sdk-patch-and-skill-loading-v1.md` | 理解远程 proxy 的 skill symlink 机制和 `buildSdkOptions()` 逻辑 |
| 源码文件 | `src/main/services/remote-deploy/remote-deploy.service.ts` (line 4356-4405) | `uninstallRemoteSkill()` 当前实现（需完善的重点） |
| 源码文件 | `src/main/services/remote-deploy/remote-deploy.service.ts` (line 2118-2142) | `restartAgentWithNewConfig()` 实现参考 |
| 源码文件 | `src/main/controllers/skill.controller.ts` (line 663-720) | `uninstallSkillMultiTarget()` — 卸载调度逻辑 |
| 源码文件 | `src/main/ipc/skill.ts` (line 95-113) | `skill:uninstall-multi` IPC handler |
| 源码文件 | `packages/remote-agent-proxy/src/claude-manager.ts` (line 1028-1136) | `buildSdkOptions()` 中的 skill 合并和 symlink 创建逻辑 |
| 源码文件 | `packages/remote-agent-proxy/src/server.ts` (line 410-520) | WebSocket 消息处理（确认无 skill 重载命令） |
| 源码文件 | `packages/remote-agent-proxy/src/types.ts` (line 11-16) | `ClientMessage` 类型定义 |
| 源码文件 | `src/renderer/components/skill/SkillMarket.tsx` (line 481-513) | `handleUninstallFromTarget()` — 远程卸载 UI 实现（需增加确认） |
| 源码文件 | `src/renderer/components/skill/SkillLibrary.tsx` (line 1140-1368) | `SkillDetail` 组件 — 远程视图需增加卸载按钮 |
| 编码规范 | `docs/Development-Standards-Guide.md` | TypeScript strict、IPC 通道常量化、UI 国际化 |

## 涉及文件

| # | 文件 | 改动类型 | 说明 |
|---|------|---------|------|
| 1 | `src/main/services/remote-deploy/remote-deploy.service.ts` | 修改 | 完善 `uninstallRemoteSkill()` 增加 symlink 清理 + 新增 `restartAgentIfRunning()` 方法 |
| 2 | `src/main/controllers/skill.controller.ts` | 修改 | `uninstallSkillMultiTarget()` 远程卸载后调用 proxy 重载 |
| 3 | `src/renderer/components/skill/SkillMarket.tsx` | 修改 | `handleUninstallFromTarget()` 增加卸载确认对话框 |
| 4 | `src/renderer/components/skill/SkillLibrary.tsx` | 修改 | 远程技能详情面板增加「卸载」按钮 + `handleRemoteUninstall()` 方法 + 确认对话框 |

> **实际**：无需修改 IPC 通道、preload、renderer API 或远程 proxy 代码。`skill:uninstall-multi` 的 IPC 接口不变，只是在 service 层完善清理逻辑和增加 proxy 重载。

## 验收标准

- [ ] **Symlink 清理**：远程卸载后，`~/.agents/claude-config/skills/<skillId>` symlink 被删除
- [ ] **悬空链接清理**：卸载后 `~/.agents/claude-config/.claude/skills/` 下无悬空链接
- [ ] **Proxy 重载**：卸载后如果远程 proxy 正在运行，proxy 被自动重启
- [ ] **新会话 skill 不可用**：卸载后创建新的远程 Agent 会话，已卸载的 skill 不再出现在 system prompt 中
- [ ] **SkillMarket 卸载确认**：从 SkillMarket 远程卸载技能时弹出确认对话框
- [ ] **SkillMarket 卸载成功**：确认后成功卸载，状态刷新为「未安装」
- [ ] **SkillLibrary 卸载入口**：在 SkillLibrary 远程技能详情面板显示「卸载」按钮
- [ ] **SkillLibrary 卸载确认**：点击卸载按钮后弹出确认对话框
- [ ] **SkillLibrary 卸载成功**：确认后成功卸载，列表刷新
- [ ] **本地卸载不受影响**：本地技能卸载功能行为不变，无回归
- [ ] **Proxy 未运行时正常卸载**：远程 proxy 未运行时，卸载仍然成功完成（仅文件清理 + symlink 清理）
- [x] **`npm run typecheck` 通过**（已有错误均为预存，未引入新错误）
- [x] **`npm run lint` 通过**（已有 warning/error 均为预存，未引入新问题）
- [x] **`npm run build` 通过**
- [x] **`npm run i18n` 通过**（新增 13 个 key，包含 "Uninstall from Server" 等）
