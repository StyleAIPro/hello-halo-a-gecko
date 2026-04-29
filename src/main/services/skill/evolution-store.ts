/**
 * Skill Self-Evolution - SQLite Persistence Layer
 *
 * Manages three tables:
 *   skill_usage_records     — per-invocation tracking data
 *   skill_pattern_discoveries — background pattern analysis results
 *   skill_evolution_suggestions — GEPA optimization suggestions
 *
 * Follows the project's DatabaseManager migration pattern (namespace-based versioning).
 */

import type Database from 'better-sqlite3';
import type { DatabaseManager, Migration } from '../../platform/store/types';
import type {
  SkillUsageRecord,
  SkillUsageToolCall,
  SkillUsageStats,
  PatternDiscovery,
  EvolutionSuggestion,
  FitnessScore,
  SkillVersionSnapshot,
  SkillHealth,
} from '../../../shared/skill/skill-evolution-types';

// ============================================
// Migrations
// ============================================

const NAMESPACE = 'skill_evolution';

const migrations: Migration[] = [
  {
    version: 1,
    description:
      'Create skill_usage_records, skill_pattern_discoveries, skill_evolution_suggestions tables',
    up(db: Database.Database) {
      db.exec(`
        CREATE TABLE skill_usage_records (
          id TEXT PRIMARY KEY,
          skill_id TEXT NOT NULL,
          skill_name TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          space_id TEXT NOT NULL,
          triggered_at TEXT NOT NULL,
          trigger_mode TEXT NOT NULL,
          user_context TEXT DEFAULT '',
          tool_calls_json TEXT DEFAULT '[]',
          agent_response_summary TEXT DEFAULT '',
          token_input INTEGER DEFAULT 0,
          token_output INTEGER DEFAULT 0,
          user_feedback TEXT,
          process_compliance REAL,
          result_correctness REAL
        )
      `);

      db.exec(`
        CREATE INDEX idx_usage_skill_id ON skill_usage_records(skill_id)
      `);
      db.exec(`
        CREATE INDEX idx_usage_triggered_at ON skill_usage_records(triggered_at)
      `);

      db.exec(`
        CREATE TABLE skill_pattern_discoveries (
          id TEXT PRIMARY KEY,
          discovered_at TEXT NOT NULL,
          type TEXT NOT NULL,
          description TEXT NOT NULL,
          frequency INTEGER DEFAULT 0,
          source_conversation_ids_json TEXT DEFAULT '[]',
          reusability_score REAL DEFAULT 0,
          matched_skill_id TEXT,
          similarity_score REAL,
          status TEXT NOT NULL DEFAULT 'pending',
          suggested_skill_draft_json TEXT,
          expires_at TEXT NOT NULL
        )
      `);

      db.exec(`
        CREATE INDEX idx_pattern_status ON skill_pattern_discoveries(status)
      `);

      db.exec(`
        CREATE TABLE skill_evolution_suggestions (
          id TEXT PRIMARY KEY,
          skill_id TEXT NOT NULL,
          type TEXT NOT NULL,
          original_prompt TEXT NOT NULL,
          optimized_prompt TEXT NOT NULL,
          explanation TEXT DEFAULT '',
          scores_json TEXT NOT NULL,
          usage_data_summary TEXT DEFAULT '',
          confidence TEXT NOT NULL,
          created_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          expires_at TEXT NOT NULL
        )
      `);

      db.exec(`
        CREATE INDEX idx_evo_skill_id ON skill_evolution_suggestions(skill_id)
      `);
      db.exec(`
        CREATE INDEX idx_evo_status ON skill_evolution_suggestions(status)
      `);

      db.exec(`
        CREATE TABLE skill_version_snapshots (
          id TEXT PRIMARY KEY,
          skill_id TEXT NOT NULL,
          version TEXT NOT NULL,
          system_prompt TEXT NOT NULL,
          fitness_score_json TEXT,
          created_at TEXT NOT NULL,
          reason TEXT NOT NULL,
          related_suggestion_id TEXT
        )
      `);

      db.exec(`
        CREATE INDEX idx_version_skill_id ON skill_version_snapshots(skill_id)
      `);
    },
  },
];

