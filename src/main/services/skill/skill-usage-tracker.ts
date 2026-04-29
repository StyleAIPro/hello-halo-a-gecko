/**
 * Skill Usage Tracker
 *
 * Tracks skill invocations in Agent sessions. Records usage context,
 * tool calls, results, and feedback for later analysis and GEPA optimization.
 *
 * Integration point: stream-processor.ts calls recordUsage() on Skill tool calls,
 * and completeUsage() when the stream finishes.
 */

import { v4 as uuid } from 'uuid';
import type {
  SkillUsageRecord,
  SkillUsageStats,
  SkillUsageToolCall,
} from '../../../shared/skill/skill-evolution-types';
import type { EvolutionStore } from './evolution-store';

/** In-flight tracking state for usage records awaiting completion */
interface PendingUsage {
  record: SkillUsageRecord;
  startTime: number;
}

export class SkillUsageTracker {
  private static instance: SkillUsageTracker;
  private store: EvolutionStore;

  /** Pending (in-flight) usage records keyed by conversationId */
  private pending = new Map<string, PendingUsage>();

  private constructor(store: EvolutionStore) {
    this.store = store;
  }

  static getInstance(): SkillUsageTracker | undefined {
    return SkillUsageTracker.instance;
  }

  static initialize(store: EvolutionStore): SkillUsageTracker {
    if (!SkillUsageTracker.instance) {
      SkillUsageTracker.instance = new SkillUsageTracker(store);
    }
    return SkillUsageTracker.instance;
  }

  /**
   * Record the start of a skill usage event.
   * Called from stream-processor when a Skill tool_use is detected.
   */
  recordUsage(params: {
    skillId: string;
    skillName: string;
    conversationId: string;
    spaceId: string;
    triggerMode: 'slash-command' | 'auto-invoke' | 'injected';
    userContext: string;
  }): void {
    const record: SkillUsageRecord = {
      id: uuid(),
      skillId: params.skillId,
      skillName: params.skillName,
      conversationId: params.conversationId,
      spaceId: params.spaceId,
      triggeredAt: new Date().toISOString(),
      triggerMode: params.triggerMode,
      userContext: params.userContext.slice(0, 500),
      toolCalls: [],
      agentResponseSummary: '',
      tokenUsage: { input: 0, output: 0 },
      userFeedback: null,
      processCompliance: null,
      resultCorrectness: null,
    };

    this.pending.set(params.conversationId, {
      record,
      startTime: Date.now(),
    });

    // Write initial record to DB immediately
    try {
      this.store.recordUsage(record);
    } catch (error) {
      console.error('[SkillUsageTracker] Failed to record usage:', error);
    }
  }

  /**
   * Complete a skill usage record with results from the stream.
   * Called from stream-processor's onComplete callback.
   */
  completeUsage(params: {
    conversationId: string;
    toolCalls: SkillUsageToolCall[];
    agentResponseSummary: string;
    tokenUsage: { input: number; output: number };
  }): void {
    const pending = this.pending.get(params.conversationId);
    if (!pending) return;

    const { record } = pending;
    this.pending.delete(params.conversationId);

    try {
      this.store.completeUsage(record.id, {
        toolCalls: params.toolCalls,
        agentResponseSummary: params.agentResponseSummary,
        tokenUsage: params.tokenUsage,
        processCompliance: this.inferProcessCompliance(params.toolCalls),
        resultCorrectness: this.inferResultCorrectness(
          params.toolCalls,
          params.agentResponseSummary,
        ),
      });
    } catch (error) {
      console.error('[SkillUsageTracker] Failed to complete usage:', error);
    }
  }

  /**
   * Update user feedback for a conversation's skill usage.
   */
  updateFeedback(conversationId: string, feedback: 'positive' | 'negative' | 'neutral'): void {
    try {
      this.store.updateFeedbackByConversation(conversationId, feedback);
    } catch (error) {
      console.error('[SkillUsageTracker] Failed to update feedback:', error);
    }
  }

  /**
   * Get usage statistics for a skill.
   */
  getUsageStats(skillId: string, since?: string): SkillUsageStats {
    return this.store.getUsageStats(skillId, since);
  }

  /**
   * Get recent usage history for a skill.
   */
  getUsageHistory(skillId: string, limit?: number): SkillUsageRecord[] {
    return this.store.getUsageHistory(skillId, limit);
  }

  /**
   * Get all skill usage statistics leaderboard.
   */
  getLeaderboard(limit?: number): SkillUsageStats[] {
    return this.store.getLeaderboard(limit);
  }

  /**
   * Check if there's a pending usage record for a conversation.
   */
  hasPendingUsage(conversationId: string): boolean {
    return this.pending.has(conversationId);
  }

  /** Infer process compliance from tool call success rate */
  private inferProcessCompliance(toolCalls: SkillUsageToolCall[]): number {
    if (toolCalls.length === 0) return 0.7;
    const successRate = toolCalls.filter((tc) => tc.status === 'success').length / toolCalls.length;
    return 0.3 + 0.7 * successRate;
  }

  /** Infer result correctness from tool outcomes and response length */
  private inferResultCorrectness(toolCalls: SkillUsageToolCall[], response: string): number {
    let score = 0.5;

    const hasErrors = toolCalls.some((tc) => tc.status === 'error');
    if (!hasErrors && toolCalls.length > 0) score += 0.2;
    if (hasErrors) score -= 0.2;

    if (response && response.length > 50) score += 0.15;
    if (response && response.length > 100) score += 0.15;

    return Math.max(0, Math.min(1, score));
  }
}
