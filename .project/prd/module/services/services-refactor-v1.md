# PRD [模块级] — services 目录模块化重构

> 版本：services-refactor-v1
> 日期：2026-05-06
> 状态：done
> 指令人：@moonseeker
> 归属模块：codebase（工程基础设施）
> 优先级：P1
> 影响范围：全栈（主进程 import 路径更新，编译验证）

## 需求分析

### 现状

`src/main/services/` 目录下当前状态：

| 类别 | 数量 | 说明 |
|------|------|------|
| 已模块化子目录 | 14 个 | `agent/`、`ai-browser/`、`ai-sources/`、`gh-search/`、`health/`、`mcp-proxy/`、`proxy/`、`remote-deploy/`、`remote-ssh/`、`remote-ws/`、`skill/`、`stealth/`、`terminal/` |
| 散落顶层 `.ts` 文件 | 26 个 | 含 1 个残留备份文件 |
| 残留备份文件 | 1 个 | `agent.service.backup.ts`（2079 行） |

### 问题

1. **代码组织混乱**：26 个散落文件与 14 个子目录并列，无法从目录名判断文件归属
2. **协作效率低**：多人同时开发不同功能模块时，散落文件容易产生冲突
3. **残留文件未清理**：`agent.service.backup.ts` 是历史遗留，不应存在于代码仓库中
4. **功能集群未收敛**：如 `browser-view.service.ts`（948 行）、`browser-menu.service.ts`、`overlay.service.ts`、`win32-hwnd-cleanup.ts` 逻辑高度关联，却散落在顶层

### 目标

将散落文件按逻辑归属收敛到子目录中，形成清晰的模块边界；删除残留备份文件。**纯重构，功能零变更。**

## 技术方案

### 概览

本 PRD 将 26 个散落顶层文件处理为三类操作：

| 操作类型 | 数量 | 说明 |
|---------|------|------|
| 新建目录迁入 | 15 个 | 收敛到 4 个新建子目录 |
| 合入已有目录 | 3 个 | 收敛到 2 个已有子目录 |
| 保持顶层不动 | 7 个 | 基础服务 + 死代码（暂不动） |
| 删除 | 1 个 | 残留备份文件 |

> 注：`image-upload.service.ts`、`search.service.ts` 未在本次迁移范围（详见下文说明）。

### 步骤 1：删除残留文件

| 文件 | 行数 | 操作 |
|------|------|------|
| `src/main/services/agent.service.backup.ts` | 2079 | 直接删除 |

验证：`git grep agent.service.backup` 应无结果。

### 步骤 2：新建 `browser/` 目录

**迁入文件（4 个，~1778 行）：**

| 文件 | 行数 | 导出 |
|------|------|------|
| `browser-view.service.ts` → `browser/browser-view.service.ts` | 948 | `browserViewManager` |
| `browser-menu.service.ts` → `browser/browser-menu.service.ts` | 152 | `buildContextMenu`、`buildTabContextMenu`、`BrowserMenuOptions`、`CanvasTabMenuOptions` |
| `overlay.service.ts` → `browser/overlay.service.ts` | 450 | `overlayManager` |
| `win32-hwnd-cleanup.ts` → `browser/win32-hwnd-cleanup.ts` | 228 | `forceDwmCleanup`、`dwmFlush` |

**新建 `browser/index.ts` 桶文件，导出所有公开 API。**

**内部依赖关系（迁入后）：**
```
browser/browser-view.service.ts  ← 引用 → browser/win32-hwnd-cleanup.ts（相对路径）
browser/browser-menu.service.ts  ← 引用 → browser/browser-view.service.ts（相对路径）
browser/overlay.service.ts       ← 引用 → browser/win32-hwnd-cleanup.ts（相对路径）
```

**需要更新 import 的文件（外部消费者）：**

| 文件 | 原路径 | 新路径 |
|------|--------|--------|
| `src/main/ipc/browser.ts` | `../services/browser-view.service` | `../services/browser/browser-view.service` |
| `src/main/ipc/browser.ts` | `../services/browser-menu.service` | `../services/browser/browser-menu.service` |
| `src/main/ipc/overlay.ts` | `../services/overlay.service` | `../services/browser/overlay.service` |
| `src/main/ipc/system.ts` | `../services/win32-hwnd-cleanup` | `../services/browser/win32-hwnd-cleanup` |
| `src/main/services/ai-browser/context.ts` | `../browser-view.service` | `../browser/browser-view.service` |
| `src/main/services/ai-browser/sdk-mcp-server.ts` | `../browser-view.service` | `../browser/browser-view.service` |
| `src/main/services/ai-browser/index.ts` | `../browser-view.service` | `../browser/browser-view.service` |

