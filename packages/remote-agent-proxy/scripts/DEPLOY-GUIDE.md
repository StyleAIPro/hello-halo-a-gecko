# Remote Agent Proxy 部署指南

## 概述

本文档说明如何在远端服务器上部署 Remote Agent Proxy 服务，使 AICO-Bot 应用能够通过本地 UI 调用远端服务器的 Claude 能力。

## 快速开始

如果你已经完成了第一次部署，跳到"快速测试"部分。

第一次部署请按照"完整部署步骤"执行。

---

## 快速测试（已部署完成后）

### 验证服务状态

```bash
# 1. 检查服务是否运行
ps aux | grep "node.*dist/index.js"

# 2. 检查端口监听
netstat -tlnp | grep 8080

# 3. 查看实时日志
tail -f /opt/claude-deployment/logs/output.log

# 按 Ctrl+C 停止日志查看
```

### 在本地 AICO-Bot 中添加服务器

1. 打开 **Settings** 页面
2. 进入 **Remote Servers** 页面
3. 添加服务器：
   - Name: 你的服务器名称
   - Host: 你的远端 IP
   - Port: 8080
   - Username: root
4. 点击保存

---

## 完整部署步骤

### 前提条件

在执行部署前，确保：

1. **本地环境**：
   - `packages/remote-agent-proxy` 目录存在
   - Node.js >= 18.x 已安装

2. **远端服务器访问**：
   - SSH 访问权限（用户名: root）
   - SSH 端口开放（默认 22）

3. **必要信息准备**：
   - 远端服务器 IP 地址
   - SSH 端口（默认 22）
   - Anthropic API Key
   - API Base URL（默认: https://api.anthropic.com）
   - 工作目录（默认: /root）

---

### 步骤 1：本地构建

```bash
# 在本地 AICO-Bot 项目根目录执行
cd /Users/zhaoyinqi/workspace/hello-halo-a-gecko

# 进入 remote-agent-proxy 目录
cd packages/remote-agent-proxy

# 安装依赖（首次需要）
npm install

# 构建 TypeScript
npm run build

# 验证构建成功
ls -la dist/
```

构建成功后应该看到：
```
dist/
├── index.js
├── server.js
├── claude-manager.js
├── types.js
└── ...
```

---

### 步骤 2：创建远端部署目录

**方式 A：使用 SCP 上传（推荐）**

```bash
# 从本地上传文件到远端服务器
# 使用你的 SSH 密码

# 上传 dist 目录
scp -r packages/remote-agent-proxy/dist/* root@your-server-ip:/opt/claude-deployment/dist/

# 上传 package.json
scp packages/remote-agent-proxy/package.json root@your-server-ip:/opt/claude-deployment/
```

**方式 B：手动在远端创建（适用于 SSH 密钥登录）**

```bash
# 1. SSH 登录远端服务器
ssh root@your-server-ip

# 2. 在远端服务器上创建目录并下载代码
mkdir -p /opt/claude-deployment
cd /opt/claude-deployment

# 3. 下载或复制 remote-agent-proxy 源代码到远端
# 方式 1: 使用 git clone（如果代码在 Git 仓库）
# 方式 2: 直接从本地上传（推荐）

# 4. 安装依赖
npm install

# 5. 验证
ls -la
```

---

### 步骤 3：安装 Claude Code CLI

```bash
# SSH 登录远端服务器
ssh root@your-server-ip

# 安装 Claude Code CLI 全局
npm install -g @anthropic-ai/claude-code@latest

# 验证安装成功
claude --version

# 创建符号链接（可选，让 V2 Session 能找到 claude 命令）
# cd /usr/local/bin
# ln -sf $(npm root -g)/.bin/claude claude
```

**预期输出**：
```
claude-code version x.x.x
```

---

### 步骤 4：配置环境变量

