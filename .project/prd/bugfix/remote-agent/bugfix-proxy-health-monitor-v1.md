# PRD [Bug 修复级] — 远程 Proxy 健康监控与自动恢复

> 版本：bugfix-proxy-health-monitor-v1
> 日期：2026-04-16
> 指令人：@zhaoyinqi
> 反馈人：@zhaoyinqi
> 归属模块：modules/remote-agent
> 严重程度：Major

## 问题描述
- **期望行为**：远程服务器管理卡片上的 Proxy 联通状态应实时反映远端 proxy 服务的真实运行状态。当 proxy 进程挂掉后，UI 应自动更新为"Bot Proxy Stopped"状态；如果文件齐全，系统应自动拉起 proxy；如果文件缺失，应提示用户手动更新 Agent。
- **实际行为**：`proxyRunning` 状态仅在 `detectAgentInstalled()` 被调用时更新（部署/手动连接时）。该检测不是周期性的。Proxy 挂掉后，UI 仍显示绿色的"Bot Proxy OK"，不会自动变红，也不会自动恢复。
- **复现步骤**：
  1. 部署 Agent 到远程服务器，确认 proxy 正常运行（UI 显示绿色"Bot Proxy OK"）
  2. 在远程服务器上手动杀掉 proxy 进程（如 `pkill -f "node.*claude-deployment"`）
  3. 观察远程服务器管理卡片 — proxy 状态仍显示绿色"Bot Proxy OK"

## 根因分析
`remote-deploy.service.ts` 中的 `detectAgentInstalled()` 方法虽然实现了 proxy 健康检查逻辑（通过 SSH 执行 `curl http://localhost:${healthPort}/health`），但该方法仅在以下时机被调用：
- 部署 Agent 时（`deployToServer()` → `detectAgentInstalled()`）
- 添加服务器后自动检测（`addServer()` → `detectAgentInstalled()`）
- 用户手动触发（但 UI 上已移除手动检测按钮）

**没有后台定时器周期性执行健康检查。** `proxyRunning` 状态一旦写入配置就不再更新，导致 proxy 进程挂掉后 UI 状态永远停留在上次检测结果。

## 修复方案

### 新增后台周期健康检查机制

在 `RemoteDeployService` 中新增 `startHealthMonitor()` / `stopHealthMonitor()` 方法，对所有状态为 `connected` 且已分配端口的服务器执行周期性 proxy 健康检查。

#### 检查流程

```
每 30 秒执行一次（对所有 connected + assignedPort 的服务器）：
  │
  ├─ 1. 通过 SSH 执行 curl health 端点
  │     └─ health 端点: http://localhost:${assignedPort + 1}/health
  │
  ├─ 2. 判断结果：
  │     ├─ status === 'ok' → proxyRunning = true（如果之前是 false，更新状态）
  │     │
  │     └─ status !== 'ok'（proxy 挂了）→ proxyRunning = false
  │           │
  │           ├─ 3. 自动恢复流程：
  │           │     ├─ a. 检查部署目录文件完整性
  │           │     │     关键文件清单：
  │           │     │     - {deployPath}/dist/index.js（入口文件）
  │           │     │     - {deployPath}/dist/server.js（服务器核心）
  │           │     │     - {deployPath}/dist/claude-manager.js（Agent 管理）
  │           │     │     - {deployPath}/dist/types.js（类型定义）
  │           │     │     - {deployPath}/package.json（依赖声明）
  │           │     │     - {deployPath}/node_modules/（依赖目录）
  │           │     │
  │           │     ├─ b. 文件齐全 → 自动调用 startAgent() 拉起 proxy
  │           │     │     └─ 等待 5 秒后再次 curl 验证，成功则更新 proxyRunning = true
  │           │     │
  │           │     └─ c. 文件不齐全 → 设置 proxyRunning = false，并显示告警
  │           │           └─ 通过 emitDeployProgress 发送告警消息：
  │           │              "Proxy 进程已停止且部署文件不完整，请使用 Update Agent 重新部署"
  │           │
  │           └─ 4. 更新 server.proxyRunning 并通知 UI
  │
  └─ 5. 对非 connected 或无 assignedPort 的服务器跳过检查
```

#### 实现细节

1. **健康检查定时器**
   - 在 `RemoteDeployService` 构造函数中初始化 `healthCheckTimer`
   - 在 `initialize()` 或 `loadServers()` 之后启动健康检查循环
   - 应用退出时清理定时器（`destroy()` 方法）
   - 检查间隔：30 秒（可通过常量配置）