### 步骤 3：新建 `file-watcher/` 目录

**迁入文件（3 个，~1899 行）：**

| 文件 | 行数 | 导出 |
|------|------|------|
| `artifact.service.ts` → `file-watcher/artifact.service.ts` | 847 | `listArtifacts`、`listArtifactsTree` 等 |
| `artifact-cache.service.ts` → `file-watcher/artifact-cache.service.ts` | 623 | `destroySpaceCache`、`cleanupAllCaches` 等 |
| `watcher-host.service.ts` → `file-watcher/watcher-host.service.ts` | 429 | `watcherHost`（命名空间导出） |

**新建 `file-watcher/index.ts` 桶文件，导出所有公开 API。**

**内部依赖关系（迁入后）：**
```
file-watcher/artifact.service.ts        ← 引用 → file-watcher/artifact-cache.service.ts（相对路径）
file-watcher/artifact-cache.service.ts  ← 引用 → file-watcher/watcher-host.service.ts（相对路径）
```

**需要更新 import 的文件（外部消费者）：**

| 文件 | 原路径 | 新路径 |
|------|--------|--------|
| `src/main/ipc/artifact.ts` | `../services/artifact.service` | `../services/file-watcher/artifact.service` |
| `src/main/http/routes/index.ts` | `../../services/artifact.service` | `../../services/file-watcher/artifact.service` |
| `src/main/bootstrap/extended.ts` | `../services/artifact-cache.service` | `../services/file-watcher/artifact-cache.service` |
| `src/main/bootstrap/extended.ts` | `../services/watcher-host.service` | `../services/file-watcher/watcher-host.service` |
| `src/main/services/space.service.ts` | `./artifact-cache.service` | `./file-watcher/artifact-cache.service` |

### 步骤 4：新建 `remote-access/` 目录

**迁入文件（2 个，~532 行）：**

| 文件 | 行数 | 导出 |
|------|------|------|
| `remote.service.ts` → `remote-access/remote.service.ts` | 287 | `disableRemoteAccess` 等 |
| `tunnel.service.ts` → `remote-access/tunnel.service.ts` | 245 | `startTunnel`、`stopTunnel`、`getTunnelStatus`、`onTunnelStatusChange` |

**新建 `remote-access/index.ts` 桶文件，导出所有公开 API。**

**内部依赖关系（迁入后）：**
```
remote-access/remote.service.ts  ← 引用 → remote-access/tunnel.service.ts（相对路径）
```

**需要更新 import 的文件（外部消费者）：**

| 文件 | 原路径 | 新路径 |
|------|--------|--------|
| `src/main/index.ts` | `./services/remote.service` | `./services/remote-access/remote.service` |
| `src/main/ipc/remote.ts` | `../services/remote.service` | `../services/remote-access/remote.service` |

### 步骤 5：新建 `auth/` 目录

**迁入文件（3 个，~703 行）：**

| 文件 | 行数 | 导出 |
|------|------|------|
| `github-auth.service.ts` → `auth/github-auth.service.ts` | 447 | `resolveGhBinary` 等 |
| `gitcode-auth.service.ts` → `auth/gitcode-auth.service.ts` | 97 | GitCode 认证函数 |
| `secure-storage.service.ts` → `auth/secure-storage.service.ts` | 159 | `decryptString`、`encryptString` 等 |

**新建 `auth/index.ts` 桶文件，导出所有公开 API。**

**内部依赖关系（迁入后）：**
- 三个文件之间无相互依赖。

**需要更新 import 的文件（外部消费者）：**

