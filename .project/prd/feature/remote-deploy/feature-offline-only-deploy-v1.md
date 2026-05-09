# PRD [功能级] -- 移除在线部署模式，默认离线部署

> 版本：feature-offline-only-deploy-v1
> 日期：2026-05-08
> 指令人：用户
> 归属模块：modules/remote-agent/remote-deploy
> 状态：in-progress
> 级别：feature
> 优先级：P1
> 影响范围：仅前端

---

## 需求分析

### 背景

远程服务器部署界面之前支持「在线/离线」两种部署模式（通过 `deployMode` state 切换）：

- **Online 模式**：通过 `handleUpdateAgent()` 调用 `api.remoteServerUpdateAgent()`，在远端执行 `npm install` 拉取代码部署，依赖远端服务器有网络访问能力
- **Offline 模式**：通过 `handleDeployOffline()` 调用 `api.remoteServerDeployOffline()`，上传本地内置离线包部署，远端零网络依赖

此外还有一个「Batch Update」批量更新按钮，仅在在线模式下可用。

### 问题

1. 在线部署模式依赖远端服务器能访问外网（nodejs.org、npm registry），在国内/企业环境下经常失败
2. 离线部署已成熟稳定，能覆盖所有在线部署的场景，且用户体验更好（无需等待远端 npm install）
3. 保留在线模式增加了 UI 复杂度（模式切换按钮、平台选择器），但实际使用率极低
4. Batch Update 功能仅配合在线模式使用，在线模式移除后该按钮也无意义

### 目标

移除在线部署模式，部署按钮直接执行离线部署流程。简化 UI，减少用户困惑。

---

## 技术方案

### 代码变更清单

在 `src/renderer/components/settings/RemoteServersSection.tsx` 中执行以下修改：

1. **删除 `deployMode` state 变量**（`useState<'online' | 'offline'>`）
2. **删除 Offline/Online 切换按钮组**（部署模式选择 UI）
3. **删除 Batch Update 按钮**（仅在线模式可用，位于标题栏右侧）
4. **`handleDeploy()` 直接调用 `handleDeployOffline()`**（当前已实现）
5. **部署按钮图标统一为 `Package`**（之前在线模式用 `RefreshCw`，已改为 `Package`）
6. **部署按钮 title 简化**：`'Deploy Agent (Offline)'` → 保留现有文案即可

### 具体删除项

| 删除项 | 说明 |
|--------|------|
| `deployMode` state | `useState<'online' \| 'offline'>('offline')` 变量声明 |
| 模式切换按钮组 | `(Offline) / (Online)` 单选按钮 UI |
| Batch Update 按钮 | `handleBatchUpdate()` 调用按钮及相关的 `batchUpdating`/`batchProgress` state |
| `handleBatchUpdate` 函数 | 批量在线更新逻辑（`Promise.allSettled` 调用 `handleUpdateAgent`） |
| `handleUpdateAgent` 函数 | 在线更新 Agent 逻辑（可保留函数体但移除 UI 入口，或一并删除） |
| `RefreshCw` icon import | 在线模式使用的刷新图标（如果 `handleUpdateAgent` 保留则 `RefreshCw` 也保留） |

### 保留项

| 保留项 | 说明 |
|--------|------|
| `handleDeployOffline()` | 核心离线部署逻辑，完整保留 |
| `handleDeploy()` | 已简化为 `return handleDeployOffline(serverId)`，保留 |
| `handleCancelOperation()` | 取消部署/更新操作，保留 |
| `offlineBundleReady` state + 检测逻辑 | 离线包可用性检测，保留 |
| 终端输出面板 | 部署进度显示，保留 |
| `activeSessionWarning` 弹窗 | 如果 `handleUpdateAgent` 保留则弹窗也保留 |

### 可选清理

`handleUpdateAgent` 函数在移除在线模式后没有 UI 入口调用。但该函数仍被以下逻辑引用：
- `activeSessionWarning` 弹窗的「Force Stop & Update」按钮
- `handleUpdateComplete` 事件处理（tab 切换后恢复状态）

建议暂时保留 `handleUpdateAgent` 函数体，仅移除其 UI 入口（在线部署按钮）。后续如果确认完全不需要在线更新能力，可在单独 PRD 中彻底清理。

---

## 开发前必读

### 模块设计文档

| 文档路径 | 阅读目的 |
|---------|---------|
| `.project/modules/remote-agent/remote-agent-v1.md` | 理解 Remote Agent 模块整体架构 |
| `.project/modules/remote-agent/features/offline-deploy/design.md` | 理解离线部署功能实现（正常/异常流程） |
| `.project/modules/remote-agent/features/remote-deploy/design.md` | 理解在线部署功能实现（了解被移除的流程） |
| `.project/modules/remote-agent/features/remote-deploy/changelog.md` | 了解近期部署相关变更 |

### 源码文件

| 文件路径 | 阅读目的 |
|---------|---------|
| `src/renderer/components/settings/RemoteServersSection.tsx` | **核心文件**：理解当前 UI 交互逻辑，定位需要删除/修改的代码段 |

### 编码规范

| 文档路径 | 阅读目的 |
|---------|---------|
| `docs/Development-Standards-Guide.md` | React 组件规范、图标使用、命名规范 |

---

## 涉及文件

| 文件路径 | 修改内容 |
|---------|---------|
| `src/renderer/components/settings/RemoteServersSection.tsx` | 删除 `deployMode` state、模式切换 UI、Batch Update 按钮；部署按钮统一走离线流程 |

---

## 验收标准

- [ ] **V1**: 远程服务器列表中无「在线/离线」模式切换按钮
- [ ] **V2**: 标题栏无「Batch Update」按钮
- [ ] **V3**: 部署按钮图标为 `Package`（非 `RefreshCw`）
- [ ] **V4**: 点击部署按钮直接执行离线部署（`handleDeployOffline`）
- [ ] **V5**: 离线包未构建时，部署按钮置灰且提示「Offline bundle not built」
- [ ] **V6**: 部署进度终端面板正常显示（`handleDeployOffline` 逻辑不受影响）
- [ ] **V7**: 取消部署按钮正常工作（`handleCancelOperation` 不受影响）
- [ ] **V8**: `npm run typecheck && npm run build` 全部通过
