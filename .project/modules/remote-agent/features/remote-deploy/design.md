# 功能 — remote-deploy

> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源 PRD：无（初始文档化）
> 所属模块：modules/remote-agent/remote-agent-v1

## 描述
远程 Agent 代理服务的完整部署生命周期管理。涵盖远程服务器的增删改查（CRUD）、SSH 连接管理、Agent SDK 安装检测与部署、Agent 代码上传与启动/停止、AI 源配置绑定、远程技能安装，以及部署进度的实时回调通知。部署目标路径为按 PC 隔离的 `/opt/claude-deployment-{clientId}`，代码来源于本地 `packages/remote-agent-proxy/dist/` 的预构建产物，打包为 `tar.gz` 后通过 SFTP 上传。

## 依赖
- `src/main/services/remote-ssh/ssh-manager.ts` — `SSHManager`（SSH 连接执行命令、文件上传/下载）
- `src/main/services/config.service.ts` — `getConfig()`/`saveConfig()` 读写配置文件中的 `remoteServers`
- `src/main/services/secure-storage.service.ts` — `decryptString()` 解密密码
- `src/main/services/remote-ws/remote-ws-client.ts` — `removePooledConnection()` 删除服务器时清理连接池
- `src/main/services/agent/system-prompt.ts` — `SYSTEM_PROMPT_TEMPLATE` 部署时同步系统提示词
- `packages/remote-agent-proxy/` — 预构建的远程 Agent Proxy 代码（`dist/` 目录）
- `src/shared/constants/sdk.ts` — `CLAUDE_AGENT_SDK_VERSION` 统一 SDK 版本常量
- `src/main/services/remote-deploy/machine-id.ts` — `getClientId()` 生成每台 PC 的唯一标识
- `src/main/services/remote-deploy/port-allocator.ts` — `resolvePort()` 按 clientId 分配远程端口

## 实现逻辑

### 正常流程

**添加服务器（`addServer()`）**
1. 生成唯一 serverId、authToken，计算 clientId（`getClientId()`）
2. 构建 `RemoteServerConfig`，设置按 PC 隔离的 `deployPath: /opt/claude-deployment-{clientId}`
3. 持久化到配置文件（`saveServers()`）
4. 建立 SSH 连接（`connectServer()`），分配端口（`resolvePort()`）
5. 自动检测远程环境（`checkDeployFilesIntegrity()` + `checkRemoteSdkVersion()`）
6. 根据检测结果自动按需部署：
   - 文件缺失 → 自动 `deployAgentCode()`（完整部署，含 Node.js 环境检查、npm install、SDK 补丁上传）
   - `buildTimestamp` 比对发现远程版本旧 → 自动 `deployAgentCode()` 更新代码
   - SDK 版本不达标 → 自动 `deployAgentSDK()` 更新 SDK
   - 多个条件同时满足时，先装 SDK 再传代码（SDK 不达标 + 文件缺失/版本旧）
   - 文件和 SDK 都 OK 且 proxy 运行中 → `stopAgent()` + `startAgent()` 同步新 authToken
   - 文件和 SDK 都 OK 且 proxy 未运行 → 直接 `startAgent()` 拉起
7. 拉起后立即 `verifyProxyHealth()` 检查连通性（不等后台健康检查周期）
8. 部署失败不阻塞添加，提示用户手动 Update Agent 重试

**部署 Agent（`deployToServer()`）**
1. 确保服务器已连接，设置状态为 `deploying`
2. 调用 `deployAgentSDK()` 安装 Claude Agent SDK
3. 调用 `deployAgentCode()` 上传并安装代理代码
4. 部署完成，恢复状态为 `connected`

**更新 Agent（`updateAgent()`）— 按需更新**
1. 检查远程环境：`checkDeployFilesIntegrity()` → `{ filesOk, needsUpdate }` + `checkRemoteSdkVersion()`
2. 判断是否需要代码部署：`needsCodeDeploy = !filesOk || needsUpdate`
3. 停止 Agent（`stopAgent()`）
4. 按需部署：
   - SDK 不匹配 → `deployAgentSDK()`
   - 需要代码部署 → `deployAgentCode()`
   - 都不需要 → 仅 `startAgent()` 重启
5. 立即 `verifyProxyHealth()` 确认 proxy 连通

**部署文件完整性检查（`checkDeployFilesIntegrity()`）**
1. 通过 SSH 检查关键文件：`dist/index.js`、`dist/server.js`、`dist/claude-manager.js`、`dist/types.js`、`package.json`、`node_modules/`、`dist/version.json`
2. 文件缺失 → 返回 `{ filesOk: false, needsUpdate: true }`
3. 文件齐全 → 读取远程 `dist/version.json` 的 `buildTimestamp`，与本地版本比对
4. `buildTimestamp` 不一致 → 返回 `{ filesOk: true, needsUpdate: true }`（本地重新编译过，需要更新）

