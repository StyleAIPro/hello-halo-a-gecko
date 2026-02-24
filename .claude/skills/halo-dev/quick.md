# quick.md

> Fast execution rules and routing for AI/human developers.
> Read after `CONTEXT.md` and `ARCHITECTURE.md`.

## 1) Hard Rules (Must Follow)

1. **Modularity, quality, and maintainability are first priority.**
   - Keep responsibilities isolated by module and layer.
   - Do not use quick fixes that create long-term architecture debt.
   - Every change must preserve or improve performance (startup, runtime latency, memory).
   - If there is a trade-off conflict (quick fix vs architecture quality), request explicit user approval before proceeding.

2. **No hardcoded user text in renderer.** Use `t('English text')`.
   - Do not manually maintain locale JSON for normal changes.
   - Run `npm run i18n` before final handoff.

3. **Tailwind first.**
   - Prefer utility classes.
   - Only use CSS files for exceptions (animations, pseudo-elements, third-party overrides).

4. **No hardcoded colors.**
   - Use theme tokens/classes (`bg-background`, `text-foreground`, `hsl(var(--...))`).

5. **Respect layering and module boundaries.**
   - Do not move business logic into IPC/HTTP/preload/renderer transport.
   - Keep orchestration in `apps/runtime` and infrastructure in `platform/*`.

6. **Transport contract changes must be synchronized.**
   - IPC request APIs: update main handler + preload + renderer API.
   - Event channels: update sender + preload listener + renderer transport/API.
   - Remote-capable features: also align HTTP routes and WebSocket behavior.

7. **Essential startup is protected.**
   - New feature default = extended phase.
   - Only first-screen-critical handlers belong in essential init.

8. **Schema/persistence changes require migrations.**
   - Add versioned migration in the owning module (`apps/*` or `platform/*`).

9. **Tests are required for Apps/Platform changes.**
   - Add/update tests under `tests/unit/apps/*` or `tests/unit/platform/*`.

10. **Never expose secrets.**
   - No API keys/tokens in source, docs, logs, or fixtures.

## 2) Fast Task Router

| If you need to... | Start here | Usually also touch |
|---|---|---|
| Add/change App spec fields | `src/main/apps/spec/schema.ts` | `src/main/apps/spec/parse.ts`, `src/main/apps/spec/validate.ts`, `src/shared/apps/spec-types.ts`, `tests/unit/apps/spec/*` |
| Change install/config/status lifecycle | `src/main/apps/manager/service.ts` | `src/main/apps/manager/store.ts`, `src/main/apps/manager/migrations.ts`, `tests/unit/apps/manager/manager.test.ts` |
| Change execution/trigger/escalation/activity | `src/main/apps/runtime/service.ts` | `src/main/apps/runtime/execute.ts`, `src/main/apps/runtime/report-tool.ts`, `src/main/apps/runtime/store.ts`, `tests/unit/apps/runtime/runtime.test.ts` |
| Change scheduling behavior | `src/main/platform/scheduler/index.ts` | `src/main/platform/scheduler/schedule.ts`, `src/main/platform/scheduler/store.ts`, `tests/unit/platform/scheduler/scheduler.test.ts` |
| Add event source/filter behavior | `src/main/platform/event-bus/*` | `src/main/bootstrap/extended.ts`, `tests/unit/platform/event-bus/event-bus.test.ts` |
| Change memory behavior/tools | `src/main/platform/memory/index.ts` | `src/main/platform/memory/tools.ts`, `src/main/platform/memory/prompt.ts`, `tests/unit/platform/memory/memory.test.ts` |
| Add App IPC APIs | `src/main/ipc/app.ts` | `src/preload/index.ts`, `src/renderer/api/index.ts` |
| Add App HTTP APIs (remote) | `src/main/http/routes/index.ts` | `src/renderer/api/index.ts`, auth/WS flow as needed |
| Add App real-time events | emitter in `src/main/apps/runtime/*` | `src/preload/index.ts`, `src/renderer/api/transport.ts`, `src/renderer/api/index.ts` |
| Build/update Apps UI | `src/renderer/pages/AppsPage.tsx` | `src/renderer/components/apps/*`, `src/renderer/stores/apps*.ts`, i18n text via `t()` |

## 3) Common Checklists

### A) Add a new IPC request API

- Add `ipcMain.handle(...)` in main (domain IPC module).
- Expose typed method in `src/preload/index.ts` (interface + implementation).
- Add unified call in `src/renderer/api/index.ts`.
- If remote must support it, add matching HTTP route and non-Electron fallback.
- Add/adjust unit tests for touched domain logic.

### B) Add a new real-time event channel

- Emit event from main domain (`sendToRenderer(...)` and/or `broadcastToAll(...)`).
- Add preload listener (`createEventListener('channel', ...)`).
- Add channel mapping in `src/renderer/api/transport.ts` `methodMap`.
- Add API helper in `src/renderer/api/index.ts`.
- Verify desktop and remote clients both receive the event when required.

### C) Add a new persistent field (App/Platform)

- Add migration with new version in owning module.
- Update store read/write mapping and service-level types.
- Keep backward compatibility defaults explicit.
- Add migration-focused unit tests.

### D) Add a new automation trigger path

- Extend spec schema/type for trigger config.
- Map trigger to scheduler or event-bus subscription in runtime activation.
- Ensure run context is included for prompt building.
- Emit activity entries and status updates for observability.
- Add tests for activate/deactivate and execution paths.

## 4) Known Gaps You Must Account For

1. HTTP App install reads `config`, but IPC/renderer install payload uses `userConfig`.
2. Renderer remote fallbacks exist for App config/frequency/chat endpoints, but matching HTTP routes are not implemented yet.
3. App activity HTTP route currently uses `limit` and `before`; renderer option names include `since/offset/type` (not all are consumed by backend).

## 5) Minimum Validation Before Handoff

- Run focused unit tests for touched module(s), for example:
  - `npm run test:unit -- tests/unit/apps/manager/manager.test.ts`
  - `npm run test:unit -- tests/unit/apps/runtime/runtime.test.ts`
- Run `npm run i18n` when renderer text changed.
- Confirm desktop path (IPC) and remote path (HTTP/WS) expectations for changed APIs.
