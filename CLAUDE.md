# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Halo is an open-source Electron desktop application that wraps Claude Code's AI agent capabilities in a visual, cross-platform interface. It enables users to interact with AI agents without using the terminal. Version 2.x includes a Digital Humans automation platform.

## Build/Test Commands

```bash
# Development
npm run dev              # Start dev server (uses ~/.halo-dev data dir, port 8081)

# Build
npm run build            # Build proxy + electron-vite build (outputs to out/)
npm run build:mac        # Build macOS universal (dmg + zip)
npm run build:win        # Build Windows x64 (nsis installer)
npm run build:linux      # Build Linux x64 (AppImage)

# Testing
npm run test             # Binary check + unit tests
npm run test:unit        # vitest run (all unit tests)
npm run test:unit:watch  # vitest watch mode
npm run test:e2e         # Playwright E2E (requires npm run build first)
npm run test:e2e:smoke   # E2E smoke tests only
npm run test:e2e:headed  # E2E with browser UI

# Run a single unit test
npx vitest run --config tests/vitest.config.ts tests/unit/services/config.test.ts

# Run tests matching a pattern
npx vitest run --config tests/vitest.config.ts -t "should return default config"

# Internationalization (run before committing new user-facing text)
npm run i18n             # Extract + translate (requires HALO_TEST_* env vars in .env.local)
npm run i18n:extract     # Extract keys only
npm run i18n:translate   # AI-translate only

# Binary preparation
npm run prepare          # Download binaries for current platform
npm run prepare:all      # Download binaries for all platforms
```

### E2E Test Prerequisites

E2E tests require `npm run build` first and API credentials in `.env.local` (see `.env.example`).

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

The app boots in two phases via `src/main/bootstrap/`:
- **Phase 1 (Essential)**: Synchronous, target <500ms — spaces, config, IPC handlers
- **Phase 2 (Extended)**: Deferred until `ready-to-show` — analytics, health, background services

### Key Directories

- **`/src/main/`** - Electron Main Process
  - `services/agent/` - Core agent, SDK integration, message handling
  - `services/remote-ws/` - WebSocket client for remote server communication
  - `services/remote-ssh/` - SSH tunneling
  - `services/remote-deploy/` - Remote agent deployment
  - `services/space/` - Workspace management
  - `services/conversation.service.ts` - Chat conversation persistence
  - `platform/` - Background subsystems (event-bus, memory, scheduler, background apps)
  - `apps/` - Digital Humans automation platform (spec, manager, runtime)
  - `ipc/` - IPC handler modules (13+ modules)
  - `http/` - Remote Access HTTP server

- **`/src/renderer/`** - React Frontend
  - `components/` - UI components
  - `stores/` - Zustand state management (`chat.store.ts` is the critical one)
  - `api/` - Dual-mode IPC/HTTP adapter layer (see below)
  - `pages/` - Page components
  - `i18n/` - Internationalization (7 locales)

- **`/src/shared/types/`** - Shared types (must NOT import Node.js or Electron modules)

- **`/src/preload/`** - Preload scripts exposing `window.halo`

- **`/src/worker/`** - File watcher (runs as separate child process)

- **`/packages/remote-agent-proxy/`** - Standalone Node.js server for remote Claude access

### Dual-Mode Renderer API

The renderer API layer (`src/renderer/api/`) works in two modes:
- **Electron**: Methods call `window.halo.xxx()` via IPC preload bridge
- **Remote web**: Methods call HTTP endpoints + WebSocket events

`transport.ts` auto-detects mode via `isElectron()` (checks `window.halo`). `api/index.ts` re-exports a unified `api` object.

### Adding IPC Endpoints

When adding a new IPC channel, update these 3 files:
1. `src/preload/index.ts` - Expose to `window.halo`
2. `src/renderer/api/transport.ts` - Add to `methodMap` in `onEvent()`
3. `src/renderer/api/index.ts` - Export as `api.xxx`

### Path Aliases

- `@/` → `src/renderer/` (renderer code)
- `@main/` → `src/main/` (tests)
- `@shared` → `src/shared/` (tests)

## Remote Space Thinking Process Flow

```
Remote Server (claude-manager.ts)     Local Client (send-message.ts)    Frontend (chat.store.ts)
─────────────────────────────────     ─────────────────────────────    ─────────────────────────
SDK stream_event                      RemoteWsClient events            Zustand store updates
├─ content_block_start (thinking) ──► 'thought' event ──────────────► handleAgentThought()
├─ content_block_delta             ──► 'thought:delta' event ────────► handleAgentThoughtDelta()
└─ content_block_stop              ──► (complete signal)            ──► thought.isStreaming = false
```

Debugging tips:
- Check `hasStreamEvent` flag in claude-manager.ts — controls fallback behavior
- Verify `sessionId` routing matches `conversationId` in send-message.ts
- `streamingBlocks` Map tracks active blocks by index for delta correlation
- Fallback path processes thinking blocks from assistant messages when no stream_event

## Code Conventions

### Commit Format

Use conventional commits: `feat:`, `fix:`, `docs:`, `style:`, `refactor:`, `test:`, `chore:`

### No Hardcoded Text in UI

All user-facing strings must use `t()`:

```tsx
// Good
<Button>{t('Save')}</Button>

// Bad — hardcoded text breaks i18n
<Button>Save</Button>
```

English is the source locale — `t('English text')` IS the English value. Run `npm run i18n` before committing new user-facing text.

### Tailwind Styling

Use CSS variable-based theme colors, never hardcoded values:

```tsx
// Good
<div className="bg-background text-foreground border-border">

// Bad
<div className="bg-white text-black border-gray-200">
```

### State Management

- **Zustand** for frontend state (see `chat.store.ts`)
- Per-session state: `Map<conversationId, SessionState>`
- Per-space state: `Map<spaceId, SpaceState>`

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

## Environment Variables

Copy `.env.example` to `.env.local`. Key variables:
- `HALO_TEST_API_KEY`, `HALO_TEST_API_URL`, `HALO_TEST_MODEL`, `HALO_TEST_PROVIDER` — E2E tests and i18n translation
- `GH_TOKEN` — Publishing releases
- Analytics vars (`HALO_GA_*`, `HALO_BAIDU_*`) — optional, disabled by default

## Configuration Files

- **`product.json`** - Build config and auth provider definitions
- **`~/.halo/`** - User data directory (conversations, settings, spaces)
- **`~/.halo-dev/`** - Dev mode data directory (used by `npm run dev`)
- **`.env.local`** - Local env overrides (gitignored)
- **`electron.vite.config.ts`** - Build configuration (main/preload/renderer entries)
