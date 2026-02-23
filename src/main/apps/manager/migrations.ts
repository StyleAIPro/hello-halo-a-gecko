/**
 * apps/manager -- Database Migrations
 *
 * Schema migrations for the installed_apps table.
 * Uses the 'app_manager' namespace in the _migrations meta-table.
 *
 * Migration rules:
 * - Versions are sequential positive integers starting from 1
 * - Never modify an existing migration -- add a new version instead
 * - Each migration runs inside a transaction (handled by DatabaseManager)
 */

import type { Migration } from '../../platform/store'

/** Migration namespace used with DatabaseManager.runMigrations() */
export const MIGRATION_NAMESPACE = 'app_manager'

/**
 * All migrations for the app_manager module.
 * Sorted by version (required by DatabaseManager but it also sorts internally).
 */
export const migrations: Migration[] = [
  {
    version: 1,
    description: 'Create installed_apps table with indexes',
    up(db) {
      db.exec(`
        CREATE TABLE installed_apps (
          id TEXT PRIMARY KEY,
          spec_id TEXT NOT NULL,
          space_id TEXT NOT NULL,
          spec_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          pending_escalation_id TEXT,
          user_config_json TEXT NOT NULL DEFAULT '{}',
          user_overrides_json TEXT NOT NULL DEFAULT '{}',
          permissions_json TEXT NOT NULL DEFAULT '{"granted":[],"denied":[]}',
          installed_at INTEGER NOT NULL,
          last_run_at INTEGER,
          last_run_outcome TEXT,
          error_message TEXT,
          UNIQUE(spec_id, space_id)
        )
      `)

      db.exec(`
        CREATE INDEX idx_installed_apps_space
          ON installed_apps(space_id)
      `)

      db.exec(`
        CREATE INDEX idx_installed_apps_status
          ON installed_apps(status)
      `)
    }
  },
  {
    version: 2,
    description: 'Add uninstalled_at column for soft-delete lifecycle',
    up(db) {
      db.exec(`
        ALTER TABLE installed_apps ADD COLUMN uninstalled_at INTEGER
      `)
    }
  }
]