**部署 Agent 代码（`deployAgentCode()`）— 完整部署**
1. 确保 SSH 连接健康（`ensureSshConnectionHealthy()`）
2. 创建远程目录结构：`/opt/claude-deployment-{clientId}/{dist,logs,data}` 和 `~/.agents/{skills,claude-config}`
3. 检查本地 `packages/remote-agent-proxy/dist/` 是否存在
4. 将 dist/、patches/、scripts/、package.json 打包为 `tar.gz`（`createDeployPackage()`）
5. 通过 SFTP 上传到远程 `/opt/claude-deployment-{clientId}/`
6. 远程解压并执行 `npm install --production`
7. 全局安装 SDK（`npm install -g @anthropic-ai/claude-agent-sdk@{VERSION}`）
8. 上传本地 SDK 补丁（`sdk.mjs`），仅当本地有 patch 文件时
9. 同步系统提示词到远程（写入 `config/system-prompt.txt`）
10. 生成版本信息文件（`version.json`）
11. 检查活跃会话，无活跃会话时自动重启 Agent

**增量更新 Agent 代码（`updateAgentCode()`）— 快速路径**
1. 检查远程 `version.json` 和 npm/node 是否可用
2. 环境不完整 → 回退到 `deployAgentCode()` 完整部署
3. 打包上传 `tar.gz`
4. 比较 `package.json` MD5，有变更则 `npm install`；无变更则检查依赖完整性
5. 检查全局 SDK 版本，有变更则更新
6. 比较本地 SDK 补丁 MD5，有变更则上传
7. 同步系统提示词
8. 检查活跃会话，无活跃会话时自动重启 Agent

**启动 Agent（`startAgent()`）**
1. 确保 logs 目录存在
2. 读取并显示远程 `version.json` 构建信息
3. 检查是否有旧进程运行（`pgrep`），有则验证健康端点：
   - 健康端点返回 `ok` → 跳过启动（进程正常运行）
   - 健康端点失败 → 进程是僵尸，先 `stopAgent()` 杀掉再重启
4. 使用 `nohup` 启动 `node /opt/claude-deployment-{clientId}/dist/index.js`
5. 设置环境变量：`REMOTE_AGENT_PORT`、`REMOTE_AGENT_AUTH_TOKEN`、`REMOTE_AGENT_WORK_DIR`、`IS_SANDBOX=1`、`DEPLOY_DIR`
6. 等待端口监听就绪（5 秒），失败时检查日志
7. 自修复：日志显示 `ERR_MODULE_NOT_FOUND` 时自动 `npm install` 并重试

**停止 Agent（`stopAgent()`）**
1. 先断开池化的 WebSocket 连接（`removePooledConnection()`），防止 socket hang up
2. 通过 `pkill` 查找并终止 Agent 进程

**立即验证 Proxy 健康（`verifyProxyHealth()`）**
1. 等待 3 秒让 proxy 初始化
2. 通过 SSH curl health 端点（`http://localhost:${assignedPort+1}/health`，3 秒超时）
3. 更新 `proxyRunning` 状态（`updateServer()` → 触发 `remote-server:status-change` 事件）
4. UI 通过 `getAgentStatusBadge()` 自动响应状态变化

**后台健康监控（`startHealthMonitor()`）**
1. 构造函数中自动启动 30 秒周期定时器
2. 使用 `static globalHealthTimer` 防止热重载创建双定时器
3. 每轮动态遍历 `this.servers`，筛选 `connected` 且有 `assignedPort` 且 SSH 连接正常的服务器
4. 并行检查所有服务器（`Promise.allSettled`）
5. 通过 SSH curl health 端点（`http://localhost:${port+1}/health`，3 秒超时）
6. proxy 正常：`proxyRunning = true`，发出 `health-ok` 进度事件
7. proxy 异常：`proxyRunning = false`，**仅更新状态，不自动恢复**
8. `healthCheckInProgress` 防抖：上一轮未完成时跳过下一轮

**更新 AI 源（`updateServerAiSource()`）**
1. 从配置中查找 AI 源（`aiSources.sources`）
2. 解析 API Key/Access Token、Base URL、Model
3. 更新服务器配置中的 `claudeApiKey`、`claudeBaseUrl`、`claudeModel`

**部署进度回调**
- `onCommandOutput()` — 订阅命令输出（command/output/error/success）
- `onDeployProgress()` — 订阅部署进度（stage/message/progress%）
- 支持 UI 组件挂载/卸载后恢复状态（`updateOperations` Map）

