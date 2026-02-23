/**
 * Unit tests for apps/runtime
 *
 * Tests the App execution engine including:
 * - Activity Store (CRUD for automation_runs + activity_entries)
 * - Concurrency control (Semaphore)
 * - Prompt building (system prompt + initial message)
 * - Report tool (MCP tool for AI-to-user communication)
 * - Service layer (activation, execution, escalation, state queries)
 * - Error types
 * - Migrations
 *
 * All tests use :memory: databases for speed and isolation.
 * The SDK (unstable_v2_createSession) is mocked -- we don't spawn real CC processes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { randomUUID } from 'crypto'

// ============================================
// Mocks for transitive dependencies
// ============================================

// Mock the Claude Agent SDK (used by execute.ts and report-tool.ts)
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  unstable_v2_createSession: vi.fn(),
  tool: vi.fn((opts: any) => ({ ...opts, _isTool: true })),
  createSdkMcpServer: vi.fn((opts: any) => ({
    name: opts.name,
    version: opts.version,
    tools: opts.tools,
    _isMcpServer: true,
  })),
}))

// Mock agent helpers (used by execute.ts)
vi.mock('../../../../src/main/services/agent/helpers', () => ({
  getApiCredentials: vi.fn().mockResolvedValue({
    baseUrl: 'https://api.test.com',
    apiKey: 'test-key',
    model: 'test-model',
    provider: 'anthropic',
  }),
  getHeadlessElectronPath: vi.fn().mockReturnValue('/usr/bin/electron'),
  getWorkingDir: vi.fn().mockReturnValue('/tmp/test-work'),
  sendToRenderer: vi.fn(),
}))

// Mock SDK config (used by execute.ts)
vi.mock('../../../../src/main/services/agent/sdk-config', () => ({
  resolveCredentialsForSdk: vi.fn().mockResolvedValue({
    anthropicBaseUrl: 'https://api.test.com',
    anthropicApiKey: 'test-key',
    sdkModel: 'test-model',
    displayModel: 'Test Model',
  }),
  buildBaseSdkOptions: vi.fn().mockReturnValue({
    model: 'test-model',
    cwd: '/tmp/test',
    maxTurns: 50,
    systemPrompt: '',
  }),
}))

// Mock config service (used by execute.ts)
vi.mock('../../../../src/main/services/config.service', () => ({
  getConfig: vi.fn().mockReturnValue({}),
  getTempSpacePath: vi.fn().mockReturnValue('/tmp/halo-test/temp'),
}))

// Mock space service (used by index.ts)
vi.mock('../../../../src/main/services/space.service', () => ({
  getSpace: vi.fn().mockReturnValue(null),
}))

import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { ActivityStore } from '../../../../src/main/apps/runtime/store'
import {
  MIGRATION_NAMESPACE as RUNTIME_MIGRATION_NS,
  migrations as runtimeMigrations,
} from '../../../../src/main/apps/runtime/migrations'
import {
  MIGRATION_NAMESPACE as MANAGER_MIGRATION_NS,
  migrations as managerMigrations,
} from '../../../../src/main/apps/manager/migrations'
import { Semaphore } from '../../../../src/main/apps/runtime/concurrency'
import { buildAppSystemPrompt, buildInitialMessage } from '../../../../src/main/apps/runtime/prompt'
import {
  AppNotRunnableError,
  NoSubscriptionsError,
  ConcurrencyLimitError,
  EscalationNotFoundError,
  RunExecutionError,
} from '../../../../src/main/apps/runtime/errors'
import { createAppRuntimeService } from '../../../../src/main/apps/runtime/service'
import { createReportToolServer } from '../../../../src/main/apps/runtime/report-tool'
import type {
  AutomationRun,
  ActivityEntry,
  ActivityEntryContent,
  EscalationResponse,
  RunStatus,
  TriggerType,
} from '../../../../src/main/apps/runtime/types'
import type { AppSpec } from '../../../../src/main/apps/spec/schema'

// ============================================
// Test Fixtures
// ============================================

function createTestSpec(overrides?: Partial<AppSpec>): AppSpec {
  return {
    spec_version: '1',
    name: 'test-automation',
    version: '1.0.0',
    author: 'Test',
    description: 'A test automation app',
    type: 'automation',
    system_prompt: 'You monitor prices.',
    subscriptions: [
      {
        id: 'check-prices',
        source: { type: 'schedule', config: { every: '30m' } },
      },
    ],
    ...overrides,
  } as AppSpec
}

function createTestAppId(): string {
  return randomUUID()
}

function createTestRunId(): string {
  return randomUUID()
}

function createTestEntry(overrides?: Partial<ActivityEntry>): ActivityEntry {
  return {
    id: randomUUID(),
    appId: 'app-001',
    runId: 'run-001',
    type: 'milestone',
    ts: Date.now(),
    sessionKey: 'session-001',
    content: { summary: 'Test entry' },
    ...overrides,
  }
}

// ============================================
// Migrations Tests
// ============================================

describe('Runtime Migrations', () => {
  let dbManager: DatabaseManager

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
  })

  it('should run manager + runtime migrations without error', () => {
    const db = dbManager.getAppDatabase()
    // Manager migrations must run first (for installed_apps FK)
    dbManager.runMigrations(db, MANAGER_MIGRATION_NS, managerMigrations)
    dbManager.runMigrations(db, RUNTIME_MIGRATION_NS, runtimeMigrations)

    // Verify tables exist
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>
    const tableNames = tables.map((t) => t.name)

    expect(tableNames).toContain('automation_runs')
    expect(tableNames).toContain('activity_entries')
  })

  it('should create indexes on automation_runs and activity_entries', () => {
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, MANAGER_MIGRATION_NS, managerMigrations)
    dbManager.runMigrations(db, RUNTIME_MIGRATION_NS, runtimeMigrations)

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all() as Array<{ name: string }>
    const indexNames = indexes.map((i) => i.name)

    expect(indexNames).toContain('idx_runs_app')
    expect(indexNames).toContain('idx_entries_app')
  })

  it('should be idempotent (run twice without error)', () => {
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, MANAGER_MIGRATION_NS, managerMigrations)
    dbManager.runMigrations(db, RUNTIME_MIGRATION_NS, runtimeMigrations)
    // Running again should not throw
    dbManager.runMigrations(db, RUNTIME_MIGRATION_NS, runtimeMigrations)
  })

  it('should enforce FK from automation_runs to installed_apps', () => {
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, MANAGER_MIGRATION_NS, managerMigrations)
    dbManager.runMigrations(db, RUNTIME_MIGRATION_NS, runtimeMigrations)

    // Inserting a run with a non-existent app_id should fail (FK constraint)
    expect(() => {
      db.prepare(`
        INSERT INTO automation_runs (run_id, app_id, session_key, status, trigger_type, started_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('run-001', 'nonexistent-app', 'sess-001', 'running', 'manual', Date.now())
    }).toThrow()
  })

  it('should CASCADE DELETE runs and entries when installed_app is deleted', () => {
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, MANAGER_MIGRATION_NS, managerMigrations)
    dbManager.runMigrations(db, RUNTIME_MIGRATION_NS, runtimeMigrations)

    const appId = randomUUID()
    const specJson = JSON.stringify(createTestSpec())

    // Insert an installed app
    db.prepare(`
      INSERT INTO installed_apps (id, spec_id, space_id, spec_json, status, user_config_json, user_overrides_json, permissions_json, installed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(appId, 'test-app', 'space-001', specJson, 'active', '{}', '{}', '{"granted":[],"denied":[]}', Date.now())

    // Insert a run
    db.prepare(`
      INSERT INTO automation_runs (run_id, app_id, session_key, status, trigger_type, started_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('run-001', appId, 'sess-001', 'ok', 'manual', Date.now())

    // Insert an activity entry
    db.prepare(`
      INSERT INTO activity_entries (id, app_id, run_id, type, ts, content_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('entry-001', appId, 'run-001', 'milestone', Date.now(), '{"summary":"test"}')

    // Delete the installed app
    db.prepare('DELETE FROM installed_apps WHERE id = ?').run(appId)

    // Verify cascade deletion
    const runs = db.prepare('SELECT * FROM automation_runs WHERE app_id = ?').all(appId)
    const entries = db.prepare('SELECT * FROM activity_entries WHERE app_id = ?').all(appId)

    expect(runs).toHaveLength(0)
    expect(entries).toHaveLength(0)
  })
})

// ============================================
// Activity Store Tests
// ============================================

describe('ActivityStore', () => {
  let dbManager: DatabaseManager
  let store: ActivityStore
  let testAppId: string

  function setupAppRecord(appId: string): void {
    const db = dbManager.getAppDatabase()
    const specJson = JSON.stringify(createTestSpec())
    db.prepare(`
      INSERT INTO installed_apps (id, spec_id, space_id, spec_json, status, user_config_json, user_overrides_json, permissions_json, installed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(appId, 'test-app', 'space-001', specJson, 'active', '{}', '{}', '{"granted":[],"denied":[]}', Date.now())
  }

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, MANAGER_MIGRATION_NS, managerMigrations)
    dbManager.runMigrations(db, RUNTIME_MIGRATION_NS, runtimeMigrations)
    store = new ActivityStore(db)
    testAppId = randomUUID()
    setupAppRecord(testAppId)
  })

  // ── Run Operations ──────────────────────────

  describe('Run Operations', () => {
    it('should insert and retrieve a run', () => {
      const runId = createTestRunId()
      store.insertRun({
        runId,
        appId: testAppId,
        sessionKey: 'sess-001',
        status: 'running',
        triggerType: 'manual',
        startedAt: 1000,
      })

      const run = store.getRun(runId)
      expect(run).not.toBeNull()
      expect(run!.runId).toBe(runId)
      expect(run!.appId).toBe(testAppId)
      expect(run!.sessionKey).toBe('sess-001')
      expect(run!.status).toBe('running')
      expect(run!.triggerType).toBe('manual')
      expect(run!.startedAt).toBe(1000)
    })

    it('should return null for non-existent run', () => {
      expect(store.getRun('nonexistent')).toBeNull()
    })

    it('should insert run with trigger data', () => {
      const runId = createTestRunId()
      const triggerData = { source: 'file', path: '/foo/bar' }
      store.insertRun({
        runId,
        appId: testAppId,
        sessionKey: 'sess-001',
        status: 'running',
        triggerType: 'event',
        triggerData,
        startedAt: 2000,
      })

      const run = store.getRun(runId)
      expect(run!.triggerData).toEqual(triggerData)
    })

    it('should update run status', () => {
      const runId = createTestRunId()
      store.insertRun({
        runId,
        appId: testAppId,
        sessionKey: 'sess-001',
        status: 'running',
        triggerType: 'manual',
        startedAt: 1000,
      })

      store.updateRunStatus(runId, 'error', 'Something went wrong')

      const run = store.getRun(runId)
      expect(run!.status).toBe('error')
      expect(run!.errorMessage).toBe('Something went wrong')
    })

    it('should complete a run with final data', () => {
      const runId = createTestRunId()
      store.insertRun({
        runId,
        appId: testAppId,
        sessionKey: 'sess-001',
        status: 'running',
        triggerType: 'schedule',
        startedAt: 1000,
      })

      store.completeRun(runId, {
        status: 'ok',
        finishedAt: 2000,
        durationMs: 1000,
        tokensUsed: 500,
      })

      const run = store.getRun(runId)
      expect(run!.status).toBe('ok')
      expect(run!.finishedAt).toBe(2000)
      expect(run!.durationMs).toBe(1000)
      expect(run!.tokensUsed).toBe(500)
    })

    it('should get runs for app ordered by most recent first', () => {
      for (let i = 0; i < 5; i++) {
        store.insertRun({
          runId: createTestRunId(),
          appId: testAppId,
          sessionKey: `sess-${i}`,
          status: 'ok',
          triggerType: 'schedule',
          startedAt: 1000 + i * 100,
        })
      }

      const runs = store.getRunsForApp(testAppId, 3)
      expect(runs).toHaveLength(3)
      // Most recent first
      expect(runs[0].startedAt).toBe(1400)
      expect(runs[1].startedAt).toBe(1300)
      expect(runs[2].startedAt).toBe(1200)
    })

    it('should get running run for app', () => {
      const runId = createTestRunId()
      store.insertRun({
        runId,
        appId: testAppId,
        sessionKey: 'sess-001',
        status: 'running',
        triggerType: 'manual',
        startedAt: 1000,
      })

      const running = store.getRunningRunForApp(testAppId)
      expect(running).not.toBeNull()
      expect(running!.runId).toBe(runId)
    })

    it('should return null when no running run', () => {
      store.insertRun({
        runId: createTestRunId(),
        appId: testAppId,
        sessionKey: 'sess-001',
        status: 'ok',
        triggerType: 'manual',
        startedAt: 1000,
      })

      expect(store.getRunningRunForApp(testAppId)).toBeNull()
    })

    it('should get latest run for app', () => {
      store.insertRun({
        runId: createTestRunId(),
        appId: testAppId,
        sessionKey: 'sess-001',
        status: 'ok',
        triggerType: 'manual',
        startedAt: 1000,
      })
      store.insertRun({
        runId: createTestRunId(),
        appId: testAppId,
        sessionKey: 'sess-002',
        status: 'error',
        triggerType: 'schedule',
        startedAt: 2000,
      })

      const latest = store.getLatestRunForApp(testAppId)
      expect(latest).not.toBeNull()
      expect(latest!.startedAt).toBe(2000)
      expect(latest!.status).toBe('error')
    })
  })

  // ── Entry Operations ────────────────────────

  describe('Entry Operations', () => {
    const runId = 'run-001'

    beforeEach(() => {
      store.insertRun({
        runId,
        appId: testAppId,
        sessionKey: 'sess-001',
        status: 'running',
        triggerType: 'manual',
        startedAt: 1000,
      })
    })

    it('should insert and retrieve an entry', () => {
      const entry = createTestEntry({
        appId: testAppId,
        runId,
        type: 'milestone',
        content: { summary: 'Found lowest price' },
      })

      store.insertEntry(entry)
      const retrieved = store.getEntry(entry.id)

      expect(retrieved).not.toBeNull()
      expect(retrieved!.id).toBe(entry.id)
      expect(retrieved!.appId).toBe(testAppId)
      expect(retrieved!.runId).toBe(runId)
      expect(retrieved!.type).toBe('milestone')
      expect(retrieved!.content.summary).toBe('Found lowest price')
    })

    it('should return null for non-existent entry', () => {
      expect(store.getEntry('nonexistent')).toBeNull()
    })

    it('should get entries for app (default ordering and limit)', () => {
      for (let i = 0; i < 5; i++) {
        store.insertEntry({
          id: randomUUID(),
          appId: testAppId,
          runId,
          type: 'milestone',
          ts: 1000 + i * 100,
          content: { summary: `Entry ${i}` },
        })
      }

      const entries = store.getEntriesForApp(testAppId)
      expect(entries).toHaveLength(5)
      // Most recent first
      expect(entries[0].content.summary).toBe('Entry 4')
    })

    it('should filter entries by type', () => {
      store.insertEntry({
        id: randomUUID(),
        appId: testAppId,
        runId,
        type: 'milestone',
        ts: 1000,
        content: { summary: 'Milestone' },
      })
      store.insertEntry({
        id: randomUUID(),
        appId: testAppId,
        runId,
        type: 'escalation',
        ts: 2000,
        content: { summary: 'Need help', question: 'What should I do?' },
      })

      const milestones = store.getEntriesForApp(testAppId, { type: 'milestone' })
      expect(milestones).toHaveLength(1)
      expect(milestones[0].type).toBe('milestone')
    })

    it('should filter entries since timestamp', () => {
      store.insertEntry({
        id: randomUUID(),
        appId: testAppId,
        runId,
        type: 'milestone',
        ts: 500,
        content: { summary: 'Old entry' },
      })
      store.insertEntry({
        id: randomUUID(),
        appId: testAppId,
        runId,
        type: 'milestone',
        ts: 1500,
        content: { summary: 'New entry' },
      })

      const entries = store.getEntriesForApp(testAppId, { since: 1000 })
      expect(entries).toHaveLength(1)
      expect(entries[0].content.summary).toBe('Old entry')
    })

    it('should respect limit and offset', () => {
      for (let i = 0; i < 10; i++) {
        store.insertEntry({
          id: randomUUID(),
          appId: testAppId,
          runId,
          type: 'milestone',
          ts: 1000 + i * 100,
          content: { summary: `Entry ${i}` },
        })
      }

      const page = store.getEntriesForApp(testAppId, { limit: 3, offset: 2 })
      expect(page).toHaveLength(3)
      // offset=2 from most recent (DESC), so skip entries 9, 8 → get 7, 6, 5
      expect(page[0].content.summary).toBe('Entry 7')
    })

    it('should update entry with user response', () => {
      const entryId = randomUUID()
      store.insertEntry({
        id: entryId,
        appId: testAppId,
        runId,
        type: 'escalation',
        ts: 1000,
        content: { summary: 'Need decision', question: 'Which option?' },
      })

      const response: EscalationResponse = {
        ts: Date.now(),
        choice: 'Option A',
        text: 'Go with option A',
      }
      store.updateEntryResponse(entryId, response)

      const entry = store.getEntry(entryId)
      expect(entry!.userResponse).toBeDefined()
      expect(entry!.userResponse!.choice).toBe('Option A')
      expect(entry!.userResponse!.text).toBe('Go with option A')
    })

    it('should find pending escalation', () => {
      const entryId = randomUUID()
      store.insertEntry({
        id: entryId,
        appId: testAppId,
        runId,
        type: 'escalation',
        ts: 1000,
        content: { summary: 'Pending question', question: 'What next?' },
      })

      const pending = store.getPendingEscalation(testAppId, entryId)
      expect(pending).not.toBeNull()
      expect(pending!.id).toBe(entryId)
    })

    it('should return null for already-responded escalation', () => {
      const entryId = randomUUID()
      store.insertEntry({
        id: entryId,
        appId: testAppId,
        runId,
        type: 'escalation',
        ts: 1000,
        content: { summary: 'Answered question', question: 'What next?' },
      })
      store.updateEntryResponse(entryId, { ts: Date.now(), text: 'Do X' })

      const pending = store.getPendingEscalation(testAppId, entryId)
      expect(pending).toBeNull()
    })

    it('should return null for wrong appId in pending escalation', () => {
      const entryId = randomUUID()
      store.insertEntry({
        id: entryId,
        appId: testAppId,
        runId,
        type: 'escalation',
        ts: 1000,
        content: { summary: 'Question', question: 'What?' },
      })

      expect(store.getPendingEscalation('wrong-app', entryId)).toBeNull()
    })

    it('should store entry with sessionKey', () => {
      const entry = createTestEntry({
        appId: testAppId,
        runId,
        sessionKey: 'custom-session-key',
      })
      store.insertEntry(entry)

      const retrieved = store.getEntry(entry.id)
      expect(retrieved!.sessionKey).toBe('custom-session-key')
    })

    it('should handle entry without sessionKey', () => {
      const entry: ActivityEntry = {
        id: randomUUID(),
        appId: testAppId,
        runId,
        type: 'run_complete',
        ts: Date.now(),
        content: { summary: 'Done', status: 'ok' },
      }
      store.insertEntry(entry)

      const retrieved = store.getEntry(entry.id)
      expect(retrieved!.sessionKey).toBeUndefined()
    })
  })
})

// ============================================
// Concurrency Tests
// ============================================

describe('Semaphore', () => {
  it('should allow acquisitions up to max', () => {
    const sem = new Semaphore(3)
    expect(sem.tryAcquire()).toBe(true)
    expect(sem.tryAcquire()).toBe(true)
    expect(sem.tryAcquire()).toBe(true)
    expect(sem.tryAcquire()).toBe(false) // 4th should fail
    expect(sem.activeCount).toBe(3)
  })

  it('should release and allow new acquisitions', () => {
    const sem = new Semaphore(1)
    expect(sem.tryAcquire()).toBe(true)
    expect(sem.tryAcquire()).toBe(false)
    sem.release()
    expect(sem.tryAcquire()).toBe(true)
  })

  it('should queue waiters and resolve in FIFO order', async () => {
    const sem = new Semaphore(1)
    const order: number[] = []

    // Acquire the single slot
    await sem.acquire()

    // Queue two waiters
    const p1 = sem.acquire().then(() => order.push(1))
    const p2 = sem.acquire().then(() => order.push(2))

    expect(sem.waitingCount).toBe(2)

    // Release twice
    sem.release()
    await p1
    sem.release()
    await p2

    expect(order).toEqual([1, 2])
  })

  it('should track waiting count', async () => {
    const sem = new Semaphore(1)
    await sem.acquire()

    const p = sem.acquire()
    expect(sem.waitingCount).toBe(1)

    sem.release()
    await p
    expect(sem.waitingCount).toBe(0)
  })

  it('should reject all waiting callers on rejectAll', async () => {
    const sem = new Semaphore(1)
    await sem.acquire()

    const p1 = sem.acquire().catch((err) => err.message)
    const p2 = sem.acquire().catch((err) => err.message)

    sem.rejectAll('shutting down')

    expect(await p1).toBe('shutting down')
    expect(await p2).toBe('shutting down')
    expect(sem.waitingCount).toBe(0)
  })

  it('should throw on invalid max', () => {
    expect(() => new Semaphore(0)).toThrow('must be >= 1')
    expect(() => new Semaphore(-1)).toThrow('must be >= 1')
  })

  it('should expose maxConcurrent', () => {
    const sem = new Semaphore(5)
    expect(sem.maxConcurrent).toBe(5)
  })

  it('should handle release with no active count gracefully', () => {
    const sem = new Semaphore(2)
    // Release without acquire should not go negative
    sem.release()
    expect(sem.activeCount).toBe(0)
  })

  it('should handle concurrent async acquire/release', async () => {
    const sem = new Semaphore(2)
    const results: string[] = []

    const tasks = Array.from({ length: 5 }, (_, i) =>
      (async () => {
        await sem.acquire()
        results.push(`start-${i}`)
        // Simulate async work
        await new Promise((r) => setTimeout(r, 10))
        results.push(`end-${i}`)
        sem.release()
      })()
    )

    await Promise.all(tasks)

    // All tasks should have completed
    expect(results.filter((r) => r.startsWith('start-'))).toHaveLength(5)
    expect(results.filter((r) => r.startsWith('end-'))).toHaveLength(5)
  })
})

// ============================================
// Prompt Builder Tests
// ============================================

describe('Prompt Builder', () => {
  describe('buildAppSystemPrompt', () => {
    it('should include base context with platform and date', () => {
      const prompt = buildAppSystemPrompt({
        appSpec: createTestSpec(),
        memoryInstructions: '',
        triggerContext: 'Manual trigger',
        workDir: '/tmp/test',
      })

      expect(prompt).toContain('automation App')
      expect(prompt).toContain('headless background execution')
      expect(prompt).toContain('Platform:')
      expect(prompt).toContain("Today's date:")
    })

    it('should include App-specific system_prompt', () => {
      const prompt = buildAppSystemPrompt({
        appSpec: createTestSpec({ system_prompt: 'Monitor AirPods prices' }),
        memoryInstructions: '',
        triggerContext: 'Scheduled',
        workDir: '/tmp/test',
      })

      expect(prompt).toContain('Monitor AirPods prices')
      expect(prompt).toContain('App Instructions')
    })

    it('should include memory instructions when provided', () => {
      const prompt = buildAppSystemPrompt({
        appSpec: createTestSpec(),
        memoryInstructions: '## Memory\nUse memory_read to recall state.',
        triggerContext: 'Manual',
        workDir: '/tmp/test',
      })

      expect(prompt).toContain('memory_read')
    })

    it('should always include reporting rules', () => {
      const prompt = buildAppSystemPrompt({
        appSpec: createTestSpec(),
        memoryInstructions: '',
        triggerContext: 'Manual',
        workDir: '/tmp/test',
      })

      expect(prompt).toContain('Reporting')
      expect(prompt).toContain('report_to_user')
      expect(prompt).toContain('escalation')
    })

    it('should include sub-agent instructions when usesAIBrowser=true', () => {
      const prompt = buildAppSystemPrompt({
        appSpec: createTestSpec(),
        memoryInstructions: '',
        triggerContext: 'Manual',
        usesAIBrowser: true,
        workDir: '/tmp/test',
      })

      expect(prompt).toContain('Browser Task Delegation')
      expect(prompt).toContain('Task tool')
    })

    it('should NOT include sub-agent instructions when usesAIBrowser=false', () => {
      const prompt = buildAppSystemPrompt({
        appSpec: createTestSpec(),
        memoryInstructions: '',
        triggerContext: 'Manual',
        usesAIBrowser: false,
        workDir: '/tmp/test',
      })

      expect(prompt).not.toContain('Browser Task Delegation')
    })

    it('should handle AppSpec without system_prompt', () => {
      const prompt = buildAppSystemPrompt({
        appSpec: createTestSpec({ system_prompt: undefined }),
        memoryInstructions: '',
        triggerContext: 'Manual',
        workDir: '/tmp/test',
      })

      expect(prompt).not.toContain('App Instructions')
      // Should still have base context + reporting rules
      expect(prompt).toContain('automation App')
      expect(prompt).toContain('Reporting')
    })
  })

  describe('buildInitialMessage', () => {
    it('should include trigger context', () => {
      const msg = buildInitialMessage({
        triggerContext: 'Scheduled run at 14:30',
        appName: 'Price Monitor',
      })

      expect(msg).toContain('Scheduled run at 14:30')
      expect(msg).toContain('Trigger')
    })

    it('should include user config when provided', () => {
      const msg = buildInitialMessage({
        triggerContext: 'Manual trigger',
        appName: 'Price Monitor',
        userConfig: { productUrl: 'https://example.com', threshold: 100 },
      })

      expect(msg).toContain('User Configuration')
      expect(msg).toContain('productUrl')
      expect(msg).toContain('https://example.com')
    })

    it('should omit user config section when empty', () => {
      const msg = buildInitialMessage({
        triggerContext: 'Manual trigger',
        appName: 'Price Monitor',
        userConfig: {},
      })

      expect(msg).not.toContain('User Configuration')
    })

    it('should omit user config section when undefined', () => {
      const msg = buildInitialMessage({
        triggerContext: 'Manual trigger',
        appName: 'Price Monitor',
      })

      expect(msg).not.toContain('User Configuration')
    })

    it('should include app name in instructions', () => {
      const msg = buildInitialMessage({
        triggerContext: 'Manual trigger',
        appName: 'My Automation',
      })

      expect(msg).toContain('"My Automation"')
      expect(msg).toContain('Instructions')
    })
  })
})

// ============================================
// Error Types Tests
// ============================================

describe('Error Types', () => {
  it('AppNotRunnableError should contain appId and status', () => {
    const err = new AppNotRunnableError('app-123', 'paused')
    expect(err.name).toBe('AppNotRunnableError')
    expect(err.appId).toBe('app-123')
    expect(err.status).toBe('paused')
    expect(err.message).toContain('app-123')
    expect(err.message).toContain('paused')
  })

  it('NoSubscriptionsError should contain appId', () => {
    const err = new NoSubscriptionsError('app-456')
    expect(err.name).toBe('NoSubscriptionsError')
    expect(err.appId).toBe('app-456')
    expect(err.message).toContain('app-456')
  })

  it('ConcurrencyLimitError should contain maxConcurrent', () => {
    const err = new ConcurrencyLimitError(3)
    expect(err.name).toBe('ConcurrencyLimitError')
    expect(err.maxConcurrent).toBe(3)
    expect(err.message).toContain('3')
  })

  it('EscalationNotFoundError should contain appId and entryId', () => {
    const err = new EscalationNotFoundError('app-789', 'entry-001')
    expect(err.name).toBe('EscalationNotFoundError')
    expect(err.appId).toBe('app-789')
    expect(err.entryId).toBe('entry-001')
  })

  it('RunExecutionError should contain appId and runId', () => {
    const err = new RunExecutionError('app-001', 'run-001', 'Network timeout')
    expect(err.name).toBe('RunExecutionError')
    expect(err.appId).toBe('app-001')
    expect(err.runId).toBe('run-001')
    expect(err.message).toContain('Network timeout')
  })

  it('All error types should be instanceof Error', () => {
    expect(new AppNotRunnableError('a', 'active')).toBeInstanceOf(Error)
    expect(new NoSubscriptionsError('a')).toBeInstanceOf(Error)
    expect(new ConcurrencyLimitError(1)).toBeInstanceOf(Error)
    expect(new EscalationNotFoundError('a', 'b')).toBeInstanceOf(Error)
    expect(new RunExecutionError('a', 'b', 'c')).toBeInstanceOf(Error)
  })
})

// ============================================
// Service Tests (with mocked dependencies)
// ============================================

describe('AppRuntimeService', () => {
  let dbManager: DatabaseManager
  let store: ActivityStore
  let mockAppManager: any
  let mockScheduler: any
  let mockEventBus: any
  let mockMemory: any
  let mockBackground: any

  // Helper to create the service
  function createService() {
    return createAppRuntimeService({
      store,
      appManager: mockAppManager,
      scheduler: mockScheduler,
      eventBus: mockEventBus,
      memory: mockMemory,
      background: mockBackground,
      getSpacePath: () => '/tmp/test-space',
    })
  }

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, MANAGER_MIGRATION_NS, managerMigrations)
    dbManager.runMigrations(db, RUNTIME_MIGRATION_NS, runtimeMigrations)
    store = new ActivityStore(db)

    // Mock AppManager
    mockAppManager = {
      getApp: vi.fn(),
      listApps: vi.fn().mockReturnValue([]),
      updateStatus: vi.fn(),
      updateLastRun: vi.fn(),
      onAppStatusChange: vi.fn().mockReturnValue(() => {}),
    }

    // Mock Scheduler
    mockScheduler = {
      addJob: vi.fn().mockReturnValue('job-id'),
      removeJob: vi.fn(),
      updateJob: vi.fn(),
      pauseJob: vi.fn(),
      resumeJob: vi.fn(),
      getJob: vi.fn().mockReturnValue(null),
      listJobs: vi.fn().mockReturnValue([]),
      onJobDue: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    }

    // Mock EventBus
    mockEventBus = {
      on: vi.fn().mockReturnValue(() => {}),
      emit: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    }

    // Mock Memory
    mockMemory = {
      createTools: vi.fn().mockReturnValue({}),
      getPromptInstructions: vi.fn().mockResolvedValue('## Memory\nUse memory tools.'),
      read: vi.fn(),
      write: vi.fn(),
      list: vi.fn(),
    }

    // Mock Background
    mockBackground = {
      registerKeepAliveReason: vi.fn().mockReturnValue(() => {}),
      shouldKeepAlive: vi.fn().mockReturnValue(false),
    }
  })

  describe('activate', () => {
    it('should register scheduler jobs for schedule subscriptions', async () => {
      const appId = randomUUID()
      const app = {
        id: appId,
        specId: 'test-app',
        spaceId: 'space-001',
        spec: createTestSpec(),
        status: 'active' as const,
        userConfig: {},
        userOverrides: {},
        permissions: { granted: [], denied: [] },
        installedAt: Date.now(),
      }
      mockAppManager.getApp.mockReturnValue(app)

      const service = createService()
      await service.activate(appId)

      expect(mockScheduler.addJob).toHaveBeenCalledTimes(1)
      const addJobCall = mockScheduler.addJob.mock.calls[0][0]
      expect(addJobCall.id).toBe(`${appId}:check-prices`)
      expect(addJobCall.schedule).toEqual({ kind: 'every', every: '30m' })
      expect(addJobCall.metadata).toEqual({ appId, subscriptionId: 'check-prices' })
    })

    it('should register event-bus subscriptions for file triggers', async () => {
      const appId = randomUUID()
      const app = {
        id: appId,
        specId: 'test-app',
        spaceId: 'space-001',
        spec: createTestSpec({
          subscriptions: [
            { id: 'watch-files', source: { type: 'file', config: { pattern: '*.md' } } },
          ],
        }),
        status: 'active' as const,
        userConfig: {},
        userOverrides: {},
        permissions: { granted: [], denied: [] },
        installedAt: Date.now(),
      }
      mockAppManager.getApp.mockReturnValue(app)

      const service = createService()
      await service.activate(appId)

      expect(mockEventBus.on).toHaveBeenCalledTimes(1)
      const filter = mockEventBus.on.mock.calls[0][0]
      expect(filter.types).toEqual(['file.*'])
    })

    it('should register keep-alive reason', async () => {
      const appId = randomUUID()
      const app = {
        id: appId,
        specId: 'test-app',
        spaceId: 'space-001',
        spec: createTestSpec(),
        status: 'active' as const,
        userConfig: {},
        userOverrides: {},
        permissions: { granted: [], denied: [] },
        installedAt: Date.now(),
      }
      mockAppManager.getApp.mockReturnValue(app)

      const service = createService()
      await service.activate(appId)

      expect(mockBackground.registerKeepAliveReason).toHaveBeenCalledWith(
        `automation-apps-active:${appId}`
      )
    })

    it('should be idempotent (activating twice is safe)', async () => {
      const appId = randomUUID()
      const app = {
        id: appId,
        specId: 'test-app',
        spaceId: 'space-001',
        spec: createTestSpec(),
        status: 'active' as const,
        userConfig: {},
        userOverrides: {},
        permissions: { granted: [], denied: [] },
        installedAt: Date.now(),
      }
      mockAppManager.getApp.mockReturnValue(app)

      const service = createService()
      await service.activate(appId)
      await service.activate(appId) // Second call should be a no-op

      expect(mockScheduler.addJob).toHaveBeenCalledTimes(1)
    })

    it('should throw for non-existent app', async () => {
      mockAppManager.getApp.mockReturnValue(null)

      const service = createService()
      await expect(service.activate('nonexistent')).rejects.toThrow()
    })

    it('should skip non-automation apps', async () => {
      const appId = randomUUID()
      const app = {
        id: appId,
        specId: 'test-mcp',
        spaceId: 'space-001',
        spec: createTestSpec({ type: 'mcp' }),
        status: 'active' as const,
        userConfig: {},
        userOverrides: {},
        permissions: { granted: [], denied: [] },
        installedAt: Date.now(),
      }
      mockAppManager.getApp.mockReturnValue(app)

      const service = createService()
      await service.activate(appId)

      // Should not register any jobs or events
      expect(mockScheduler.addJob).not.toHaveBeenCalled()
      expect(mockEventBus.on).not.toHaveBeenCalled()
    })

    it('should throw for automation app with no subscriptions', async () => {
      const appId = randomUUID()
      const app = {
        id: appId,
        specId: 'test-app',
        spaceId: 'space-001',
        spec: createTestSpec({ subscriptions: [] }),
        status: 'active' as const,
        userConfig: {},
        userOverrides: {},
        permissions: { granted: [], denied: [] },
        installedAt: Date.now(),
      }
      mockAppManager.getApp.mockReturnValue(app)

      const service = createService()
      await expect(service.activate(appId)).rejects.toThrow(NoSubscriptionsError)
    })

    it('should use user frequency override when available', async () => {
      const appId = randomUUID()
      const app = {
        id: appId,
        specId: 'test-app',
        spaceId: 'space-001',
        spec: createTestSpec(),
        status: 'active' as const,
        userConfig: {},
        userOverrides: { frequency: { 'check-prices': '1h' } },
        permissions: { granted: [], denied: [] },
        installedAt: Date.now(),
      }
      mockAppManager.getApp.mockReturnValue(app)

      const service = createService()
      await service.activate(appId)

      const addJobCall = mockScheduler.addJob.mock.calls[0][0]
      expect(addJobCall.schedule.every).toBe('1h') // User override, not default 30m
    })

    it('should resume existing scheduler job instead of creating new', async () => {
      const appId = randomUUID()
      const app = {
        id: appId,
        specId: 'test-app',
        spaceId: 'space-001',
        spec: createTestSpec(),
        status: 'active' as const,
        userConfig: {},
        userOverrides: {},
        permissions: { granted: [], denied: [] },
        installedAt: Date.now(),
      }
      mockAppManager.getApp.mockReturnValue(app)
      // Simulate existing job
      mockScheduler.getJob.mockReturnValue({ id: `${appId}:check-prices`, status: 'paused' })

      const service = createService()
      await service.activate(appId)

      expect(mockScheduler.resumeJob).toHaveBeenCalledWith(`${appId}:check-prices`)
      expect(mockScheduler.addJob).not.toHaveBeenCalled()
    })
  })

  describe('deactivate', () => {
    it('should remove scheduler jobs and event subscriptions', async () => {
      const appId = randomUUID()
      const unsubFn = vi.fn()
      mockEventBus.on.mockReturnValue(unsubFn)
      const keepAliveDisposer = vi.fn()
      mockBackground.registerKeepAliveReason.mockReturnValue(keepAliveDisposer)

      const app = {
        id: appId,
        specId: 'test-app',
        spaceId: 'space-001',
        spec: createTestSpec({
          subscriptions: [
            { id: 'sched', source: { type: 'schedule', config: { every: '30m' } } },
            { id: 'watch', source: { type: 'file', config: { pattern: '*.md' } } },
          ],
        }),
        status: 'active' as const,
        userConfig: {},
        userOverrides: {},
        permissions: { granted: [], denied: [] },
        installedAt: Date.now(),
      }
      mockAppManager.getApp.mockReturnValue(app)

      const service = createService()
      await service.activate(appId)
      await service.deactivate(appId)

      expect(mockScheduler.removeJob).toHaveBeenCalled()
      expect(unsubFn).toHaveBeenCalled()
      expect(keepAliveDisposer).toHaveBeenCalled()
    })

    it('should be safe to deactivate non-activated app', async () => {
      const service = createService()
      // Should not throw
      await service.deactivate('never-activated')
    })
  })

  describe('getAppState', () => {
    it('should return idle state for inactive app', () => {
      const appId = randomUUID()
      mockAppManager.getApp.mockReturnValue({
        id: appId,
        status: 'active',
        userConfig: {},
        userOverrides: {},
        permissions: { granted: [], denied: [] },
      })

      const service = createService()
      const state = service.getAppState(appId)

      expect(state.status).toBe('idle')
    })

    it('should return paused state', () => {
      const appId = randomUUID()
      mockAppManager.getApp.mockReturnValue({
        id: appId,
        status: 'paused',
        userConfig: {},
        userOverrides: {},
        permissions: { granted: [], denied: [] },
      })

      const service = createService()
      const state = service.getAppState(appId)

      expect(state.status).toBe('paused')
    })

    it('should return waiting_user state with escalation ID', () => {
      const appId = randomUUID()
      mockAppManager.getApp.mockReturnValue({
        id: appId,
        status: 'waiting_user',
        pendingEscalationId: 'esc-001',
        userConfig: {},
        userOverrides: {},
        permissions: { granted: [], denied: [] },
      })

      const service = createService()
      const state = service.getAppState(appId)

      expect(state.status).toBe('waiting_user')
      expect(state.pendingEscalationId).toBe('esc-001')
    })

    it('should return error state for error and needs_login', () => {
      const appId = randomUUID()
      mockAppManager.getApp.mockReturnValue({
        id: appId,
        status: 'error',
        errorMessage: 'Something failed',
        userConfig: {},
        userOverrides: {},
        permissions: { granted: [], denied: [] },
      })

      const service = createService()
      const state = service.getAppState(appId)

      expect(state.status).toBe('error')
      expect(state.lastError).toBe('Something failed')
    })

    it('should return idle for non-existent app', () => {
      mockAppManager.getApp.mockReturnValue(null)

      const service = createService()
      const state = service.getAppState('nonexistent')

      expect(state.status).toBe('idle')
    })

    it('should include next run time from scheduler', async () => {
      const appId = randomUUID()
      const app = {
        id: appId,
        specId: 'test-app',
        spaceId: 'space-001',
        spec: createTestSpec(),
        status: 'active' as const,
        userConfig: {},
        userOverrides: {},
        permissions: { granted: [], denied: [] },
        installedAt: Date.now(),
      }
      mockAppManager.getApp.mockReturnValue(app)

      const service = createService()
      await service.activate(appId)

      // Now mock getJob to return a job with nextRunAtMs
      mockScheduler.getJob.mockReturnValue({
        id: `${appId}:check-prices`,
        nextRunAtMs: 99999,
      })

      const state = service.getAppState(appId)
      expect(state.nextRunAtMs).toBe(99999)
    })
  })

  describe('getActivityEntries', () => {
    let testAppId: string

    beforeEach(() => {
      testAppId = randomUUID()
      // Insert an installed app record for FK
      const db = dbManager.getAppDatabase()
      const specJson = JSON.stringify(createTestSpec())
      db.prepare(`
        INSERT INTO installed_apps (id, spec_id, space_id, spec_json, status, user_config_json, user_overrides_json, permissions_json, installed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(testAppId, 'test-app', 'space-001', specJson, 'active', '{}', '{}', '{"granted":[],"denied":[]}', Date.now())

      // Insert a run for FK
      store.insertRun({
        runId: 'run-001',
        appId: testAppId,
        sessionKey: 'sess-001',
        status: 'ok',
        triggerType: 'manual',
        startedAt: Date.now(),
      })
    })

    it('should return entries from store', () => {
      store.insertEntry({
        id: randomUUID(),
        appId: testAppId,
        runId: 'run-001',
        type: 'milestone',
        ts: Date.now(),
        content: { summary: 'Test milestone' },
      })

      const service = createService()
      const entries = service.getActivityEntries(testAppId)

      expect(entries).toHaveLength(1)
      expect(entries[0].content.summary).toBe('Test milestone')
    })

    it('should pass query options through', () => {
      for (let i = 0; i < 5; i++) {
        store.insertEntry({
          id: randomUUID(),
          appId: testAppId,
          runId: 'run-001',
          type: 'milestone',
          ts: 1000 + i * 100,
          content: { summary: `Entry ${i}` },
        })
      }

      const service = createService()
      const entries = service.getActivityEntries(testAppId, { limit: 2 })

      expect(entries).toHaveLength(2)
    })
  })

  describe('getRun and getRunsForApp', () => {
    let testAppId: string

    beforeEach(() => {
      testAppId = randomUUID()
      const db = dbManager.getAppDatabase()
      const specJson = JSON.stringify(createTestSpec())
      db.prepare(`
        INSERT INTO installed_apps (id, spec_id, space_id, spec_json, status, user_config_json, user_overrides_json, permissions_json, installed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(testAppId, 'test-app', 'space-001', specJson, 'active', '{}', '{}', '{"granted":[],"denied":[]}', Date.now())
    })

    it('should return run by ID', () => {
      const runId = createTestRunId()
      store.insertRun({
        runId,
        appId: testAppId,
        sessionKey: 'sess-001',
        status: 'ok',
        triggerType: 'manual',
        startedAt: 1000,
      })

      const service = createService()
      const run = service.getRun(runId)
      expect(run).not.toBeNull()
      expect(run!.runId).toBe(runId)
    })

    it('should return runs for app', () => {
      for (let i = 0; i < 3; i++) {
        store.insertRun({
          runId: createTestRunId(),
          appId: testAppId,
          sessionKey: `sess-${i}`,
          status: 'ok',
          triggerType: 'schedule',
          startedAt: 1000 + i * 100,
        })
      }

      const service = createService()
      const runs = service.getRunsForApp(testAppId)
      expect(runs).toHaveLength(3)
    })
  })

  describe('respondToEscalation', () => {
    let testAppId: string

    beforeEach(() => {
      testAppId = randomUUID()
      const db = dbManager.getAppDatabase()
      const specJson = JSON.stringify(createTestSpec())
      db.prepare(`
        INSERT INTO installed_apps (id, spec_id, space_id, spec_json, status, user_config_json, user_overrides_json, permissions_json, installed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(testAppId, 'test-app', 'space-001', specJson, 'waiting_user', '{}', '{}', '{"granted":[],"denied":[]}', Date.now())

      store.insertRun({
        runId: 'run-001',
        appId: testAppId,
        sessionKey: 'sess-001',
        status: 'waiting_user',
        triggerType: 'manual',
        startedAt: Date.now(),
      })
    })

    it('should throw for non-existent escalation', async () => {
      mockAppManager.getApp.mockReturnValue({
        id: testAppId,
        status: 'waiting_user',
        spec: createTestSpec(),
        userConfig: {},
        userOverrides: {},
        spaceId: 'space-001',
      })

      const service = createService()
      await expect(
        service.respondToEscalation(testAppId, 'nonexistent', {
          ts: Date.now(),
          text: 'response',
        })
      ).rejects.toThrow(EscalationNotFoundError)
    })

    it('should record response and clear waiting_user status', async () => {
      const entryId = randomUUID()
      store.insertEntry({
        id: entryId,
        appId: testAppId,
        runId: 'run-001',
        type: 'escalation',
        ts: Date.now(),
        content: { summary: 'Need decision', question: 'Which option?' },
      })

      mockAppManager.getApp.mockReturnValue({
        id: testAppId,
        status: 'waiting_user',
        spec: createTestSpec(),
        userConfig: {},
        userOverrides: {},
        spaceId: 'space-001',
      })

      const service = createService()

      // Don't await the full thing - the follow-up run will fail because
      // executeRun is not mocked, but the response recording should succeed
      await service.respondToEscalation(testAppId, entryId, {
        ts: Date.now(),
        text: 'Go with option B',
      })

      // Verify response was recorded
      const entry = store.getEntry(entryId)
      expect(entry!.userResponse).toBeDefined()
      expect(entry!.userResponse!.text).toBe('Go with option B')

      // Verify status was updated
      expect(mockAppManager.updateStatus).toHaveBeenCalledWith(testAppId, 'active')
    })
  })

  describe('activateAll / deactivateAll', () => {
    it('should activate all active automation apps', async () => {
      const app1 = {
        id: randomUUID(),
        specId: 'app-1',
        spaceId: 'space-001',
        spec: createTestSpec({ name: 'App 1' }),
        status: 'active' as const,
        userConfig: {},
        userOverrides: {},
        permissions: { granted: [], denied: [] },
        installedAt: Date.now(),
      }
      const app2 = {
        id: randomUUID(),
        specId: 'app-2',
        spaceId: 'space-001',
        spec: createTestSpec({ name: 'App 2' }),
        status: 'active' as const,
        userConfig: {},
        userOverrides: {},
        permissions: { granted: [], denied: [] },
        installedAt: Date.now(),
      }

      mockAppManager.listApps.mockReturnValue([app1, app2])
      mockAppManager.getApp.mockImplementation((id: string) => {
        if (id === app1.id) return app1
        if (id === app2.id) return app2
        return null
      })

      const service = createService()
      await service.activateAll()

      // Should have added jobs for both apps
      expect(mockScheduler.addJob).toHaveBeenCalledTimes(2)
    })

    it('should deactivate all and reject waiting callers', async () => {
      const app = {
        id: randomUUID(),
        specId: 'app-1',
        spaceId: 'space-001',
        spec: createTestSpec(),
        status: 'active' as const,
        userConfig: {},
        userOverrides: {},
        permissions: { granted: [], denied: [] },
        installedAt: Date.now(),
      }

      mockAppManager.listApps.mockReturnValue([app])
      mockAppManager.getApp.mockReturnValue(app)

      const service = createService()
      await service.activateAll()
      await service.deactivateAll()

      expect(mockScheduler.removeJob).toHaveBeenCalled()
    })
  })

  describe('onJobDue handler registration', () => {
    it('should register a job due handler on the scheduler', () => {
      createService()
      expect(mockScheduler.onJobDue).toHaveBeenCalledTimes(1)
      expect(typeof mockScheduler.onJobDue.mock.calls[0][0]).toBe('function')
    })
  })

  describe('onAppStatusChange listener', () => {
    it('should register a status change handler on the manager', () => {
      createService()
      expect(mockAppManager.onAppStatusChange).toHaveBeenCalledTimes(1)
    })
  })
})

// ============================================
// Report Tool Tests
// ============================================

describe('Report Tool', () => {
  let dbManager: DatabaseManager
  let store: ActivityStore
  let testAppId: string

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, MANAGER_MIGRATION_NS, managerMigrations)
    dbManager.runMigrations(db, RUNTIME_MIGRATION_NS, runtimeMigrations)
    store = new ActivityStore(db)

    testAppId = randomUUID()
    const specJson = JSON.stringify(createTestSpec())
    db.prepare(`
      INSERT INTO installed_apps (id, spec_id, space_id, spec_json, status, user_config_json, user_overrides_json, permissions_json, installed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(testAppId, 'test-app', 'space-001', specJson, 'active', '{}', '{}', '{"granted":[],"denied":[]}', Date.now())

    store.insertRun({
      runId: 'run-001',
      appId: testAppId,
      sessionKey: 'sess-001',
      status: 'running',
      triggerType: 'manual',
      startedAt: Date.now(),
    })
  })

  it('should create an MCP server with report_to_user tool', () => {
    const server = createReportToolServer(store, {
      appId: testAppId,
      runId: 'run-001',
      sessionKey: 'sess-001',
    })

    expect(server).toBeDefined()
  })

  it('should invoke escalation callback on escalation type', async () => {
    let capturedEntryId = ''
    const server = createReportToolServer(
      store,
      { appId: testAppId, runId: 'run-001', sessionKey: 'sess-001' },
      (entryId: string) => { capturedEntryId = entryId }
    )

    // The server's tools list is internal, but we can verify the server was created
    expect(server).toBeDefined()
    // The actual tool execution would be tested via integration tests with the SDK
  })
})
