#!/bin/bash
# Remote Agent Test Script
# Run this on the remote server to test the agent directly

set -e

echo "========================================"
echo "Remote Agent Test Script"
echo "========================================"
echo ""

# Configuration
DEPLOY_PATH="${DEPLOY_PATH:-/opt/claude-deployment}"
PORT="${PORT:-8080}"
AUTH_TOKEN="${AUTH_TOKEN:-}"
ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"

# Check if deployment exists
if [ ! -d "$DEPLOY_PATH" ]; then
    echo "[✗] Deployment directory not found: $DEPLOY_PATH"
    echo "    Please deploy the agent first"
    exit 1
fi

cd "$DEPLOY_PATH"

# Check if dist/index.js exists
if [ ! -f "dist/index.js" ]; then
    echo "[✗] dist/index.js not found"
    echo "    Files in $DEPLOY_PATH:"
    ls -la
    exit 1
fi

echo "[i] Deployment directory: $DEPLOY_PATH"
echo "[i] Port: $PORT"
echo "[i] Auth Token: ${AUTH_TOKEN:-(none)}"
echo "[i] API Key: ${ANTHROPIC_API_KEY:+configured}"
echo ""

# Check if already running
if lsof -i :$PORT > /dev/null 2>&1; then
    echo "[!] Agent already running on port $PORT"
    echo "[i] PID: $(lsof -t -i :$PORT)"
    echo ""
    read -p "Kill existing process and restart? (y/n) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "[i] Killing existing process..."
        kill $(lsof -t -i :$PORT) 2>/dev/null || true
        sleep 2
    else
        echo "[i] Using existing process"
    fi
fi

# Start the agent if not running
if ! lsof -i :$PORT > /dev/null 2>&1; then
    echo "[i] Starting agent..."

    env \
        REMOTE_AGENT_PORT=$PORT \
        REMOTE_AGENT_AUTH_TOKEN="$AUTH_TOKEN" \
        ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
        nohup node dist/index.js > logs/agent-test.log 2>&1 &

    echo "[i] Waiting for agent to start..."
    sleep 3

    if lsof -i :$PORT > /dev/null 2>&1; then
        echo "[✓] Agent started successfully"
    else
        echo "[✗] Agent failed to start"
        echo "[i] Logs:"
        cat logs/agent-test.log
        exit 1
    fi
fi

echo ""
echo "========================================"
echo "Testing WebSocket Connection"
echo "========================================"
echo ""

# Install wscat if not available
if ! command -v wscat &> /dev/null; then
    echo "[i] Installing wscat..."
    npm install -g wscat 2>/dev/null || {
        echo "[!] Could not install wscat, trying with node..."
    }
fi

# Test with node script
if [ -f "test-client.js" ]; then
    echo "[i] Running test-client.js..."
    node test-client.js "ws://localhost:$PORT/agent" "$AUTH_TOKEN"
else
    echo "[!] test-client.js not found, trying direct WebSocket test..."

    # Simple test with node
    node -e "
    const WebSocket = require('ws');
    const ws = new WebSocket('ws://localhost:$PORT/agent', {
        headers: { 'Authorization': 'Bearer $AUTH_TOKEN' }
    });

    ws.on('open', () => {
        console.log('[✓] Connected!');
        ws.send(JSON.stringify({ type: 'ping', sessionId: 'test' }));
    });

    ws.on('message', (data) => {
        console.log('[←] Received:', data.toString());
    });

    ws.on('error', (err) => {
        console.error('[✗] Error:', err.message);
    });

    setTimeout(() => {
        ws.close();
        console.log('[i] Test completed');
        process.exit(0);
    }, 5000);
    "
fi

echo ""
echo "========================================"
echo "Logs (last 20 lines):"
echo "========================================"
tail -20 logs/agent-test.log 2>/dev/null || echo "No logs available"

echo ""
echo "[i] To stop the agent: kill \$(lsof -t -i $PORT)"
echo "[i] To view logs: tail -f $DEPLOY_PATH/logs/agent-test.log"