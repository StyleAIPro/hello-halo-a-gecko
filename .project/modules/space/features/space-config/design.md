# 功能 — space-config

> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源 PRD：无（初始文档化）
> 所属模块：modules/space/space-management-v1

## 描述
Space 级别的配置与偏好管理。偏好数据（如布局设置 `layout`）存储在每个空间的 `.aico-bot/meta.json` 文件中，而非全局索引文件 `spaces-index.json`，实现配置的空间级隔离。读取偏好需要按需加载（`getSpaceWithPreferences()` / `getSpacePreferences()`），涉及一次磁盘 IO；更新偏好通过深合并（deep merge）方式写入，保留未变更字段。

## 依赖
- `src/main/services/space.service.ts` — `updateSpacePreferences()`、`getSpacePreferences()`、`getSpaceWithPreferences()`
- `src/main/ipc/space.ts` — IPC 通道（`space:update-preferences`、`space:get-preferences`）
- `src/renderer/stores/space.store.ts` — 前端偏好状态管理（`updateSpacePreferences`、`getSpacePreferences`）

## 实现逻辑

### 正常流程

**更新偏好（`updateSpacePreferences()`）**
1. 从注册表获取空间 entry
2. 确保 `.aico-bot/` 目录存在（防御性创建）
3. 读取已有 `meta.json` 获取当前偏好（`tryReadMeta()`）
4. 深合并传入的偏好到当前偏好（仅处理 `layout` 层级）
5. 构建完整 `SpaceMeta` 对象，写入 `meta.json`
6. 非临时空间：更新 `updatedAt` 时间戳
7. 返回合并后的 Space 对象（含最新偏好）

**读取偏好（`getSpacePreferences()`）**
1. 从注册表获取空间 entry
2. 调用 `tryReadMeta()` 从 `meta.json` 读取
3. 返回 `meta.preferences` 或 `null`

**带偏好读取空间（`getSpaceWithPreferences()`）**
1. 从注册表获取空间 entry
2. 调用 `tryReadMeta()` 加载完整元数据
3. 合并 meta.json 中的远程配置字段（`claudeSource`、`remoteServerId` 等）
4. 返回完整的 Space 对象（含 preferences + 远程配置）

**前端状态同步（`useSpaceStore`）**
1. `updateSpacePreferences` action 调用 IPC 后更新 `currentSpace` 和 `spaces` 列表
2. `getSpacePreferences` action 从内存状态（currentSpace / defaultSpace / spaces）同步读取，不触发 IPC

### 异常流程
1. **meta.json 不存在** — `tryReadMeta()` 返回 `null`，使用空对象 `{}` 作为当前偏好
2. **空间不存在** — 返回 `null`，前端静默忽略
3. **写入失败** — 捕获异常，日志记录，返回 `null`

## 涉及 API
- IPC `space:update-preferences` — 更新空间偏好（Partial<SpacePreferences>）
- IPC `space:get-preferences` — 获取空间偏好

## 涉及数据
- `~/.aico-bot/spaces/{id}/.aico-bot/meta.json` — `preferences.layout.artifactRailExpanded`、`preferences.layout.chatWidth`

## 变更
-> changelog.md
