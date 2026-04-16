# 功能 — folder-management

> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源 PRD：无（初始文档化）
> 所属模块：modules/space/space-management-v1

## 描述
Space 的文件夹选择与工作目录管理。用户在创建空间时可选择自定义项目目录（`customPath`），该路径存储为空间的 `workingDir`，作为 Agent 的工作目录（cwd）、Artifacts 存储根和文件浏览器的起始路径。系统通过 Electron `dialog.showOpenDialog` 提供原生文件夹选择器，并在 `openSpaceFolder()` 中使用 `shell.openPath()` 打开系统文件管理器。

## 依赖
- `src/main/services/space.service.ts` — `openSpaceFolder()`、`getAllSpacePaths()`、`createSpace()` 中的 `customPath` 参数
- `src/main/services/config.service.ts` — `getSpacesDir()`（默认空间路径）
- `src/main/ipc/space.ts` — IPC 通道（`dialog:select-folder`、`space:open-folder`、`space:get-default-path`）
- `src/renderer/stores/space.store.ts` — `openSpaceFolder` action
- Electron `dialog` — 原生文件夹选择对话框
- Electron `shell` — 打开系统文件管理器

## 实现逻辑

### 正常流程

**选择文件夹（`dialog:select-folder` IPC）**
1. 调用 `dialog.showOpenDialog()`，配置 `properties: ['openDirectory', 'createDirectory']`
2. 用户取消或未选择 → 返回 `{ success: true, data: null }`
3. 用户选择文件夹 → 返回 `{ success: true, data: "选择的路径" }`

**创建空间时设置工作目录（`createSpace()`）**
1. `customPath` 参数存储为 `workingDir`（agent cwd、artifact 根目录）
2. 空间数据始终存储在 `~/.aico-bot/spaces/{id}/`（集中式存储）
3. `workingDir` 写入 `meta.json` 和 `SpaceIndexEntry`
4. 如果未提供 `customPath`，`workingDir` 为 `undefined`，Agent 使用空间数据目录作为 cwd

**打开空间文件夹（`openSpaceFolder()`）**
1. Temp 空间 → 打开 `{spacePath}/artifacts` 目录（如存在）
2. 普通空间 → 打开 `workingDir`（如已设置）或 `spacePath`（空间数据目录）
3. 调用 `shell.openPath()` 由系统文件管理器打开

**获取默认路径（`space:get-default-path` IPC）**
1. 返回 `getSpacesDir()` 即 `~/.aico-bot/spaces/`

**安全路径校验（`getAllSpacePaths()`）**
1. 遍历注册表收集所有空间的 `path` 和 `workingDir`
2. 用于安全检查，确保 Agent 操作在授权目录内

### 异常流程
1. **文件夹选择对话框失败** — 捕获异常，返回 `{ success: false, error: message }`
2. **打开文件夹失败** — `openSpaceFolder()` 中 `entry` 不存在返回 `false`；Temp 空间无 artifacts 目录返回 `false`
3. **路径不存在** — Temp 空间 artifacts 路径通过 `existsSync` 检查后才打开

## 涉及 API
- IPC `dialog:select-folder` — 打开文件夹选择对话框
- IPC `space:open-folder` — 在文件管理器中打开空间目录
- IPC `space:get-default-path` — 获取默认空间存储路径

## 涉及数据
- `~/.aico-bot/spaces/{id}/.aico-bot/meta.json` — `workingDir` 字段
- `~/.aico-bot/spaces-index.json` — 每个条目的 `workingDir` 字段

## 变更
-> changelog.md
