# PRD [功能级] — 远端服务器 Skill 同步到本地

> 版本：sync-from-remote-v1
> 日期：2026-04-17
> 指令人：@moonseeker1
> 归属模块：modules/skill

## 需求

### 背景

AICO-Bot 技能系统（Skill System）支持将本地安装的 skill 通过 SSH 同步到远端服务器（`skill:sync-to-remote`），方便在多台服务器上部署相同的 Agent 能力扩展。但目前已有的同步是**单向的**（本地 → 远端），缺少反向操作——当远端服务器上已存在某个 skill 时，用户无法直接将其下载并安装到本地。

### 问题

1. 用户在远端服务器上手动安装或通过其他途径获得了 skill，无法反向同步回本地
2. 多人协作场景下，团队成员在远端服务器上更新了 skill，本地端无法获取最新版本
3. 现有的 skill 同步只能「推」不能「拉」，双向管理能力不完整

### 预期效果

用户在 SkillLibrary 中切换到远端服务器视图后，可以选中一个远端 skill，点击「Sync to Local」按钮将其下载并安装到本地 `~/.agents/skills/<skillId>/` 目录。同步完成后自动切换到本地视图确认 skill 已安装。

## 功能设计

→ modules/skill/features/sync-from-remote/design.md

## 技术方案

### 架构概览

遵循现有 `syncLocalSkillToRemote` 的分层架构反向实现，数据流方向相反：

```
现有（本地 → 远端）：                             新增（远端 → 本地）：
SkillLibrary UI                                  SkillLibrary UI
    ↓                                                ↓
skill.store.ts syncSkillToRemote                skill.store.ts syncSkillFromRemote
    ↓                                                ↓
renderer/api/index.ts                           renderer/api/index.ts
    ↓                                                ↓
preload/index.ts                                preload/index.ts
    ↓                                                ↓
ipc/skill.ts skill:sync-to-remote              ipc/skill.ts skill:sync-from-remote
    ↓                                                ↓
skill.controller.ts                             skill.controller.ts
    ↓                                                ↓
remote-deploy.service.ts                        remote-deploy.service.ts
    ↓                                                ↓
SSHManager → 写入远端文件                        SSHManager → 读取远端文件 → 写入本地
```

### 1. RemoteDeployService — `syncRemoteSkillToLocal()`

**文件**：`src/main/services/remote-deploy/remote-deploy.service.ts`

新增方法 `syncRemoteSkillToLocal(id, skillId, options, onOutput)`：

- **输入**：
  - `id: string` — 远端服务器 ID
  - `skillId: string` — 目标 skill 标识
  - `options?: { overwrite?: boolean }` — 覆盖选项（默认 `true`）
  - `onOutput?: (data: { type, content }) => void` — 流式进度回调
- **输出**：`Promise<{ success: boolean; error?: string; fileCount?: number }>`

**实现逻辑**：

1. 获取服务器配置并建立 SSH 连接（复用 `ensureFreshConnection`）
2. 通过 SSH 执行 `find <remoteSkillDir> -type f` 列出远端 skill 目录下的所有文件
3. 对每个文件执行 `cat <filePath> | base64 -w 0` 读取 base64 编码内容
4. 本地解码 base64 后写入 `~/.agents/skills/<skillId>/` 对应路径
5. 如果本地已存在同名 skill 目录且 `options.overwrite` 为 `true`，先删除再写入
6. 每个文件写入成功后通过 `onOutput` 输出进度信息
7. SSH 命令需使用 `-w 0` 防止 base64 输出换行

**关键 SSH 命令**：

```bash
# 列出所有文件（相对路径）
find ~/.agents/skills/<skillId> -type f | sed 's|~/.agents/skills/<skillId>/||'

# 读取单个文件内容（base64 编码）
cat ~/.agents/skills/<skillId>/<filePath> | base64 -w 0
```

### 2. SkillController — `syncRemoteSkillToLocal()`

**文件**：`src/main/controllers/skill.controller.ts`

新增方法 `syncRemoteSkillToLocal(skillId, serverId, onOutput)`：

