#!/bin/bash
#
# Remote Agent Proxy Deployment Script
# Deploys remote-agent-proxy with V2 Session support to remote server
#
# Usage:
#   ./scripts/deploy-remote-agent.sh <user@host> <ssh-port> <api-key> <base-url> [work-dir] [password]
#
# Example:
#   ./scripts/deploy-remote-agent.sh root@124.71.177.25 22 sk-xxx https://api.example.com/v1 /root
#   ./scripts/deploy-remote-agent.sh root@124.71.177.25 22 sk-xxx https://api.example.com/v1 /root "mypassword"
#
# Note: Password authentication uses sshpass for non-interactive login

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ============================================
# Configuration
# ============================================

DEPLOY_HOST="${1:-}"
SSH_PORT="${2:-22}"
API_KEY="${3:-}"
BASE_URL="${4:-}"
WORK_DIR="${5:-/root}"
SSH_PASSWORD="${6:-}"  # Optional SSH password
REMOTE_DEPLOY_PATH="/opt/claude-deployment"
LOCAL_PACKAGE_PATH="./packages/remote-agent-proxy"

# Validate required arguments
if [ -z "$DEPLOY_HOST" ]; then
    echo -e "${RED}Error: Deployment host is required${NC}"
    echo "Usage: $0 <user@host> <ssh-port> <api-key> <base-url> [work-dir] [password]"
    exit 1
fi

if [ -z "$API_KEY" ]; then
    echo -e "${RED}Error: API key is required${NC}"
    echo "Usage: $0 <user@host> <ssh-port> <api-key> <base-url> [work-dir] [password]"
    exit 1
fi

if [ -z "$BASE_URL" ]; then
    echo -e "${YELLOW}Warning: Base URL not provided, using default${NC}"
    BASE_URL="https://api.anthropic.com"
fi

# ============================================
# Functions
# ============================================

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

check_ssh_connection() {
    log_step "Testing SSH connection..."

    if [ -n "$SSH_PASSWORD" ]; then
        # Password authentication
        if ssh -o ConnectTimeout=10 -o BatchMode=yes -p "$SSH_PORT" "$DEPLOY_HOST" "exit 0" 2>/dev/null; then
            log_success "SSH connection successful (password auth)"
            return 0
        else
            log_error "Cannot connect to remote server: $DEPLOY_HOST:$SSH_PORT"
            exit 1
        fi
    else
        # Key authentication (default)
        if ssh -o ConnectTimeout=10 -o BatchMode=yes -p "$SSH_PORT" "$DEPLOY_HOST" "exit 0" 2>/dev/null; then
            log_success "SSH connection successful (key auth)"
            return 0
        else
            log_error "Cannot connect to remote server: $DEPLOY_HOST:$SSH_PORT"
            exit 1
        fi
    fi
}

create_remote_directory() {
    log_step "Creating remote deployment directory..."

    ssh -p $SSH_PORT "$DEPLOY_HOST" "mkdir -p $REMOTE_DEPLOY_PATH" 2>/dev/null

    if [ $? -eq 0 ]; then
        log_success "Remote directory created: $REMOTE_DEPLOY_PATH"
    else
        log_error "Failed to create remote directory"
        exit 1
    fi
}

