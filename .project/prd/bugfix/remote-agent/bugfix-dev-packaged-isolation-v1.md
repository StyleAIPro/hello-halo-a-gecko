# PRD [Bug 修复级] — dev 与 packaged 实例日志和远程部署路径未隔离

> 版本：bugfix-dev-packaged-isolation-v1
> 日期：2026-04-16
> 指令人：@moonseeker1
> 归属模块：modules/remote-deploy
> 严重程度：Medium（并发运行时日志混写、远程代理冲突）
> 所属功能：features/websocket-client

## 问题描述

- **期望行为**：dev 版和 packaged 版各自独立运行，不互相干扰
- **实际行为**：本地日志写入同一目录，远程部署到同一路径（`/opt/claude-deployment`），远程日志和 token 共用；clientId 仅基于 machineId，dev/packaged hash 相同导致部署路径、token、proxy 端口全部冲突
- **复现步骤**：同时运行 `npm run dev` 和打包 exe，观察日志和远程服务器

## 根因分析

| 资源 | 当前行为 | 影响 |
|------|---------|------|
| 本地日志 | electron-log 默认使用 `app.getPath('userData')`，dev 和 packaged 写入同一日志目录 | 日志混写，难以排查问题 |
| 远程部署路径 | 硬编码 `/opt/claude-deployment` | 两个实例部署同一代理，代码互相覆盖 |
| 远程日志 | `/opt/claude-deployment/logs/output.log` | 共用，无法区分来源 |
| 远程 tokens | `/opt/claude-deployment/tokens.json` | 共用，一个实例注册 token 可能影响另一个 |
| clientId | `getClientId()` 仅 hash machineId，dev/packaged 结果相同 | deployPath、proxy 端口、auth token 全部冲突，多实例互踢 |

## 修复方案

1. **本地日志**：dev 模式（`isDev`）将 electron-log 文件路径覆盖为 `~/.aico-bot-dev/logs/`
2. **远程部署路径**：`DEPLOY_AGENT_PATH` 根据 `app.isPackaged` 区分：
   - packaged → `/opt/claude-deployment`
   - dev → `/opt/claude-deployment-dev`
3. **clientId 区分**：`getClientId(mode)` 接受 `'dev' | 'packaged'` 参数，hash 时加入 mode 后缀，使同一台机器上 dev 和 packaged 生成不同 clientId，从而隔离部署路径、proxy 端口和 auth token

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始 Bug 修复 PRD | @moonseeker1 |
| 2026-04-16 | 追加 clientId dev/packaged 区分方案 | @moonseeker1 |