| 文件 | 原路径 | 新路径 |
|------|--------|--------|
| `src/main/ipc/github.ts` | `../services/github-auth.service` | `../services/auth/github-auth.service` |
| `src/main/ipc/gitcode.ts` | `../services/gitcode-auth.service` | `../services/auth/gitcode-auth.service` |
| `src/main/services/config.service.ts` | `./secure-storage.service` | `./auth/secure-storage.service` |
| `src/main/services/ai-sources/manager.ts` | `../secure-storage.service` | `../auth/secure-storage.service` |
| `src/main/services/agent/send-message.ts` | `../secure-storage.service` | `../auth/secure-storage.service` |
| `src/main/services/agent/orchestrator.ts`（动态导入） | `../secure-storage.service` | `../auth/secure-storage.service` |
| `src/main/services/remote-deploy/remote-deploy.service.ts` | `../secure-storage.service` | `../auth/secure-storage.service` |
| `src/main/services/gh-search/index.ts` | `../github-auth.service` | `../auth/github-auth.service` |
| `src/main/services/gh-search/sdk-mcp-server.ts` | `../github-auth.service` | `../auth/github-auth.service` |

### 步骤 6：合入 `terminal/` 目录

**迁入文件（2 个，~339 行）：**

| 文件 | 行数 | 导出 |
|------|------|------|
| `git-bash.service.ts` → `terminal/git-bash.service.ts` | 228 | Git Bash 状态/初始化函数 |
| `git-bash-installer.service.ts` → `terminal/git-bash-installer.service.ts` | 224 | `downloadAndInstallGitBash` |
| `mock-bash.service.ts` → `terminal/mock-bash.service.ts` | 111 | `createMockBash`、`cleanupMockBash` |

**更新 `terminal/index.ts` 桶文件，追加新导出。**

**内部依赖关系（迁入后）：**
```
terminal/git-bash.service.ts          ← 引用 → terminal/mock-bash.service.ts（相对路径）
terminal/git-bash-installer.service.ts ← 引用 → terminal/git-bash.service.ts（相对路径）
```

**需要更新 import 的文件（外部消费者）：**

| 文件 | 原路径 | 新路径 |
|------|--------|--------|
| `src/main/ipc/git-bash.ts` | `../services/git-bash.service` | `../services/terminal/git-bash.service` |
| `src/main/ipc/git-bash.ts` | `../services/git-bash-installer.service` | `../services/terminal/git-bash-installer.service` |

### 步骤 7：合入 `ai-sources/` 目录

**迁入文件（1 个，~295 行）：**

| 文件 | 行数 | 导出 |
|------|------|------|
| `api-validator.service.ts` → `ai-sources/api-validator.service.ts` | 295 | `validateApiConnection`、`fetchModelsFromApi` |

**更新 `ai-sources/index.ts` 桶文件，追加新导出。**

**需要更新 import 的文件（外部消费者）：**

| 文件 | 原路径 | 新路径 |
|------|--------|--------|
| `src/main/controllers/config.controller.ts` | `../services/api-validator.service` | `../services/ai-sources/api-validator.service` |
| `src/main/ipc/config.ts` | `../services/api-validator.service` | `../services/ai-sources/api-validator.service` |

### 步骤 8：保持顶层不动

以下文件保持当前位置不变：

| 文件 | 行数 | 理由 |
|------|------|------|
| `config.service.ts` | ~900 | 基础依赖，被 `auth/secure-storage.service.ts` 等大量文件引用，保持在顶层减少循环依赖风险 |
| `conversation.service.ts` | ~1100 | 核心数据模型，被多处直接引用 |
| `space.service.ts` | ~800 | 核心数据模型，被多处直接引用 |
| `window.service.ts` | ~100 | 基础设施单例，全局唯一 |
| `notification.service.ts` | ~150 | 横切关注点，被多处引用 |
| `updater.service.ts` | ~300 | 应用生命周期管理 |
| `onboarding.service.ts` | ~90 | 功能自包含且体量小 |
| `protocol.service.ts` | ~30 | Electron 协议注册，极小 |

**不在迁移范围（需单独处理）：**

| 文件 | 行数 | 说明 |
|------|------|------|
| `image-upload.service.ts` | 168 | 死代码（无任何文件导入），建议后续 PRD 清理 |
| `search.service.ts` | 359 | 仅被 `ipc/search.ts` 引用，待定归属（search 模块尚未建立） |

### 步骤 9：更新模块文档

更新以下模块文档，反映文件路径变更：

