# 功能 — 系统设置

> 日期：2026-04-16
> 指令人：@moonseeker1
> 所属模块：modules/settings/settings-v1

## 描述
管理系统级设置，包括远程访问配置、MCP 服务器管理、远程服务器管理等。

## 依赖
- config.service（配置持久化）
- remote-agent 模块（远程服务器）
- ai-browser 模块（MCP 服务器）

## 实现逻辑
1. 配置远程访问参数
2. 管理 MCP 服务器列表
3. 管理远程服务器连接

## 涉及文件
- `renderer/components/settings/SystemSection.tsx` — 系统设置 UI
- `renderer/components/settings/AboutSection.tsx` — 关于页面
- `renderer/components/settings/RemoteAccessSection.tsx` — 远程访问
- `renderer/components/settings/RemoteServersSection.tsx` — 远程服务器
- `renderer/components/settings/McpServerList.tsx` — MCP 服务器
- `renderer/components/settings/RegistrySection.tsx` — 注册表
- `services/config.service.ts` — 配置服务
- `services/secure-storage.service.ts` — 加密存储

## 变更
→ changelog.md
