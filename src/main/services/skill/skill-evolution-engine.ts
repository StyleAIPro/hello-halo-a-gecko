/**
 * Skill Evolution Engine
 *
 * Core engine that uses @jaex/dstsx GEPA/MIPROv2 optimizers to evolve
 * skill system_prompts based on usage data and feedback.
 *
 * Evolution flow:
 * 1. Check which skills meet evolution criteria
 * 2. Build evaluation dataset from usage records
 * 3. Run GEPA optimization (or MIPROv2 as fallback)
 * 4. Route result through confidence tiers
 * 5. Auto-apply or queue for user confirmation
 */

import { v4 as uuid } from 'uuid';
import { GEPA, settings, Anthropic, OpenAI } from '@jaex/dstsx';
import type {
  EvolutionSuggestion,
  EvolutionEngineConfig,
  ConfidenceLevel,
} from '../../../shared/skill/skill-evolution-types';
import { DEFAULT_EVOLUTION_CONFIG } from '../../../shared/skill/skill-evolution-types';
import type { EvolutionStore } from './evolution-store';
import { SkillManager } from './skill-manager';
import { SkillVersionManager } from './skill-version-manager';
import {
  createSkillModule,
  buildExamplesFromUsage,
  splitExamples,
  createSkillFitnessMetric,
  evaluateSkillModule,
  extractOptimizedInstructions,
} from './skill-module';
import { routeConfidence, meetsEvolutionCriteria } from './evolution-confidence';

export class SkillEvolutionEngine {
  private static instance: SkillEvolutionEngine;
  private store: EvolutionStore;
  private config: EvolutionEngineConfig;

  private constructor(store: EvolutionStore, config?: Partial<EvolutionEngineConfig>) {
    this.store = store;
    this.config = { ...DEFAULT_EVOLUTION_CONFIG.evolutionEngine, ...config };
  }

  static getInstance(): SkillEvolutionEngine | undefined {
    return SkillEvolutionEngine.instance;
  }

  static initialize(
    store: EvolutionStore,
    config?: Partial<EvolutionEngineConfig>,
  ): SkillEvolutionEngine {
    if (!SkillEvolutionEngine.instance) {
      SkillEvolutionEngine.instance = new SkillEvolutionEngine(store, config);
    }
    return SkillEvolutionEngine.instance;
  }

  /**
   * Initialize the LLM adapter for DSPy.
   * Must be called before any optimization with user's API credentials.
   */
  configureLLM(params: {
    provider: 'anthropic' | 'openai' | string;
    apiKey: string;
    model: string;
    baseURL?: string;
  }): void {
    let lm;
    if (params.provider === 'openai' || params.provider.includes('openai')) {
      lm = new OpenAI({
        apiKey: params.apiKey,
        model: params.model,
        baseURL: params.baseURL,
      });
    } else {
      lm = new Anthropic({
        apiKey: params.apiKey,
        model: params.model,
      });
    }

    settings.configure({ lm });
    this.config.optimizerModel = params.model;
    console.log(`[EvolutionEngine] LLM configured: ${params.provider}/${params.model}`);
  }

