# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Halo is an open-source desktop application that wraps Claude Code's AI agent capabilities in a visual, cross-platform interface. It enables users to interact with AI agents without using the terminal.

## Build/Test Commands

```bash
# Development
npm run dev              # Start development server (uses ~/.halo-dev data dir)

# Build
npm run build            # Build for production
npm run build:mac        # Build for macOS (universal)
npm run build:win        # Build for Windows
npm run build:linux      # Build for Linux

# Testing
npm run test             # Run all tests
npm run test:unit        # Unit tests only (Vitest)
npm run test:e2e         # E2E tests (Playwright)

# Internationalization
npm run i18n             # Extract and translate strings (run before commit)

# Binary preparation (for contributors)
npm run prepare          # Download binaries for current platform
npm run prepare:all      # Download binaries for all platforms
```

## Architecture Overview

### Multi-Process Electron Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          Halo Desktop                           │
│  ┌─────────────┐    ┌─────────────┐    ┌───────────────────┐   │
│  │   React UI  │◄──►│    Main     │◄──►│  Claude Code SDK  │   │
│  │  (Renderer) │IPC │   Process   │    │   (Agent Loop)    │   │
│  └─────────────┘    └─────────────┘    └───────────────────┘   │
│                            │                                    │
│                            ▼                                    │
│                    ┌───────────────┐                           │
│                    │  Local Files  │                           │
│                    │  ~/.halo/     │                           │
│                    └───────────────┘                           │
└─────────────────────────────────────────────────────────────────┘
```

### Key Directories

- **`/src/main/`** - Electron Main Process
  - `services/agent/` - Core agent functionality, SDK integration, message handling
  - `services/remote-ws/` - WebSocket client for remote server communication
  - `services/remote-ssh/` - SSH tunneling for remote access
  - `services/remote-deploy/` - Remote agent deployment
  - `services/space/` - Workspace management
  - `services/conversation.service.ts` - Chat conversation persistence

- **`/src/renderer/`** - React Frontend
  - `components/` - UI components
  - `stores/` - Zustand state management (chat.store.ts is critical)
  - `api/` - IPC/HTTP adapter layer
  - `i18n/` - Internationalization

- **`/packages/remote-agent-proxy/`** - Standalone Node.js server for remote Claude access
  - `src/server.ts` - WebSocket server
  - `src/claude-manager.ts` - V2 Session management

- **`/src/shared/`** - Shared types between main/renderer

## Remote Space Thinking Process Flow

The thinking/reasoning display for remote spaces follows this data flow:

```
Remote Server (claude-manager.ts)     Local Client (send-message.ts)    Frontend (chat.store.ts)
─────────────────────────────────     ─────────────────────────────    ─────────────────────────
SDK stream_event                      RemoteWsClient events            Zustand store updates
├─ content_block_start (thinking) ──► 'thought' event ──────────────► handleAgentThought()
├─ content_block_delta             ──► 'thought:delta' event ────────► handleAgentThoughtDelta()
└─ content_block_stop              ──► (complete signal)            ──► thought.isStreaming = false
```

### Key Files for Thinking Process

1. **Remote Server**:
   - `packages/remote-agent-proxy/src/claude-manager.ts:856-970` - Thinking block streaming
   - `packages/remote-agent-proxy/src/server.ts:280-296` - WebSocket message sending

2. **Local Client**:
   - `src/main/services/remote-ws/remote-ws-client.ts:211-217` - Event emission
   - `src/main/services/agent/send-message.ts:684-737` - Event forwarding to renderer

3. **Frontend**:
   - `src/renderer/stores/chat.store.ts:1125-1195` - Thought state management

### Debugging Tips

- Check `hasStreamEvent` flag in claude-manager.ts - controls fallback behavior
- Verify `sessionId` routing matches `conversationId` in send-message.ts
- `streamingBlocks` Map tracks active blocks by index for delta correlation
- Fallback path processes thinking blocks from assistant messages when no stream_event

## Code Conventions

### No Hardcoded Text in UI

Use `t('English text')` for all user-visible strings:

```tsx
✓ <Button>{t('Save')}</Button>
✗ <Button>Save</Button>
```

Translation files are auto-generated. Run `npm run i18n` before commit.

### State Management

- **Zustand** for frontend state (see chat.store.ts)
- Per-session state uses `Map<conversationId, SessionState>`
- Per-space state uses `Map<spaceId, SpaceState>`

### IPC Communication

- Main → Renderer: `sendToRenderer('agent:event', spaceId, conversationId, data)`
- Renderer → Main: Use `api.*` methods from `src/renderer/api/`

## Remote Agent Architecture

Remote spaces route through a WebSocket proxy:

1. **SSH Tunnel** (optional): `sshTunnelService.establishTunnel()` creates local port forward
2. **WebSocket Client**: `RemoteWsClient` connects to remote agent
3. **Session Resumption**: `sdkSessionId` enables multi-turn conversations

Key config:
- `space.claudeSource === 'remote'` triggers remote execution
- `space.remoteServerId` identifies the target server
- `space.useSshTunnel` (default: true) determines connection mode

## SDK Integration

Uses `@anthropic-ai/claude-agent-sdk` with V2 sessions:

- `unstable_v2_createSession()` - Create new session
- `unstable_v2_resumeSession()` - Resume existing session
- Session options include `permissionMode: 'bypassPermissions'`

### Key SDK Options

```typescript
{
  model: 'claude-sonnet-4-20250514',
  cwd: workDir,
  permissionMode: 'bypassPermissions',
  includePartialMessages: true,
  maxThinkingTokens: 10240  // When thinking enabled
}
```

## Configuration Files

- **`product.json`** - Build configuration and auth provider definitions
- **`~/.halo/`** - User data directory (conversations, settings, spaces)
- **`.env.example`** - Environment variables template