// ============================================
// EvolutionStore
// ============================================

export class EvolutionStore {
  private db: Database.Database;

  constructor(dbManager: DatabaseManager) {
    this.db = dbManager.getAppDatabase();
    dbManager.runMigrations(this.db, NAMESPACE, migrations);
  }

  // ============================================
  // Usage Records
  // ============================================

  recordUsage(record: SkillUsageRecord): void {
    this.db
      .prepare(
        `INSERT INTO skill_usage_records
          (id, skill_id, skill_name, conversation_id, space_id, triggered_at,
           trigger_mode, user_context, tool_calls_json, agent_response_summary,
           token_input, token_output, user_feedback, process_compliance, result_correctness)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.skillId,
        record.skillName,
        record.conversationId,
        record.spaceId,
        record.triggeredAt,
        record.triggerMode,
        record.userContext,
        JSON.stringify(record.toolCalls),
        record.agentResponseSummary,
        record.tokenUsage.input,
        record.tokenUsage.output,
        record.userFeedback,
        record.processCompliance,
        record.resultCorrectness,
      );
  }

  completeUsage(
    id: string,
    params: {
      toolCalls: SkillUsageToolCall[];
      agentResponseSummary: string;
      tokenUsage: { input: number; output: number };
      processCompliance: number | null;
      resultCorrectness: number | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE skill_usage_records SET
          tool_calls_json = ?, agent_response_summary = ?,
          token_input = ?, token_output = ?,
          process_compliance = ?, result_correctness = ?
         WHERE id = ?`,
      )
      .run(
        JSON.stringify(params.toolCalls),
        params.agentResponseSummary.slice(0, 500),
        params.tokenUsage.input,
        params.tokenUsage.output,
        params.processCompliance,
        params.resultCorrectness,
        id,
      );
  }

  updateFeedback(id: string, feedback: 'positive' | 'negative' | 'neutral'): void {
    this.db
      .prepare('UPDATE skill_usage_records SET user_feedback = ? WHERE id = ?')
      .run(feedback, id);
  }

  updateFeedbackByConversation(
    conversationId: string,
    feedback: 'positive' | 'negative' | 'neutral',
  ): void {
    this.db
      .prepare('UPDATE skill_usage_records SET user_feedback = ? WHERE conversation_id = ?')
      .run(feedback, conversationId);
  }

  getUsageStats(skillId: string, since?: string): SkillUsageStats {
    const sinceClause = since ? `AND triggered_at >= ?` : '';
    const row = this.db
      .prepare(
        `SELECT
          COUNT(*) as total_uses,
          COALESCE(AVG(
            CASE WHEN tool_calls_json != '[]'
              THEN (SELECT COUNT(*) FROM json_each(tool_calls_json) WHERE json_extract(value, '$.status') = 'success') * 1.0 /
                   MAX((SELECT COUNT(*) FROM json_each(tool_calls_json)), 1)
              ELSE 1.0 END
          ), 1.0) as success_rate,
          COALESCE(AVG(process_compliance), 0.5) as avg_compliance,
          COALESCE(AVG(result_correctness), 0.5) as avg_correctness,
          COALESCE(AVG(token_input + token_output), 0) as avg_token_cost,
          COALESCE(
            SUM(CASE WHEN user_feedback = 'positive' THEN 1 ELSE 0 END) * 1.0 /
            NULLIF(SUM(CASE WHEN user_feedback IS NOT NULL THEN 1 ELSE 0 END), 0),
            0.5
          ) as positive_rate,
          MAX(triggered_at) as last_used
         FROM skill_usage_records
         WHERE skill_id = ? ${sinceClause}`,
      )
      .get(...(since ? [skillId, since] : [skillId])) as any;

    return {
      skillId,
      totalUses: row?.total_uses ?? 0,
      successRate: row?.success_rate ?? 1,
      avgProcessCompliance: row?.avg_compliance ?? 0.5,
      avgResultCorrectness: row?.avg_correctness ?? 0.5,
      avgTokenCost: row?.avg_token_cost ?? 0,
      positiveFeedbackRate: row?.positive_rate ?? 0.5,
      lastUsedAt: row?.last_used ?? '',
      usageTrend: this.calculateTrend(skillId),
    };
  }

