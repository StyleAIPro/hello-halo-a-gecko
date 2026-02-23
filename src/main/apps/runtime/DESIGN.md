# apps/runtime -- Design Decisions

> Module owner: apps/runtime
> Date: 2026-02-21
> Status: Implementation

---

## 1. Module Role

Core glue layer that connects all platform modules and the existing Agent service
to provide App execution capabilities. This is the **only module** that crosses
layer boundaries (apps/ → platform/ → services/).

Responsibilities:
- Translate App subscriptions into scheduler jobs + event-bus subscriptions
- Execute App runs: create Agent session → inject prompt/tools → process results
- Manage the Activity Layer (automation_runs + activity_entries)
- Provide `report_to_user` MCP tool for AI-to-user communication
- Handle escalation lifecycle (waiting_user → user responds → new run with context)
- Enforce concurrency limits (global maxConcurrentRuns)

Does NOT:
- Install/configure Apps (that's apps/manager)
- Implement scheduling algorithms (that's platform/scheduler)
- Filter events (that's platform/event-bus)
- Directly operate AI Browser DOM (AI does that via MCP tools + Task tool)

---

## 2. Key Design Decisions

### 2.1 Own SDK Sessions (No sendMessage Modification)

**Decision**: Runtime creates its own V2 sessions using `unstable_v2_createSession`
directly, rather than modifying the existing `sendMessage()` in `services/agent/`.

**Rationale**:
- `sendMessage()` is 946 lines of complex code tightly coupled to conversation UI
  (mainWindow IPC, thought accumulation, streaming display, conversation persistence).
- Runtime's execution needs are fundamentally different: no UI streaming, no
  conversation persistence, different MCP tool set, different error handling.
- Modifying sendMessage risks breaking the core conversation flow.
- Runtime imports helper functions (`getApiCredentials`, `resolveCredentialsForSdk`,
  `buildBaseSdkOptions`, `getHeadlessElectronPath`) from the agent service but
  manages its own session lifecycle independently.

**Trade-off**: Some code duplication in stream processing. Acceptable because the
runtime's stream processing is much simpler (no thought accumulation, no UI events).

### 2.2 Stateless Runs (No Cross-Run Session Persistence)

**Decision**: Each run creates a fresh V2 session. Sessions are closed after
the run completes. No session reuse across runs.

**Rationale**:
- Conversation sessions benefit from reuse (user expects continuity within a chat).
- Automation runs are independent executions. Each should start clean.
- Keeping sessions alive for 24h (escalation wait) wastes resources and is fragile.
- The memory system provides continuity: AI reads memory at start, writes at end.
- Escalation responses trigger a NEW run with the escalation context injected into
  the initial message, not a session resume. This is simpler and more robust.

### 2.3 Escalation as Run Boundary

**Decision**: When AI calls `report_to_user(type="escalation")`, the current run
records the escalation and ends. User response triggers a new run.

**Rationale**:
- Holding a Claude Code subprocess alive for hours is resource-wasteful and fragile.
- The AI can write important context to memory before escalating.
- The new run receives: escalation question + user response + memory context.
- This is simpler than session hibernation and more resilient to process crashes.
- V2 could introduce session persistence if needed, but V1 prioritizes robustness.

### 2.4 report_to_user as SDK MCP Server

**Decision**: `report_to_user` is implemented as an SDK MCP server using
`tool()` + `createSdkMcpServer()`, same pattern as `platform/memory/tools.ts`
and `services/ai-browser/sdk-mcp-server.ts`.

**Rationale**:
- Consistent with existing Halo patterns for injecting custom tools.
- SDK MCP servers are first-class citizens in V2 sessions.
- The tool handler has direct access to the Activity store (closure capture).

### 2.5 Activity Layer in SQLite

**Decision**: `automation_runs` and `activity_entries` tables in the app-level
SQLite database, with FOREIGN KEY to `installed_apps` with CASCADE DELETE.

**Rationale**:
- Structured data enables querying (by app, by type, by time range).
- FK CASCADE ensures cleanup when an App is uninstalled.
- Matches the architecture doc's schema design exactly.

### 2.6 Concurrency: Simple Counting Semaphore

**Decision**: Module-level counting semaphore with configurable `maxConcurrent`.
Default: 2 concurrent runs.

**Rationale**:
- Each run spawns a Claude Code subprocess (significant resource usage).
- Simple acquire/release pattern. Callers that can't acquire are queued.
- No priority system in V1 (FIFO queue).
- The AI Browser lane (maxConcurrentAIBrowserRuns) is deferred to V2.

### 2.7 Activation Lifecycle

**Decision**: `activate(appId)` is idempotent. It reads the App's subscriptions,
creates scheduler jobs (for schedule-type) and event-bus subscriptions (for other
types), and registers a keep-alive reason.

`deactivate(appId)` removes all scheduler jobs and event-bus subscriptions for
the App and unregisters the keep-alive reason.

**State tracking**: An internal `Map<appId, ActivationState>` tracks the
scheduler job IDs, event-bus unsubscribe functions, and keep-alive disposer for
each activated App.

### 2.8 Trigger Context in Initial Message

**Decision**: The initial message sent to the Agent includes structured trigger
context (what triggered this run, when, user config values).

**Rationale**:
- The AI needs to know WHY it was triggered to decide what to do.
- For schedule triggers: "Scheduled run at 2026-02-21 14:30 (every 30m)"
- For event triggers: "Triggered by file change: /path/to/file"
- For escalation follow-ups: includes the original question + user's response
- User config values are included so the AI can use them (e.g., product URLs).

### 2.9 No IPC/HTTP Routes in This Module

**Decision**: Runtime module exposes only a TypeScript service interface.
IPC handlers and HTTP routes are a separate concern (Phase 3 task ⑫).

**Rationale**:
- Keeps the module focused on business logic.
- IPC/HTTP layer is thin routing that delegates to the service.
- Can be added independently without modifying runtime internals.

### 2.10 Stream Processing: Collect Final Result Only

**Decision**: Runtime's stream processing collects the final text result and
token usage but does NOT stream individual events to the renderer.

**Rationale**:
- Activity Thread shows summaries, not real-time AI thinking.
- The AI communicates results via `report_to_user` tool calls.
- Full execution details are available via "View Process" (session logs).
- This dramatically simplifies stream processing vs. conversation mode.

### 2.11 Auto-Continue on Missing report_to_user

**Decision**: `report_to_user` is the definitive completion signal for
automation runs. If the LLM ends a turn without calling it (and no SDK error
occurred), the runtime automatically sends a follow-up message prompting the
AI to continue — up to `MAX_AUTO_CONTINUES` (3) times.

**Rationale**:
- LLMs occasionally return `end_turn` prematurely due to model quirks, context
  issues, or non-deterministic behavior. In interactive sessions a human types
  "continue"; automation runs have no human operator.
- `report_to_user` is already mandated by the system prompt ("ALWAYS call this
  at the end of every execution") and powers the Activity Thread. Using it as
  the completion gate adds zero new concepts.
- The graduated messaging (normal prompt → final warning) gives the model
  clear signals. If all attempts fail, the run is marked as error and counts
  toward the consecutive-error auto-pause threshold.
- `MAX_TURNS` raised from 30 → 100 to give autonomous runs more room before
  per-cycle turn limits are hit.

**Trade-off**: Up to 3 extra LLM round-trips in pathological cases. Acceptable
because the alternative is a silently incomplete run with no user-visible output.

---

## 3. SQLite Schema

```sql
-- Each App execution run
CREATE TABLE automation_runs (
  run_id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  trigger_type TEXT NOT NULL,
  trigger_data_json TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  duration_ms INTEGER,
  tokens_used INTEGER,
  error_message TEXT,
  FOREIGN KEY (app_id) REFERENCES installed_apps(id) ON DELETE CASCADE
);
CREATE INDEX idx_runs_app ON automation_runs(app_id, started_at DESC);

-- Activity Thread entries (user-facing)
CREATE TABLE activity_entries (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  type TEXT NOT NULL,
  ts INTEGER NOT NULL,
  session_key TEXT,
  content_json TEXT NOT NULL,
  user_response_json TEXT,
  FOREIGN KEY (app_id) REFERENCES installed_apps(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES automation_runs(run_id) ON DELETE CASCADE
);
CREATE INDEX idx_entries_app ON activity_entries(app_id, ts DESC);
```

---

## 4. File Structure

```
src/main/apps/runtime/
  DESIGN.md           -- This file
  types.ts            -- AppRuntimeService, AppRunResult, AutomationAppState, ActivityEntry
  errors.ts           -- Runtime-specific error types
  migrations.ts       -- Schema for automation_runs + activity_entries
  store.ts            -- ActivityStore (CRUD for runs and entries)
  prompt.ts           -- buildAppSystemPrompt() for automation sessions
  report-tool.ts      -- report_to_user SDK MCP tool
  concurrency.ts      -- Counting semaphore
  execute.ts          -- executeRun() core logic
  service.ts          -- AppRuntimeService implementation
  index.ts            -- initAppRuntime(), shutdownAppRuntime(), re-exports
```

---

## 5. Dependency Map

```
apps/runtime depends on:
├── apps/manager          getApp(), updateStatus(), updateLastRun(), onAppStatusChange()
├── apps/spec             AppSpec type (via manager)
├── platform/scheduler    addJob(), removeJob(), onJobDue(), getJob()
├── platform/event-bus    on(), emit()
├── platform/memory       createTools(), getPromptInstructions()
├── platform/background   registerKeepAliveReason()
├── platform/store        DatabaseManager (for migrations + activity store)
├── services/agent        getApiCredentials (helpers), resolveCredentialsForSdk,
│                         buildBaseSdkOptions, getHeadlessElectronPath (sdk-config)
├── services/config       getConfig()
└── services/space        getSpace()
```

---

## 6. Interface Contract

```typescript
interface AppRuntimeService {
  activate(appId: string): Promise<void>
  deactivate(appId: string): Promise<void>
  triggerManually(appId: string): Promise<AppRunResult>
  getAppState(appId: string): AutomationAppState
  respondToEscalation(appId: string, entryId: string, response: EscalationResponse): Promise<void>
  getActivityEntries(appId: string, options?: ActivityQueryOptions): ActivityEntry[]
  getRun(runId: string): AutomationRun | null
  getRunsForApp(appId: string, limit?: number): AutomationRun[]
  activateAll(): Promise<void>
  deactivateAll(): Promise<void>
}
```
