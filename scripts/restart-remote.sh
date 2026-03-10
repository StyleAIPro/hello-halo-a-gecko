#!/bin/bash
#
# Simple script to restart remote agent service
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if password is provided
if [ -z "$SSH_PASSWORD" ]; then
    log_error "SSH_PASSWORD environment variable not set"
    exit 1
fi

REMOTE_HOST="root@124.71.177.25"
REMOTE_PORT=8080
API_KEY="7d9d6f744dea44ca89413025d1cf9250.T4asr8unnrVz5QCt"
BASE_URL="https://open.bigmodel.cn/api/anthropic"
WORK_DIR="/root"

log_info "Checking remote server status..."

# Check if service is running
SSH_RESULT=$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -o ConnectTimeout=10 "$REMOTE_HOST" "ps aux | grep 'node.*dist/index.js'" 2>/dev/null)

if [ -n "$SSH_RESULT" ]; then
    log_info "No process found"

    # Start the service
    log_info "Starting remote agent service..."
    SSH_RESULT=$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -o ConnectTimeout=10 "$REMOTE_HOST" "cd /opt/claude-deployment && export ANTHROPIC_API_KEY=$API_KEY ANTHROPIC_BASE_URL=$BASE_URL CLAUDE_WORK_DIR=$WORK_DIR REMOTE_AGENT_PORT=$REMOTE_PORT; nohup node dist/index.js > logs/output.log 2>&1 & echo \$! > logs/service.pid" 2>/dev/null)

    if [ $? -eq 0 ]; then
        log_info "Service started successfully"

        # Wait and verify
        sleep 5
        sleep 5

        # Check if running
        SSH_RESULT=$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -o ConnectTimeout=10 "$REMOTE_HOST" "ps aux | grep 'node.*dist/index.js'" 2>/dev/null)

        if [ -n "$SSH_RESULT" ]; then
            log_error "Failed to start service"
        else
            log_info "Service is running (PID: $SSH_RESULT)"

            # Check port
            SSH_PORT=$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -o ConnectTimeout=10 "$REMOTE_HOST" "netstat -tlnp | grep ':$REMOTE_PORT ' | head -1" 2>/dev/null)

            if [ -n "$SSH_PORT" ]; then
                log_error "Port $REMOTE_PORT is not listening"
            else
                log_info "Port $REMOTE_PORT is listening"
            fi

            # Check logs
            log_info "Recent logs:"
            ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -o ConnectTimeout=10 "$REMOTE_HOST" "tail -20 /opt/claude-deployment/logs/output.log" 2>/dev/null
        fi
    else
        log_error "Failed to check service status"
    fi
else
    log_info "Remote agent is running"
fi

log_info "Done!"