```bash
# SSH 登录远端服务器
ssh root@your-server-ip

# 进入部署目录
cd /opt/claude-deployment

# 创建 .env 文件
cat > .env << 'EOF'
# WebSocket 服务配置
REMOTE_AGENT_PORT=8080

# Claude API 配置
ANTHROPIC_API_KEY=your-api-key-here
ANTHROPIC_BASE_URL=https://api.anthropic.com
# 或者使用自定义的 API
# ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic

# 工作目录配置
CLAUDE_WORK_DIR=/root
# 可选：CLAUDE_CODE_PATH=/usr/local/bin/claude
EOF

# 验证环境变量
cat .env
```

**.env 文件说明**：

| 变量 | 说明 | 必填 | 默认值 |
|--------|------|--------|--------|
| `REMOTE_AGENT_PORT` | WebSocket 服务端口 | 否 | 8080 |
| `ANTHROPIC_API_KEY` | Claude API 密钥 | **是** | - |
| `ANTHROPIC_BASE_URL` | API 服务地址 | 否 | https://api.anthropic.com |
| `CLAUDE_WORK_DIR` | Claude 工作目录 | 否 | /root |
| `CLAUDE_CODE_PATH` | Claude Code 可执行路径 | 否 | 自动查找 |

---

### 步骤 5：创建启动脚本（推荐）

```bash
# 在远端服务器上创建启动脚本
cd /opt/claude-deployment

cat > start.sh << 'EOF'
#!/bin/bash

# Remote Agent Proxy 启动脚本

# 设置工作目录
cd /opt/claude-deployment

# 停止现有服务
echo "Stopping existing service..."
pkill -f "node.*dist/index.js"
sleep 2

# 等待进程完全停止
while pgrep -f "node.*dist/index.js" > /dev/null; do
    sleep 1
done

# 启动服务
echo "Starting Remote Agent Proxy service..."
nohup node dist/index.js > logs/output.log 2>&1 &

# 保存进程 ID
echo $! > logs/service.pid

# 等待服务启动
sleep 3

# 检查服务状态
if pgrep -f "node.*dist/index.js" > /dev/null; then
    echo "Service started successfully (PID: $(cat logs/service.pid))"
else
    echo "Failed to start service"
    exit 1
fi

# 显示日志
echo ""
echo "Recent logs:"
tail -20 logs/output.log
EOF

# 设置执行权限
chmod +x start.sh
```

---

### 步骤 6：启动服务

```bash
# 方式 1：使用启动脚本
./start.sh

# 方式 2：直接启动（测试用）
nohup node dist/index.js > logs/output.log 2>&1 &

# 方式 3：导出环境变量后启动
export ANTHROPIC_API_KEY=your-api-key-here && \
nohup node dist/index.js > logs/output.log 2>&1 &
```

---

### 步骤 7：验证部署

```bash
# SSH 登录远端服务器
ssh root@your-server-ip

# 检查服务状态
ps aux | grep "node.*dist/index.js"

# 检查端口
netstat -tlnp | grep 8080

# 查看日志（实时）
tail -f /opt/claude-deployment/logs/output.log

# 按 Ctrl+C 停止日志查看
```

**预期输出**（无警告时）：
```
Remote Agent Proxy server listening on port 8080
Claude API Base URL: https://your-api-url.com
```

---

## 在本地 AICO-Bot 中配置

### 添加远程服务器

1. 打开 AICO-Bot 应用
2. 进入 **Settings** > **Remote Servers**
3. 点击 **Add Server**
4. 填写服务器信息：
   ```
   Name: 你的服务器名称（例如：生产服务器）
   Host: 你的远端 IP 地址
   Port: 8080
   Username: root
   ```
5. 点击 **Save**

### 创建远程空间

1. 返回 **Home** 页面
2. 点击 **Create Space** 创建新空间
3. 配置空间信息：
   ```
   Space Name: 空间名称
   Claude Source: Remote
   Remote Server: 选择刚才添加的服务器
   Working Directory (Remote): /root
   ```
