# Halo Architecture (Minimal Entry)

> Keep this file compact. It defines boundaries, lifecycle order, and integration contracts.

## 1) Layer Model

```
User Interaction Layer
  - Renderer pages/components/stores
  - Desktop UI and remote web UI

Apps Layer (src/main/apps)
  - spec        : App YAML parse + validate
  - manager     : install/config/status persistence
  - runtime     : activation/execution/activity/escalation
  - store-index : planned

Platform Layer (src/main/platform)
  - store       : SQLite manager + migrations foundation
  - scheduler   : persistent job engine
  - event-bus   : event routing/filter/dedup
  - memory      : scoped memory tools + files
  - background  : keep-alive + tray + daemon browser

Services Layer (src/main/services)
  - existing domain services (agent, ai-browser, space, conversation, remote, etc.)
```

## 2) Dependency Direction (Must Hold)

- Dependencies flow downward only: `UI -> apps -> platform -> services/utilities`.
- `apps/runtime` is the orchestration boundary; do not push runtime orchestration into transport layers.
- `platform/*` modules stay generic infrastructure (not renderer-specific, not UI-coupled).
- Shared renderer-safe types belong in `src/shared/apps/*`.

## 3) Engineering Baseline (Non-Negotiable)

- **Modularity and boundary clarity are mandatory.**
  - Keep responsibilities isolated by module; avoid cross-layer leakage.
  - Prefer extending existing module contracts over ad-hoc shortcuts.
- **High quality and maintainability are first priority.**
  - Production-ready behavior, explicit error handling, and test coverage are expected.
- **Performance must be preserved or improved.**
  - No startup/runtime/memory regressions as a trade-off for feature speed.
  - Essential startup path remains minimal; heavy work stays in extended/lazy flows.

## 4) Startup / Shutdown Lifecycle

### 4.1 Startup phases

1. `app.whenReady()` creates window and initializes core app directories.
2. `initializeEssentialServices()` runs synchronously for first-screen features.
3. After `ready-to-show`, `initializeExtendedServices()` registers deferred handlers/services.
4. `initializeExtendedServices()` triggers `initPlatformAndApps()` asynchronously:
   - Phase 0: `initStore()`
   - Phase 1 (parallel): `initScheduler({ db })`, `initEventBus()`, `initMemory()`
   - Source wiring: register `FileWatcherSource` to event-bus
   - Phase 2: `initAppManager({ db })`
   - Phase 3: `initAppRuntime({ db, appManager, scheduler, eventBus, memory, background })`
   - Start loops only after wiring: `scheduler.start()`, `eventBus.start()`

### 4.2 Shutdown behavior

- `before-quit` calls `cleanupExtendedServices()` via bootstrap shutdown flow.
- `window-all-closed` keeps process alive when `background.shouldKeepAlive()` is true.
- Cleanup order includes runtime/manager, platform modules, background, and cache cleanup.

## 5) Integration Surfaces

- **IPC handlers**: `src/main/ipc/*.ts` (Apps entry: `src/main/ipc/app.ts`)
- **HTTP routes**: `src/main/http/routes/index.ts`
- **WebSocket broadcast**: `src/main/http/websocket.ts`
- **Preload bridge**: `src/preload/index.ts` (`window.halo` contract)
- **Renderer unified API**: `src/renderer/api/index.ts`
- **Renderer transport mode switch**: `src/renderer/api/transport.ts`

Desktop mode: renderer -> preload -> IPC -> main.
Remote mode: renderer -> HTTP/WS -> main.

## 6) Current Contract Gaps (Known)

- `POST /api/apps/install` in HTTP currently reads `config`, while IPC/renderer install path uses `userConfig`.
- Renderer remote fallbacks exist for these App endpoints, but HTTP routes are not implemented yet:
  - `/api/apps/:appId/config`
  - `/api/apps/:appId/frequency`
  - `/api/apps/:appId/chat/send`
  - `/api/apps/:appId/chat/stop`
  - `/api/apps/:appId/chat/status`
  - `/api/apps/:appId/chat/messages`
  - `/api/apps/:appId/chat/session-state`

Treat these as explicit alignment tasks when extending remote App capabilities.

## 7) Deep-Dive Module Docs

When touching a module, read its design doc first:
- `src/main/apps/spec/DESIGN.md`
- `src/main/apps/manager/DESIGN.md`
- `src/main/apps/runtime/DESIGN.md`
- `src/main/platform/store/DESIGN.md`
- `src/main/platform/scheduler/DESIGN.md`
- `src/main/platform/event-bus/DESIGN.md`
- `src/main/platform/memory/DESIGN.md`
- `src/main/platform/background/DESIGN.md`
