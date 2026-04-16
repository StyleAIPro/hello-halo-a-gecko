# AICO-Bot Claude 集成方案

本文档详细说明 AICO-Bot 如何调用本地和远程服务器的 Claude，实现统一的 AI 助手体验。

## 目录

- [架构概览](#架构概览)
- [本地 Claude 调用](#本地-claude-调用)
- [远程 Claude 调用](#远程-claude-调用)
- [远程服务器部署](#远程服务器部署)
- [配置说明](#配置说明)
- [故障排查](#故障排查)

---

## 架构概览

```
┌─────────────────────────────────────────────────────────────────────┐
│                           AICO-Bot Electron App                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌─────────────────┐              ┌─────────────────────────────┐   │
│  │   Local Space   │              │       Remote Space          │   │
│  │                 │              │                              │   │
│  │  ┌───────────┐  │              │  ┌───────────────────────┐  │   │
│  │  │  Claude   │  │              │  │    SSH Tunnel         │  │   │
│  │  │  Agent    │  │              │  │    (ssh2)             │  │   │
│  │  │  SDK V2   │  │              │  └───────────┬───────────┘  │   │
│  │  │  Session  │  │              │              │              │   │
│  │  └─────┬─────┘  │              │              ▼              │   │
│  │        │        │              │  ┌───────────────────────┐  │   │
│  │        ▼        │              │  │   WebSocket Client    │  │   │
│  │  ┌───────────┐  │              │  │   (ws://localhost:8080)│  │   │
│  │  │  Claude   │  │              │  └───────────┬───────────┘  │   │
│  │  │  CLI      │  │              │              │              │   │
│  │  │ (subprocess)│              │              │ Network      │   │
│  │  └───────────┘  │              │              ▼              │   │
│  │                 │              │                    ┌────────┴───┐
│  └─────────────────┘              │                    │            │
│                                   │  ┌─────────────────▼────────┐ │
│                                   │  │   Remote Server          │ │
│                                   │  │   (124.71.177.25)        │ │
│                                   │  │                          │ │
│                                   │  │  ┌────────────────────┐  │ │
│                                   │  │  │ remote-agent-proxy │  │ │
│                                   │  │  │ (WebSocket Server) │  │ │
│                                   │  │  └─────────┬──────────┘  │ │
│                                   │  │            │             │ │
│                                   │  │            ▼             │ │
│                                   │  │  ┌────────────────────┐  │ │
│                                   │  │  │  Claude Agent SDK  │  │ │
│                                   │  │  │  V2 Session        │  │ │
│                                   │  │  └─────────┬──────────┘  │ │
│                                   │  │            │             │ │
│                                   │  │            ▼             │ │
│                                   │  │  ┌────────────────────┐  │ │
│                                   │  │  │  Claude CLI        │  │ │
│                                   │  │  │  (subprocess)      │  │ │
│                                   │  │  └────────────────────┘  │ │
│                                   │  │                          │ │
│                                   │  └──────────────────────────┘ │
│                                   └────────────────────────────────┘
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 本地 Claude 调用

### 核心组件

| 文件 | 说明 |
|------|------|
| `src/main/services/agent/session-manager.ts` | V2 Session 管理，进程复用，健康检查 |
| `src/main/services/agent/sdk-config.ts` | SDK 配置构建 |
| `src/main/services/agent/mcp-manager.ts` | MCP 服务器管理 |
| `src/main/services/agent/send-message.ts` | 消息发送入口 |

### 调用流程

```
1. 用户发送消息
       │
       ▼
2. send-message.ts 判断 claudeSource
       │
       ├── 'local' → 调用 sendLocalMessage()
       │                    │
       │                    ▼
       │              3. session-manager.getOrCreateV2Session()
       │                    │
       │                    ▼
       │              4. 创建/复用 SDK V2 Session
       │                    │
       │                    ▼
       │              5. session.send(message)
       │                    │
       │                    ▼
       │              6. 流式返回事件
       │
       └── 'remote' → 调用 sendRemoteMessage() (见下文)
```

### 关键代码

```typescript
// src/main/services/agent/session-manager.ts

async getOrCreateV2Session(spaceId: string, options?: SessionOptions): Promise<SDKSession> {
  const existing = this.sessions.get(spaceId)

  // 1. 检查现有会话是否可用
  if (existing && isSessionTransportReady(existing.session)) {
    return existing.session
  }

  // 2. 创建新会话
  const session = unstable_v2_createSession({
    model: options?.model || 'claude-sonnet-4-20250514',
    cwd: options?.cwd || space.path,
    systemPrompt: buildSystemPrompt(options?.cwd),
    allowedTools: DEFAULT_ALLOWED_TOOLS,
    mcpServers: mcpConfig,
    // ... 其他配置
  })

  // 3. 注册进程退出监听
  registerProcessExitListener(session, spaceId, () => {
    this.cleanupSession(spaceId, 'process exited')
  })

  return session
}
```

### 会话特性

- **进程复用**：同一空间的多个请求复用同一个 Claude 进程
- **会话持久化**：Claude 内部维护对话历史
- **健康检查**：定期检查进程状态，自动清理失效会话
- **空闲超时**：30分钟无活动自动关闭

---

## 远程 Claude 调用

### 核心组件

| 文件 | 说明 |
|------|------|
| `src/main/services/remote-ssh/ssh-tunnel.service.ts` | SSH 隧道管理，端口转发 |
| `src/main/services/remote-ssh/ssh-manager.ts` | SSH 连接管理 |
| `src/main/services/remote-deploy/remote-deploy.service.ts` | 远程服务器部署 |
| `packages/remote-agent-proxy/` | 远程代理服务（运行在远程服务器） |

### 调用流程

```
1. 用户发送消息到远程空间
       │
       ▼
2. send-message.ts → sendRemoteMessage()
       │
       ▼
3. 确保 SSH 隧道已建立 (ssh-tunnel.service.ts)
       │
       ├── 隧道已存在 → 复用
       │
       └── 隧道不存在 → 建立 SSH 隧道
              │
              ▼
         ssh -L localhost:8080:localhost:8080 user@host
       │
       ▼
4. 通过 WebSocket 连接到 localhost:8080
       │
       ▼
5. 发送消息到 remote-agent-proxy
       │
       ▼
6. remote-agent-proxy 调用本地 Claude SDK
       │
       ▼
7. 流式返回事件 via WebSocket
```

### SSH 隧道

```typescript
// src/main/services/remote-ssh/ssh-tunnel.service.ts

async establishTunnel(config: SshTunnelConfig): Promise<number> {
  const client = new Client()

  // 1. 建立 SSH 连接
  client.connect({
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,  // 或 privateKey
  })

  // 2. 创建本地 TCP Server
  const server = net.createServer((socket) => {
    // 3. 通过 SSH forwardOut 转发连接
    client.forwardOut(
      '127.0.0.1', config.localPort,
      'localhost', config.remotePort,
      (err, stream) => {
        socket.pipe(stream).pipe(socket)
      }
    )
  })

  // 4. 监听本地端口
  server.listen(config.localPort, '127.0.0.1')

  return config.localPort
}
```

### 隧道共享机制

多个空间连接同一台服务器时，共享同一个 SSH 隧道：

```
Space A ─┐
         ├──→ 共享 SSH 隧道 ──→ Remote Server:8080
Space B ─┘

- 使用 serverId 作为隧道 key
- spaces: Set<string> 记录使用该隧道的空间
- 引用计数，最后一个空间断开时关闭隧道
```

### WebSocket 通信协议

```typescript
// 客户端 → 服务端
{
  type: 'chat',
  conversationId: 'conv-123',
  message: {
    role: 'user',
    content: '你好'
  },
  options: {
    workDir: '/home/user/project'  // 可选，覆盖工作目录
  }
}

// 服务端 → 客户端 (流式事件)
{ type: 'text', data: { text: '你好！' } }
{ type: 'thinking', data: { content: '...', isStreaming: true } }
{ type: 'tool_use', data: { name: 'Bash', input: {...} } }
{ type: 'terminal', data: { content: '...', stream_type: 'stdout' } }
{ type: 'result', data: { is_error: false } }
```

---

## 远程服务器部署

### 自动部署流程

添加新服务器时，AICO-Bot 自动完成以下步骤：

```
┌─────────────────────────────────────────────────────────────────┐
│                    自动部署流程                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. 连接 SSH                                                     │
│       │                                                          │
│       ▼                                                          │
│  2. 检查/安装 Node.js (via NodeSource)                          │
│       │                                                          │
│       ▼                                                          │
│  3. 检查/安装 Claude CLI (npm install -g)                       │
│       │                                                          │
│       ▼                                                          │
│  4. 检查/安装 claude-agent-sdk (npm install -g)                 │
│       │                                                          │
│       ▼                                                          │
│  5. 上传 remote-agent-proxy 代码                                 │
│       │                                                          │
│       ▼                                                          │
│  6. 安装依赖 (npm install)                                       │
│       │                                                          │
│       ▼                                                          │
│  7. 上传 patched SDK (包含 bypass-permissions 支持)             │
│       │                                                          │
│       ▼                                                          │
│  8. 启动 agent                                                   │
│       │                                                          │
│       ▼                                                          │
│  ✅ 完成                                                         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 部署目录结构

```
/opt/claude-deployment/
├── dist/
│   ├── index.js           # 入口文件
│   ├── server.js          # WebSocket 服务器
│   └── claude-manager.js  # Claude SDK 封装
├── node_modules/
│   └── @anthropic-ai/
│       └── claude-agent-sdk/
│           └── sdk.mjs    # Patched SDK
├── logs/
│   └── output.log         # 运行日志
├── data/                  # 数据目录
├── .env                   # 配置文件
├── package.json
└── package-lock.json
```

### 环境变量

```bash
# .env 文件
REMOTE_AGENT_PORT=8080              # WebSocket 端口
REMOTE_AGENT_AUTH_TOKEN=xxx         # 认证 Token
REMOTE_AGENT_WORK_DIR=/home         # 默认工作目录
IS_SANDBOX=1                        # 启用 bypass-permissions
ANTHROPIC_API_KEY=sk-xxx            # Claude API Key
ANTHROPIC_BASE_URL=https://...      # API Base URL (可选)
ANTHROPIC_MODEL=claude-sonnet-4-20250514  # 模型 (可选)
```

### 支持的操作系统

- Debian/Ubuntu (通过 apt)
- RHEL/CentOS/Fedora (通过 yum)

### 前置要求

- SSH 访问权限 (root 或 sudo)
- 网络可达

---

## 配置说明

### 空间配置

```typescript
// src/shared/types.ts
interface Space {
  id: string
  name: string
  path: string                    // 本地路径

  // 远程配置
  claudeSource?: 'local' | 'remote'
  remoteServerId?: string         // 远程服务器 ID
  remotePath?: string             // 远程工作目录
}
```

### 远程服务器配置

```typescript
// src/shared/types.ts
interface RemoteServer {
  id: string
  name: string

  // SSH 配置
  host: string
  sshPort: number                 // 默认 22
  username: string
  password?: string

  // Agent 配置
  wsPort: number                  // 默认 8080
  authToken?: string

  // Claude 配置
  workDir?: string                // 默认 /home
  claudeApiKey?: string
  claudeBaseUrl?: string
  claudeModel?: string
}
```

### Bypass Permissions 模式

远程服务器默认启用 bypass-permissions 模式，Claude 执行命令无需用户审批：

```typescript
// packages/remote-agent-proxy/src/claude-manager.ts

private buildSdkOptions(workDir?: string): any {
  return {
    model: this.model || 'claude-sonnet-4-20250514',
    cwd: effectiveWorkDir,
    permissionMode: 'bypassPermissions',
    extraArgs: {
      'dangerously-skip-permissions': null
    },
    env: {
      ...process.env,
      IS_SANDBOX: '1',  // root 权限下必须
    },
    // ...
  }
}
```

**注意**：在 root 权限下运行时，必须设置 `IS_SANDBOX=1` 环境变量，否则 Claude 会拒绝 bypass-permissions 模式。

---

## 故障排查

### 常见问题

#### 1. SSH 隧道连接失败

```
错误: SSH connection error
```

**排查步骤：**
1. 检查网络连通性: `ping <server_ip>`
2. 检查 SSH 服务: `ssh <user>@<host>`
3. 检查防火墙是否开放 22 端口

#### 2. WebSocket 连接失败

```
错误: WebSocket connection failed
```

**排查步骤：**
1. 检查远程 agent 是否运行:
   ```bash
   ssh root@<host> "ss -tln | grep 8080"
   ```
2. 检查 agent 日志:
   ```bash
   ssh root@<host> "tail -50 /opt/claude-deployment/logs/output.log"
   ```
3. 重启 agent:
   ```bash
   ssh root@<host> "pkill -f 'node.*claude-deployment'"
   ssh root@<host> "cd /opt/claude-deployment && source .env && nohup node dist/index.js > logs/output.log 2>&1 &"
   ```

#### 3. Claude 执行命令需要审批

**原因**：bypass-permissions 模式未生效

**排查步骤：**
1. 检查 SDK 是否 patched:
   ```bash
   ssh root@<host> "grep -c '\\[PATCHED\\]' /opt/claude-deployment/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"
   ```
   应该返回 `8` 或更多

2. 检查 IS_SANDBOX 是否设置:
   ```bash
   ssh root@<host> "grep IS_SANDBOX /opt/claude-deployment/dist/claude-manager.js"
   ```

3. 点击 AICO-Bot 中的 "Update Agent" 按钮重新部署

#### 4. 工作目录不正确

**原因**：SDK 未正确传递 cwd 参数

**解决方案**：
1. 确保 patched SDK 已上传
2. 重新部署 agent

### 日志查看

**本地日志：**
- Electron main process 日志在 DevTools Console

**远程日志：**
```bash
# Agent 日志
ssh root@<host> "tail -100 /opt/claude-deployment/logs/output.log"

# 系统 logs
ssh root@<host> "journalctl -u claude-agent -f"
```

### 重置远程环境

```bash
# 停止 agent
ssh root@<host> "pkill -f 'node.*claude-deployment'"

# 清理部署目录
ssh root@<host> "rm -rf /opt/claude-deployment"

# 在 AICO-Bot 中点击 "Update Agent" 重新部署
```

---

## 文件索引

### 主进程服务

| 文件路径 | 说明 |
|---------|------|
| `src/main/services/agent/send-message.ts` | 消息发送入口 |
| `src/main/services/agent/session-manager.ts` | 本地 Session 管理 |
| `src/main/services/agent/sdk-config.ts` | SDK 配置 |
| `src/main/services/agent/mcp-manager.ts` | MCP 管理 |
| `src/main/services/remote-ssh/ssh-tunnel.service.ts` | SSH 隧道 |
| `src/main/services/remote-ssh/ssh-manager.ts` | SSH 连接 |
| `src/main/services/remote-deploy/remote-deploy.service.ts` | 远程部署 |

### 远程代理包

| 文件路径 | 说明 |
|---------|------|
| `packages/remote-agent-proxy/src/index.ts` | 入口 |
| `packages/remote-agent-proxy/src/server.ts` | WebSocket 服务器 |
| `packages/remote-agent-proxy/src/claude-manager.ts` | Claude SDK 封装 |

### SDK Patch

| 文件路径 | 说明 |
|---------|------|
| `patches/@anthropic-ai+claude-agent-sdk+0.2.63.patch` | SDK 补丁 |

---

## 版本信息

| 组件 | 版本 |
|------|------|
| Claude CLI | 2.1.62 |
| Claude Agent SDK | 0.2.63 (patched) |
| Node.js | 20.x |

---

*最后更新: 2026-03-02*
