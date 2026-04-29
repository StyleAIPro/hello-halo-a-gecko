/**
 * Evolution Confidence Router
 *
 * Determines the confidence level for evolution suggestions based on
 * improvement percentage and usage count. Implements the three-tier
 * mechanism:
 *   High (≥30% + ≥10 uses) → auto-apply + notify
 *   Medium (≥15% + ≥5 uses) → silent apply + rollback available
 *   Low → needs user confirmation
 */

import type {
  ConfidenceLevel,
  ConfidenceThresholds,
} from '../../../shared/skill/skill-evolution-types';
import { DEFAULT_CONFIDENCE_THRESHOLDS } from '../../../shared/skill/skill-evolution-types';

export interface ConfidenceInput {
  improvement: number;
  totalUses: number;
  fitnessBaseline: number;
  fitnessEvolved: number;
}

export interface ConfidenceResult {
  level: ConfidenceLevel;
  autoApply: boolean;
  notifyUser: boolean;
  allowRollback: boolean;
  reason: string;
}

/**
 * Route an evolution suggestion to the appropriate confidence tier.
 */
export function routeConfidence(
  input: ConfidenceInput,
  thresholds: ConfidenceThresholds = DEFAULT_CONFIDENCE_THRESHOLDS,
): ConfidenceResult {
  const { improvement, totalUses } = input;

  // High confidence: significant improvement + sufficient usage data
  if (improvement >= thresholds.high.minImprovement && totalUses >= thresholds.high.minUses) {
    return {
      level: 'high',
      autoApply: true,
      notifyUser: true,
      allowRollback: true,
      reason: `Improvement ${(improvement * 100).toFixed(0)}% with ${totalUses} uses — high confidence auto-apply`,
    };
  }

  // Medium confidence: moderate improvement + some usage data
  if (improvement >= thresholds.medium.minImprovement && totalUses >= thresholds.medium.minUses) {
    return {
      level: 'medium',
      autoApply: true,
      notifyUser: false,
      allowRollback: true,
      reason: `Improvement ${(improvement * 100).toFixed(0)}% with ${totalUses} uses — medium confidence silent apply`,
    };
  }

  // Low confidence: insufficient data or marginal improvement
  return {
    level: 'low',
    autoApply: false,
    notifyUser: true,
    allowRollback: false,
    reason: `Improvement ${(improvement * 100).toFixed(0)}% with ${totalUses} uses — needs user confirmation`,
  };
}

/**
 * Check if a skill meets the minimum criteria for evolution consideration.
 */
export function meetsEvolutionCriteria(
  totalUses: number,
  avgScore: number,
  minUses: number = 3,
  lowScoreThreshold: number = 0.6,
): { eligible: boolean; reason: string } {
  if (totalUses < minUses) {
    return { eligible: false, reason: `Only ${totalUses} uses (minimum: ${minUses})` };
  }

  // Evolve if score is below threshold (needs improvement)
  // or if score is decent but we have enough data to try optimizing
  if (avgScore < lowScoreThreshold) {
    return { eligible: true, reason: `Score ${(avgScore * 100).toFixed(0)}% below threshold` };
  }

  // Even good skills can be optimized if we have enough data
  if (totalUses >= 10) {
    return {
      eligible: true,
      reason: `${totalUses} uses — sufficient data for optimization attempt`,
    };
  }

  return {
    eligible: false,
    reason: `Score ${(avgScore * 100).toFixed(0)}% is acceptable with only ${totalUses} uses`,
  };
}
