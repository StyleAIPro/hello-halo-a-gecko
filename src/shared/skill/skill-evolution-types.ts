/**
 * Skill Self-Evolution System - Shared Types
 *
 * Type definitions shared between main process and renderer for the
 * skill self-evolution pipeline (usage tracking, GEPA optimization,
 * confidence routing, version management).
 */

// ============================================
// Skill Usage Tracking
// ============================================

/** Single skill usage record */
export interface SkillUsageRecord {
  id: string;
  skillId: string;
  skillName: string;
  conversationId: string;
  spaceId: string;
  triggeredAt: string;
  triggerMode: 'slash-command' | 'auto-invoke' | 'injected';
  userContext: string;
  toolCalls: SkillUsageToolCall[];
  agentResponseSummary: string;
  tokenUsage: { input: number; output: number };
  userFeedback: 'positive' | 'negative' | 'neutral' | null;
  processCompliance: number | null;
  resultCorrectness: number | null;
}

export interface SkillUsageToolCall {
  name: string;
  status: 'success' | 'error';
  duration?: number;
}

/** Aggregated usage statistics for a skill */
export interface SkillUsageStats {
  skillId: string;
  totalUses: number;
  successRate: number;
  avgProcessCompliance: number;
  avgResultCorrectness: number;
  avgTokenCost: number;
  positiveFeedbackRate: number;
  lastUsedAt: string;
  usageTrend: 'increasing' | 'stable' | 'decreasing';
}

// ============================================
// Pattern Discovery
// ============================================

/** Pattern discovery result from background analysis */
export interface PatternDiscovery {
  id: string;
  discoveredAt: string;
  type: 'new-skill' | 'optimize-existing';
  description: string;
  frequency: number;
  sourceConversationIds: string[];
  reusabilityScore: number;
  matchedSkillId?: string;
  similarityScore?: number;
  status: 'pending' | 'accepted' | 'dismissed' | 'expired';
  suggestedSkillDraft?: {
    name: string;
    description: string;
    triggerCommand: string;
    systemPrompt: string;
  };
  expiresAt: string;
}

/** Pattern analyzer configuration */
export interface PatternAnalyzerConfig {
  analysisInterval: string;
  frequencyThreshold: number;
  reusabilityThreshold: number;
  lookbackDays: number;
  maxConversationsPerRun: number;
  enabled: boolean;
}

// ============================================
// Evolution / GEPA Optimization
// ============================================

/** GEPA fitness score (three dimensions, 0-1) */
export interface FitnessScore {
  processCompliance: number;
  resultCorrectness: number;
  conciseness: number;
  overall: number;
}

/** Evolution suggestion produced by GEPA optimizer */
export interface EvolutionSuggestion {
  id: string;
  skillId: string;
  type: 'prompt-optimize' | 'add-examples' | 'add-error-handling' | 'restructure';
  originalPrompt: string;
  optimizedPrompt: string;
  explanation: string;
  scores: {
    baseline: FitnessScore;
    evolved: FitnessScore;
    improvement: number;
  };
  usageDataSummary: string;
  confidence: 'high' | 'medium' | 'low';
  createdAt: string;
  status: 'pending' | 'auto-applied' | 'confirmed' | 'rejected' | 'rolled-back' | 'expired';
  expiresAt: string;
}

/** Evolution engine configuration */
export interface EvolutionEngineConfig {
  minUsageCount: number;
  lowScoreThreshold: number;
  gepaSteps: number;
  gepaGroupSize: number;
  suggestionInterval: string;
  enabled: boolean;
  optimizerModel: string;
}

// ============================================
// Version Management
// ============================================

/** Skill version snapshot */
export interface SkillVersionSnapshot {
  id: string;
  skillId: string;
  version: string;
  systemPrompt: string;
  fitnessScore: FitnessScore | null;
  createdAt: string;
  reason: 'manual' | 'auto-evolve' | 'rollback' | 'initial';
  relatedSuggestionId?: string;
}

// ============================================
// Confidence Routing
// ============================================

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface ConfidenceThresholds {
  high: { minImprovement: number; minUses: number };
  medium: { minImprovement: number; minUses: number };
}

export const DEFAULT_CONFIDENCE_THRESHOLDS: ConfidenceThresholds = {
  high: { minImprovement: 0.3, minUses: 10 },
  medium: { minImprovement: 0.15, minUses: 5 },
};

// ============================================
// Evolution Guidance
// ============================================

/** Guidance injected into system prompt to encourage skill feedback */
export interface EvolutionGuidanceContext {
  enabledSkills: Array<{
    id: string;
    name: string;
    triggerCommand: string;
    description: string;
  }>;
}

// ============================================
// Skill Health
// ============================================

/** Health status of a skill based on usage and evolution data */
export interface SkillHealth {
  skillId: string;
  status: 'healthy' | 'needs-attention' | 'underperforming' | 'unused';
  fitnessScore: FitnessScore | null;
  totalUses: number;
  lastEvolvedAt: string | null;
  activeSuggestionCount: number;
  recentTrend: 'improving' | 'stable' | 'declining';
}

// ============================================
// Evolution System Configuration (top-level)
// ============================================

export interface EvolutionSystemConfig {
  usageTracking: { enabled: boolean };
  patternAnalyzer: PatternAnalyzerConfig;
  evolutionEngine: EvolutionEngineConfig;
  confidenceThresholds: ConfidenceThresholds;
}

export const DEFAULT_EVOLUTION_CONFIG: EvolutionSystemConfig = {
  usageTracking: { enabled: true },
  patternAnalyzer: {
    analysisInterval: '6h',
    frequencyThreshold: 5,
    reusabilityThreshold: 0.7,
    lookbackDays: 7,
    maxConversationsPerRun: 50,
    enabled: false,
  },
  evolutionEngine: {
    minUsageCount: 10,
    lowScoreThreshold: 0.6,
    gepaSteps: 10,
    gepaGroupSize: 6,
    suggestionInterval: '1d',
    enabled: false,
    optimizerModel: '',
  },
  confidenceThresholds: DEFAULT_CONFIDENCE_THRESHOLDS,
};
