#!/bin/bash
#
# Simple Remote Agent Deployment Script
# Designed to work when run from any directory
#

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ============================================
# Configuration
# ============================================

DEPLOY_HOST="${1:-root@124.71.177.25}"
SSH_PORT="${2:-22}"
API_KEY="${3:-}"
BASE_URL="${4:-https://api.anthropic.com}"
WORK_DIR="${5:-/root}"
REMOTE_DEPLOY_PATH="/opt/claude-deployment"

# Validate required arguments
if [ -z "$API_KEY" ]; then
    echo -e "${RED}Error: API key is required${NC}"
    echo "Usage: $0 <user@host> <ssh-port> <api-key> <base-url> [work-dir]"
    exit 1
fi

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[OK]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
    echo -e "${YELLOW}[STEP]${NC} $1"
}

# ============================================
# Check remote server environment
# ============================================

log_step "Checking remote server environment..."

ssh -p $SSH_PORT "$DEPLOY_HOST" << 'ENDSSH'
    echo "Checking Node.js..."
    if ! command -v node &>/dev/null; then
        echo "Node.js is not available on remote server"
        exit 1
    fi
    node --version

    if ! command -v npm &>/dev/null; then
        echo "npm is not available on remote server"
        exit 1
    fi
    npm --version
ENDSSH

if [ $? -ne 0 ]; then
    log_error "Failed to check remote server environment"
    exit 1
fi

log_success "Remote server environment checked"

# ============================================
# Upload files
# ============================================

log_step "Uploading files to remote server..."

# Create deployment directory
ssh -p $SSH_PORT "$DEPLOY_HOST" "mkdir -p $REMOTE_DEPLOY_PATH/dist" 2>/dev/null

# Upload dist files from local
LOCAL_DIST_DIR="/Users/zhaoyinqi/zyq_workspace/hello-aico-bot/packages/remote-agent-proxy/dist"
if [ -d "$LOCAL_DIST_DIR" ]; then
    for file in "$LOCAL_DIST_DIR"/*.js; do
        if [ -f "$file" ]; then
            filename=$(basename "$file")
            echo "  Uploading: $filename"
            scp -P $SSH_PORT "$file" "$DEPLOY_HOST:$REMOTE_DEPLOY_PATH/dist/" 2>/dev/null

            if [ $? -ne 0 ]; then
                log_error "Failed to upload: $filename"
                exit 1
            fi
        fi
    done

    # Upload package.json
    echo "  Uploading: package.json"
    scp -P $SSH_PORT "$LOCAL_DIST_DIR/../package.json" "$DEPLOY_HOST:$REMOTE_DEPLOY_PATH/" 2>/dev/null

    if [ $? -eq 0 ]; then
        log_success "All files uploaded"
    else
        log_error "Failed to upload package.json"
        exit 1
    fi
else
    log_error "Local dist directory not found: $LOCAL_DIST_DIR"
    exit 1
fi

# ============================================
# Configure environment
# ============================================

log_step "Configuring environment variables..."

# Create environment file
ssh -p $SSH_PORT "$DEPLOY_HOST" << 'ENDSSH'
    cd $REMOTE_DEPLOY_PATH

    # Create .env file
    cat > .env << EOF
REMOTE_AGENT_PORT=8080
ANTHROPIC_API_KEY=$API_KEY
ANTHROPIC_BASE_URL=$BASE_URL
CLAUDE_WORK_DIR=$WORK_DIR
EOF

    echo "Environment configured"
ENDSSH

if [ $? -eq 0 ]; then
    log_success "Environment configured"
else
    log_error "Failed to configure environment"
    exit 1
fi

# ============================================
# Start service
# ============================================

log_step "Starting remote agent service..."

ssh -p $SSH_PORT "$DEPLOY_HOST" << 'ENDSSH'
    cd $REMOTE_DEPLOY_PATH

    # Create logs directory
    mkdir -p logs

    # Stop existing service
    if [ -f logs/service.pid ]; then
        echo "Stopping existing service..."
        PID=$(cat logs/service.pid)
        if [ -n "$PID" ]; then
            kill $PID 2>/dev/null
            sleep 2
        fi
        rm -f logs/service.pid
    fi

    # Also try to kill by process name
    pkill -f "node.*dist/index.js" 2>/dev/null

    # Load environment variables from .env file
    if [ -f .env ]; then
        export $(grep -v '^#' .env | xargs)
        echo "Environment variables loaded from .env"
    else
        echo "Warning: .env file not found"
    fi

    # Start service in background
    nohup node dist/index.js > logs/output.log 2>&1 &
    echo $! > logs/service.pid
ENDSSH

if [ $? -eq 0 ]; then
    log_success "Service started"
else
    log_error "Failed to start service"
    exit 1
fi

# ============================================
# Verify deployment
# ============================================

log_step "Verifying deployment..."

# Wait for service to start
sleep 5

# Check if service is running
ssh -p $SSH_PORT "$DEPLOY_HOST" << 'ENDSSH'
    cd $REMOTE_DEPLOY_PATH

    if pgrep -f "node.*dist/index.js" > /dev/null; then
        echo "Service is running (PID: $(pgrep -f 'node.*dist/index.js'))"
    else
        echo "Service failed to start"
        exit 1
    fi

    # Check port
    if netstat -tlnp 2>/dev/null | grep -q ":8080 "; then
        echo "WebSocket port 8080 is listening"
    else
        echo "WebSocket port 8080 is not listening"
        exit 1
    fi

    # Show recent logs
    echo ""
    echo "=== Recent Service Logs ==="
    tail -20 logs/output.log
ENDSSH

if [ $? -eq 0 ]; then
    echo ""
    log_success "Deployment complete!"
else
    log_error "Deployment verification failed"
    exit 1
fi
