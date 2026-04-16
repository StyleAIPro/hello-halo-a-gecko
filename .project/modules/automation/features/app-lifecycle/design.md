# 功能 — app-lifecycle

> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源 PRD：prd/automation-platform-v1.md
> 所属模块：modules/automation/automation-platform-v1

## 描述

App 生命周期管理：安装、卸载、重装、暂停/恢复、永久删除。提供 App 从创建到销毁的完整状态机管理，包括工作目录创建、SQLite 持久化、状态变更事件通知和权限控制。

## 依赖

- `apps/spec` — AppSpec 定义和验证（Zod）
- `platform/store` — DatabaseManager 提供 SQLite 数据库实例
- `services/space.service` — 空间路径解析（安装时创建工作目录）

## 实现逻辑

### 正常流程

1. **安装（install）**
   - 验证目标空间存在（通过 `getSpacePath`）
   - 验证 AppSpec 合法性（Zod schema）
   - 检查是否重复安装（specId + spaceId 唯一约束）
   - 生成 UUID 作为 appId
   - 写入 SQLite `installed_apps` 表（原子操作）
   - 创建工作目录 `{spacePath}/.aico-bot/apps/{appId}/` 和 `memory/` 子目录
   - 若目录创建失败，回滚数据库记录

2. **卸载（uninstall）**
   - 软删除：状态转为 `uninstalled`，记录 `uninstalled_at` 时间戳
   - 保留数据库记录和工作目录数据
   - 触发状态变更事件

3. **重装（reinstall）**
   - 仅允许从 `uninstalled` 状态恢复到 `active`
   - 清除 `uninstalled_at` 时间戳
   - 触发状态变更事件

4. **永久删除（deleteApp）**
   - 仅允许对 `uninstalled` 状态的 App 执行
   - 从 SQLite 删除记录
   - 递归删除工作目录（`rmSync`，失败不阻塞）

5. **暂停/恢复（pause/resume）**
   - 暂停：`active` -> `paused`，移除调度任务
   - 恢复：`paused`/`error`/`needs_login` -> `active`，重新注册调度任务
   - 均触发状态变更事件

6. **配置更新**
   - `updateConfig`：替换整个 userConfig 对象
   - `updateFrequency`：通过 userOverrides 覆盖订阅频率
   - `updateOverrides`：合并式更新 userOverrides
   - `updateSpec`：JSON Merge Patch 语义，null 表示删除字段，重新走 Zod 验证

7. **权限管理**
   - `grantPermission`：添加到 granted 列表，从 denied 列表移除
   - `revokePermission`：反向操作

### 状态机

```
active ──────► paused
  │               │
  ▼               ▼
error ────────► active (resume)
  │
  ▼
needs_login ──► active (resume)
  │
  ▼
waiting_user ─► active / error / paused
  │
  ▼
uninstalled ──► active (reinstall)
```

合法转换表（VALID_TRANSITIONS）：
- `active` -> `paused`, `error`, `needs_login`, `waiting_user`, `uninstalled`
- `paused` -> `active`, `uninstalled`
- `error` -> `active`, `paused`, `uninstalled`
- `needs_login` -> `active`, `paused`, `uninstalled`
- `waiting_user` -> `active`, `paused`, `error`, `uninstalled`
- `uninstalled` -> `active`

### 异常流程

1. **空间不存在**：抛出 `SpaceNotFoundError`
2. **App 不存在**：抛出 `AppNotFoundError`
3. **重复安装**：先检查数据库，再捕获 SQLITE_CONSTRAINT_UNIQUE，统一抛出 `AppAlreadyInstalledError`
4. **非法状态转换**：抛出 `InvalidStatusTransitionError`
5. **目录创建失败**：回滚数据库记录，抛出原始错误
6. **Spec 验证失败**：`updateSpec` 中 Zod 验证不通过时抛出 `AppSpecValidationError`

## 涉及 API

→ 无独立 HTTP API，通过 IPC 通道暴露给渲染进程

## 涉及数据

→ db/schema.md（installed_apps 表）

SQLite 表结构：
- `installed_apps`：id(PK), spec_id, space_id, spec_json, status, pending_escalation_id, user_config_json, user_overrides_json, permissions_json, installed_at, last_run_at, last_run_outcome, error_message, uninstalled_at
- 索引：`idx_installed_apps_space`(space_id), `idx_installed_apps_status`(status)
- 约束：UNIQUE(spec_id, space_id)

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/main/apps/manager/index.ts` | 模块入口，初始化/关闭，单例管理 |
| `src/main/apps/manager/service.ts` | 核心业务逻辑，状态机，事件通知 |
| `src/main/apps/manager/store.ts` | SQLite CRUD，预处理语句 |
| `src/main/apps/manager/types.ts` | 公共类型定义 |
| `src/main/apps/manager/errors.ts` | 领域错误类型 |
| `src/main/apps/manager/migrations.ts` | 数据库迁移（v1 建表，v2 加 uninstalled_at） |

## 变更

→ changelog.md
