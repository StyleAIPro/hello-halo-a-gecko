# apps/manager -- Design Decisions

> Module owner: apps/manager
> Date: 2026-02-21
> Status: Implementation

---

## 1. Module Role

Pure data/persistence layer for App lifecycle management.
Consumed by `apps/runtime` (activation, status updates) and renderer (IPC for UI).
Does NOT execute Apps, trigger scheduling, or call Agents.

---

## 2. Key Design Decisions

### 2.1 State Machine for Status Transitions

**Decision**: Implement an explicit allow-list state machine rather than free-form status updates.

**Rationale**: Prevents illegal transitions (e.g., `error` -> `waiting_user` directly) which
would indicate bugs in `apps/runtime`. The state machine is small and well-defined:

```
          install()
             |
             v
         [active] <--------- resume()
           |   |                ^
   pause() |   | updateStatus() |
           v   v                |
       [paused] [error] --------+--- (via resume after fixing)
           |       |
           |       v
           |  [needs_login] ----+--- (via resume after re-login)
           |       |
           +-------+
                   |
                   v
           [waiting_user] ------+--- (via resolveEscalation -> active)
```

Valid transitions:
- `active` -> `paused`, `error`, `needs_login`, `waiting_user`
- `paused` -> `active`
- `error` -> `active`, `paused`
- `needs_login` -> `active`, `paused`
- `waiting_user` -> `active`, `paused`, `error`

Any other transition throws an `InvalidStatusTransitionError`.

### 2.2 pendingEscalationId -- Decoupled from runtime tables

**Decision**: Store `pendingEscalationId` as an opaque `string | null` rather than a FOREIGN KEY
to `activity_entries.id`.

**Rationale**: The architecture doc suggests this field points to `activity_entries.id`
(an `apps/runtime` table). Having a cross-module FK creates a tight coupling and circular
dependency between manager and runtime schemas. Instead:
- Manager stores it as a plain TEXT column with no FK constraint.
- Runtime is responsible for keeping it semantically valid.
- On uninstall, runtime cleans up its own tables (CASCADE on `app_id`).

### 2.3 Uninstall: Default Preserve, Optional Purge

**Decision**: `uninstall(appId, options?)` with `options.purge?: boolean` (default `false`).

**Rationale**: The architecture doc says "default preserve work directory". However, users
may want a clean uninstall. Adding `purge` as an opt-in flag satisfies both cases without
breaking the default contract. Runtime should call `deactivate(appId)` before uninstall.

### 2.4 userConfig Validation

**Decision**: Manager does NOT validate `userConfig` against `config_schema`.

**Rationale**:
- The caller (IPC layer or runtime) is responsible for validation before calling `updateConfig`.
- Manager is a data layer -- it persists what it is told.
- Validation logic belongs in the IPC handler or a shared utility, not in the persistence layer.
- This avoids coupling manager to the Zod schema details of `apps/spec`.

### 2.5 Space Isolation

**Decision**: `(spec_id, space_id)` together uniquely identify an installed App instance.
Different spaces can install the same spec independently with completely isolated state.

**Implementation**: The `id` (primary key) is a UUID generated at install time. The
`(spec_id, space_id)` pair has a UNIQUE constraint so you cannot install the same spec
twice in the same space. Different spaces produce different UUIDs, different rows, different
work directories.

### 2.6 Event Notification: Callback Array Pattern

**Decision**: Use a simple callback array pattern (not EventEmitter) for `onAppStatusChange`.

**Rationale**: Consistent with the project's existing pattern seen in:
- `platform/background` -- `onStatusChange` uses a handler array with unsubscribe function
- This is simpler and more explicit than Node.js EventEmitter for single-event patterns.

### 2.7 Migration Namespace

**Decision**: Use `'app_manager'` as the migration namespace.

**Rationale**: Consistent with the test example in `database-manager.test.ts` which already
uses `'app_manager'` as a namespace. Follows the underscore convention used by other modules.

### 2.8 App Work Directory Structure

```
{space.path}/apps/{appId}/          -- App root work directory
{space.path}/apps/{appId}/memory/   -- App memory directory
{space.path}/apps/{appId}/memory.md -- App memory file (created by memory module, not us)
```

`getAppWorkDir(appId)` returns the root. It ensures the directory exists (auto-creates).

### 2.9 updateStatus: Separate from pause/resume

**Decision**: Expose `updateStatus(appId, status, extra?)` as a general status setter
(used by runtime for `error`, `needs_login`, `waiting_user`), while `pause()` and `resume()`
are convenience wrappers that enforce specific transitions.

This keeps the interface clean:
- `pause(appId)` -- user action, only from `active`
- `resume(appId)` -- user action, from `paused`/`error`/`needs_login`
- `updateStatus(appId, status, extra)` -- runtime action, for `error`/`needs_login`/`waiting_user`

### 2.10 updateLastRun

**Decision**: Add `updateLastRun(appId, outcome, errorMessage?)` as a dedicated method
for runtime to record execution results. This is cleaner than overloading `updateStatus`.

---

## 3. SQLite Schema

```sql
CREATE TABLE installed_apps (
  id TEXT PRIMARY KEY,                    -- UUID
  spec_id TEXT NOT NULL,                  -- App spec identifier
  space_id TEXT NOT NULL,                 -- Space this app belongs to
  spec_json TEXT NOT NULL,                -- Full AppSpec as JSON
  status TEXT NOT NULL DEFAULT 'active',  -- active|paused|error|needs_login|waiting_user
  pending_escalation_id TEXT,             -- Opaque ID (no FK, managed by runtime)
  user_config_json TEXT DEFAULT '{}',     -- User config values
  user_overrides_json TEXT DEFAULT '{}',  -- User overrides (frequency etc.)
  permissions_json TEXT DEFAULT '{"granted":[],"denied":[]}',
  installed_at INTEGER NOT NULL,
  last_run_at INTEGER,
  last_run_outcome TEXT,                  -- 'useful'|'noop'|'error'|'skipped'|null
  error_message TEXT,
  UNIQUE(spec_id, space_id)
);
CREATE INDEX idx_installed_apps_space ON installed_apps(space_id);
CREATE INDEX idx_installed_apps_status ON installed_apps(status);
```

---

## 4. File Structure

```
src/main/apps/manager/
  index.ts       -- initAppManager(), shutdownAppManager(), re-exports
  types.ts       -- InstalledApp, AppManagerService, AppStatus, etc.
  migrations.ts  -- Migration[] for the installed_apps table
  store.ts       -- SQLite CRUD operations (AppManagerStore class)
  service.ts     -- AppManagerService implementation
  errors.ts      -- Custom error types
```

---

## 5. Interface Contract (what runtime depends on)

```typescript
interface AppManagerService {
  install(spaceId: string, spec: AppSpec, userConfig?: Record<string, unknown>): Promise<string>
  uninstall(appId: string, options?: { purge?: boolean }): Promise<void>
  pause(appId: string): void
  resume(appId: string): void
  updateConfig(appId: string, config: Record<string, unknown>): void
  updateFrequency(appId: string, subscriptionId: string, frequency: string): void
  updateStatus(appId: string, status: AppStatus, extra?: { errorMessage?: string; pendingEscalationId?: string }): void
  updateLastRun(appId: string, outcome: RunOutcome, errorMessage?: string): void
  getApp(appId: string): InstalledApp | null
  listApps(filter?: AppListFilter): InstalledApp[]
  getAppWorkDir(appId: string): string
  grantPermission(appId: string, permission: string): void
  revokePermission(appId: string, permission: string): void
  onAppStatusChange(handler: StatusChangeHandler): Unsubscribe
}
```
