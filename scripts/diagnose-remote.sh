#!/bin/bash
#
# Diagnostic script for remote agent service
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_step() {
    echo -e "${BLUE}[STEP]${NC} $1"
}

# Check if password is provided
if [ -z "$SSH_PASSWORD" ]; then
    log_error "SSH_PASSWORD environment variable not set"
    echo "Usage: SSH_PASSWORD=yourpassword $0"
    exit 1
fi

REMOTE_HOST="root@124.71.177.25"
REMOTE_PORT=8080
DEPLOY_PATH="/opt/claude-deployment"

log_step "Starting diagnostic check..."

echo "=========================================="
log_step "1. Checking SSH connectivity"
echo "=========================================="

if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -o BatchMode=yes "$REMOTE_HOST" "echo 'SSH OK'" 2>/dev/null; then
    log_info "SSH connection successful"
else
    log_error "SSH connection failed"
    log_warn "Trying with password authentication..."
    if sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 "$REMOTE_HOST" "echo 'SSH OK'" 2>/dev/null; then
        log_info "SSH connection with password successful"
    else
        log_error "SSH authentication failed - cannot proceed"
        exit 1
    fi
fi

echo ""
echo "=========================================="
log_step "2. Checking deployment directory"
echo "=========================================="

DEPLOY_EXISTS=$(sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 "$REMOTE_HOST" "[ -d $DEPLOY_PATH ] && echo 'EXISTS' || echo 'NOT_EXISTS'" 2>/dev/null)

if [ "$DEPLOY_EXISTS" = "EXISTS" ]; then
    log_info "Deployment directory exists: $DEPLOY_PATH"

    # Check for required files
    log_info "Checking for required files..."
    FILES_OK=true

    if sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 "$REMOTE_HOST" "[ -f $DEPLOY_PATH/dist/index.js ]" 2>/dev/null; then
        log_info "  ✓ dist/index.js found"
    else
        log_error "  ✗ dist/index.js NOT found"
        FILES_OK=false
    fi

    if sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 "$REMOTE_HOST" "[ -f $DEPLOY_PATH/package.json ]" 2>/dev/null; then
        log_info "  ✓ package.json found"
    else
        log_error "  ✗ package.json NOT found"
        FILES_OK=false
    fi

    if sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 "$REMOTE_HOST" "[ -d $DEPLOY_PATH/node_modules ]" 2>/dev/null; then
        log_info "  ✓ node_modules directory found"
    else
        log_warn "  ! node_modules directory NOT found - dependencies may not be installed"
        FILES_OK=false
    fi

else
    log_error "Deployment directory NOT found: $DEPLOY_PATH"
    log_info "Please deploy the remote agent first"
    exit 1
fi

echo ""
echo "=========================================="
log_step "3. Checking process status"
echo "=========================================="

PROCESS=$(sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 "$REMOTE_HOST" "ps aux | grep '[n]ode.*dist/index.js'" 2>/dev/null)

if [ -z "$PROCESS" ]; then
    log_error "No remote agent process found"
    PROCESS_RUNNING=false
else
    log_info "Remote agent process is running:"
    echo "$PROCESS"
    PROCESS_RUNNING=true
fi

echo ""
echo "=========================================="
log_step "4. Checking port status"
echo "=========================================="

PORT_CHECK=$(sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 "$REMOTE_HOST" "netstat -tlnp 2>/dev/null | grep ':$REMOTE_PORT ' || echo 'NOT_LISTENING'" 2>/dev/null)

if echo "$PORT_CHECK" | grep -q "LISTEN"; then
    log_info "Port $REMOTE_PORT is listening:"
    echo "$PORT_CHECK"
elif echo "$PORT_CHECK" | grep -q "node"; then
    log_info "Port $REMOTE_PORT is in use by Node.js:"
    echo "$PORT_CHECK"
else
    log_error "Port $REMOTE_PORT is NOT listening"
fi

echo ""
echo "=========================================="
log_step "5. Checking recent logs"
echo "=========================================="

if sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 "$REMOTE_HOST" "[ -f $DEPLOY_PATH/logs/output.log ]" 2>/dev/null; then
    log_info "Recent log entries:"
    sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 "$REMOTE_HOST" "tail -30 $DEPLOY_PATH/logs/output.log" 2>/dev/null
else
    log_warn "No log file found at $DEPLOY_PATH/logs/output.log"
fi

echo ""
echo "=========================================="
log_step "6. Checking environment variables"
echo "=========================================="

ENV_CHECK=$(sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 "$REMOTE_HOST" "env | grep -E 'ANTHROPIC|REMOTE_AGENT' || echo 'NONE'" 2>/dev/null)

if [ "$ENV_CHECK" = "NONE" ]; then
    log_warn "No ANTHROPIC or REMOTE_AGENT environment variables found"
    log_info "These should be set when starting the service:"
    echo "  - ANTHROPIC_API_KEY"
    echo "  - ANTHROPIC_BASE_URL"
    echo "  - REMOTE_AGENT_PORT"
    echo "  - CLAUDE_WORK_DIR"
else
    log_info "Environment variables found:"
    echo "$ENV_CHECK"
fi

echo ""
echo "=========================================="
log_step "7. Diagnostic Summary"
echo "=========================================="

if [ "$FILES_OK" = true ] && [ "$PROCESS_RUNNING" = true ]; then
    log_info "All checks passed - service should be functional"
    log_info "Try testing the connection from the local AICO-Bot app"
else
    log_error "Some checks failed - see details above"

    if [ "$FILES_OK" = false ]; then
        log_warn "Deployment files incomplete - may need to redeploy"
    fi

    if [ "$PROCESS_RUNNING" = false ]; then
        log_warn "Process not running - try starting the service"
        log_info "Start command:"
        echo "  ssh root@124.71.177.25 \"cd $DEPLOY_PATH && export ANTHROPIC_API_KEY=... ANTHROPIC_BASE_URL=... REMOTE_AGENT_PORT=8080 CLAUDE_WORK_DIR=/root && nohup node dist/index.js > logs/output.log 2>&1 &\""
    fi
fi

echo ""
log_info "Diagnostic complete"
