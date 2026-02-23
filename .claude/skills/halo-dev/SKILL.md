---
name: Halo Development Context v2
description: Minimal onboarding skill for Halo development. Mandatory entry: CONTEXT.md, ARCHITECTURE.md, and quick.md. Use quick.md for hard rules, task routing, and fast implementation checklists.
---

# Halo Development Context v2

## Mandatory Entry (Read in Order)

1. `CONTEXT.md` - what the product does and current implementation status.
2. `ARCHITECTURE.md` - layer boundaries, init sequence, integration surfaces.
3. `quick.md` - hard development rules and task-to-file fast routing.

Do not start implementation before reading these three files.

## Why This Is Minimal

- `SKILL.md`: workflow entry only
- `CONTEXT.md`: product and scope
- `ARCHITECTURE.md`: structure and dependency contracts
- `quick.md`: rules + practical execution

This avoids large documentation trees while keeping execution guidance explicit.

## Fast Navigation Policy

After the mandatory entry docs:

- Jump directly to touched module `DESIGN.md`:
  - `src/main/apps/*/DESIGN.md`
  - `src/main/platform/*/DESIGN.md`
- For transport-level changes, inspect:
  - `src/main/ipc/`
  - `src/main/http/routes/index.ts`
  - `src/preload/index.ts`
  - `src/renderer/api/index.ts`

## Source of Truth Priority

When docs and code differ:

1. Actual code in `src/**`
2. Module design docs (`src/main/apps/*/DESIGN.md`, `src/main/platform/*/DESIGN.md`)
3. `quick.md`, `ARCHITECTURE.md`, `CONTEXT.md`
4. Historical notes in `CHANGELOG.md`

## Keeping These Documents Updated

After completing a development task, evaluate whether these documents need updating. Apply the following rules:

**Update when** the change significantly affects how a developer understands the codebase:
- New module or service added to the architecture
- New IPC channel introduced
- Major refactoring that changes code organization
- New architectural pattern or convention established
- Core data type added or significantly changed

**Do not update** for changes that don't affect architectural understanding:
- Bug fixes
- Minor features within existing modules
- Styling or UI tweaks
- Performance optimizations that don't change structure
- Dependency updates
- Code cleanup or formatting

The threshold is: **would a new AI developer make wrong assumptions without this information?** If yes, update. If no, skip.