4. 点击 **Create**

### 测试远程 Claude

1. 进入新创建的远程空间
2. 发送消息测试，例如：
   ```
   你好，请介绍一下你自己的功能
   ```
3. 验证是否正常响应

---

## 故障排查

### 常见问题

#### 问题 1：服务启动失败

**症状**：
```
Error: Cannot bind to port 8080
```

**原因**：端口 8080 已被占用

**解决方案**：
```bash
# 查找占用端口的进程
lsof -i :8080

# 或者使用 netstat
netstat -tlnp | grep 8080

# 停止占用端口的进程
kill -9 <PID>

# 重启服务
```

#### 问题 2：连接超时

**症状**：
```
Error: Connection timeout
```

**原因**：网络连接问题或防火墙阻止

**解决方案**：
```bash
# 检查防火墙状态（CentOS/RHEL）
sudo firewall-cmd --list-all
sudo firewall-cmd --add-port=8080/tcp --permanent
sudo firewall-cmd --reload

# Ubuntu/Debian
sudo ufw status
sudo ufw allow 8080/tcp

# 暂时关闭防火墙测试
sudo systemctl stop firewalld  # CentOS/RHEL
sudo ufw disable        # Ubuntu/Debian
```

#### 问题 3：V2 Session 无法找到 Claude Code

**症状**：
```
Warning: No Claude API key provided. Chat features will be unavailable.
```

**原因**：环境变量未正确设置

**解决方案**：

**方式 A：检查并修复 .env 文件**
```bash
# 检查 .env 文件
cat /opt/claude-deployment/.env

# 确保 ANTHROPIC_API_KEY 存在且值正确
```

**方式 B：导出环境变量后启动**
```bash
# 在启动时导出环境变量
export ANTHROPIC_API_KEY=your-key && \
nohup node dist/index.js > logs/output.log 2>&1 &
```

**方式 C：设置系统环境变量**
```bash
# 编辑 ~/.bashrc
echo "export ANTHROPIC_API_KEY=your-key" >> ~/.bashrc

# 重新加载
source ~/.bashrc

# 重启服务
```

#### 问题 4：内存不足

**症状**：服务频繁崩溃

**原因**：V2 Session 进程内存占用过高

**解决方案**：
```bash
# 增加交换空间
sudo dd if=/dev/zero of=/swapfile bs=1M count=1024 status=progress
sudo mkswap /swapfile
sudo chmod 600 /swapfile
sudo swapon /swapfile

# 检查内存使用
free -h

# 限制 Node.js 内存
# 在启动脚本中添加
export NODE_OPTIONS="--max-old-space-size=512"
```

#### 问题 5：权限错误

**症状**：
```
Error: EACCES: permission denied
```

**原因**：文件或目录权限不足

**解决方案**：
```bash
# 检查文件权限
ls -la /opt/claude-deployment/

# 修复权限
sudo chown -R root:root /opt/claude-deployment/
sudo chmod -R 755 /opt/claude-deployment/

# 确保用户权限
id  # 查看当前用户
```

#### 问题 6：Claude Code 版本不匹配

**症状**：
```
Error: Claude Code version mismatch
```

**原因**：Claude Code CLI 版本与 V2 Session SDK 不兼容

**解决方案**：
```bash
# 检查当前版本
claude --version

# 重新安装正确版本
npm uninstall -g @anthropic-ai/claude-code
npm install -g @anthropic-ai/claude-code@latest
```

---

## 日志查看

### 查看实时日志

```bash
# SSH 登录远端服务器
ssh root@your-server-ip

# 查看实时日志
tail -f /opt/claude-deployment/logs/output.log

# 按 Ctrl+C 停止
```

### 查看历史日志

```bash
# 查看最近 50 行
tail -50 /opt/claude-deployment/logs/output.log

# 查看完整日志
cat /opt/claude-deployment/logs/output.log

# 按日期查看
grep "2024-" /opt/claude-deployment/logs/output.log
```