**远程技能安装（`installRemoteSkill()`）**
1. 通过 SSH 在远程创建技能目录
2. 上传技能文件（GitHub 仓库或本地文件）
3. 在远程执行安装脚本

### 异常流程
1. **SSH 连接失败** — 设置服务器状态为 `error`，记录错误信息
2. **dist 目录不存在** — 抛出异常提示先执行 `npm run build`
3. **Node.js 未安装** — 检测后自动安装（支持 Debian/Ubuntu、RHEL/CentOS、EulerOS/openEuler、Alpine 等）
4. **npm/npx 异常** — 自动清理 standalone npx 包、修复 symlink、创建 wrapper 脚本
5. **端口占用** — Agent 启动后端口监听检查失败，检查日志并自修复
6. **僵尸进程** — `pgrep` 检测到进程但 health 端点不响应，先 kill 再重启
7. **进程停止失败** — `pkill` 直接终止（`stopAgent` 不做 SIGTERM → SIGKILL 分级）
8. **SSH 连接静默断开** — `ensureSshConnectionHealthy()` 在长操作前检测并自动重连
9. **自动部署失败** — 不阻塞服务器添加，记录错误并提示用户手动 Update Agent

## 涉及 API
- `RemoteDeployService` 单例方法：`addServer()`、`getServers()`、`getServer()`、`updateServer()`、`removeServer()`、`deployToServer()`、`deployAgentCode()`、`updateAgentCode()`、`startAgent()`、`stopAgent()`、`updateAgent()`、`checkAgentInstalled()`、`detectAgentInstalled()`、`deployAgentSDK()`、`installRemoteSkill()`、`updateServerAiSource()`、`updateServerModel()`、`verifyProxyHealth()`、`checkDeployFilesIntegrity()`、`checkRemoteSdkVersion()`、`getLocalAgentVersion()`、`restartAgentWithNewConfig()`、`cleanupOrphanDeployments()`、`deleteDeployment()`
- 健康监控：`startHealthMonitor()`、`stopHealthMonitor()`、`runHealthCheck()`、`checkServerHealth()`

## 涉及数据
- `~/.aico-bot/config.json` — `remoteServers[]` 服务器配置持久化
- `/opt/claude-deployment-{clientId}/` — 远程部署目录（dist/、logs/、data/、config/、version.json）
- `packages/remote-agent-proxy/dist/version.json` — 本地构建版本信息（含 `buildTimestamp`）
- `packages/remote-agent-proxy/dist/` — 本地预构建产物

## 变更
-> changelog.md

## SDK Patch 机制

AICO-Bot 本地和远程都通过运行时 patch 修改 `@anthropic-ai/claude-agent-sdk` 的 minified `sdk.mjs`，以绕过 SDK API 的设计限制。本地和远程各有一个独立的 patch 脚本，覆盖不同的功能需求。

> SDK 版本统一由 `src/shared/constants/sdk.ts` 中的 `CLAUDE_AGENT_SDK_VERSION` 常量管理。升级 SDK 时需同步更新该常量、根 `package.json` 和 proxy `package.json`，以及两个 patch 脚本中的 minified 变量名。

### 为什么需要 patch

SDK 的 `unstable_v2_createSession` API 在设计上对部分选项做了硬编码或忽略：

- **选项不转发**：`cwd`、`stderr`、`extraArgs`、`maxTurns`、`maxBudgetUsd`、`sandbox` 等传入后被 Tz 构造器丢弃，未传递给底层 ProcessTransport
- **systemPrompt 不生效**：调用方传入的 `systemPrompt` 未传递给 Query 构造器
- **ENTRYPOINT 标记**：SDK 设置 `process.env.CLAUDE_CODE_ENTRYPOINT = "sdk-ts"` 标记进程为 SDK 模式，导致部分功能被限制
- **版本号泄露**：SDK 硬编码 `process.env.CLAUDE_AGENT_SDK_VERSION`

### 本地 vs 远端 Patch 对比

| 维度 | 本地 (Electron 主进程) | 远端 (remote-agent-proxy) |
|------|----------------------|--------------------------|
| 脚本文件 | `src/main/services/agent/sdk-turn-injection-patch.ts` | `packages/remote-agent-proxy/scripts/patch-sdk.mjs` |
| 触发方式 | 模块 import 时自动执行（第 137 行 `patchSdkForTurnInjection()`） | 远程部署后首次启动时执行（`node scripts/patch-sdk.mjs`） |
| 修改目标 | `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`（本地 node_modules） | 远程服务器上 `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` |
| 幂等保护 | `patched` 布尔变量（进程级，重启后重新 patch） | `[PATCHED]` 文件标记（持久化，文件被改后永久生效） |
| 匹配策略 | 精确字符串匹配（非 minified 源码风格，如 `pendingMcpResponses = new Map;`） | 精确字符串匹配（minified 变量名，如 `new aX({`）+ 动态正则（ENTRYPOINT） |
| 当前状态 | **未适配 0.2.104**（代码中无任何引用，疑似死代码） | 已适配 0.2.104（5 个 patch 全部生效） |