| 文档 | 变更内容 |
|------|---------|
| `.project/modules/ai-browser/ai-browser-v1.md` | 内部组件表中 `browser-view.service`、`browser-menu.service` 路径更新 |
| `.project/modules/terminal/terminal-service-v1.md` | 内部组件表追加 git-bash 相关组件 |
| `.project/modules/ai-sources/ai-sources-v1.md` | 内部组件表追加 api-validator 组件 |
| `CLAUDE.md` 关键目录章节 | 如有必要，反映新的目录结构 |

### 步骤 10：验证

```bash
# 类型检查
npm run typecheck

# 构建
npm run build
```

### Import 更新策略

对于每个被移动的文件，按以下顺序更新 import：

1. **移动文件内部**：更新同目录内文件之间的相对 import 路径
2. **同目录 `index.ts`**：如果需要新建或更新桶文件
3. **外部消费者**：按 `services/` 目录 → `ipc/` → `controllers/` → `bootstrap/` → `http/` 顺序逐一更新
4. **动态 import**：`orchestrator.ts` 中的 `await import()` 也需要更新路径

所有 import 路径更新使用 `from '...'` 相对路径形式，与项目现有风格保持一致。

## 开发前必读

| 类别 | 文件路径 | 阅读目的 |
|------|---------|---------|
| 模块设计文档 | `.project/modules/ai-browser/ai-browser-v1.md` | 理解 browser-view/browser-menu 在 AI Browser 模块中的定位，确认路径更新范围 |
| 模块设计文档 | `.project/modules/terminal/terminal-service-v1.md` | 理解 terminal 模块现有结构，确认 git-bash 迁入的合理性 |
| 模块设计文档 | `.project/modules/ai-sources/ai-sources-v1.md` | 理解 ai-sources 模块现有结构，确认 api-validator 迁入的合理性 |
| 模块设计文档 | `.project/modules/remote-agent/remote-agent-v1.md` | 理解 remote 模块结构，确认 remote-access 新目录不与现有 remote-* 目录重叠 |
| 编码规范 | `docs/Development-Standards-Guide.md` | 遵循 import 规范、命名规范 |
| 开发流程 | `CLAUDE.md` | 遵循编辑后 re-read 确认、提交规范 |
| 源码文件 | 所有「需要更新 import 的文件」（见上方各步骤表格） | 理解 import 上下文，避免路径更新遗漏 |
| 桶文件 | `src/main/services/terminal/index.ts`、`src/main/services/ai-sources/index.ts` | 理解现有桶文件导出风格，新桶文件需保持一致 |

## 涉及文件

### 移动的文件（20 个）

| 原路径 | 新路径 | 步骤 |
|--------|--------|------|
| `services/browser-view.service.ts` | `services/browser/browser-view.service.ts` | 步骤 2 |
| `services/browser-menu.service.ts` | `services/browser/browser-menu.service.ts` | 步骤 2 |
| `services/overlay.service.ts` | `services/browser/overlay.service.ts` | 步骤 2 |
| `services/win32-hwnd-cleanup.ts` | `services/browser/win32-hwnd-cleanup.ts` | 步骤 2 |
| `services/artifact.service.ts` | `services/file-watcher/artifact.service.ts` | 步骤 3 |
| `services/artifact-cache.service.ts` | `services/file-watcher/artifact-cache.service.ts` | 步骤 3 |
| `services/watcher-host.service.ts` | `services/file-watcher/watcher-host.service.ts` | 步骤 3 |
| `services/remote.service.ts` | `services/remote-access/remote.service.ts` | 步骤 4 |
| `services/tunnel.service.ts` | `services/remote-access/tunnel.service.ts` | 步骤 4 |
| `services/github-auth.service.ts` | `services/auth/github-auth.service.ts` | 步骤 5 |
| `services/gitcode-auth.service.ts` | `services/auth/gitcode-auth.service.ts` | 步骤 5 |
| `services/secure-storage.service.ts` | `services/auth/secure-storage.service.ts` | 步骤 5 |
| `services/git-bash.service.ts` | `services/terminal/git-bash.service.ts` | 步骤 6 |
| `services/git-bash-installer.service.ts` | `services/terminal/git-bash-installer.service.ts` | 步骤 6 |
| `services/mock-bash.service.ts` | `services/terminal/mock-bash.service.ts` | 步骤 6 |
| `services/api-validator.service.ts` | `services/ai-sources/api-validator.service.ts` | 步骤 7 |

