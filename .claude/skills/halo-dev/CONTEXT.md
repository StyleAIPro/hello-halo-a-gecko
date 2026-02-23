# Halo Context (Minimal Entry)

> Audience: AI and human engineers working in this repository.
> Goal: quickly understand what Halo does now and what is already implemented.

## 1) Product Definition

Halo is a local-first Electron AI product moving from chat-first UX to an AI workstation model.

Current product shape:
- conversational AI + tool calling
- Space-based work context (temporary and dedicated spaces)
- Artifact/file workflows and content viewing
- AI Browser automation capability
- optional remote access via HTTP + WebSocket
- installable Apps foundation (automation-focused)

## 2) Current Delivery State (as of February 22, 2026)

### 2.1 AI Workstation backend foundation is implemented (Phase 0-3)

- **apps layer** (`src/main/apps/`)
  - `spec` implemented
  - `manager` implemented
  - `runtime` implemented
  - `store-index` planned (not implemented)
- **platform layer** (`src/main/platform/`)
  - `store`, `scheduler`, `event-bus`, `memory`, `background` implemented
- **existing services integration**
  - bootstrap, session-manager, send-message, IPC/HTTP/WebSocket integration paths updated

### 2.2 What is still pending

- **Phase 4 (E2E validation)** is still pending.
- **Dedicated Apps product surfaces in the user interaction layer** are not fully finished.

## 3) What This Means for New Development

- You should treat `apps/` + `platform/` as the default foundation for new workstation features.
- `services/` remains critical infrastructure, but new automation behavior should not bypass `apps/runtime` and `platform/*` contracts.
- Main-process state is authoritative for execution and activity; renderer should consume APIs/events rather than re-implement persistence.
- Keep desktop and remote behavior aligned when feature scope includes remote usage.

## 4) Non-Negotiable Product Constraints

- **Local-first remains the default architecture** (no required cloud backend for core behavior).
- **Security hygiene is mandatory**: never put secrets/tokens in code, logs, or docs.
- **Automation model**: trigger-driven execution (schedule/event/manual), not always-on token consumption.

## 5) Mandatory Next Read

1. `ARCHITECTURE.md` (layer boundaries, init order, integration contracts)
2. `quick.md` (hard rules and task-to-file routing)

Then jump directly to module design docs when implementing:
- `src/main/apps/*/DESIGN.md`
- `src/main/platform/*/DESIGN.md`
