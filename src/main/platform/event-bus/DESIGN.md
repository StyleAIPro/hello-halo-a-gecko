# platform/event-bus -- Design Document

> Date: 2026-02-21
> Status: V1 Implementation

## Module Position

Event-bus is the unified event routing hub in the platform layer.
`apps/runtime` subscribes via `eventBus.on(filter, handler)` and receives
HaloEvent objects when any registered source (file-watcher, webhook, scheduler)
produces events. This module does NOT process business logic and has zero
knowledge of AI/LLM.

## Key Design Decisions

### 1. FilterRule field path resolution -- hand-rolled, no library

The architecture doc specifies `field: "payload.extension"` style dot-path
access. We implement a minimal path resolver supporting:

- Dot-separated property access: `payload.price`
- Array index access: `payload.items[0].name`

A hand-rolled implementation is chosen over lodash `_.get` because:
- Zero extra dependency
- Trivially small (~30 lines) for the supported subset
- Performance: no dynamic require, no feature overhead
- This subset is enough for event payload filtering in V1

### 2. Deduplication -- in-memory TTL cache, not SQLite

After evaluating the options:

- **In-memory TTL Map** (chosen): Simple, fast, zero I/O overhead
- SQLite persistence: Only useful if dedup state must survive process restart

For event dedup, surviving restarts is not critical. If the app restarts, the
worst case is a single duplicate event fires -- which is harmless because
consumers (apps/runtime) are idempotent by design. In-memory TTL + maxSize is
simple, fast, and reliable for this workload.

Default TTL: **60 seconds**. This covers the common case of file-watcher
burst events and webhook retries. The TTL is configurable per event type
via the dedup mechanism (events set their own `dedupKey`).

maxSize: **10,000 entries** to bound memory usage (~1MB worst case).

### 3. Event type glob matching

The architecture doc specifies `types?: string[]` with glob support like
`"file.*"`. I implement simple prefix-glob matching:

- `"file.changed"` -- exact match
- `"file.*"` -- matches any type starting with `"file."`
- `"*"` -- matches everything

This is NOT full glob (no `**`, `?`, `[]`). Full glob would be over-
engineering for event type strings that are simple dotted identifiers.

### 4. Error isolation in handler dispatch

When multiple subscribers match the same event, each handler is called
independently. If one handler throws, it is caught and logged, and the
remaining handlers still execute. This prevents one buggy subscriber from
blocking all others.

Dispatch is sequential (not concurrent) to maintain deterministic ordering.
Async handlers are awaited before moving to the next subscriber.

### 5. WebhookSource integration with existing Express

The architecture doc and existing `server.ts` show routes are registered via
`registerApiRoutes(app, mainWindow)`. The WebhookSource needs to mount
`POST /hooks/*` routes.

**Decision**: WebhookSource does NOT import or depend on `server.ts`. Instead,
it accepts an Express Router or Application instance via its constructor/start
method. The bootstrap layer passes the Express app when creating the source.

The `/hooks/*` endpoint is public (no auth middleware) because external
services (GitHub, payment providers) need to POST to it without Halo's
auth token. A separate HMAC/token verification can be layered per-hook
by the consuming automation App's configuration.

### 6. FileWatcherSource -- hook into watcher-host

The file-watcher runs in a child_process.fork worker. The main process
receives events via `watcher-host.service.ts` which exposes
`setFsEventsHandler(callback)`.

**Decision**: FileWatcherSource calls `setFsEventsHandler` on start and
sets it to null on stop. Each `ProcessedFsEvent` batch is converted to
individual HaloEvent objects with:

- `type`: `"file.changed"`, `"file.created"`, `"file.deleted"`
- `source`: `"file-watcher"`
- `payload.spaceId`, `payload.filePath`, `payload.relativePath`,
  `payload.changeType`, `payload.extension`

### 7. ScheduleBridgeSource -- adapter pattern

The scheduler module does not exist yet (will be built in parallel). The
ScheduleBridgeSource accepts a scheduler-like object conforming to a minimal
interface: `onJobDue(handler)`. When the scheduler fires, the bridge
converts the job info into a HaloEvent with:

- `type`: `"schedule.due"`
- `source`: `"scheduler"`
- `payload.jobId`, `payload.jobName`, `payload.metadata`

Since scheduler is not yet implemented, the bridge source accepts a
generic EventEmitter-like interface and will be wired when scheduler lands.

### 8. Listener lifecycle management

Each EventSourceAdapter has `start(emit)` and `stop()`. On `stop()`:

- FileWatcherSource: sets the watcher-host callback to null
- WebhookSource: removes the Express route handler
- ScheduleBridgeSource: unregisters the jobDue listener

The EventBus's `stop()` method calls `stop()` on all registered sources,
then clears all subscriptions. This ensures no leaked listeners.

### 9. V2 placeholders

`WebPageSource` and `RSSSource` are exported as type-only interfaces.
No implementation in V1.

## File Structure

```
src/main/platform/event-bus/
  index.ts           -- initEventBus(), shutdownEventBus(), re-exports
  types.ts           -- HaloEvent, EventFilter, FilterRule, EventBusService, etc.
  event-bus.ts       -- Core EventBus implementation
  filter.ts          -- FilterRule matching logic
  dedup.ts           -- TTL dedup cache
  sources/
    file-watcher.source.ts
    webhook.source.ts
    schedule-bridge.source.ts
```

## Dependencies

- `platform/store` (optional, not used in V1 -- dedup is in-memory)
- `services/watcher-host.service` (FileWatcherSource reads events)
- Express `Router` type (WebhookSource mounts routes)
- No other internal module dependencies
