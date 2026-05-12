# Bugfix PRD: Agent 高风险操作不询问用户许可

## 元信息

| 字段 | 值 |
|------|------|
| 时间 | 2026-05-11 |
| 状态 | draft |
| 指令人 | @mi-saka |
| 级别 | bugfix |
| 模块 | agent |

## 问题描述

Agent 在执行高风险操作（如删除文件、执行破坏性命令等）时不会询问用户许可，直接执行。用户无法在 Agent 执行危险操作前介入确认，存在数据丢失风险。

## 根因分析

`sdk-config.ts` 第 726 行硬编码使用 `permissionMode: 'bypassPermissions'`，完全绕过了 SDK 的权限检查系统。同时第 704 行通过 `extraArgs` 传递了 `'dangerously-skip-permissions': null`，这两处共同导致所有权限检查被跳过。

SDK 权限模式说明：

| 模式 | 行为 |
|------|------|
| `default` | 写操作（编辑文件、执行命令等）需要用户确认 |
| `acceptEdits` | 自动接受编辑，但其他操作仍需确认 |
| `bypassPermissions` | 完全绕过权限检查 |
| `plan` | 规划模式，所有操作都需要确认 |

`mcp-manager.ts` 第 178 行同样使用 `bypassPermissions`，但该处仅做一次 MCP 状态检查（maxTurns: 1），不涉及用户操作，属于合理使用，不需要修改。

## 技术方案

修改 `src/main/services/agent/sdk-config.ts` 中的两处设置：

1. **第 726 行**：将 `permissionMode` 从 `'bypassPermissions'` 改为 `'default'`
2. **第 704 行**：移除 `extraArgs` 中的 `'dangerously-skip-permissions': null`

`mcp-manager.ts` 第 178 行保持 `bypassPermissions` 不变。

## 涉及文件

| 文件 | 预估变更 |
|------|---------|
| `src/main/services/agent/sdk-config.ts` | 修改 permissionMode、移除 dangerously-skip-permissions |

## 验收标准

- [ ] Agent 执行写操作（编辑文件、执行命令等）时，前端正确弹出权限确认
- [ ] 用户确认后操作正常执行，拒绝后操作被阻断
- [ ] Agent 普通读操作不受影响，无需确认
- [ ] MCP 健康检查功能正常（mcp-manager.ts 未被修改）
- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过