- **输入**：
  - `skillId: string` — 目标 skill 标识
  - `serverId: string` — 远端服务器 ID
  - `onOutput?: (data) => void` — 流式进度回调
- **输出**：`Promise<{ success: boolean; error?: string }>`

**实现逻辑**：

1. 调用 `skillManager.getSkill(skillId)` 检查本地是否已存在同名 skill
2. 如果已存在，通过 `onOutput` 输出 warning 信息（如 `⚠ Skill "xxx" already exists locally, will be overwritten`）
3. 调用 `remoteDeployService.syncRemoteSkillToLocal(serverId, skillId, { overwrite: true }, onOutput)`
4. 成功后调用 `skillManager.refresh()` 刷新本地 skill 缓存

### 3. IPC Handler — `skill:sync-from-remote`

**文件**：`src/main/ipc/skill.ts`

新增 IPC handle 通道：

```typescript
// ── skill:sync-from-remote ───────────────────────────────────────────
ipcMain.handle(
  'skill:sync-from-remote',
  async (event, input: { skillId: string; serverId: string }) => {
    const onOutput = (data: {
      type: 'stdout' | 'stderr' | 'complete' | 'error';
      content: string;
    }) => {
      event.sender.send('skill:sync-from-remote-output', input.skillId, input.serverId, data);
    };
    return skillController.syncRemoteSkillToLocal(input.skillId, input.serverId, onOutput);
  },
);
```

**IPC 通道**：

| 通道 | 方向 | 说明 |
|------|------|------|
| `skill:sync-from-remote` | renderer → main | 触发远端到本地的 skill 同步 |
| `skill:sync-from-remote-output` | main → renderer | 流式输出同步进度 |

### 4. Preload

**文件**：`src/preload/index.ts`

在 `AicoBotAPI` interface 中新增：

```typescript
skillSyncFromRemote: (input: { skillId: string; serverId: string }) => Promise<IpcResponse>;
onSkillSyncFromRemoteOutput: (
  callback: (data: {
    skillId: string;
    serverId: string;
    output: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string };
  }) => void,
) => () => void;
```

在 contextBridge 暴露对象中新增实现：

```typescript
skillSyncFromRemote: (input) => ipcRenderer.invoke('skill:sync-from-remote', input),
onSkillSyncFromRemoteOutput: (callback) => {
  const handler = (_event, skillId, serverId, output) => {
    callback({ skillId, serverId, output });
  };
  ipcRenderer.on('skill:sync-from-remote-output', handler);
  return () => ipcRenderer.removeListener('skill:sync-from-remote-output', handler);
},
```

### 5. Renderer API

**文件**：`src/renderer/api/index.ts`

新增两个方法：

```typescript
skillSyncFromRemote: async (input: {
  skillId: string;
  serverId: string;
}): Promise<ApiResponse<{ success: boolean; error?: string }>> => {
  if (isElectron()) {
    return window.aicoBot.skillSyncFromRemote(input);
  }
  return httpRequest('POST', '/api/skills/sync-from-remote', input);
},

onSkillSyncFromRemoteOutput: (
  callback: (data: {
    skillId: string;
    serverId: string;
    output: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string };
  }) => void,
): (() => void) => {
  if (isElectron() && window.aicoBot.onSkillSyncFromRemoteOutput) {
    return window.aicoBot.onSkillSyncFromRemoteOutput(callback);
  }
  return () => {};
},
```

### 6. Store

**文件**：`src/renderer/stores/skill/skill.store.ts`

新增状态字段：

```typescript
// Sync from remote server 状态
syncFromRemoteLoading: boolean;
syncFromRemoteError: string | null;
syncFromRemoteResult: { skillId: string; success: boolean } | null;
```

新增 interface 方法和 action：