### 本地 Patch 详情 (`sdk-turn-injection-patch.ts`)

> **当前状态**：该文件在代码库中**没有被任何模块 import**，`patchSdkForTurnInjection()` 不会被调用。代码中搜索 `enableContinueConversation`、`hasPendingMessages` 等由该 patch 注入的方法也**无调用方**。疑似为历史遗留死代码，功能可能已被 SDK 0.2.104 原生支持或其他机制替代。

该 patch 实现的是**轮级消息注入**（Turn-Level Message Injection），与远端 `patch-sdk.mjs` 的功能完全不同：

| # | 补丁名称 | 作用 |
|---|---------|------|
| 1 | 注入跟踪属性 | 在 Query 类添加 `_continueAfterResult`、`_pendingUserMessages` 属性 |
| 2 | 消息注入逻辑 | 修改 `readMessages()`，在 `result` 事件后自动出队并注入排队的用户消息 |
| 3 | send 拦截 | 修改 `send()`，result 后的新消息改为入队而非直接发送 |
| 4 | stream 持续迭代 | 修改 `stream()`，result 后若有排队消息则继续迭代而非 return |
| 5 | 辅助方法 | 在 Tz 类添加 `enableContinueConversation()`、`hasPendingMessages()`、`getPendingMessageCount()` |

**设计意图**：原生 SDK 的 `stream()` 在收到 `result` 事件后立即结束迭代。多轮对话场景下，如果用户在 Agent 回复过程中发送了新消息，这些消息会被丢弃。该 patch 让 SDK 支持在 result 后继续处理排队的消息。

### 远端 Patch 详情 (`patch-sdk.mjs`)

远端 patch 解决的是 SDK 选项转发的核心问题，本地代码中也有多处 `// Requires SDK patch` 注释依赖这些功能（如 `session-manager.ts:682`、`sdk-config.ts:594`）。

| # | 补丁名称 | 作用 | 匹配策略 |
|---|---------|------|---------|
| 1 | 移除 CLAUDE_CODE_ENTRYPOINT | 移除 3 处赋值，伪装为原生 CLI 进程 | 动态正则（minifier 安全） |
| 2 | 转发选项到 ProcessTransport | 将 `cwd`/`stderr`/`extraArgs`/`maxTurns`/`sandbox` 等从调用方参数转发 | 精确匹配 minified 变量名（`aX`、`Y`、`c1()`） |
| 3 | 传递 initConfig 到 Query | 解析 `systemPrompt` 构建 `initConfig` 对象并传入 Query 构造器 | 精确匹配 minified 变量名（`sX`） |
| 4 | 添加 pid getter | 补充 `get pid()` 访问底层进程 PID（0.2.104 已内置其他 4 个方法） | 精确匹配 minified 变量名（`B2`） |
| 5 | 移除 CLAUDE_AGENT_SDK_VERSION | 移除硬编码的版本号环境变量 | 精确 + fallback 正则 |
| 6 | 添加 patch 标记 | 插入 `[PATCHED]` 防止重复执行 | 始终执行 |

### 关键差异分析

1. **功能互补而非重复**：本地 patch 解决"消息排队注入"（Turn Injection），远端 patch 解决"选项转发"（Option Forwarding）。两者修改 SDK 的不同位置，理论上可以共存。

2. **本地缺少选项转发 patch**：本地 `session-manager.ts` 和 `sdk-config.ts` 传递了 `cwd`、`systemPrompt`、`resume` 等选项给 `unstable_v2_createSession`，并标注了 `// Requires SDK patch`。但本地**没有执行**远端 `patch-sdk.mjs` 中的选项转发 patch。本地可能通过以下方式绕过了限制：
   - `cwd`：通过 `env` 环境变量间接控制工作目录
   - `systemPrompt`：通过 `--add-dir` 指令注入到 CLI 子进程
   - `executable`：使用 headless Electron 而非 node，改变了进程行为

3. **版本升级风险**：两个 patch 脚本都依赖精确字符串匹配 minified 代码。SDK 升级后 minifier 会生成不同的变量名，两个脚本**都需要同步更新**。当前本地 patch 已无人维护，远端 patch 已适配 0.2.104。
