# 模块 — 设置系统 settings-v1

> 版本：settings-v1
> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源架构：无（初始版本）

## 职责

管理应用的全局设置和配置，包括 API 配置、外观主题、远程访问、模型选择等。是用户配置应用行为的唯一入口。

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                     Settings Module                              │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐     │
│  │ config.service │  │secure-storage │ │ settings-page       │     │
│  │ (配置管理)     │ │ (加密存储)    │ │  (设置页面)          │     │
│  └──────────────┘  └──────────────┘  └────────────────────┘     │
│                                                                  │
│  设置分区:                                                       │
│  ├── AI 源管理 (→ ai-sources 模块)                               │
│  ├── 外观主题                                                    │
│  ├── 远程访问                                                    │
│  ├── 通知渠道 (→ notification 模块)                              │
│  ├── GitHub/GitCode (→ ai-sources 模块)                         │
│  ├── MCP 服务器                                                  │
│  ├── 注册表                                                      │
│  └── 系统信息                                                    │
└─────────────────────────────────────────────────────────────────┘

外部依赖:
  → ai-sources 模块（AI 源设置）
  → notification 模块（通知渠道设置）
  → config.service（配置持久化）
```

## 对外接口

### IPC Handle 通道

| 方法 | 通道名 | 输入 | 输出 | 说明 |
|------|--------|------|------|------|
| getConfig | `config:get` | 无 | `{ success, data: AppConfig }` | 获取应用配置 |
| saveConfig | `config:set` | `{ config }` | `{ success }` | 保存应用配置 |

## 内部组件

| 组件 | 职责 | 文件 |
|------|------|------|
| config.service | 应用配置管理（读取/保存/解密） | `services/config.service.ts` |
| secure-storage.service | 加密存储服务 | `services/secure-storage.service.ts` |
| SettingsPage | 设置页面容器 | `renderer/pages/SettingsPage.tsx` |
| SettingsNav | 设置导航 | `renderer/components/settings/SettingsNav.tsx` |
| AppearanceSection | 外观设置 | `renderer/components/settings/AppearanceSection.tsx` |
| SystemSection | 系统设置 | `renderer/components/settings/SystemSection.tsx` |
| AboutSection | 关于页面 | `renderer/components/settings/AboutSection.tsx` |
| RemoteAccessSection | 远程访问设置 | `renderer/components/settings/RemoteAccessSection.tsx` |
| RemoteServersSection | 远程服务器管理 | `renderer/components/settings/RemoteServersSection.tsx` |
| ProviderSelector | 模型提供商选择器 | `renderer/components/settings/ProviderSelector.tsx` |
| McpServerList | MCP 服务器列表 | `renderer/components/settings/McpServerList.tsx` |
| RegistrySection | 注册表设置 | `renderer/components/settings/RegistrySection.tsx` |
| nav-config | 导航配置 | `renderer/components/settings/nav-config.ts` |
| types | 设置页面类型 | `renderer/components/settings/types.ts` |

### 归属 IPC Handler

| Handler | 文件 |
|---------|------|
| config | `ipc/config.ts` |

## 功能列表

| 功能 | 状态 | 文档 |
|------|------|------|
| settings-page | 已完成 | features/settings-page/design.md |
| appearance | 已完成 | features/appearance/design.md |
| system-settings | 已完成 | features/system-settings/design.md |

## 绑定的 API

- 无

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始模块文档 | @moonseeker1 |