  private calculateTrend(skillId: string): 'increasing' | 'stable' | 'decreasing' {
    const now = Date.now();
    const week = 7 * 24 * 60 * 60 * 1000;
    const recent = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM skill_usage_records
         WHERE skill_id = ? AND triggered_at >= ?`,
      )
      .get(skillId, new Date(now - week).toISOString()) as any;
    const previous = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM skill_usage_records
         WHERE skill_id = ? AND triggered_at >= ? AND triggered_at < ?`,
      )
      .get(
        skillId,
        new Date(now - 2 * week).toISOString(),
        new Date(now - week).toISOString(),
      ) as any;

    const r = recent?.cnt ?? 0;
    const p = previous?.cnt ?? 0;
    if (r > p * 1.2) return 'increasing';
    if (r < p * 0.8) return 'decreasing';
    return 'stable';
  }

  getUsageHistory(skillId: string, limit = 50): SkillUsageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM skill_usage_records WHERE skill_id = ? ORDER BY triggered_at DESC LIMIT ?`,
      )
      .all(skillId, limit) as any[];

    return rows.map(this.parseUsageRow);
  }

  getRecentUsage(skillId: string, count: number): SkillUsageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM skill_usage_records WHERE skill_id = ? ORDER BY triggered_at DESC LIMIT ?`,
      )
      .all(skillId, count) as any[];
    return rows.map(this.parseUsageRow);
  }

  getAllSkillStats(): SkillUsageStats[] {
    const skillIds = this.db
      .prepare('SELECT DISTINCT skill_id FROM skill_usage_records')
      .all() as any[];
    return skillIds.map((r) => this.getUsageStats(r.skill_id));
  }

  getLeaderboard(limit = 20): SkillUsageStats[] {
    return this.getAllSkillStats()
      .sort((a, b) => b.totalUses - a.totalUses)
      .slice(0, limit);
  }

  private parseUsageRow(row: any): SkillUsageRecord {
    return {
      id: row.id,
      skillId: row.skill_id,
      skillName: row.skill_name,
      conversationId: row.conversation_id,
      spaceId: row.space_id,
      triggeredAt: row.triggered_at,
      triggerMode: row.trigger_mode,
      userContext: row.user_context || '',
      toolCalls: JSON.parse(row.tool_calls_json || '[]'),
      agentResponseSummary: row.agent_response_summary || '',
      tokenUsage: { input: row.token_input || 0, output: row.token_output || 0 },
      userFeedback: row.user_feedback || null,
      processCompliance: row.process_compliance ?? null,
      resultCorrectness: row.result_correctness ?? null,
    };
  }

  // ============================================
  // Pattern Discoveries
  // ============================================

  savePatternDiscovery(discovery: PatternDiscovery): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO skill_pattern_discoveries
          (id, discovered_at, type, description, frequency, source_conversation_ids_json,
           reusability_score, matched_skill_id, similarity_score, status,
           suggested_skill_draft_json, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        discovery.id,
        discovery.discoveredAt,
        discovery.type,
        discovery.description,
        discovery.frequency,
        JSON.stringify(discovery.sourceConversationIds),
        discovery.reusabilityScore,
        discovery.matchedSkillId ?? null,
        discovery.similarityScore ?? null,
        discovery.status,
        discovery.suggestedSkillDraft ? JSON.stringify(discovery.suggestedSkillDraft) : null,
        discovery.expiresAt,
      );
  }

  getPendingPatterns(limit = 20): PatternDiscovery[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM skill_pattern_discoveries
         WHERE status = 'pending' AND expires_at > ?
         ORDER BY reusability_score DESC LIMIT ?`,
      )
      .all(new Date().toISOString(), limit) as any[];
    return rows.map(this.parsePatternRow);
  }

  updatePatternStatus(id: string, status: PatternDiscovery['status']): void {
    this.db.prepare('UPDATE skill_pattern_discoveries SET status = ? WHERE id = ?').run(status, id);
  }

  cleanExpiredPatterns(): number {
    const result = this.db
      .prepare(`DELETE FROM skill_pattern_discoveries WHERE status = 'pending' AND expires_at <= ?`)
      .run(new Date().toISOString());
    return result.changes;
  }

  private parsePatternRow(row: any): PatternDiscovery {
    return {
      id: row.id,
      discoveredAt: row.discovered_at,
      type: row.type,
      description: row.description,
      frequency: row.frequency,
      sourceConversationIds: JSON.parse(row.source_conversation_ids_json || '[]'),
      reusabilityScore: row.reusability_score,
      matchedSkillId: row.matched_skill_id ?? undefined,
      similarityScore: row.similarity_score ?? undefined,
      status: row.status,
      suggestedSkillDraft: row.suggested_skill_draft_json
        ? JSON.parse(row.suggested_skill_draft_json)
        : undefined,
      expiresAt: row.expires_at,
    };
  }

  // ============================================
  // Evolution Suggestions
  // ============================================

  saveSuggestion(suggestion: EvolutionSuggestion): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO skill_evolution_suggestions
          (id, skill_id, type, original_prompt, optimized_prompt, explanation,
           scores_json, usage_data_summary, confidence, created_at, status, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        suggestion.id,
        suggestion.skillId,
        suggestion.type,
        suggestion.originalPrompt,
        suggestion.optimizedPrompt,
        suggestion.explanation,
        JSON.stringify(suggestion.scores),
        suggestion.usageDataSummary,
        suggestion.confidence,
        suggestion.createdAt,
        suggestion.status,
        suggestion.expiresAt,
      );
  }

  getPendingSuggestions(skillId?: string): EvolutionSuggestion[] {
    const query = skillId
      ? `SELECT * FROM skill_evolution_suggestions
         WHERE skill_id = ? AND status = 'pending' AND expires_at > ?
         ORDER BY created_at DESC`
      : `SELECT * FROM skill_evolution_suggestions
         WHERE status = 'pending' AND expires_at > ?
         ORDER BY created_at DESC`;
    const params = skillId ? [skillId, new Date().toISOString()] : [new Date().toISOString()];

    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map(this.parseSuggestionRow);
  }

  getAllSuggestions(skillId?: string, limit = 50): EvolutionSuggestion[] {
    const query = skillId
      ? `SELECT * FROM skill_evolution_suggestions WHERE skill_id = ? ORDER BY created_at DESC LIMIT ?`
      : `SELECT * FROM skill_evolution_suggestions ORDER BY created_at DESC LIMIT ?`;
    const params = skillId ? [skillId, limit] : [limit];

    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map(this.parseSuggestionRow);
  }

  updateSuggestionStatus(id: string, status: EvolutionSuggestion['status']): void {
    this.db
      .prepare('UPDATE skill_evolution_suggestions SET status = ? WHERE id = ?')
      .run(status, id);
  }

  getSuggestion(id: string): EvolutionSuggestion | null {
    const row = this.db
      .prepare('SELECT * FROM skill_evolution_suggestions WHERE id = ?')
      .get(id) as any;
    return row ? this.parseSuggestionRow(row) : null;
  }

  cleanExpiredSuggestions(): number {
    const result = this.db
      .prepare(
        `DELETE FROM skill_evolution_suggestions WHERE status = 'pending' AND expires_at <= ?`,
      )
      .run(new Date().toISOString());
    return result.changes;
  }

  private parseSuggestionRow(row: any): EvolutionSuggestion {
    const scores = JSON.parse(row.scores_json || '{}');
    return {
      id: row.id,
      skillId: row.skill_id,
      type: row.type,
      originalPrompt: row.original_prompt,
      optimizedPrompt: row.optimized_prompt,
      explanation: row.explanation,
      scores,
      usageDataSummary: row.usage_data_summary,
      confidence: row.confidence,
      createdAt: row.created_at,
      status: row.status,
      expiresAt: row.expires_at,
    };
  }

  // ============================================
  // Version Snapshots
  // ============================================

  saveVersionSnapshot(snapshot: SkillVersionSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO skill_version_snapshots
          (id, skill_id, version, system_prompt, fitness_score_json, created_at, reason, related_suggestion_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.id,
        snapshot.skillId,
        snapshot.version,
        snapshot.systemPrompt,
        snapshot.fitnessScore ? JSON.stringify(snapshot.fitnessScore) : null,
        snapshot.createdAt,
        snapshot.reason,
        snapshot.relatedSuggestionId ?? null,
      );
  }

  getVersionHistory(skillId: string, limit = 20): SkillVersionSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM skill_version_snapshots WHERE skill_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(skillId, limit) as any[];
    return rows.map((row) => ({
      id: row.id,
      skillId: row.skill_id,
      version: row.version,
      systemPrompt: row.system_prompt,
      fitnessScore: row.fitness_score_json ? JSON.parse(row.fitness_score_json) : null,
      createdAt: row.created_at,
      reason: row.reason,
      relatedSuggestionId: row.related_suggestion_id ?? undefined,
    }));
  }

  getLatestVersion(skillId: string): SkillVersionSnapshot | null {
    const rows = this.getVersionHistory(skillId, 1);
    return rows[0] ?? null;
  }

  // ============================================
  // Skill Health
  // ============================================

  getSkillHealth(skillId: string): SkillHealth {
    const stats = this.getUsageStats(skillId);
    const lastSuggestion = this.db
      .prepare(
        `SELECT created_at FROM skill_evolution_suggestions WHERE skill_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(skillId) as any;
    const activeSuggestions = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM skill_evolution_suggestions WHERE skill_id = ? AND status IN ('pending', 'auto-applied')`,
      )
      .get(skillId) as any;

    const overall = stats.avgProcessCompliance * 0.4 + stats.avgResultCorrectness * 0.4 + 0.5 * 0.2;

    let status: SkillHealth['status'] = 'unused';
    if (stats.totalUses >= 3) {
      status = overall >= 0.6 ? 'healthy' : overall >= 0.4 ? 'needs-attention' : 'underperforming';
    }

    return {
      skillId,
      status,
      fitnessScore:
        stats.totalUses > 0
          ? {
              processCompliance: stats.avgProcessCompliance,
              resultCorrectness: stats.avgResultCorrectness,
              conciseness: 0.5,
              overall,
            }
          : null,
      totalUses: stats.totalUses,
      lastEvolvedAt: lastSuggestion?.created_at ?? null,
      activeSuggestionCount: activeSuggestions?.cnt ?? 0,
      recentTrend:
        stats.usageTrend === 'increasing'
          ? 'improving'
          : stats.usageTrend === 'decreasing'
            ? 'declining'
            : 'stable',
    };
  }

  getAllSkillHealth(): SkillHealth[] {
    const skillIds = this.db
      .prepare('SELECT DISTINCT skill_id FROM skill_usage_records')
      .all() as any[];
    return skillIds.map((r) => this.getSkillHealth(r.skill_id));
  }
}