  /**
   * Evolve a single skill using GEPA.
   *
   * Returns an EvolutionSuggestion if optimization was beneficial,
   * or null if the skill doesn't need/can't benefit from optimization.
   */
  async evolveSkill(skillId: string): Promise<EvolutionSuggestion | null> {
    if (!this.config.enabled) {
      console.log('[EvolutionEngine] Engine is disabled');
      return null;
    }

    const skillManager = SkillManager.getInstance();
    const skill = skillManager?.getSkill(skillId);
    if (!skill) {
      console.warn(`[EvolutionEngine] Skill not found: ${skillId}`);
      return null;
    }

    const currentPrompt = skill.spec.system_prompt || '';

    // Get usage data
    const stats = this.store.getUsageStats(skillId);
    const avgScore =
      stats.avgProcessCompliance * 0.4 + stats.avgResultCorrectness * 0.4 + 0.5 * 0.2;

    // Check eligibility
    const { eligible, reason } = meetsEvolutionCriteria(
      stats.totalUses,
      avgScore,
      this.config.minUsageCount,
      this.config.lowScoreThreshold,
    );

    if (!eligible) {
      console.log(`[EvolutionEngine] Skill ${skillId} not eligible: ${reason}`);
      return null;
    }

    console.log(`[EvolutionEngine] Evolving skill ${skillId}: ${reason}`);

    // Build dataset
    const usageRecords = this.store.getRecentUsage(skillId, 30);
    const examples = buildExamplesFromUsage(usageRecords, currentPrompt);

    if (examples.length < 3) {
      console.log(`[EvolutionEngine] Not enough examples (${examples.length}) for ${skillId}`);
      return null;
    }

    const { train, val, holdout } = splitExamples(examples);

    // Create baseline module and evaluate
    const baselineModule = createSkillModule(currentPrompt);
    const baselineScore = await evaluateSkillModule(baselineModule, holdout);

    // Create module for optimization
    const studentModule = createSkillModule(currentPrompt);
    const metric = createSkillFitnessMetric(train);

    try {
      // Run GEPA optimization
      const gepa = new GEPA({
        numSteps: this.config.gepaSteps,
        groupSize: this.config.gepaGroupSize,
        valset: val,
      });

      console.log(
        `[EvolutionEngine] Running GEPA for ${skillId}: ${this.config.gepaSteps} steps, ${this.config.gepaGroupSize} group size`,
      );

      const optimized = await gepa.compile(studentModule, train, metric);

      // Extract optimized instructions
      const optimizedPrompt = extractOptimizedInstructions(optimized);
      if (!optimizedPrompt) {
        console.warn(`[EvolutionEngine] GEPA returned no optimized instructions for ${skillId}`);
        return null;
      }

      // Evaluate optimized version on holdout
      const evolvedModule = createSkillModule(optimizedPrompt);
      const evolvedScore = await evaluateSkillModule(evolvedModule, holdout);

      const improvement = evolvedScore.overall - baselineScore.overall;

      // Route through confidence
      const confidenceResult = routeConfidence({
        improvement,
        totalUses: stats.totalUses,
        fitnessBaseline: baselineScore.overall,
        fitnessEvolved: evolvedScore.overall,
      });

      const suggestion: EvolutionSuggestion = {
        id: uuid(),
        skillId,
        type: 'prompt-optimize',
        originalPrompt: currentPrompt,
        optimizedPrompt,
        explanation: confidenceResult.reason,
        scores: {
          baseline: baselineScore,
          evolved: evolvedScore,
          improvement,
        },
        usageDataSummary: `${stats.totalUses} uses, avg score ${(avgScore * 100).toFixed(0)}%`,
        confidence: confidenceResult.level,
        createdAt: new Date().toISOString(),
        status: 'pending',
        expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      };

      // Auto-apply if confidence allows
      if (confidenceResult.autoApply) {
        await this.autoApplySuggestion(suggestion, confidenceResult);
      } else {
        this.store.saveSuggestion(suggestion);
      }

      return suggestion;
    } catch (error) {
      console.error(`[EvolutionEngine] GEPA failed for ${skillId}:`, error);
      return null;
    }
  }

  /**
   * Run evolution cycle for all eligible skills.
   */
  async runEvolutionCycle(): Promise<EvolutionSuggestion[]> {
    if (!this.config.enabled) return [];

    const skillManager = SkillManager.getInstance();
    const skills = skillManager?.getInstalledSkills().filter((s) => s.enabled) || [];
    const suggestions: EvolutionSuggestion[] = [];

    for (const skill of skills) {
      try {
        const suggestion = await this.evolveSkill(skill.appId);
        if (suggestion) {
          suggestions.push(suggestion);
        }
      } catch (error) {
        console.error(`[EvolutionEngine] Error evolving ${skill.appId}:`, error);
      }
    }

    // Clean expired suggestions
    this.store.cleanExpiredSuggestions();

    console.log(`[EvolutionEngine] Cycle complete: ${suggestions.length} suggestions generated`);
    return suggestions;
  }

