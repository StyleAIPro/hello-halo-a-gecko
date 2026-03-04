# 远程 Agent 故障排查指南

## 当前问题

从本地 Halo UI 发送消息到远程服务器时出现 `ECONNRESET` 错误。

```
Error: read ECONNRESET at TCP.onStreamRead
```

## 诊断步骤

请手动登录到远程服务器 (124.71.177.25) 并执行以下命令：

### 1. 检查进程是否运行

```bash
ps aux | grep '[n]ode.*dist/index.js'
```

**如果显示进程信息** → 服务正在运行，跳到步骤 3
**如果没有输出** → 服务未运行，跳到步骤 2

### 2. 启动远程 Agent 服务

如果服务未运行，执行以下命令：

```bash
cd /opt/claude-deployment

# 设置环境变量
export ANTHROPIC_API_KEY="7d9d6f744dea44ca89413025d1cf9250.T4asr8unnrVz5QCt"
export ANTHROPIC_BASE_URL="https://open.bigmodel.cn/api/anthropic"
export REMOTE_AGENT_PORT=8080
export CLAUDE_WORK_DIR="/root"

# 启动服务（后台运行）
nohup node dist/index.js > logs/output.log 2>&1 &

# 保存进程 ID
echo $! > logs/service.pid
```

然后等待 5 秒，再次检查进程：
```bash
ps aux | grep '[n]ode.*dist/index.js'
```

### 3. 检查端口监听状态

```bash
netstat -tlnp | grep 8080
```

**预期输出**：显示 `node` 进程正在监听 8080 端口
**如果没有输出** → 端口未监听，服务可能启动失败

### 4. 查看服务日志

```bash
tail -50 /opt/claude-deployment/logs/output.log
```

**查找以下信息**：
- `Remote Agent Proxy server listening on port 8080` → 服务启动成功
- `Error:` 或 `Warning:` → 需要排查错误
- `Shutting down server...` → 服务被停止

### 5. 测试网络连接

从本地测试远程服务器的 WebSocket 端口：

```bash
nc -zv 124.71.177.25 8080
```

**预期输出**：`Connection to 124.71.177.25 8080 port [tcp/*] succeeded!`

## 常见问题及解决方案

### 问题 1: 服务启动后立即停止

**症状**：`ps aux` 显示进程存在，但几秒钟后消失

**可能原因**：
1. 缺少 `@anthropic-ai/claude-agent-sdk` 依赖
2. 环境变量未正确设置
3. Node.js 版本不兼容

**解决方案**：

```bash
# 检查 Node.js 版本
node --version

# 检查依赖是否安装
cd /opt/claude-deployment
npm list @anthropic-ai/claude-agent-sdk

# 如果未安装，执行：
npm install @anthropic-ai/claude-agent-sdk
```

### 问题 2: 端口 8080 被占用

**症状**：启动服务时提示端口已占用

**解决方案**：

```bash
# 查找占用 8080 端口的进程
lsof -i :8080

# 如果是旧进程，可以杀掉
kill -9 <PID>

# 然后重新启动服务
```

### 问题 3: ECONNRESET 持续出现

**症状**：服务运行正常，但本地连接时出现 ECONNRESET

**可能原因**：
1. 远程服务器防火墙阻止了 WebSocket 连接
2. 本地网络不稳定
3. 服务进程正在重启

**解决方案**：

1. **检查防火墙**：
```bash
# 检查防火墙状态
firewall-cmd --state  # CentOS/RHEL
ufw status            # Ubuntu/Debian

# 如果启用，添加端口规则
firewall-cmd --add-port=8080/tcp --permanent
firewall-cmd --reload

# 或
ufw allow 8080/tcp
```

2. **检查服务是否稳定运行**：
```bash
# 连续监控进程
watch -n 2 'ps aux | grep "[n]ode.*dist/index.js"'
```

3. **检查云服务商安全组**：
   - 登录云服务商控制台（阿里云、腾讯云等）
   - 检查安全组规则
   - 确保 8080 端口的入站规则已开启

### 问题 4: 环境变量未生效

**症状**：日志显示 "No Claude API key provided"

**解决方案**：

确保在启动服务前设置了环境变量：

```bash
# 检查环境变量
echo $ANTHROPIC_API_KEY
echo $ANTHROPIC_BASE_URL

# 如果为空，重新设置
export ANTHROPIC_API_KEY="7d9d6f744dea44ca89413025d1cf9250.T4asr8unnrVz5QCt"
export ANTHROPIC_BASE_URL="https://open.bigmodel.cn/api/anthropic"

# 重新启动服务
pkill -f "node.*dist/index.js"
cd /opt/claude-deployment
export ANTHROPIC_API_KEY="7d9d6f744dea44ca89413025d1cf9250.T4asr8unnrVz5QCt"
export ANTHROPIC_BASE_URL="https://open.bigmodel.cn/api/anthropic"
export REMOTE_AGENT_PORT=8080
export CLAUDE_WORK_DIR="/root"
nohup node dist/index.js > logs/output.log 2>&1 &
```

## 完整的启动脚本

在远程服务器上创建一个启动脚本：

```bash
cat > /opt/claude-deployment/start.sh << 'EOF'
#!/bin/bash
cd /opt/claude-deployment

# 停止旧进程
pkill -f "node.*dist/index.js" || true
sleep 2

# 设置环境变量
export ANTHROPIC_API_KEY="7d9d6f744dea44ca89413025d1cf9250.T4asr8unnrVz5QCt"
export ANTHROPIC_BASE_URL="https://open.bigmodel.cn/api/anthropic"
export REMOTE_AGENT_PORT=8080
export CLAUDE_WORK_DIR="/root"

# 启动服务
nohup node dist/index.js > logs/output.log 2>&1 &

# 保存 PID
echo $! > logs/service.pid

# 等待启动
sleep 3

# 检查状态
if ps -p $(cat logs/service.pid) > /dev/null; then
    echo "Service started successfully (PID: $(cat logs/service.pid))"
else
    echo "Service failed to start. Check logs:"
    tail -20 logs/output.log
fi
EOF

chmod +x /opt/claude-deployment/start.sh
```

然后每次启动服务只需执行：
```bash
/opt/claude-deployment/start.sh
```

## 验证步骤

服务启动后，在本地验证：

1. **测试端口连通性**：
```bash
nc -zv 124.71.177.25 8080
```

2. **在 Halo 中测试**：
   - 打开 Halo 应用
   - 进入远程空间（例如 "test" 空间）
   - 发送消息 "hello"
   - 查看是否收到响应

3. **查看本地日志**：
```bash
tail -f /Users/zhaoyinqi/Library/Logs/halo/main.log
```

## 获取帮助

如果以上步骤都无法解决问题，请提供以下信息：

1. 远程服务器的完整日志：`tail -100 /opt/claude-deployment/logs/output.log`
2. 本地 Halo 的错误日志：`tail -100 /Users/zhaoyinqi/Library/Logs/halo/main.log`
3. 进程状态：`ps aux | grep '[n]ode.*dist/index.js'`
4. 端口状态：`netstat -tlnp | grep 8080`