### 新建的文件（5 个）

| 文件 | 说明 |
|------|------|
| `services/browser/index.ts` | browser 模块桶文件 |
| `services/file-watcher/index.ts` | file-watcher 模块桶文件 |
| `services/remote-access/index.ts` | remote-access 模块桶文件 |
| `services/auth/index.ts` | auth 模块桶文件 |

### 删除的文件（1 个）

| 文件 | 说明 |
|------|------|
| `services/agent.service.backup.ts` | 残留备份文件 |

### 需要更新 import 的文件（19 个）

| 文件 | 更新内容 |
|------|---------|
| `src/main/ipc/browser.ts` | browser-view、browser-menu 路径 |
| `src/main/ipc/overlay.ts` | overlay 路径 |
| `src/main/ipc/system.ts` | win32-hwnd-cleanup 路径 |
| `src/main/ipc/artifact.ts` | artifact 路径 |
| `src/main/ipc/remote.ts` | remote 路径 |
| `src/main/ipc/github.ts` | github-auth 路径 |
| `src/main/ipc/gitcode.ts` | gitcode-auth 路径 |
| `src/main/ipc/git-bash.ts` | git-bash、git-bash-installer 路径 |
| `src/main/ipc/config.ts` | api-validator 路径 |
| `src/main/ipc/search.ts` | search.service 路径（本次不动，仅记录） |
| `src/main/controllers/config.controller.ts` | api-validator 路径 |
| `src/main/index.ts` | remote 路径 |
| `src/main/bootstrap/extended.ts` | artifact-cache、watcher-host 路径 |
| `src/main/http/routes/index.ts` | artifact 路径 |
| `src/main/services/config.service.ts` | secure-storage 路径 |
| `src/main/services/space.service.ts` | artifact-cache 路径 |
| `src/main/services/ai-sources/manager.ts` | secure-storage 路径 |
| `src/main/services/ai-browser/context.ts` | browser-view 路径 |
| `src/main/services/ai-browser/sdk-mcp-server.ts` | browser-view 路径 |
| `src/main/services/ai-browser/index.ts` | browser-view 路径 |
| `src/main/services/agent/send-message.ts` | secure-storage 路径 |
| `src/main/services/agent/orchestrator.ts` | secure-storage 动态 import 路径 |
| `src/main/services/remote-deploy/remote-deploy.service.ts` | secure-storage 路径 |
| `src/main/services/gh-search/index.ts` | github-auth 路径 |
| `src/main/services/gh-search/sdk-mcp-server.ts` | github-auth 路径 |

### 更新的桶文件（2 个）

| 文件 | 变更 |
|------|------|
| `src/main/services/terminal/index.ts` | 追加 git-bash、git-bash-installer、mock-bash 导出 |
| `src/main/services/ai-sources/index.ts` | 追加 api-validator 导出 |

### 更新的文档（预估）

| 文件 | 变更 |
|------|------|
| `.project/modules/ai-browser/ai-browser-v1.md` | 内部组件路径更新 |
| `.project/modules/terminal/terminal-service-v1.md` | 追加 git-bash 组件 |
| `.project/modules/ai-sources/ai-sources-v1.md` | 追加 api-validator 组件 |

## 验收标准

- [ ] `agent.service.backup.ts` 已删除
- [ ] `browser/` 目录已创建，4 个文件已迁入，`index.ts` 桶文件已创建
- [ ] `file-watcher/` 目录已创建，3 个文件已迁入，`index.ts` 桶文件已创建
- [ ] `remote-access/` 目录已创建，2 个文件已迁入，`index.ts` 桶文件已创建
- [ ] `auth/` 目录已创建，3 个文件已迁入，`index.ts` 桶文件已创建
- [ ] `terminal/` 目录已迁入 3 个文件，`index.ts` 桶文件已更新
- [ ] `ai-sources/` 目录已迁入 1 个文件，`index.ts` 桶文件已更新
- [ ] 所有外部消费者的 import 路径已更新（25 处）
- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过
- [ ] 相关模块文档已更新

## 变更记录

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-05-06 | 初始 PRD（draft） | @moonseeker |
