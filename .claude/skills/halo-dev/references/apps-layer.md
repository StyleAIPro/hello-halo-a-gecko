# Apps Layer Reference

Scope: `src/main/apps/**` and shared app-facing types in `src/shared/apps/**`.

## 1) Layer Role

The Apps layer is the product-facing orchestration layer above platform infrastructure.

It defines:

- what an App is (`spec`)
- how an App is installed and managed (`manager`)
- how automation Apps are activated and executed (`runtime`)

## 2) Module Overview

## 2.1 `apps/spec`

Purpose:

- parse YAML app specs
- normalize aliases and compatibility fields
- validate schema via Zod-derived contracts

Key files:

- `src/main/apps/spec/index.ts`
- `src/main/apps/spec/schema.ts`
- `src/main/apps/spec/parse.ts`
- `src/main/apps/spec/validate.ts`
- `src/main/apps/spec/DESIGN.md`

Outputs consumed by other modules:

- `AppSpec` and related schema-derived types
- parse/validate API for install-time checks

Renderer-safe mirror:

- `src/shared/apps/spec-types.ts`

## 2.2 `apps/manager`

Purpose:

- install and uninstall apps
- persist app records and state in SQLite
- enforce app status transitions (`active`, `paused`, `error`, `needs_login`, `waiting_user`)
- manage user config, frequency overrides, and permissions

Key files:

- `src/main/apps/manager/index.ts`
- `src/main/apps/manager/service.ts`
- `src/main/apps/manager/store.ts`
- `src/main/apps/manager/migrations.ts`
- `src/main/apps/manager/types.ts`
- `src/main/apps/manager/DESIGN.md`

Persistence namespace:

- `app_manager`

Main table:

- `installed_apps`

## 2.3 `apps/runtime`

Purpose:

- activate/deactivate automation apps
- bridge app subscriptions to scheduler jobs and event-bus subscriptions
- execute runs via independent SDK sessions
- write activity entries and escalation events
- provide app runtime state and run history access

Key files:

- `src/main/apps/runtime/index.ts`
- `src/main/apps/runtime/service.ts`
- `src/main/apps/runtime/execute.ts`
- `src/main/apps/runtime/report-tool.ts`
- `src/main/apps/runtime/store.ts`
- `src/main/apps/runtime/migrations.ts`
- `src/main/apps/runtime/types.ts`
- `src/main/apps/runtime/DESIGN.md`

Persistence namespace:

- `app_runtime`

Main tables:

- `automation_runs`
- `activity_entries`

Execution details:

- run creates its own session (`execute.ts`)
- memory tools and `report_to_user` tool are injected per run
- escalation ends current run and resumes via follow-up run

## 2.4 `apps/store-index` (planned)

Status:

- planned in architecture direction docs
- not present yet under `src/main/apps`

## 3) Shared App Types

Shared renderer-safe contracts:

- `src/shared/apps/spec-types.ts`
- `src/shared/apps/app-types.ts`

Use these for renderer code; do not import `src/main/apps/**` directly into renderer code.

## 4) Integration Touchpoints

Transport and UI integration entry points:

- IPC handlers: `src/main/ipc/app.ts`
- HTTP routes: `src/main/http/routes/index.ts` (`/api/apps/*`)
- preload bridge: `src/preload/index.ts` app methods and app events
- renderer API adapter: `src/renderer/api/index.ts`
- renderer app state stores: `src/renderer/stores/apps.store.ts`, `src/renderer/stores/apps-page.store.ts`

## 5) Known Practical Notes

- Runtime and manager are initialized asynchronously in extended bootstrap.
- App APIs can return not-ready errors immediately after startup until init completes.
- Remote HTTP app install currently accepts `config` in route handler while IPC path uses `userConfig`.
- HTTP endpoints for app config/frequency updates are not yet implemented even though renderer API includes remote fallback calls.
