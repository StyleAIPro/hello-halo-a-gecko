/**
 * apps/runtime -- Database Migrations
 *
 * Schema for the activity layer: automation_runs + activity_entries.
 * Uses the same migration pattern as platform/store and apps/manager.
 */

import type { Migration } from '../../platform/store'

export const MIGRATION_NAMESPACE = 'app_runtime'

export const migrations: Migration[] = [
  {
    version: 1,
    description: 'Create automation_runs and activity_entries tables',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS automation_runs (
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
        CREATE INDEX IF NOT EXISTS idx_runs_app ON automation_runs(app_id, started_at DESC);

        CREATE TABLE IF NOT EXISTS activity_entries (
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
        CREATE INDEX IF NOT EXISTS idx_entries_app ON activity_entries(app_id, ts DESC);
      `)
    },
  },
]
