# 功能 — remote-deploy

> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源 PRD：无（初始文档化）
> 所属模块：modules/remote-agent/remote-agent-v1

## 描述
远程 Agent 代理服务的完整部署生命周期管理。涵盖远程服务器的增删改查（CRUD）、SSH 连接管理、Agent SDK 安装检测与部署、Agent 代码上传与启动/停止、Token 注册（支持多 PC 同时连接）、AI 源配置绑定、远程技能安装，以及部署进度的实时回调通知。部署目标路径为 `/opt/claude-deployment`，代码来源于本地 `packages/remote-agent-proxy/dist/` 的预构建产物，打包为 `tar.gz` 后通过 SFTP 上传。

## 依赖
- `src/main/services/remote-ssh/ssh-manager.ts` — `SSHManager`（SSH 连接执行命令、文件上传/下载）
- `src/main/services/config.service.ts` — `getConfig()`/`saveConfig()` 读写配置文件中的 `remoteServers`
- `src/main/services/secure-storage.service.ts` — `decryptString()` 解密密码
- `src/main/services/remote-ws/remote-ws-client.ts` — `removePooledConnection()` 删除服务器时清理连接池
- `src/main/services/agent/system-prompt.ts` — `SYSTEM_PROMPT_TEMPLATE` 部署时同步系统提示词
- `packages/remote-agent-proxy/` — 预构建的远程 Agent Proxy 代码（`dist/` 目录）

## 实现逻辑

### 正常流程

**添加服务器（`addServer()`）**
1. 生成唯一 serverId 和 authToken
2. 构建 `RemoteServerConfig`，存入内存 `servers` Map
3. 持久化到配置文件（`saveServers()`）
4. 建立 SSH 连接（`connectServer()`）
5. 自动检测已安装的 Agent（`detectAgentInstalled()`），不影响添加流程

**部署 Agent（`deployToServer()`）**
1. 确保服务器已连接，设置状态为 `deploying`
2. 调用 `deployAgentSDK()` 安装 Claude Agent SDK
3. 调用 `deployAgentCode()` 上传并安装代理代码
4. 部署完成，恢复状态为 `connected`

**部署 Agent 代码（`deployAgentCode()`）**
1. 确保 SSH 连接健康（`ensureSshConnectionHealthy()`）
2. 创建远程目录结构：`/opt/claude-deployment/{dist,logs,data}` 和 `~/.agents/{skills,claude-config}`
3. 检查本地 `packages/remote-agent-proxy/dist/` 是否存在
4. 将 dist/、patches/、scripts/、package.json 打包为 `tar.gz`（`createDeployPackage()`）
5. 通过 SFTP 上传到远程 `/opt/claude-deployment/`
6. 远程解压并执行 `npm install --production`
7. 同步系统提示词到远程（写入 `system-prompt.js`）
8. 生成版本信息文件（`version.json`）
9. 注册本机 Token 到远程白名单（`registerTokenOnRemote()`）
10. 自动重启 Agent（`startAgent()`）

**启动 Agent（`startAgent()`）**
1. 确保 logs 目录存在
2. 检查是否有旧进程运行，有则先停止
3. 注册本机 Token 到远程 `tokens.json`（支持多 PC 连接）
4. 从 `tokens.json` 读取 bootstrap token 作为环境变量
5. 使用 `nohup` 启动 `node /opt/claude-deployment/dist/index.js`
6. 设置环境变量：`REMOTE_AGENT_PORT`、`REMOTE_AGENT_AUTH_TOKEN`、`REMOTE_AGENT_WORK_DIR`、`IS_SANDBOX=1`
7. 等待端口监听就绪（最多 15 秒，1 秒间隔重试）

**停止 Agent（`stopAgent()`）**
1. 通过 `pgrep` 查找 Agent 进程 PID
2. 发送 `SIGTERM` 优雅停止（5 秒超时）
3. 超时后 `SIGKILL` 强制终止
4. 等待端口释放（最多 5 秒）

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
3. **Node.js 未安装** — 检测后返回错误，提示安装 Node.js
4. **端口占用** — Agent 启动后端口监听检查失败，等待重试
5. **Token 注册失败** — 不阻塞部署，仅日志记录
6. **进程停止失败** — `SIGTERM` 超时后强制 `SIGKILL`

## 涉及 API
- `RemoteDeployService` 单例方法：`addServer()`、`getServers()`、`getServer()`、`updateServer()`、`removeServer()`、`deployToServer()`、`deployAgentCode()`、`startAgent()`、`stopAgent()`、`checkAgentInstalled()`、`deployAgentSDK()`、`installRemoteSkill()`、`updateServerAiSource()`、`updateServerModel()`

## 涉及数据
- `~/.aico-bot/config.json` — `remoteServers[]` 服务器配置持久化
- `/opt/claude-deployment/` — 远程部署目录（dist/、logs/、data/、tokens.json、version.json）
- `packages/remote-agent-proxy/dist/` — 本地预构建产物

## 变更
-> changelog.md
