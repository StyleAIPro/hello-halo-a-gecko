#!/bin/bash
#
# Update remote agent server with IPv4 support
#

set -e

REMOTE_HOST="root@124.71.177.25"
DEPLOY_PATH="/opt/claude-deployment"

echo "=== Updating Remote Agent Server ==="
echo ""
echo "This will update the server to listen on IPv4 (0.0.0.0)"
echo "Current issue: Server only listens on IPv6, causing ECONNRESET for IPv4 clients"
echo ""

# Create a temporary archive of the dist files
echo "Creating deployment package..."
cd "$(dirname "$0")/../packages/remote-agent-proxy"

tar -czf /tmp/remote-agent-update.tar.gz dist/ package.json

echo "Deployment package created: /tmp/remote-agent-update.tar.gz"
echo ""
echo "========================================"
echo "Manual deployment required"
echo "========================================"
echo ""
echo "Please run the following commands on the remote server:"
echo ""
echo "1. Create deployment directory:"
echo "   mkdir -p $DEPLOY_PATH"
echo ""
echo "2. Stop the current service:"
echo "   ssh $REMOTE_HOST 'pkill -f \"node.*dist/index.js\"'"
echo ""
echo "3. Copy the updated files:"
echo "   scp /tmp/remote-agent-update.tar.gz $REMOTE_HOST:$DEPLOY_PATH/"
echo ""
echo "4. Extract and start:"
echo "   ssh $REMOTE_HOST << 'ENDSSH'"
echo "   cd $DEPLOY_PATH"
echo "   tar -xzf remote-agent-update.tar.gz"
echo "   rm remote-agent-update.tar.gz"
echo "   export ANTHROPIC_API_KEY=\"7d9d6f744dea44ca89413025d1cf9250.T4asr8unnrVz5QCt\""
echo "   export ANTHROPIC_BASE_URL=\"https://open.bigmodel.cn/api/anthropic\""
echo "   export REMOTE_AGENT_PORT=8080"
echo "   export CLAUDE_WORK_DIR=\"/root\""
echo "   nohup node dist/index.js > logs/output.log 2>&1 &"
echo "   ENDSSH"
echo ""
echo "5. Verify IPv4 is listening:"
echo "   ssh $REMOTE_HOST 'netstat -tlnp | grep 8080'"
echo ""
echo "Expected output should show 'tcp' (IPv4) in addition to 'tcp6' (IPv6)"
echo ""
