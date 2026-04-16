# 模块 — Space 管理 space-management-v1

> 版本：space-management-v1
> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源架构：无（初始版本）

## 职责

管理工作空间（Space）的完整生命周期，包括创建、读取、更新、删除、配置管理、本地文件存储、空间类型（本地/远程/Hyper Space）管理和偏好设置持久化。

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                     Space Management Module                      │
│                                                                  │
│  主进程 (Main)                                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                  space.service.ts                         │   │
│  │  ┌────────────────┐  ┌────────────────────────────────┐ │   │
│  │  │ spaces-index   │  │  Per-Space meta.json            │ │   │
│  │  │ .json (v3 索引) │  │  (偏好设置, workingDir 等)       │ │   │
│  │  └────────────────┘  └────────────────────────────────┘ │   │
│  │                                                          │   │
│  │  注册表 Map (内存) ──── 同步 ────→ 磁盘索引文件            │   │
│  │  listSpaces() = 纯内存读取 (零磁盘 IO)                    │   │
│  │  getSpace()   = 纯内存读取 (零磁盘 IO)                    │   │
│  │  getSpaceWithPreferences() = 按需加载 meta.json           │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│                        IPC 通道                                 │
│                              │                                   │
│  渲染进程 (Renderer)         ▼                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                  space.store.ts (Zustand)                 │   │
│  │  - spaces[] / currentSpace / defaultSpace                 │   │
│  │  - loadSpaces / createSpace / updateSpace / deleteSpace   │   │
│  │  - updateSpacePreferences / getSpacePreferences           │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘

存储结构:
  ~/.aico-bot/
    spaces/
      spaces-index.json          # 空间注册索引 (v3)
      <spaceId>/
        meta.json                # 空间偏好设置
        conversations/
          conversations-index.json
          <conversationId>.json
```

## 对外接口

### IPC Handle 通道（渲染进程 → 主进程）

| 方法 | 通道名 | 输入 | 输出 | 说明 |
|------|--------|------|------|------|
| getAicoBotSpace | `space:get-aico-bot` | 无 | `{ success, data: Space }` | 获取 AICO-Bot 临时空间 |
| listSpaces | `space:list` | 无 | `{ success, data: Space[] }` | 列出所有空间 |
| createSpace | `space:create` | `{ name, icon, customPath?, claudeSource?, remoteServerId?, remotePath?, systemPrompt? }` | `{ success, data: Space }` | 创建新空间 |
| deleteSpace | `space:delete` | `spaceId` | `{ success, error? }` | 删除空间 |
| getSpace | `space:get` | `spaceId` | `{ success, data: Space }` | 获取空间详情（含偏好设置） |
| updateSpace | `space:update` | `spaceId, { name?, icon?, ... }` | `{ success, data: Space }` | 更新空间属性 |
| openSpaceFolder | `space:open-folder` | `spaceId` | `{ success }` | 在文件管理器中打开空间目录 |
| getDefaultSpacePath | `space:get-default-path` | 无 | `{ success, data: string }` | 获取默认空间路径 |
| updateSpacePreferences | `space:update-preferences` | `spaceId, preferences` | `{ success }` | 更新空间偏好设置 |
| getSpacePreferences | `space:get-preferences` | `spaceId` | `{ success, data }` | 获取空间偏好设置 |
| createHyperSpace | `hyper-space:create` | `CreateHyperSpaceInput` | `{ success, data: Space }` | 创建 Hyper Space |
| getHyperSpaceStatus | `hyper-space:get-status` | `spaceId` | `{ success, data }` | 获取 Hyper Space 状态 |
| getSkillSpace | `space:get-skill-space` | 无 | `{ success, data: Space }` | 获取技能空间 |
| getSkillSpaceId | `space:get-skill-space-id` | 无 | `{ success, data: string }` | 获取技能空间 ID |
| isSkillSpace | `space:is-skill-space` | `spaceId` | `{ success, data: boolean }` | 判断是否为技能空间 |

## 内部组件

| 组件 | 职责 | 文件 |
|------|------|------|
| space.service.ts | 空间服务核心（CRUD、索引管理、v1/v2/v3 格式迁移、路径验证、临时空间管理） | `services/space.service.ts` |
| space.store.ts | 空间前端状态管理（Zustand store，加载/创建/更新/删除空间） | `renderer/stores/space.store.ts` |

## 功能列表

| 功能 | 状态 | 文档 |
|------|------|------|
| space-crud | 已完成 | features/space-crud/design.md |
| space-config | 已完成 | features/space-config/design.md |
| hyper-space | 已完成 | features/hyper-space/design.md |
| folder-management | 已完成 | features/folder-management/design.md |

## 绑定的 API

- 无（通过 IPC 通道暴露接口）

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始模块文档 | @moonseeker1 |
