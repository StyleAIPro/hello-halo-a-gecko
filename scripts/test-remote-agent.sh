#!/bin/bash

# 远程 Claude 执行测试脚本
# 直接调用后台接口，无需通过前端

set -e

AICO_BOT_DATA_DIR=${AICO_BOT_DATA_DIR:-~/.aico-bot-dev}

echo "==================================="
echo "远程 Claude 执行测试"
echo "==================================="
echo ""

# 检查数据目录
echo "[1] 检查数据目录: $AICO_BOT_DATA_DIR"

# 测试用的空间 ID 和服务器 ID
# 使用配置中已有的远程服务器
SPACE_ID="d51eb244-82c2-4cc8-a398-d914e3694c0b"  # 远程空间 "222"
SERVER_ID="server-1772116803709-jpzuror"

# 显示配置
echo "[2] 配置信息:"
echo "  空间 ID: $SPACE_ID"
echo "  服务器 ID: $SERVER_ID"
echo ""

# 查看配置文件
echo "[3] 当前远程服务器配置:"
cat "$AICO_BOT_DATA_DIR/config.json" | jq '.remoteServers[] | {id, name, host, status}' 2>/dev/null || echo "  (无法读取配置)"
echo ""

echo "[4] 测试用例："
echo "  测试 1: echo 简单消息"
echo "  测试 2: pwd 查看当前目录"
echo "  测试 3: date 查看时间"
echo "  测试 4: ls 查看目录内容"
echo ""

read -p "选择测试用例 (1-4) 或直接输入消息: " choice

case "$choice" in
  1)
    MESSAGE="echo 'SSH_TEST_SUCCESS: remote agent working'"
    ;;
  2)
    MESSAGE="echo 'Current directory: ' && pwd"
    ;;
  3)
    MESSAGE="echo 'Server time: ' && date"
    ;;
  4)
    MESSAGE="ls -la"
    ;;
  *)
    MESSAGE="echo 'Message from remote: $choice'"
    ;;
esac

echo ""
echo "[5] 执行测试命令: $MESSAGE"
echo ""

# 这里我们只是打印测试命令，实际执行需要在应用内进行
# 因为远程执行逻辑在 Electron 应用内

echo "==================================="
echo "测试说明："
echo "==================================="
echo ""
echo "这个脚本只是用于查看配置和准备测试信息。"
echo "实际的远程执行需要在 AICO-Bot 应用内进行。"
echo ""
echo "请在 AICO-Bot 应用中："
echo "1. 打开远程空间 '222'"
echo "2. 发送消息: hello"
echo "3. 查看 F12 控制台输出"
echo ""