### 查看错误日志

```bash
# 只查看错误信息
grep -i error /opt/claude-deployment/logs/output.log

# 查看最近的错误
tail -100 /opt/claude-deployment/logs/output.log | grep -i error
```

---

## 服务管理

### 重启服务

```bash
# 使用启动脚本
./start.sh

# 或者手动执行
cd /opt/claude-deployment
pkill -f "node.*dist/index.js"
sleep 2
nohup node dist/index.js > logs/output.log 2>&1 &

# 验证
ps aux | grep "node.*dist/index.js"
tail -f logs/output.log
```

### 停止服务

```bash
# 方式 1：使用启动脚本
./start.sh  # 脚本会自动停止旧服务并启动新服务

# 方式 2：手动停止
cd /opt/claude-deployment
pkill -f "node.*dist/index.js"

# 方式 3：使用 service.pid
if [ -f logs/service.pid ]; then
    PID=$(cat logs/service.pid)
    if [ -n "$PID" ]; then
        kill $PID 2>/dev/null
        rm logs/service.pid
    fi
fi
```

### 查看服务状态

```bash
# SSH 登录远端服务器
ssh root@your-server-ip

# 检查进程
ps aux | grep "node.*dist/index.js"

# 查看端口
netstat -tlnp | grep 8080

# 查看日志
tail -20 /opt/claude-deployment/logs/output.log
```

---

## 环境变量

### .env 文件示例

```bash
# Remote Agent Proxy 配置
REMOTE_AGENT_PORT=8080
ANTHROPIC_API_KEY=sk-ant-xxxxxx
ANTHROPIC_BASE_URL=https://api.anthropic.com
CLAUDE_WORK_DIR=/root

# 可选：Claude Code 可执行文件路径
# CLAUDE_CODE_PATH=/usr/local/bin/claude
```

### 环境变量优先级

1. `.env` 文件中的变量
2. 系统环境变量（`~/.bashrc` 或 `/etc/environment`）
3. 启动时导出的变量（`export VAR=value && command`）

---

## 架构说明

### 整体架构

```
┌──────────────────────────────────────────────────────────────────┐
│                    本地 AICO-Bot UI                           │
│                                                            │
│     sendMessage() ──> 检查 space.claudeSource          │
│                                                            │
│     ┌─────────────┴────────────┐               │
│     │                           │               │
│  'local'  │  'remote' │               │
│     │              │         │      │
│     ↓              │         ↓      │
│ 本地 V2 Session  │  RemoteWsClient │
│ (本地进程)        │     │
│                    │         │
│     └───────────┴───┘ │
│                            │         │
│                            ↓         ↓
│              Anthropic API  │    远端服务器
│                                │
│                            ↓         ↓
│                    ┌────────────┴────────────┐
│                    │         │            │
│         V2 Session  │  远端 Claude Code │
│      (子进程)     │         │            │
│                            │         │
│                            ↓         │
│                    ─────────────┴────────────┘
│                         Anthropic API
└───────────────────────────────────────────────────────────────────┘
```

### 本地 vs 远端对比

