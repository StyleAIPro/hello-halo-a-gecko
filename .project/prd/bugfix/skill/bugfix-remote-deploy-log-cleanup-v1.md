# PRD [Bugfix] — RemoteDeploy 日志降噪

| 字段 | 值 |
|------|------|
| 版本 | v1 |
| 日期 | 2026-05-07 |
| 指令人 | @misakamikoto |
| 模块 | main（Remote Deploy） |
| 状态 | done |
| 优先级 | P2 |
| 影响范围 | 仅主进程日志文件 |

## 需求分析

### 背景

`src/main/services/remote/deploy/` 目录下的远程部署模块包含大量操作日志（`console.log`、`console.warn`），在远程 agent 部署、SSH 连接、健康检查等过程中产生大量日志输出，影响日志文件的可读性和排查效率。用户要求精简这些日志，生产环境只保留错误级别的日志。

### 问题

1. 远程部署过程中，`agent-runner.ts` 单文件就有 80 处 `console.log/warn`，`server-manager.ts` 有 41 处，总计约 144 处非错误日志
2. 生产环境 `fileLevel='info'` 会将 `log` 和 `warn` 级别的日志全部写入文件，导致日志文件膨胀
3. 正常操作日志（如端口分配、agent 启停、健康检查心跳等）对生产环境排查无价值，但噪声极大

### 期望行为

- 所有 `console.log` 降级为 `console.debug`，生产环境不写入文件
- 所有 `console.warn` 降级为 `console.debug`，生产环境不写入文件
- 所有 `console.error` 保持不变，确保错误信息可追溯
- dev 模式下（`DEBUG=*` 或控制台过滤）仍可看到 debug 级别日志，不影响开发调试

## 技术方案

### 核心策略

全局替换，无逻辑变更：

| 原调用 | 替换为 | 理由 |
|--------|--------|------|
| `console.log(...)` | `console.debug(...)` | 信息类日志，生产环境无需记录 |
| `console.warn(...)` | `console.debug(...)` | 操作类警告，非错误，降级处理 |
| `console.error(...)` | `console.error(...)` | **保持不变** |

生产环境日志文件级别为 `info`，`console.debug` 不会被写入文件。dev 模式下浏览器 DevTools 或终端默认显示 debug 级别日志，不影响开发调试。

## 涉及文件

| 文件 | console.log/warn 处数 | 说明 |
|------|----------------------|------|
| `src/main/services/remote/deploy/agent-runner.ts` | 80 | 远程 agent 启动/停止/重启、SDK 部署、健康检查等过程日志 |
| `src/main/services/remote/deploy/server-manager.ts` | 41 | server CRUD、SSH 连接、端口分配等操作日志 |
| `src/main/services/remote/deploy/agent-deployer.ts` | 9 | 部署过程日志 |
| `src/main/services/remote/deploy/health-monitor.ts` | 7 | 健康监控日志（另有 1 处 console.error 保持不变） |
| `src/main/services/remote/deploy/remote-skill-manager.ts` | 4 | 远程技能列表日志 |
| `src/main/services/remote/deploy/remote-deploy.service.ts` | 3 | 部署服务入口日志 |
| `src/main/services/remote/deploy/port-allocator.ts` | 0 | 无需修改 |
| `src/main/services/remote/deploy/machine-id.ts` | 0 | 无需修改 |

> **注**：`port-allocator.ts` 和 `machine-id.ts` 经检查无 `console.log/warn`，无需修改。实际共 6 个文件、144 处需要降级。

**不动文件**（仅含 `console.error` 的文件不受影响）：
- `port-allocator.ts`、`machine-id.ts` — 无 log/warn
- 各文件中的 `console.error` 调用（共 16 处，分布在 `agent-runner.ts` 10 处、`server-manager.ts` 5 处、`health-monitor.ts` 1 处）保持不变

## 验收标准

- [ ] 远程部署过程中，日志文件无 `[RemoteDeployService]` / `[AgentRunner]` / `[ServerManager]` 等前缀的 log/warn 级别日志
- [ ] 远程 SSH 连接、agent 启停、健康检查等操作日志全部降级为 debug
- [ ] 所有 `console.error` 调用保持不变，错误信息正常输出
- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过

## 变更记录

| 日期 | 变更 |
|------|------|
| 2026-05-07 | 初稿 |
