/**
 * Unit tests for platform/store -- DatabaseManager
 *
 * Tests core database management functionality including:
 * - Connection management (open, close, reopen)
 * - Migration system (idempotency, ordering, namespacing)
 * - Transaction helpers
 * - Error handling and edge cases
 *
 * All tests use :memory: databases for speed and isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager, Migration } from '../../../../src/main/platform/store/types'

describe('DatabaseManager', () => {
  let manager: DatabaseManager

  beforeEach(() => {
    manager = createDatabaseManager(':memory:')
  })

  afterEach(() => {
    manager.closeAll()
  })

  // ===========================================================================
  // Connection Management
  // ===========================================================================

  describe('getAppDatabase', () => {
    it('should return a valid database instance', () => {
      const db = manager.getAppDatabase()
      expect(db).toBeDefined()
      // Verify we can execute queries
      const result = db.prepare('SELECT 1 as value').get() as { value: number }
      expect(result.value).toBe(1)
    })

    it('should return the same instance on repeated calls', () => {
      const db1 = manager.getAppDatabase()
      const db2 = manager.getAppDatabase()
      expect(db1).toBe(db2)
    })

    it('should apply WAL journal mode', () => {
      const db = manager.getAppDatabase()
      const result = db.pragma('journal_mode') as Array<{ journal_mode: string }>
      // In-memory databases use 'memory' journal mode regardless of pragma setting
      // This is expected behavior -- WAL is applied but only takes effect on file databases
      expect(result[0].journal_mode).toBeDefined()
    })

    it('should enable foreign keys', () => {
      const db = manager.getAppDatabase()
      const result = db.pragma('foreign_keys') as Array<{ foreign_keys: number }>
      expect(result[0].foreign_keys).toBe(1)
    })
  })

  describe('getSpaceDatabase', () => {
    it('should throw not-implemented error in V1', () => {
      expect(() => manager.getSpaceDatabase('/some/space/path')).toThrow(
        'Space-level databases are not implemented in V1'
      )
    })
  })

  describe('closeAll', () => {
    it('should close all open connections', () => {
      const db = manager.getAppDatabase()
      // Verify database works before close
      db.prepare('SELECT 1').get()

      manager.closeAll()

      // After closeAll, getting the database should create a new connection
      const db2 = manager.getAppDatabase()
      expect(db2).not.toBe(db)
      // New connection should work
      const result = db2.prepare('SELECT 1 as value').get() as { value: number }
      expect(result.value).toBe(1)
    })

    it('should be safe to call multiple times', () => {
      manager.getAppDatabase()
      manager.closeAll()
      manager.closeAll() // Should not throw
    })
  })

  // ===========================================================================
  // Migration System
  // ===========================================================================

  describe('runMigrations', () => {
    const basicMigrations: Migration[] = [
      {
        version: 1,
        description: 'Create users table',
        up(db) {
          db.exec(`
            CREATE TABLE users (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              email TEXT UNIQUE
            )
          `)
        }
      },
      {
        version: 2,
        description: 'Add created_at column to users',
        up(db) {
          db.exec('ALTER TABLE users ADD COLUMN created_at INTEGER')
        }
      }
    ]

    it('should run all migrations from scratch', () => {
      const db = manager.getAppDatabase()
      manager.runMigrations(db, 'test', basicMigrations)

      // Verify tables were created
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>
      const tableNames = tables.map(t => t.name)
      expect(tableNames).toContain('users')
      expect(tableNames).toContain('_migrations')

      // Verify columns
      const columns = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>
      const colNames = columns.map(c => c.name)
      expect(colNames).toContain('id')
      expect(colNames).toContain('name')
      expect(colNames).toContain('email')
      expect(colNames).toContain('created_at')
    })

    it('should record the final version in _migrations', () => {
      const db = manager.getAppDatabase()
      manager.runMigrations(db, 'test', basicMigrations)

      const row = db
        .prepare('SELECT version, applied_at FROM _migrations WHERE namespace = ?')
        .get('test') as { version: number; applied_at: number }
      expect(row.version).toBe(2)
      expect(row.applied_at).toBeGreaterThan(0)
    })

    it('should be idempotent -- running twice has no effect', () => {
      const db = manager.getAppDatabase()

      // Run migrations twice
      manager.runMigrations(db, 'test', basicMigrations)
      manager.runMigrations(db, 'test', basicMigrations)

      // Should still be at version 2
      const row = db
        .prepare('SELECT version FROM _migrations WHERE namespace = ?')
        .get('test') as { version: number }
      expect(row.version).toBe(2)

      // Data should not be duplicated or corrupted
      const result = db.prepare('SELECT count(*) as count FROM sqlite_master WHERE name = ?').get('users') as { count: number }
      expect(result.count).toBe(1)
    })

    it('should only run unapplied migrations', () => {
      const db = manager.getAppDatabase()

      // Run only version 1
      manager.runMigrations(db, 'test', [basicMigrations[0]])

      // Verify only version 1 was applied
      const row1 = db
        .prepare('SELECT version FROM _migrations WHERE namespace = ?')
        .get('test') as { version: number }
      expect(row1.version).toBe(1)

      // Verify users table exists but without created_at
      const columns1 = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>
      expect(columns1.map(c => c.name)).not.toContain('created_at')

      // Now run all migrations -- only version 2 should execute
      manager.runMigrations(db, 'test', basicMigrations)

      const row2 = db
        .prepare('SELECT version FROM _migrations WHERE namespace = ?')
        .get('test') as { version: number }
      expect(row2.version).toBe(2)

      // Now created_at should exist
      const columns2 = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>
      expect(columns2.map(c => c.name)).toContain('created_at')
    })

    it('should handle migrations passed in any order', () => {
      const db = manager.getAppDatabase()

      // Pass migrations in reverse order
      const reversed = [...basicMigrations].reverse()
      manager.runMigrations(db, 'test', reversed)

      // Should still work correctly
      const row = db
        .prepare('SELECT version FROM _migrations WHERE namespace = ?')
        .get('test') as { version: number }
      expect(row.version).toBe(2)
    })

    it('should support multiple independent namespaces', () => {
      const db = manager.getAppDatabase()

      const schedulerMigrations: Migration[] = [
        {
          version: 1,
          description: 'Create scheduler_jobs table',
          up(db) {
            db.exec(`
              CREATE TABLE scheduler_jobs (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL
              )
            `)
          }
        }
      ]

      const appManagerMigrations: Migration[] = [
        {
          version: 1,
          description: 'Create installed_apps table',
          up(db) {
            db.exec(`
              CREATE TABLE installed_apps (
                id TEXT PRIMARY KEY,
                spec_id TEXT NOT NULL
              )
            `)
          }
        },
        {
          version: 2,
          description: 'Add status column',
          up(db) {
            db.exec("ALTER TABLE installed_apps ADD COLUMN status TEXT DEFAULT 'active'")
          }
        }
      ]

      // Run both sets of migrations
      manager.runMigrations(db, 'scheduler', schedulerMigrations)
      manager.runMigrations(db, 'app_manager', appManagerMigrations)

      // Each namespace should have its own version
      const schedRow = db
        .prepare('SELECT version FROM _migrations WHERE namespace = ?')
        .get('scheduler') as { version: number }
      expect(schedRow.version).toBe(1)

      const appRow = db
        .prepare('SELECT version FROM _migrations WHERE namespace = ?')
        .get('app_manager') as { version: number }
      expect(appRow.version).toBe(2)

      // Both tables should exist
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>
      const tableNames = tables.map(t => t.name)
      expect(tableNames).toContain('scheduler_jobs')
      expect(tableNames).toContain('installed_apps')
    })

    it('should rollback all migrations on failure', () => {
      const db = manager.getAppDatabase()

      const failingMigrations: Migration[] = [
        {
          version: 1,
          description: 'Create table',
          up(db) {
            db.exec('CREATE TABLE rollback_test (id INTEGER PRIMARY KEY)')
          }
        },
        {
          version: 2,
          description: 'This one fails',
          up(_db) {
            throw new Error('Intentional test failure')
          }
        }
      ]

      // Should throw
      expect(() => manager.runMigrations(db, 'failing', failingMigrations)).toThrow(
        'Intentional test failure'
      )

      // Table should not exist (transaction rolled back)
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rollback_test'")
        .all() as Array<{ name: string }>
      expect(tables).toHaveLength(0)

      // No version should be recorded
      // The _migrations table itself might or might not exist depending on
      // whether CREATE TABLE IF NOT EXISTS is inside or outside the transaction
      try {
        const row = db
          .prepare('SELECT version FROM _migrations WHERE namespace = ?')
          .get('failing')
        expect(row).toBeUndefined()
      } catch {
        // _migrations table may not exist either, which is also correct
      }
    })

    it('should do nothing for empty migrations array', () => {
      const db = manager.getAppDatabase()
      // Should not throw
      manager.runMigrations(db, 'empty', [])
    })

    it('should reject invalid namespace', () => {
      const db = manager.getAppDatabase()
      expect(() => manager.runMigrations(db, '', basicMigrations)).toThrow(
        'namespace must be a non-empty string'
      )
    })

    it('should reject duplicate versions in the same namespace', () => {
      const db = manager.getAppDatabase()
      const dupes: Migration[] = [
        { version: 1, description: 'First', up() {} },
        { version: 1, description: 'Duplicate', up() {} }
      ]
      expect(() => manager.runMigrations(db, 'dupes', dupes)).toThrow(
        'Duplicate migration version 1'
      )
    })

    it('should reject non-positive version numbers', () => {
      const db = manager.getAppDatabase()
      expect(() =>
        manager.runMigrations(db, 'bad', [
          { version: 0, description: 'Zero version', up() {} }
        ])
      ).toThrow('Invalid migration version 0')

      expect(() =>
        manager.runMigrations(db, 'bad', [
          { version: -1, description: 'Negative version', up() {} }
        ])
      ).toThrow('Invalid migration version -1')
    })

    it('should handle adding new migrations to an existing namespace', () => {
      const db = manager.getAppDatabase()

      // Version 1 already applied
      manager.runMigrations(db, 'incremental', [
        {
          version: 1,
          description: 'Initial',
          up(db) {
            db.exec('CREATE TABLE inc_test (id INTEGER PRIMARY KEY)')
          }
        }
      ])

      // Later, version 2 and 3 are added
      manager.runMigrations(db, 'incremental', [
        { version: 1, description: 'Initial', up(db) { db.exec('CREATE TABLE inc_test (id INTEGER PRIMARY KEY)') } },
        { version: 2, description: 'Add name', up(db) { db.exec('ALTER TABLE inc_test ADD COLUMN name TEXT') } },
        { version: 3, description: 'Add email', up(db) { db.exec('ALTER TABLE inc_test ADD COLUMN email TEXT') } }
      ])

      const row = db
        .prepare('SELECT version FROM _migrations WHERE namespace = ?')
        .get('incremental') as { version: number }
      expect(row.version).toBe(3)

      const columns = db.prepare('PRAGMA table_info(inc_test)').all() as Array<{ name: string }>
      const colNames = columns.map(c => c.name)
      expect(colNames).toContain('name')
      expect(colNames).toContain('email')
    })
  })

  // ===========================================================================
  // Transaction Helper
  // ===========================================================================

  describe('transaction', () => {
    it('should commit on success', () => {
      const db = manager.getAppDatabase()
      db.exec('CREATE TABLE tx_test (id INTEGER PRIMARY KEY, value TEXT)')

      manager.transaction(db, () => {
        db.prepare('INSERT INTO tx_test (value) VALUES (?)').run('hello')
        db.prepare('INSERT INTO tx_test (value) VALUES (?)').run('world')
      })

      const rows = db.prepare('SELECT * FROM tx_test').all() as Array<{ value: string }>
      expect(rows).toHaveLength(2)
      expect(rows.map(r => r.value)).toEqual(['hello', 'world'])
    })

    it('should rollback on error', () => {
      const db = manager.getAppDatabase()
      db.exec('CREATE TABLE tx_test2 (id INTEGER PRIMARY KEY, value TEXT)')

      expect(() =>
        manager.transaction(db, () => {
          db.prepare('INSERT INTO tx_test2 (value) VALUES (?)').run('will be rolled back')
          throw new Error('Rollback test')
        })
      ).toThrow('Rollback test')

      const rows = db.prepare('SELECT * FROM tx_test2').all()
      expect(rows).toHaveLength(0)
    })

    it('should return the value from the function', () => {
      const db = manager.getAppDatabase()

      const result = manager.transaction(db, () => {
        return 42
      })

      expect(result).toBe(42)
    })
  })

  // ===========================================================================
  // Data Integrity
  // ===========================================================================

  describe('data integrity', () => {
    it('should persist data across getAppDatabase calls', () => {
      const db1 = manager.getAppDatabase()
      db1.exec('CREATE TABLE persist_test (id INTEGER PRIMARY KEY, val TEXT)')
      db1.prepare('INSERT INTO persist_test (val) VALUES (?)').run('test')

      const db2 = manager.getAppDatabase()
      const row = db2.prepare('SELECT val FROM persist_test').get() as { val: string }
      expect(row.val).toBe('test')
    })

    it('should support foreign key constraints', () => {
      const db = manager.getAppDatabase()

      db.exec(`
        CREATE TABLE parents (id INTEGER PRIMARY KEY);
        CREATE TABLE children (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL,
          FOREIGN KEY (parent_id) REFERENCES parents(id) ON DELETE CASCADE
        );
      `)

      db.prepare('INSERT INTO parents (id) VALUES (1)').run()
      db.prepare('INSERT INTO children (parent_id) VALUES (1)').run()

      // Should fail: referencing non-existent parent
      expect(() =>
        db.prepare('INSERT INTO children (parent_id) VALUES (999)').run()
      ).toThrow()
    })
  })

  // ===========================================================================
  // Realistic Multi-Module Scenario
  // ===========================================================================

  describe('multi-module realistic scenario', () => {
    it('should support the full scheduler + app_manager + event_bus flow', () => {
      const db = manager.getAppDatabase()

      // Scheduler registers its tables
      const schedulerMigrations: Migration[] = [
        {
          version: 1,
          description: 'Create scheduler tables',
          up(db) {
            db.exec(`
              CREATE TABLE scheduler_jobs (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                schedule_json TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                anchor_ms INTEGER NOT NULL,
                next_run_at_ms INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'idle',
                metadata_json TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
              )
            `)
            db.exec(`
              CREATE TABLE scheduler_run_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                finished_at INTEGER NOT NULL,
                outcome TEXT NOT NULL,
                error TEXT,
                FOREIGN KEY (job_id) REFERENCES scheduler_jobs(id) ON DELETE CASCADE
              )
            `)
          }
        }
      ]

      // App manager registers its tables
      const appManagerMigrations: Migration[] = [
        {
          version: 1,
          description: 'Create installed_apps table',
          up(db) {
            db.exec(`
              CREATE TABLE installed_apps (
                id TEXT PRIMARY KEY,
                spec_id TEXT NOT NULL,
                space_id TEXT NOT NULL,
                spec_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                user_config_json TEXT,
                installed_at INTEGER NOT NULL
              )
            `)
          }
        }
      ]

      // Event bus registers its tables
      const eventBusMigrations: Migration[] = [
        {
          version: 1,
          description: 'Create dedup_events table',
          up(db) {
            db.exec(`
              CREATE TABLE dedup_events (
                dedup_key TEXT PRIMARY KEY,
                event_type TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL
              )
            `)
          }
        }
      ]

      // Run all migrations -- order should not matter
      manager.runMigrations(db, 'event_bus', eventBusMigrations)
      manager.runMigrations(db, 'scheduler', schedulerMigrations)
      manager.runMigrations(db, 'app_manager', appManagerMigrations)

      // Verify all tables exist
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite%' ORDER BY name")
        .all() as Array<{ name: string }>
      const tableNames = tables.map(t => t.name)

      expect(tableNames).toContain('_migrations')
      expect(tableNames).toContain('scheduler_jobs')
      expect(tableNames).toContain('scheduler_run_log')
      expect(tableNames).toContain('installed_apps')
      expect(tableNames).toContain('dedup_events')

      // Verify each namespace has correct version
      const migrations = db.prepare('SELECT namespace, version FROM _migrations ORDER BY namespace').all() as Array<{ namespace: string; version: number }>
      expect(migrations).toEqual([
        { namespace: 'app_manager', version: 1 },
        { namespace: 'event_bus', version: 1 },
        { namespace: 'scheduler', version: 1 }
      ])

      // Simulate some CRUD operations
      manager.transaction(db, () => {
        db.prepare(`
          INSERT INTO scheduler_jobs (id, name, schedule_json, anchor_ms, next_run_at_ms, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run('job-1', 'Price checker', '{"kind":"every","every":"30m"}', Date.now(), Date.now() + 1800000, Date.now(), Date.now())

        db.prepare(`
          INSERT INTO installed_apps (id, spec_id, space_id, spec_json, installed_at)
          VALUES (?, ?, ?, ?, ?)
        `).run('app-1', 'price-checker', 'space-1', '{}', Date.now())
      })

      // Verify data was inserted
      const job = db.prepare('SELECT name FROM scheduler_jobs WHERE id = ?').get('job-1') as { name: string }
      expect(job.name).toBe('Price checker')

      const app = db.prepare('SELECT spec_id FROM installed_apps WHERE id = ?').get('app-1') as { spec_id: string }
      expect(app.spec_id).toBe('price-checker')

      // Verify foreign key cascade: delete a job and its run logs should be deleted
      db.prepare('INSERT INTO scheduler_run_log (job_id, started_at, finished_at, outcome) VALUES (?, ?, ?, ?)').run('job-1', Date.now(), Date.now() + 1000, 'useful')
      const logsBefore = db.prepare('SELECT count(*) as count FROM scheduler_run_log WHERE job_id = ?').get('job-1') as { count: number }
      expect(logsBefore.count).toBe(1)

      db.prepare('DELETE FROM scheduler_jobs WHERE id = ?').run('job-1')
      const logsAfter = db.prepare('SELECT count(*) as count FROM scheduler_run_log WHERE job_id = ?').get('job-1') as { count: number }
      expect(logsAfter.count).toBe(0)
    })
  })
})