| 特性 | 本地 V2 Session | 远端 V2 Session |
|------|----------------|----------------|
| 会话位置 | `~/.claude/` | `~/.claude/` |
| 进程管理 | 本地进程管理 | 本地进程管理 |
| API 密钥 | 本地环境变量 | 远端环境变量 |
| 工作目录 | 本地目录 | 远端目录（通过 SSH/SCP） |
| 通信方式 | IPC (进程内) | WebSocket (网络） |
| 启动方式 | 自动 | 自动（启动脚本） |
| 健康检查 | V2 Session 健康检查 | V2 Session 健康检查 |

---

## 文件结构

### 本地文件结构

```
packages/remote-agent-proxy/
├── src/                    # 源代码
│   ├── index.ts           # 入口文件
│   ├── server.ts           # WebSocket 服务器
│   ├── claude-manager.ts   # V2 Session 管理器
│   ├── types.ts           # 类型定义
│   └── fs-proxy.ts       # 文件系统代理（可选）
├── dist/                   # 编译输出
│   ├── index.js
│   ├── server.js
│   ├── claude-manager.js
│   └── *.map
├── package.json           # 依赖配置
├── tsconfig.json          # TypeScript 配置
├── scripts/               # 部署和管理脚本
│   └── DEPLOY-GUIDE.md   # 本文档
```

### 远端文件结构

```
/opt/claude-deployment/
├── dist/                   # 可执行文件
│   ├── index.js
│   ├── server.js
│   ├── claude-manager.js
│   └── *.map
├── package.json           # 依赖配置
├── node_modules/           # 安装的包
│   ├── @anthropic-ai/claude-agent-sdk/
│   ├── @anthropic-ai/sdk/
│   ├── @anthropic-ai/claude-code@latest/
│   └── ws/
├── .env                   # 环境变量配置
├── logs/                   # 日志目录
│   ├── output.log          # 服务日志
│   └── service.pid        # 进程 ID
├── start.sh              # 启动脚本
└── ~/.claude/              # V2 Session 会话目录
    └── projects/
        └── .claude/
            └── sessions/
                ├── {session-id}.jsonl
                └── {session-id}.json
```

---

## 快速参考

### 常用命令

```bash
# SSH 登录
ssh root@your-server-ip

# 查看服务状态
ps aux | grep "node.*dist/index.js"
netstat -tlnp | grep 8080

# 重启服务
cd /opt/claude-deployment && ./start.sh

# 停止服务
cd /opt/claude-deployment
pkill -f "node.*dist/index.js"

# 查看日志
tail -f /opt/claude-deployment/logs/output.log

# 查看环境变量
cat /opt/claude-deployment/.env
```

### 端口说明

| 端口 | 服务 | 说明 |
|------|------|--------|
| 8080 | Remote Agent Proxy | WebSocket 服务端口 |
| 22 | SSH | SSH 连接端口 |

### API 端点

Anthropic API 支持不同的端点，根据你的 API Key 类型：

- `https://api.anthropic.com` - Anthropic 官方 API
- `https://open.bigmodel.cn/api/anthropic` - 代理端点
- `https://your-custom-endpoint.com` - 自定义端点

在 `.env` 文件中通过 `ANTHROPIC_BASE_URL` 指定。

---

## 附录

### 依赖版本

| 包名 | 版本 | 用途 |
|--------|------|------|
| `@anthropic-ai/claude-agent-sdk` | 0.1.76 | V2 Session SDK |
| `@anthropic-ai/claude-code` | latest | Claude Code CLI |
| `@anthropic-ai/sdk` | ^0.27.0 | Anthropic SDK（被 V2 Session 使用） |
| `ws` | ^8.18.0 | WebSocket 库 |

### 系统要求

| 组件 | 最低版本 | 推荐版本 |
|--------|---------|----------|
| Node.js | 18.x | 20.x LTS |
| npm | 8.x | 10.x LTS |
| 内存 | 512MB | 2GB+ |
| 磁盘 | 10GB | 50GB+ |

---

## 更新日志

```text
v1.0.0 - 2025-02-27
- 初始版本发布
- 完整部署流程文档
- 添加故障排查指南
- 优化环境变量配置说明

主要改进：
- 支持 V2 Session 完整功能
- 完善的日志记录
- 详细的故障排查步骤
```

---

## 联系与支持

如果遇到本指南未涵盖的问题，请：

1. 检查远端服务器日志
2. 提供错误信息复现步骤
3. 确认环境配置是否正确

---

*本文档存放在 `/Users/zhaoyinqi/workspace/hello-halo-a-gecko/packages/remote-agent-proxy/scripts/DEPLOY-GUIDE.md`*
