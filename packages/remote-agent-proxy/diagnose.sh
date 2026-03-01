#!/bin/bash
# 在远程服务器上运行此脚本诊断问题

echo "========================================"
echo "Remote Agent Diagnostic"
echo "========================================"
echo ""

# 1. 检查部署目录
echo "[1] 检查部署目录..."
DEPLOY_PATH="/opt/claude-deployment"
if [ -d "$DEPLOY_PATH" ]; then
    echo "    ✓ 部署目录存在: $DEPLOY_PATH"
    ls -la $DEPLOY_PATH/
else
    echo "    ✗ 部署目录不存在: $DEPLOY_PATH"
fi
echo ""

# 2. 检查 dist 目录
echo "[2] 检查 dist 目录..."
if [ -d "$DEPLOY_PATH/dist" ]; then
    echo "    ✓ dist 目录存在"
    ls -la $DEPLOY_PATH/dist/
else
    echo "    ✗ dist 目录不存在"
fi
echo ""

# 3. 检查运行中的进程
echo "[3] 检查运行中的 agent 进程..."
AGENT_PID=$(lsof -t -i :8080 2>/dev/null)
if [ -n "$AGENT_PID" ]; then
    echo "    ✓ Agent 运行中 (PID: $AGENT_PID)"
    ps aux | grep $AGENT_PID | grep -v grep
else
    echo "    ✗ 没有进程监听 8080 端口"
fi
echo ""

# 4. 检查 Claude Code CLI
echo "[4] 检查 Claude Code CLI..."
if command -v claude &> /dev/null; then
    echo "    ✓ claude 命令存在"
    claude --version 2>&1 || echo "    (无法获取版本)"
elif [ -f "$HOME/.claude/local/claude" ]; then
    echo "    ✓ claude 存在于 ~/.claude/local/"
else
    echo "    ✗ Claude Code CLI 未安装"
    echo "    安装命令: npm install -g @anthropic-ai/claude-code"
fi
echo ""

# 5. 检查 Node.js 版本
echo "[5] 检查 Node.js 版本..."
node --version
echo ""

# 6. 检查环境变量
echo "[6] 当前 agent 进程的环境变量..."
if [ -n "$AGENT_PID" ]; then
    cat /proc/$AGENT_PID/environ 2>/dev/null | tr '\0' '\n' | grep -E "ANTHROPIC|REMOTE_AGENT|PORT" || echo "    (无相关环境变量)"
else
    echo "    (无运行中的进程)"
fi
echo ""

# 7. 检查日志
echo "[7] 检查日志..."
if [ -f "$DEPLOY_PATH/logs/output.log" ]; then
    echo "    最近 20 行日志:"
    tail -20 "$DEPLOY_PATH/logs/output.log"
else
    echo "    ✗ 日志文件不存在"
fi
echo ""

# 8. 测试 WebSocket 连接
echo "[8] 测试 WebSocket 连接..."
if command -v node &> /dev/null; then
    node -e "
    const WebSocket = require('ws');
    const ws = new WebSocket('ws://localhost:8080/agent');
    ws.on('open', () => {
        console.log('    ✓ WebSocket 连接成功');
        ws.send(JSON.stringify({type: 'ping', sessionId: 'test'}));
    });
    ws.on('message', (data) => {
        console.log('    ← 收到响应:', data.toString());
        ws.close();
        process.exit(0);
    });
    ws.on('error', (err) => {
        console.log('    ✗ WebSocket 连接失败:', err.message);
    });
    setTimeout(() => {
        console.log('    ✗ 连接超时');
        process.exit(1);
    }, 5000);
    "
else
    echo "    (跳过 - node 不可用)"
fi

echo ""
echo "========================================"
echo "诊断完成"
echo "========================================"