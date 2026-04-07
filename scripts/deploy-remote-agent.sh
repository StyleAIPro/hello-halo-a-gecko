#!/bin/bash

# deploy-remote-agent.sh - Deployment script for remote-agent-proxy

set -e

echo "=== Remote Agent Proxy Deployment ==="

# Check Node.js environment
echo "Checking Node.js environment..."
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed"
    exit 1
fi

NODE_VERSION=$(node --version)
echo "Node.js version: $NODE_VERSION"

if ! command -v npm &> /dev/null; then
    echo "Error: npm is not installed"
    exit 1
fi

NPM_VERSION=$(npm --version)
echo "npm version: $NPM_VERSION"

# Navigate to package directory
cd "$(dirname "$0")/../packages/remote-agent-proxy"
echo "Working directory: $(pwd)"

# Install dependencies
echo ""
echo "Installing dependencies..."
npm install

# Build the package
echo ""
echo "Building package..."
npm run build

# Create systemd service
echo ""
echo "Creating systemd service..."

SERVICE_NAME="aico-bot-remote-agent"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

if [ "$EUID" -ne 0 ]; then
    echo "Note: Not running as root. Systemd service file will be generated but not installed."
    echo "Run with sudo to install the systemd service."
    echo ""
    echo "Service file content:"
    cat <<EOF
[Unit]
Description=AICO-Bot Remote Agent Proxy
After=network.target

[Service]
Type=simple
User=\$USER
WorkingDirectory=$(pwd)
ExecStart=/usr/bin/node $(pwd)/dist/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

# Optional environment variables - uncomment and set as needed
# Environment="REMOTE_AGENT_PORT=8080"
# Environment="REMOTE_AGENT_AUTH_TOKEN=your-token"
# Environment="REMOTE_AGENT_WORK_DIR=/path/to/work/dir"
# Environment="ANTHROPIC_API_KEY=your-api-key"

[Install]
WantedBy=multi-user.target
EOF

    # Create a local copy of the service file
    cat > "${SERVICE_NAME}.service" <<EOF
[Unit]
Description=AICO-Bot Remote Agent Proxy
After=network.target

[Service]
Type=simple
User=\$USER
WorkingDirectory=$(pwd)
ExecStart=/usr/bin/node $(pwd)/dist/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

# Optional environment variables - uncomment and set as needed
# Environment="REMOTE_AGENT_PORT=8080"
# Environment="REMOTE_AGENT_AUTH_TOKEN=your-token"
# Environment="REMOTE_AGENT_WORK_DIR=/path/to/work/dir"
# Environment="ANTHROPIC_API_KEY=your-api-key"

[Install]
WantedBy=multi-user.target
EOF

    echo ""
    echo "Service file created: $(pwd)/${SERVICE_NAME}.service"
    echo "To install as systemd service, run:"
    echo "  sudo cp $(pwd)/${SERVICE_NAME}.service ${SERVICE_FILE}"
    echo "  sudo systemctl daemon-reload"
    echo "  sudo systemctl enable ${SERVICE_NAME}"
    echo "  sudo systemctl start ${SERVICE_NAME}"
else
    # Running as root, install the service
    cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=AICO-Bot Remote Agent Proxy
After=network.target

[Service]
Type=simple
User=SUDO_USER
WorkingDirectory=$(pwd)
ExecStart=/usr/bin/node $(pwd)/dist/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

    echo "Reloading systemd..."
    systemctl daemon-reload

    echo "Enabling service..."
    systemctl enable "$SERVICE_NAME"

    echo "Starting service..."
    systemctl start "$SERVICE_NAME"

    echo ""
    echo "Service status:"
    systemctl status "$SERVICE_NAME" --no-pager || true
fi

echo ""
echo "=== Deployment Complete ==="
echo ""
echo "Environment variables (set these before running):"
echo "  REMOTE_AGENT_PORT     - Port to listen on (default: 8080)"
echo "  REMOTE_AGENT_AUTH_TOKEN - Authentication token (optional)"
echo "  REMOTE_AGENT_WORK_DIR  - Working directory for file operations"
echo "  ANTHROPIC_API_KEY     - Claude API key for chat features"
echo ""
echo "To run manually:"
echo "  npm start"
