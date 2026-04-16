# 功能 — space-crud

> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源 PRD：无（初始文档化）
> 所属模块：modules/space/space-management-v1

## 描述
Space 的创建、读取、更新、删除（CRUD）全生命周期管理。每个 Space 代表一个独立工作空间，拥有唯一的 ID、名称、图标、文件路径，并支持本地/远程两种 Claude 来源。系统通过内存注册表（`Map<string, SpaceIndexEntry>`）+ 磁盘索引文件（`spaces-index.json` v3）双写机制实现原子性持久化，`listSpaces()` 和 `getSpace()` 为纯内存读取，零磁盘 IO。

## 依赖
- `src/main/services/config.service.ts` — `getAicoBotDir()`、`getTempSpacePath()`、`getSpacesDir()`
- `src/main/services/agent/session-manager.ts` — `closeSessionsBySpaceId()`（删除前关闭活跃会话）
- `src/main/services/artifact-cache.service.ts` — `destroySpaceCache()`（删除前释放文件监听器）
- `src/main/ipc/space.ts` — IPC 通道注册（`space:create`、`space:list`、`space:get`、`space:update`、`space:delete`、`space:get-aico-bot`）
- `src/renderer/stores/space.store.ts` — 前端 Zustand 状态管理
- `uuid` — 空间 ID 生成

## 实现逻辑

### 正常流程

**创建 Space（`createSpace()`）**
1. 生成 UUID 作为空间 ID
2. 在 `~/.aico-bot/spaces/{id}/` 下创建目录结构（`.aico-bot/`、`.aico-bot/conversations/`）
3. 写入 `.aico-bot/meta.json`（名称、图标、远程配置等）
4. 将 `SpaceIndexEntry` 写入内存注册表 `Map`
5. 调用 `persistIndex()` 将注册表原子写入 `spaces-index.json`（tmp + rename）
6. 返回构建好的 `Space` 对象

**读取 Space（`getSpace()` / `listSpaces()`）**
1. `getSpace(id)` — 直接从内存注册表 `Map` 读取，零磁盘 IO
2. `listSpaces()` — 遍历注册表，跳过 `isTemp`（aico-bot-temp）和 `isSkillSpace` 条目
3. 批量验证路径有效性，无效条目从注册表和磁盘清除
4. 按 `updatedAt` 降序排序后返回

**更新 Space（`updateSpace()`）**
1. 从注册表获取 entry
2. 更新 name/icon 和 `updatedAt` 时间戳
3. 持久化注册表到磁盘
4. 读取已有 `meta.json`（保留 preferences），合并后写回 `meta.json`

**删除 Space（`deleteSpace()`）**
1. 验证空间存在且非 temp 空间
2. 调用 `closeSessionsBySpaceId()` 关闭所有活跃 SDK 会话
3. 调用 `destroySpaceCache()` 释放文件监听器（解决 Windows EBUSY 问题）
4. 集中式存储空间：`rmSync` 删除整个目录；旧版自定义路径空间：仅删除 `.aico-bot/` 子目录
5. 从注册表和磁盘索引移除

**AICO-Bot Temp Space（`getAicoBotSpace()`）**
1. 始终注册到内存注册表（`registerAicoBotTemp()`），`isTemp: true` 标记
2. 不持久化到 `spaces-index.json`
3. 每次加载索引时自动注册

### 异常流程
1. **索引文件损坏** — `loadSpaceIndex()` 捕获 JSON 解析错误，触发全量扫描重建（v1 迁移路径）
2. **空间路径失效** — `listSpaces()` 批量检测 `existsSync`，失效条目自动清理
3. **删除失败（EBUSY/EPERM）** — 捕获文件锁定错误，返回用户友好提示："文件可能正在使用中"
4. **Temp 空间保护** — 禁止删除 aico-bot-temp 空间（`entry.isTemp` 检查）

## 涉及 API
- IPC `space:create` — 创建空间
- IPC `space:list` — 列出所有空间
- IPC `space:get` — 获取单个空间（含 preferences）
- IPC `space:update` — 更新空间名称/图标
- IPC `space:delete` — 删除空间
- IPC `space:get-aico-bot` — 获取默认 Temp 空间

## 涉及数据
- `~/.aico-bot/spaces-index.json` — v3 格式空间索引（内存注册表的磁盘快照）
- `~/.aico-bot/spaces/{id}/.aico-bot/meta.json` — 单空间元数据
- `~/.aico-bot/spaces/{id}/.aico-bot/conversations/` — 对话数据目录

## 变更
-> changelog.md
