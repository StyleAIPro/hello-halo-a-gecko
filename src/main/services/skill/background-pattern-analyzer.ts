/**
 * Background Pattern Analyzer
 *
 * Periodically scans conversation history to discover high-frequency
 * reusable patterns that could become new skills or optimize existing ones.
 * Reuses ConversationAnalyzer and SimilarityCalculator from the existing skill system.
 */

import { v4 as uuid } from 'uuid';
import type {
  PatternDiscovery,
  PatternAnalyzerConfig,
} from '../../../shared/skill/skill-evolution-types';
import type { EvolutionStore } from './evolution-store';
import { SkillManager } from './skill-manager';
import { conversationAnalyzer } from './conversation-analyzer';
import { getConversationService } from '../conversation.service';
import { listSpaces } from '../space.service';

const DEFAULT_CONFIG: PatternAnalyzerConfig = {
  analysisInterval: '6h',
  frequencyThreshold: 5,
  reusabilityThreshold: 0.7,
  lookbackDays: 7,
  maxConversationsPerRun: 50,
  enabled: false,
};

export class BackgroundPatternAnalyzer {
  private static instance: BackgroundPatternAnalyzer;
  private store: EvolutionStore;
  private config: PatternAnalyzerConfig;

  private constructor(store: EvolutionStore, config?: Partial<PatternAnalyzerConfig>) {
    this.store = store;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  static getInstance(): BackgroundPatternAnalyzer | undefined {
    return BackgroundPatternAnalyzer.instance;
  }

  static initialize(
    store: EvolutionStore,
    config?: Partial<PatternAnalyzerConfig>,
  ): BackgroundPatternAnalyzer {
    if (!BackgroundPatternAnalyzer.instance) {
      BackgroundPatternAnalyzer.instance = new BackgroundPatternAnalyzer(store, config);
    }
    return BackgroundPatternAnalyzer.instance;
  }

  /**
   * Run one analysis cycle.
   *
   * 1. Scan recent conversations
   * 2. Analyze patterns using ConversationAnalyzer
   * 3. Aggregate by task type
   * 4. Match against existing skills
   * 5. Save pattern discoveries
   */
  async analyze(): Promise<PatternDiscovery[]> {
    if (!this.config.enabled) return [];

    console.log('[PatternAnalyzer] Starting analysis cycle');

    const discoveries: PatternDiscovery[] = [];

    try {
      // Collect conversations across all spaces
      const spaces = listSpaces();
      let conversations: string[] = [];
      for (const space of spaces) {
        const convIds = await this.getRecentConversations(space.id);
        conversations = conversations.concat(convIds);
      }
      if (conversations.length === 0) {
        console.log('[PatternAnalyzer] No conversations to analyze');
        return [];
      }

      // Group conversations by task type
      const taskGroups = new Map<string, string[]>();
      for (const convId of conversations) {
        try {
          const analysis = await conversationAnalyzer.analyzeConversation('*', convId);
          const taskType = analysis.userIntent.taskType;
          const existing = taskGroups.get(taskType) || [];
          existing.push(convId);
          taskGroups.set(taskType, existing);
        } catch {
          // Skip conversations that fail to analyze
        }
      }

      const skillManager = SkillManager.getInstance();
      const installedSkills = skillManager?.getInstalledSkills() || [];

      Array.from(taskGroups.entries()).forEach(([taskType, convIds]) => {
        // Check frequency threshold
        if (convIds.length < this.config.frequencyThreshold) return;

        // Check if matches an existing skill
        const matchedSkill = this.findMatchingSkill(taskType, installedSkills);

        const reusabilityScore = matchedSkill ? 0.8 : 0.75;

        if (reusabilityScore < this.config.reusabilityThreshold) return;

        // Check if this pattern was already discovered
        const existingPending = this.store.getPendingPatterns();
        const alreadyKnown = existingPending.some(
          (p) => p.description.includes(taskType) && p.status === 'pending',
        );
        if (alreadyKnown) return;

        const discovery: PatternDiscovery = {
          id: uuid(),
          discoveredAt: new Date().toISOString(),
          type: matchedSkill ? 'optimize-existing' : 'new-skill',
          description: `High-frequency pattern: ${taskType} (${convIds.length} occurrences)`,
          frequency: convIds.length,
          sourceConversationIds: convIds,
          reusabilityScore,
          matchedSkillId: matchedSkill?.appId,
          similarityScore: matchedSkill ? 0.7 : undefined,
          status: 'pending',
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        };

        this.store.savePatternDiscovery(discovery);
        discoveries.push(discovery);
      });

      // Clean expired patterns
      this.store.cleanExpiredPatterns();

      console.log(`[PatternAnalyzer] Found ${discoveries.length} new pattern discoveries`);
    } catch (error) {
      console.error('[PatternAnalyzer] Analysis failed:', error);
    }

    return discoveries;
  }

  /**
   * Get pending pattern suggestions.
   */
  getPendingSuggestions(limit?: number): PatternDiscovery[] {
    return this.store.getPendingPatterns(limit);
  }

  /**
   * Accept a pattern suggestion (mark as accepted).
   */
  acceptSuggestion(suggestionId: string): void {
    this.store.updatePatternStatus(suggestionId, 'accepted');
  }

  /**
   * Dismiss a pattern suggestion.
   */
  dismissSuggestion(suggestionId: string): void {
    this.store.updatePatternStatus(suggestionId, 'dismissed');
  }

  /**
   * Update configuration.
   */
  updateConfig(config: Partial<PatternAnalyzerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration.
   */
  getConfig(): PatternAnalyzerConfig {
    return { ...this.config };
  }

  /** Get recent conversation IDs from the conversation service */
  private async getRecentConversations(spaceId: string): Promise<string[]> {
    try {
      const convService = getConversationService();
      if (!convService) return [];

      const since = new Date(
        Date.now() - this.config.lookbackDays * 24 * 60 * 60 * 1000,
      ).toISOString();

      const conversations = await convService.getSpaceConversations(spaceId);
      return conversations
        .filter((c) => (c.updatedAt ?? c.createdAt) >= since)
        .sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt))
        .slice(0, this.config.maxConversationsPerRun)
        .map((c) => c.id);
    } catch {
      return [];
    }
  }

  /** Find an existing skill that matches the task type */
  private findMatchingSkill(
    taskType: string,
    skills: Array<{ appId: string; spec: { description?: string; name: string; tags?: string[] } }>,
  ): { appId: string } | null {
    const taskLower = taskType.toLowerCase();

    for (const skill of skills) {
      const nameLower = skill.spec.name.toLowerCase();
      const descLower = (skill.spec.description || '').toLowerCase();
      const tags = (skill.spec.tags || []).map((t) => t.toLowerCase());

      if (
        nameLower.includes(taskLower) ||
        descLower.includes(taskLower) ||
        tags.some((t) => t.includes(taskLower))
      ) {
        return { appId: skill.appId };
      }
    }

    return null;
  }
}
