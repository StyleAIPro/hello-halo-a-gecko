/**
 * Terminal History Store - SQLite persistence for terminal command records
 *
 * Stores both agent and user terminal commands in SQLite for cross-conversation
 * querying and persistence across restarts.
 *
 * Follows the same pattern as platform/scheduler/store.ts.
 */

import type Database from 'better-sqlite3'
import type { DatabaseManager, Migration } from '../../platform/store/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TerminalCommandRow {
  id: string
  command: string
  source: string  // 'user' | 'agent'
  output: string
  exit_code: number | null
  status: string  // 'running' | 'completed' | 'error'
  space_id: string
  conversation_id: string
  cwd: string | null
  cwd_label: string | null
  timestamp: string
  created_at_ms: number
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

const NAMESPACE = 'terminal_history'

const migrations: Migration[] = [
  {
    version: 1,
    description: 'Create terminal_commands table',
    up(db: Database.Database) {
      db.exec(`
        CREATE TABLE terminal_commands (
          id              TEXT PRIMARY KEY,
          command         TEXT NOT NULL,
          source          TEXT NOT NULL DEFAULT 'user',
          output          TEXT NOT NULL DEFAULT '',
          exit_code       INTEGER,
          status          TEXT NOT NULL DEFAULT 'running',
          space_id        TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          cwd             TEXT,
          cwd_label       TEXT,
          timestamp       TEXT NOT NULL,
          created_at_ms   INTEGER NOT NULL
        )
      `)
      db.exec(`
        CREATE INDEX idx_term_cmd_conv
        ON terminal_commands(conversation_id, created_at_ms DESC)
      `)
      db.exec(`
        CREATE INDEX idx_term_cmd_space
        ON terminal_commands(space_id, created_at_ms DESC)
      `)
    }
  }
]

// ---------------------------------------------------------------------------
// Row <-> Domain conversion
// ---------------------------------------------------------------------------

function rowToDomain(row: TerminalCommandRow): TerminalCommandRow {
  return { ...row }
}

// ---------------------------------------------------------------------------
// TerminalHistoryStore class
// ---------------------------------------------------------------------------

export class TerminalHistoryStore {
  private db: Database.Database

  constructor(dbManager: DatabaseManager) {
    this.db = dbManager.getAppDatabase()
    dbManager.runMigrations(this.db, NAMESPACE, migrations)
  }

  /**
   * Insert or replace a command record.
   */
  insertCommand(cmd: TerminalCommandRow): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO terminal_commands (
        id, command, source, output, exit_code, status,
        space_id, conversation_id, cwd, cwd_label, timestamp, created_at_ms
      ) VALUES (
        @id, @command, @source, @output, @exit_code, @status,
        @space_id, @conversation_id, @cwd, @cwd_label, @timestamp, @created_at_ms
      )
    `).run({
      id: cmd.id,
      command: cmd.command,
      source: cmd.source,
      output: cmd.output,
      exit_code: cmd.exit_code,
      status: cmd.status,
      space_id: cmd.space_id,
      conversation_id: cmd.conversation_id,
      cwd: cmd.cwd,
      cwd_label: cmd.cwd_label,
      timestamp: cmd.timestamp,
      created_at_ms: cmd.created_at_ms
    })
  }

  /**
   * Update specific fields of an existing command.
   */
  updateCommand(id: string, fields: Partial<TerminalCommandRow>): void {
    const allowed = ['output', 'status', 'exit_code']
    const setClauses: string[] = []
    const params: Record<string, unknown> = { id }

    for (const key of allowed) {
      if (key in fields) {
        setClauses.push(`${key} = @${key}`)
        params[key] = fields[key]
      }
    }

    if (setClauses.length === 0) return

    this.db.prepare(`
      UPDATE terminal_commands SET ${setClauses.join(', ')} WHERE id = @id
    `).run(params)
  }

  /**
   * Get a single command by ID.
   */
  getCommand(id: string): TerminalCommandRow | null {
    const row = this.db.prepare(
      'SELECT * FROM terminal_commands WHERE id = ?'
    ).get(id) as TerminalCommandRow | undefined
    return row ? rowToDomain(row) : null
  }

  /**
   * Get commands for a conversation, ordered by time ascending (oldest first).
   */
  getCommandsForConversation(conversationId: string, limit: number = 500): TerminalCommandRow[] {
    const rows = this.db.prepare(`
      SELECT * FROM terminal_commands
      WHERE conversation_id = ?
      ORDER BY created_at_ms ASC
      LIMIT ?
    `).all(conversationId, limit) as TerminalCommandRow[]
    return rows.map(rowToDomain)
  }

  /**
   * Get recent commands across all conversations in a space.
   */
  getRecentCommands(spaceId: string, sinceMs: number, limit: number = 50): TerminalCommandRow[] {
    const rows = this.db.prepare(`
      SELECT * FROM terminal_commands
      WHERE space_id = ? AND created_at_ms >= ?
      ORDER BY created_at_ms DESC
      LIMIT ?
    `).all(spaceId, sinceMs, limit) as TerminalCommandRow[]
    return rows.map(rowToDomain)
  }

  /**
   * Prune old commands, keeping at most maxPerConversation per conversation.
   * Returns total number of pruned records.
   */
  pruneOldCommands(maxPerConversation: number = 500): number {
    const overflowConvs = this.db.prepare(`
      SELECT conversation_id, COUNT(*) as cnt
      FROM terminal_commands
      GROUP BY conversation_id
      HAVING cnt > ?
    `).all(maxPerConversation) as Array<{ conversation_id: string; cnt: number }>

    let totalPruned = 0
    for (const { conversation_id } of overflowConvs) {
      const result = this.db.prepare(`
        DELETE FROM terminal_commands
        WHERE conversation_id = ? AND id NOT IN (
          SELECT id FROM terminal_commands
          WHERE conversation_id = ?
          ORDER BY created_at_ms DESC
          LIMIT ?
        )
      `).run(conversation_id, conversation_id, maxPerConversation)
      totalPruned += result.changes
    }

    if (totalPruned > 0) {
      console.log(`[TerminalHistory] Pruned ${totalPruned} old command records`)
    }

    return totalPruned
  }
}

// ---------------------------------------------------------------------------
// Singleton management
// ---------------------------------------------------------------------------

let store: TerminalHistoryStore | null = null

/**
 * Initialize the terminal history store. Called during platform initialization.
 */
export function initTerminalHistory(dbManager: DatabaseManager): TerminalHistoryStore {
  store = new TerminalHistoryStore(dbManager)
  store.pruneOldCommands()
  console.log('[TerminalHistory] Store initialized')
  return store
}

/**
 * Get the current terminal history store instance.
 */
export function getTerminalHistoryStore(): TerminalHistoryStore | null {
  return store
}

/**
 * Shutdown the terminal history store.
 */
export function shutdownTerminalHistory(): void {
  store = null
  console.log('[TerminalHistory] Store shut down')
}