upload_files() {
    log_step "Uploading remote-agent-proxy files..."

    # Upload dist files
    ssh -p $SSH_PORT "$DEPLOY_HOST" "mkdir -p $REMOTE_DEPLOY_PATH/dist" 2>/dev/null

    for file in $LOCAL_PACKAGE_PATH/dist/*.js; do
        filename=$(basename "$file")
        echo "  Uploading: $filename"
        scp -P $SSH_PORT "$file" "$DEPLOY_HOST:$REMOTE_DEPLOY_PATH/dist/" 2>/dev/null

        if [ $? -ne 0 ]; then
            log_error "Failed to upload: $filename"
            exit 1
        fi
    done

    # Upload package.json
    echo "  Uploading: package.json"
    scp -P $SSH_PORT "$LOCAL_PACKAGE_PATH/package.json" "$DEPLOY_HOST:$REMOTE_DEPLOY_PATH/package.json" 2>/dev/null

    if [ $? -eq 0 ]; then
        log_success "All files uploaded"
    else
        log_error "Failed to upload package.json"
        exit 1
    fi
}

install_claude_code_cli() {
    log_step "Installing Claude Code CLI globally..."

    ssh -p $SSH_PORT "$DEPLOY_HOST" << 'ENDSSH'
        # Check if npm is available
        if ! command -v npm &>/dev/null; then
            echo "npm is not available on remote server"
            echo "Please install npm first"
            exit 1
        fi

        # Configure npm to use Chinese mirror for faster installation
        npm config set registry https://registry.npmmirror.com

        # Install Claude Code CLI globally
        npm install -g @anthropic-ai/claude-code@latest
ENDSSH

    if [ $? -eq 0 ]; then
        log_success "Claude Code CLI installed"

        # Verify installation
        ssh -p $SSH_PORT "$DEPLOY_HOST" "claude --version" 2>/dev/null
    else
        log_error "Failed to install Claude Code CLI"
        exit 1
    fi
}

install_dependencies() {
    log_step "Installing remote-agent-proxy dependencies..."

    ssh -p $SSH_PORT "$DEPLOY_HOST" << 'ENDSSH'
        cd $REMOTE_DEPLOY_PATH

        # Configure npm to use Chinese mirror for faster installation
        npm config set registry https://registry.npmmirror.com

        # Install dependencies
        npm install --production
ENDSSH

    if [ $? -eq 0 ]; then
        log_success "Dependencies installed"
    else
        log_error "Failed to install dependencies"
        exit 1
    fi
}

configure_environment() {
    log_step "Configuring environment..."

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
ENDSSH

    if [ $? -eq 0 ]; then
        log_success "Environment configured"
    else
        log_error "Failed to configure environment"
        exit 1
    fi
}

start_service() {
    log_step "Starting remote-agent-proxy service..."

    # Create logs directory
    ssh -p $SSH_PORT "$DEPLOY_HOST" << 'ENDSSH'
        cd $REMOTE_DEPLOY_PATH
        mkdir -p logs
ENDSSH

    # Check if service is already running
    ssh -p $SSH_PORT "$DEPLOY_HOST" << 'ENDSSH'
        if pgrep -f "node.*dist/index.js" > /dev/null; then
            PID=\$(pgrep -f "node.*dist/index.js")
            echo "Service already running with PID: \$PID"
            echo "Stopping existing service..."
            pkill -f "node.*dist/index.js"
            sleep 2
        fi
ENDSSH

    # Start service in background
    ssh -p $SSH_PORT "$DEPLOY_HOST" << 'ENDSSH'
        cd $REMOTE_DEPLOY_PATH
        # Load environment variables from .env file
        if [ -f .env ]; then
            export $(grep -v '^#' .env | xargs)
            echo "Environment variables loaded from .env"
        else
            echo "Warning: .env file not found"
        fi
        # Start the service
        nohup node dist/index.js > logs/output.log 2>&1 &
        echo \$! > logs/service.pid
ENDSSH

    if [ $? -eq 0 ]; then
        log_success "Service started"
    else
        log_error "Failed to start service"
        exit 1
    fi
}

verify_deployment() {
    log_step "Verifying deployment..."

    # Wait for service to start
    sleep 3

    # Check if service is running
    ssh -p $SSH_PORT "$DEPLOY_HOST" << 'ENDSSH'
        if pgrep -f "node.*dist/index.js" > /dev/null; then
            log_success "Service is running"
        else
            log_error "Service failed to start"
            exit 1
        fi
ENDSSH

    # Check WebSocket port
    ssh -p $SSH_PORT "$DEPLOY_HOST" << 'ENDSSH'
        if netstat -tlnp 2>/dev/null | grep -q ":8080 "; then
            log_success "WebSocket port 8080 is listening"
        else
            log_error "WebSocket port 8080 is not listening"
            exit 1
        fi
ENDSSH
}

show_logs() {
    echo ""
    echo "=== Recent Service Logs ==="

    ssh -p $SSH_PORT "$DEPLOY_HOST" << 'ENDSSH'
        cd $REMOTE_DEPLOY_PATH
        tail -50 logs/output.log
ENDSSH
}

stop_service() {
    log_step "Stopping remote-agent-proxy service..."

    ssh -p $SSH_PORT "$DEPLOY_HOST" << 'ENDSSH'
        cd $REMOTE_DEPLOY_PATH

        if [ -f logs/service.pid ]; then
            PID=\$(cat logs/service.pid)
            if [ -n "\$PID" ]; then
                kill \$PID 2>/dev/null
                rm logs/service.pid
                echo "Service stopped (PID: \$PID)"
            else
                echo "No service PID found"
            fi
        else
            # Try to kill by process name
            pkill -f "node.*dist/index.js"
            echo "Service stopped (by process name)"
        fi
ENDSSH

    if [ $? -eq 0 ]; then
        log_success "Service stopped"
    else
        log_error "Failed to stop service"
        exit 1
    fi
}

show_status() {
    echo ""
    echo "=== Remote Agent Proxy Status ==="

    ssh -p $SSH_PORT "$DEPLOY_HOST" << 'ENDSSH'
        cd $REMOTE_DEPLOY_PATH

        # Check if service is running
        if pgrep -f "node.*dist/index.js" > /dev/null; then
            PID=\$(pgrep -f "node.*dist/index.js")
            echo "Status: ${GREEN}Running${NC} (PID: \$PID)"
        else
            echo "Status: ${RED}Stopped${NC}"
        fi

        # Show recent logs
        if [ -f logs/output.log ]; then
            echo ""
            echo "=== Recent Logs (last 20 lines) ==="
            tail -20 logs/output.log
        fi
ENDSSH
}

# ============================================
# Main Deployment Flow
# ============================================

echo ""
echo "============================================================"
echo "  Remote Agent Proxy Deployment"
echo "============================================================"
echo ""
echo "Deployment Target: $DEPLOY_HOST:$SSH_PORT"
echo "Deploy Path: $REMOTE_DEPLOY_PATH"
echo "Work Directory: $WORK_DIR"
echo "Base URL: $BASE_URL"
echo "SSH Auth: $([ -n \"$SSH_PASSWORD\" ] && echo \"Password\" || echo \"Key\")"
echo ""

# Build local package first
log_step "Building local remote-agent-proxy..."
cd "$LOCAL_PACKAGE_PATH"
npm run build

if [ $? -ne 0 ]; then
    log_error "Failed to build remote-agent-proxy"
    exit 1
fi

log_success "Build completed"

# Execute deployment steps
check_ssh_connection
create_remote_directory
upload_files
install_claude_code_cli
install_dependencies
configure_environment
start_service
verify_deployment

# ============================================
# Deployment Summary
# ============================================

echo ""
echo "============================================================"
echo "  Deployment Complete!"
echo "============================================================"
echo ""
echo -e "${GREEN}Deployment successful!${NC}"
echo ""
echo "Service commands:"
echo "  ./scripts/deploy-remote-agent.sh $DEPLOY_HOST $SSH_PORT $API_KEY $BASE_URL logs"
echo "  ./scripts/deploy-remote-agent.sh $DEPLOY_HOST $SSH_PORT $API_KEY $BASE_URL stop"
echo "  ./scripts/deploy-remote-agent.sh $DEPLOY_HOST $SSH_PORT $API_KEY $BASE_URL restart"
echo "  ./scripts/deploy-remote-agent.sh $DEPLOY_HOST $SSH_PORT $API_KEY $BASE_URL status"
echo ""
echo "Test WebSocket connection:"
echo "  wscat -c \"Authorization: Bearer $API_KEY\" ws://$DEPLOY_HOST:8080/agent"
echo ""

# Save deployment info for later use
cat > "$LOCAL_PACKAGE_PATH/.deploy-info" << EOF
DEPLOY_HOST=$DEPLOY_HOST
SSH_PORT=$SSH_PORT
REMOTE_DEPLOY_PATH=$REMOTE_DEPLOY_PATH
API_KEY=$API_KEY
BASE_URL=$BASE_URL
WORK_DIR=$WORK_DIR
SSH_PASSWORD=$SSH_PASSWORD
DEPLOY_DATE=$(date -Iseconds)
EOF

log_info "Deployment info saved to: $LOCAL_PACKAGE_PATH/.deploy-info"
