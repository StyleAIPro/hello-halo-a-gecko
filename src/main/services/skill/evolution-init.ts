/**
 * Skill Evolution System - Initialization
 *
 * Initializes all evolution subsystems (store, tracker, analyzer,
 * engine, version manager) and wires them into the application lifecycle.
 *
 * Called from bootstrap/extended.ts after DatabaseManager is ready.
 */

import type { DatabaseManager } from '../../platform/store/types';
import type {
  EvolutionEngineConfig,
  PatternAnalyzerConfig,
  EvolutionSystemConfig,
} from '../../../shared/skill/skill-evolution-types';
import { DEFAULT_EVOLUTION_CONFIG } from '../../../shared/skill/skill-evolution-types';
import { EvolutionStore } from './evolution-store';
import { SkillUsageTracker } from './skill-usage-tracker';
import { BackgroundPatternAnalyzer } from './background-pattern-analyzer';
import { SkillEvolutionEngine } from './skill-evolution-engine';
import { SkillVersionManager } from './skill-version-manager';

/**
 * Initialize the skill evolution system.
 *
 * This is idempotent — calling it multiple times is safe.
 */
export function initSkillEvolution(
  db: DatabaseManager,
  config?: Partial<EvolutionSystemConfig>,
): {
  store: EvolutionStore;
  usageTracker: SkillUsageTracker;
  patternAnalyzer: BackgroundPatternAnalyzer;
  evolutionEngine: SkillEvolutionEngine;
  versionManager: SkillVersionManager;
} {
  const mergedConfig: EvolutionSystemConfig = {
    ...DEFAULT_EVOLUTION_CONFIG,
    ...config,
  };

  // 1. Initialize store (runs migrations)
  const store = new EvolutionStore(db);

  // 2. Initialize usage tracker
  const usageTracker = SkillUsageTracker.initialize(store);

  // 3. Initialize version manager
  const versionManager = SkillVersionManager.initialize(store);

  // 4. Initialize pattern analyzer
  const patternAnalyzer = BackgroundPatternAnalyzer.initialize(store, mergedConfig.patternAnalyzer);

  // 5. Initialize evolution engine
  const evolutionEngine = SkillEvolutionEngine.initialize(store, mergedConfig.evolutionEngine);

  console.log('[SkillEvolution] System initialized');

  return {
    store,
    usageTracker,
    patternAnalyzer,
    evolutionEngine,
    versionManager,
  };
}