  /**
   * Get pending suggestions that need user confirmation.
   */
  getPendingSuggestions(skillId?: string): EvolutionSuggestion[] {
    return this.store.getPendingSuggestions(skillId);
  }

  /**
   * Get all suggestions (including applied ones) for a skill.
   */
  getAllSuggestions(skillId?: string, limit?: number): EvolutionSuggestion[] {
    return this.store.getAllSuggestions(skillId, limit);
  }

  /**
   * User confirms a low-confidence suggestion.
   */
  async confirmSuggestion(suggestionId: string): Promise<boolean> {
    const suggestion = this.store.getSuggestion(suggestionId);
    if (!suggestion) return false;

    try {
      const versionManager = SkillVersionManager.getInstance();
      if (!versionManager) return false;

      await versionManager.applyVersion(
        suggestion.skillId,
        suggestion.optimizedPrompt,
        'auto-evolve',
        suggestion.scores.evolved,
        suggestion.id,
      );

      this.store.updateSuggestionStatus(suggestionId, 'confirmed');
      return true;
    } catch (error) {
      console.error(`[EvolutionEngine] Failed to confirm suggestion ${suggestionId}:`, error);
      return false;
    }
  }

  /**
   * User rejects a suggestion.
   */
  rejectSuggestion(suggestionId: string): void {
    this.store.updateSuggestionStatus(suggestionId, 'rejected');
  }

  /**
   * Rollback a previously applied suggestion.
   */
  async rollbackSuggestion(suggestionId: string): Promise<boolean> {
    const suggestion = this.store.getSuggestion(suggestionId);
    if (!suggestion) return false;

    try {
      const versionManager = SkillVersionManager.getInstance();
      if (!versionManager) return false;

      // Find the version snapshot created for this suggestion
      const history = versionManager.getVersionHistory(suggestion.skillId);
      const snapshot = history.find((h) => h.relatedSuggestionId === suggestionId);

      if (snapshot) {
        // Rollback to the version BEFORE this snapshot (the original)
        const prevVersion = history.find(
          (h) => new Date(h.createdAt) < new Date(snapshot.createdAt),
        );
        if (prevVersion) {
          await versionManager.rollback(suggestion.skillId, prevVersion.id);
        }
      }

      this.store.updateSuggestionStatus(suggestionId, 'rolled-back');
      return true;
    } catch (error) {
      console.error(`[EvolutionEngine] Failed to rollback ${suggestionId}:`, error);
      return false;
    }
  }

  /**
   * Update configuration.
   */
  updateConfig(config: Partial<EvolutionEngineConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration.
   */
  getConfig(): EvolutionEngineConfig {
    return { ...this.config };
  }

  /** Auto-apply a suggestion based on confidence level */
  private async autoApplySuggestion(
    suggestion: EvolutionSuggestion,
    confidence: { level: ConfidenceLevel; notifyUser: boolean },
  ): Promise<void> {
    try {
      const versionManager = SkillVersionManager.getInstance();
      if (!versionManager) return;

      await versionManager.applyVersion(
        suggestion.skillId,
        suggestion.optimizedPrompt,
        'auto-evolve',
        suggestion.scores.evolved,
        suggestion.id,
      );

      suggestion.status = 'auto-applied';
      this.store.saveSuggestion(suggestion);

      console.log(
        `[EvolutionEngine] Auto-applied ${confidence.level} confidence suggestion for ${suggestion.skillId}`,
      );
    } catch (error) {
      console.error(`[EvolutionEngine] Auto-apply failed:`, error);
      this.store.saveSuggestion(suggestion);
    }
  }
}
