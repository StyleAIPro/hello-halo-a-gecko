# Remote Agent Proxy Deployment Guide

## Overview

This deployment script sets up a remote Claude agent with V2 Session capabilities on your remote server.

## Architecture

```
Local Halo UI
     │
     │ sendMessage()
     │     ├─ Local V2 Session
     │     └─ RemoteWsClient ──> WebSocket
     │                            │
     └────────────────────────────┘
              │
         Remote Server
              │
    remote-agent-proxy
              │
         └──> V2 Session (via Claude Code CLI)
                 │
         └──> Claude API
```

## Prerequisites

On the **remote server** you need:
1. **SSH access** with sudo/root privileges
2. **Node.js** >= 18.x
3. **npm** package manager
4. **Network access** to download npm packages and connect to Claude API

## Quick Start

```bash
# Deploy to your remote server
./scripts/deploy-remote-agent.sh root@124.71.177.25 22 sk-ant-key https://api.example.com/v1

# Parameters:
# $1 = SSH user@host (required)
# $2 = SSH port (default: 22)
# $3 = Anthropic API key (required)
# $4 = Base URL (optional, defaults to https://api.anthropic.com)
# $5 = Work directory (optional, defaults to /root)
```

## Management Commands

After deployment, you can manage the remote service:

```bash
# View service status
./scripts/deploy-remote-agent.sh <host> <port> <key> <url> status

# View service logs
./scripts/deploy-remote-agent.sh <host> <port> <key> <url> logs

# Stop the service
./scripts/deploy-remote-agent.sh <host> <port> <key> <url> stop

# Restart the service
./scripts/deploy-remote-agent.sh <host> <port> <key> <url> restart

# Redeploy (stop + start)
./scripts/deploy-remote-agent.sh <host> <port> <key> <url> stop
./scripts/deploy-remote-agent.sh <host> <port> <key> <url>
```

## What Gets Deployed

### Remote Server Setup

```
/opt/claude-deployment/
├── dist/                    # Built remote-agent-proxy
│   ├── index.js           # WebSocket server
│   ├── server.js           # V2 Session handler
│   ├── claude-manager.js   # Claude manager
│   └── types.js
├── package.json             # Dependencies
├── node_modules/            # Installed dependencies
│   ├── @anthropic-ai/claude-agent-sdk  # V2 Session SDK
│   └── ws
├── .env                   # Environment configuration
└── logs/                   # Service logs
    └── service.pid         # Process ID
```

### Installed Components

1. **Claude Code CLI** (`@anthropic-ai/claude-code@latest`)
   - Executed by V2 Session
   - Manages Claude AI interactions
   - Supports tool calls, file operations, etc.

2. **remote-agent-proxy** (our package)
   - WebSocket server on port 8080
   - Uses V2 Session for persistent conversations
   - Manages multiple concurrent sessions

## How It Works

### Session Persistence

V2 Session automatically creates a `.claude/` directory with session history:

```
~/.claude/
└── projects/
    └── {project-dir}/
        └── .claude/
            ├── sessions/
            │   ├── {session-id}.jsonl  # Full session history
            │   └── {session-id}.json     # Current session state
```

### WebSocket Communication

```typescript
// Client sends
{
  type: "claude:chat",
  sessionId: "abc123",
  payload: {
    messages: [{ role: "user", content: "Hello" }],
    options: { stream: true }
  }
}

// Server responds (streaming)
{
  type: "claude:stream",
  sessionId: "abc123",
  data: { content: "Hi there" }
}

// Server responds (complete)
{
  type: "claude:complete",
  sessionId: "abc123"
}
```

## Troubleshooting

### Check if service is running

```bash
# SSH to remote server
ssh root@124.71.177.25

# Check process
ps aux | grep "node.*dist/index.js"

# Check port
netstat -tlnp | grep 8080

# View logs
tail -f /opt/claude-deployment/logs/output.log
```

### Common Issues

**Issue**: "Claude Code not found"
- **Cause**: npm install failed
- **Fix**: Check npm is installed and try manual install

**Issue**: "Port 8080 already in use"
- **Cause**: Another service using the port
- **Fix**: Find and stop the other service

**Issue**: "Session file not found"
- **Cause**: V2 Session can't locate .claude/ directory
- **Fix**: Check HOME environment variable

**Issue**: "WebSocket connection refused"
- **Cause**: Service crashed or not running
- **Fix**: Check logs and restart service

## Security Notes

1. **SSH Key Authentication**: Recommended for production
2. **API Key Storage**: The .env file contains the API key - ensure proper file permissions
3. **Firewall**: Ensure port 8080 is accessible from your local machine
4. **Service User**: Running as root (recommended for production)

## File Locations

| Location | Description |
|----------|-------------|
| `/opt/claude-deployment/` | Main deployment directory |
| `/opt/claude-deployment/logs/` | Service logs |
| `/opt/claude-deployment/.env` | Environment variables |
| `~/.claude/projects/` | V2 Session projects |
| `~/.claude/projects/{project}/.claude/sessions/` | Session history |

## Next Steps

After successful deployment:

1. Add the remote server in Halo settings (Remote Servers page)
2. Create a new space with "Remote" Claude source
3. Specify the remote server and working directory
4. Start using the remote Claude agent!