2. **文件完整性检查**
   - 新增私有方法 `checkDeployFilesIntegrity(id: string): Promise<boolean>`
   - 通过 SSH 检查关键文件是否存在：`test -f {path} && echo ok || echo missing`
   - 一次 SSH 命令检查所有关键文件（用 `&&` 连接）

3. **自动恢复逻辑**
   - 新增私有方法 `tryAutoRecoverProxy(id: string): Promise<void>`
   - 先检查文件完整性，再决定是自动启动还是告警
   - 自动恢复失败时（启动后仍不健康）设置告警状态
   - 添加防抖：同一服务器连续 3 次自动恢复失败后停止自动恢复尝试，直到用户手动操作

4. **UI 告警显示**
   - 在 `RemoteServersSection.tsx` 中监听 `remote-server:deploy-progress` 事件
   - 当收到告警类型消息时，在服务器卡片上显示告警提示
   - 告警消息包含"Update Agent"操作按钮，点击调用 `api.updateAgent(serverId)`

5. **状态更新**
   - `proxyRunning` 变化时通过 `updateServer()` 自动触发 `remote-server:status-change` 事件
   - UI 已有的 `getAgentStatusBadge()` 会自动响应 `proxyRunning` 的变化，无需修改 UI 渲染逻辑

6. **性能考虑**
   - 只对 `connected` 且有 `assignedPort` 的服务器执行检查
   - 检查命令使用 `--connect-timeout 3` 超时限制
   - 文件检查与 proxy 启动不在同一轮执行（避免阻塞其他服务器的检查）

## 影响范围
- [x] 涉及功能设计变更 → modules/remote-agent/features/remote-deploy/design.md
- [ ] 涉及 API 变更 → 无新 IPC 端点，复用现有 status-change 和 deploy-progress 事件
- [ ] 涉及数据结构变更 → 无

## 验证方式
1. 部署 Agent 到远程服务器，确认 proxy 正常运行，UI 显示绿色"Bot Proxy OK"
2. 在远程服务器上杀掉 proxy 进程（`pkill -f "node.*claude-deployment"`）
3. 等待最多 30 秒，观察 UI 应自动变为红色"Bot Proxy Stopped"
4. 再等待最多 30 秒（下一轮检查周期），proxy 应自动被拉起，UI 恢复绿色"Bot Proxy OK"
5. 删除远程部署目录中的关键文件（如 `dist/index.js`），杀掉 proxy
6. 等待最多 30 秒，UI 应显示红色"Bot Proxy Stopped"并出现告警提示"请使用 Update Agent 重新部署"
7. 点击"Update Agent"按钮，确认能正常重新部署
8. 长时间运行测试：确认 30 秒周期检查不会导致 SSH 连接堆积或性能问题

## 变更
| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始 PRD | @zhaoyinqi |
| 2026-04-16 | 修复两个问题：(1) connectServer 成功后重置 autoRecoverFailures；(2) updateAgent 增加快速重启路径——文件完整且 SDK 版本匹配时只 stop+start，不传文件 | @zhaoyinqi |
| 2026-04-17 | 移除自动恢复逻辑（tryAutoRecoverProxy），健康检查仅更新 proxyRunning 状态 | @zhaoyinqi |
| 2026-04-17 | 修复快速路径不生效：IPC handler 直接调 updateAgentCode 绕过 service 层，改为委托 deployService.updateAgent() | @zhaoyinqi |
| 2026-04-17 | 修复 startAgent 僵尸进程问题：pgrep 检测到旧进程时先 curl health 验证，不健康则 kill 后重启 | @zhaoyinqi |
| 2026-04-17 | 修复 registerTokenOnRemote is not a function：删除残留死代码调用 | @zhaoyinqi |
| 2026-04-17 | updateAgent 拉起 proxy 后立即 verifyProxyHealth，不等后台健康检查周期 | @zhaoyinqi |
| 2026-04-17 | 健康监控改用 static 全局定时器防止热重载双定时器；动态列表已自动生效（每轮从 servers Map 读取 connected 状态） | @zhaoyinqi |
| 2026-04-17 | addServer/updateAgent 统一为按需部署逻辑：缺什么补什么（SDK 不达标只装 SDK，文件缺失只传文件，都 OK 只 restart），最后 verifyProxyHealth | @zhaoyinqi |
| 2026-04-17 | checkDeployFilesIntegrity 增加版本比对：对比远程和本地 dist/version.json 的 buildTimestamp，远程版本旧于本地时也触发代码部署 | @zhaoyinqi |
