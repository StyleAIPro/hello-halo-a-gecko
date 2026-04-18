# PRD [Bug 修复级] — startAgent pgrep 误判导致代理未启动

> 版本：bugfix-startAgent-pgrep-false-positive-v1
> 日期：2026-04-16
> 指令人：@claude
> 归属模块：modules/remote-agent
> 严重程度：Critical（代理更新后无法启动，远程功能完全不可用）
> 所属功能：features/remote-deploy

## 问题描述

- **期望行为**：updateAgent 部署代码后自动重启 proxy，或重连后检测到 proxy 未运行时自动启动
- **实际行为**：startAgent 误判代理已在运行，跳过启动，之后所有重连检测到 proxyRunning=false
- **复现步骤**：
  1. 远程服务器已有 proxy 运行中
  2. 执行 Update Agent（updateAgent）
  3. stopAgent pkill 杀掉 proxy
  4. 部署代码（npm install 等）
  5. startAgent 的 pgrep 检查误判"进程已存在"，跳过启动
  6. UI 永远显示"Bot 代理已停止"

## 根因分析

`startAgent()` 在 `remote-deploy.service.ts:1702-1713` 用 `pgrep -f "node.*${deployPath}"` 判断代理是否已运行：

```typescript
const checkResult = await manager.executeCommandFull(
  `pgrep -f "node.*${deployPath}" || echo "not running"`,
);
if (checkResult.exitCode === 0 && !checkResult.stdout.includes('not running')) {
  // "Agent already running, skipping start"
  return;
}
```

pgrep 只检查进程是否存在，不验证进程是否正常工作。以下场景会误判：
1. pkill 杀了 proxy 但进程残留为僵尸状态
2. 同一 deployPath 下有其他 node 进程（npm install 残留、其他工具）
3. packaged/dev 实例的 proxy 被 kill 后进程未完全退出

而 health 端点检查（`curl localhost:{port+1}/health`）能准确判断 proxy 是否正常工作，但 startAgent 没有使用它。

## 修复方案

`startAgent()` 的进程检查改为双重验证：pgrep + health 端点。

逻辑：
1. 先用 health 端点检查 proxy 是否正常（端口有响应且返回 `{"status":"ok"}`）
2. 如果 health 正常 → 确认代理在运行，跳过启动
3. 如果 health 失败但 pgrep 有匹配 → 进程异常，pkill 清理后继续启动
4. 如果 health 失败且 pgrep 无匹配 → 正常启动

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始 Bug 修复 PRD | @claude |
