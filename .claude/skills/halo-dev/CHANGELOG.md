# Halo Architecture Changelog (Indexed v2)

> Focus: architectural and module-level milestones relevant to engineering decisions.

## 2026-02-21 - AI Workstation Foundation (Phase 0-3)

Major milestone delivering foundational Apps/Platform layers:

- Added `src/main/apps/` modules:
  - `spec` (YAML schema parsing/validation)
  - `manager` (installation/lifecycle/state persistence)
  - `runtime` (execution orchestration, activity thread, escalation handling)
- Added `src/main/platform/` modules:
  - `store` (SQLite manager + namespaced migrations)
  - `scheduler` (persistent scheduling + backoff)
  - `event-bus` (adapters, filters, dedup)
  - `memory` (scoped memory tools and files)
  - `background` (keep-alive/tray/daemon browser)
- Added app integration surfaces:
  - IPC: `src/main/ipc/app.ts` with app lifecycle and runtime channels
  - HTTP: `/api/apps/*` routes in `src/main/http/routes/index.ts`
  - Renderer bridge: app methods in `src/preload/index.ts` and `src/renderer/api/index.ts`
- Updated bootstrap and lifecycle behavior:
  - extended bootstrap now initializes platform/apps asynchronously
  - `window-all-closed` now respects background keep-alive
- Added shared app types for renderer-safe usage:
  - `src/shared/apps/spec-types.ts`
  - `src/shared/apps/app-types.ts`
- Added unit coverage for new module layers:
  - `tests/unit/apps/*`
  - `tests/unit/platform/*`

## Earlier major milestones (pre-foundation)

- Multi-provider AI sources and auth model
- Content Canvas file preview architecture
- AI Browser tool stack and stealth subsystem
- Remote access HTTP + WebSocket architecture
- Space path/data model refinements
- Conversation thoughts separation and backend SSOT improvements
- Health and performance infrastructure

## Notes

For detailed per-module design rationale, use:

- `src/main/apps/*/DESIGN.md`
- `src/main/platform/*/DESIGN.md`