```typescript
// Interface
syncSkillFromRemote: (skillId: string, serverId: string) => Promise<boolean>;
clearSyncFromRemoteState: () => void;

// Action
syncSkillFromRemote: async (skillId: string, serverId: string) => {
  set({ syncFromRemoteLoading: true, syncFromRemoteError: null, syncFromRemoteResult: null });
  try {
    const result = await api.skillSyncFromRemote({ skillId, serverId });
    if (result.success) {
      set({
        syncFromRemoteLoading: false,
        syncFromRemoteResult: { skillId, success: true },
      });
      // 刷新本地已安装技能列表
      get().loadInstalledSkills();
      return true;
    } else {
      set({
        syncFromRemoteLoading: false,
        syncFromRemoteError: result.error || 'Failed to sync skill from remote',
      });
      return false;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to sync skill from remote';
    set({ syncFromRemoteLoading: false, syncFromRemoteError: msg });
    return false;
  }
},

clearSyncFromRemoteState: () => {
  set({ syncFromRemoteLoading: false, syncFromRemoteError: null, syncFromRemoteResult: null });
},
```

### 7. UI

**文件**：`src/renderer/components/skill/SkillLibrary.tsx`

#### 7a. 远端 skill 操作按钮

当 `selectedSource.type === 'remote'` 时，在 skill 详情面板的操作按钮区域新增「Sync to Local」按钮（仅在非安装中状态显示）：

```tsx
<button
  onClick={() => {
    setSyncFromRemoteSkillId(skillId);
    setShowSyncFromRemoteModal(true);
    setSyncFromRemoteOutput('');
  }}
  className="..."
  disabled={syncFromRemoteLoading}
>
  {t('Sync to Local')}
</button>
```

#### 7b. 同步确认与进度弹窗

新增 `showSyncFromRemoteModal` 状态变量，弹出模态框显示：

- 标题：`Sync to Local`（使用 `t()` 国际化）
- skill 名称和远端服务器名称
- 流式输出区域（复用现有 syncOutput 的终端样式）
- 「Start Sync」按钮触发同步
- 同步完成后自动关闭弹窗、切换 `selectedSource` 为 `{ type: 'local' }`、刷新本地 skill 列表

#### 7c. 监听流式输出

使用 `useEffect` 监听 `api.onSkillSyncFromRemoteOutput` 事件，将输出内容追加到 `syncFromRemoteOutput` 状态变量。

## 改动文件清单

| # | 文件 | 改动类型 | 说明 |
|---|------|---------|------|
| 1 | `src/main/services/remote-deploy/remote-deploy.service.ts` | 新增方法 | `syncRemoteSkillToLocal()` — SSH 读取远端文件并写入本地 |
| 2 | `src/main/controllers/skill.controller.ts` | 新增方法 | `syncRemoteSkillToLocal()` — 本地存在性检查 + 调用 service + 刷新缓存 |
| 3 | `src/main/ipc/skill.ts` | 新增 handler | `skill:sync-from-remote` IPC 通道 + `skill:sync-from-remote-output` 事件 |
| 4 | `src/preload/index.ts` | 新增类型+实现 | `skillSyncFromRemote` + `onSkillSyncFromRemoteOutput` |
| 5 | `src/renderer/api/index.ts` | 新增 API | `skillSyncFromRemote()` + `onSkillSyncFromRemoteOutput()` |
| 6 | `src/renderer/stores/skill/skill.store.ts` | 新增状态+action | `syncFromRemoteLoading/Error/Result` + `syncSkillFromRemote` action |
| 7 | `src/renderer/components/skill/SkillLibrary.tsx` | 新增 UI | 「Sync to Local」按钮 + 同步进度弹窗 |

## 验证方式

1. 添加远端服务器并确保 SSH 连接正常
2. 确认远端服务器上 `~/.agents/skills/` 下至少有一个已安装的 skill
3. 在 SkillLibrary 中切换到远端服务器视图，加载远端 skill 列表
4. 选中一个远端 skill，确认操作区域显示「Sync to Local」按钮
5. 点击按钮打开确认弹窗，点击「Start Sync」开始同步
6. 确认弹窗中流式显示文件下载进度（如 `Downloading file1.yaml...`、`Downloaded 3 file(s)`）
7. 同步完成后弹窗自动关闭，视图切换到本地，确认 skill 出现在本地列表中
8. 重复步骤 5-7，验证本地已存在同名 skill 时 warning 信息正确输出且覆盖成功
9. 测试 SSH 连接失败时的错误处理，确认错误信息正确显示在弹窗中

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-17 | 初始 PRD | @moonseeker1 |
