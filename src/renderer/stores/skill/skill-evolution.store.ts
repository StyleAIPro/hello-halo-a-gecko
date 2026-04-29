/**
 * Skill Evolution Store - Zustand state management for evolution panel
 */

import { create } from 'zustand';
import type {
  SkillUsageStats,
  SkillUsageRecord,
  EvolutionSuggestion,
  PatternDiscovery,
  SkillVersionSnapshot,
  SkillHealth,
  EvolutionEngineConfig,
  PatternAnalyzerConfig,
} from '../../../shared/skill/skill-evolution-types';

// ============================================
// State Interface
// ============================================

interface SkillEvolutionState {
  // Usage statistics
  usageStats: Map<string, SkillUsageStats>;
  usageLeaderboard: SkillUsageStats[];
  usageHistory: SkillUsageRecord[];
  selectedSkillId: string | null;

  // Evolution suggestions
  suggestions: EvolutionSuggestion[];
  pendingSuggestions: EvolutionSuggestion[];

  // Version history
  versionHistory: SkillVersionSnapshot[];

  // Pattern discoveries
  patterns: PatternDiscovery[];

  // Configuration
  engineConfig: EvolutionEngineConfig | null;
  analyzerConfig: PatternAnalyzerConfig | null;

  // Loading states
  loadingStats: boolean;
  loadingSuggestions: boolean;
  loadingVersions: boolean;
  loadingPatterns: boolean;
  evolving: boolean;

  // Error states
  error: string | null;

  // Actions
  loadUsageStats: (skillId: string) => Promise<void>;
  loadLeaderboard: () => Promise<void>;
  loadUsageHistory: (skillId: string, limit?: number) => Promise<void>;

  loadSuggestions: (skillId?: string) => Promise<void>;
  loadPendingSuggestions: (skillId?: string) => Promise<void>;
  confirmSuggestion: (suggestionId: string) => Promise<boolean>;
  rejectSuggestion: (suggestionId: string) => Promise<void>;
  rollbackSuggestion: (suggestionId: string) => Promise<boolean>;

  evolveSkill: (skillId: string) => Promise<EvolutionSuggestion | null>;
  runEvolutionCycle: () => Promise<EvolutionSuggestion[]>;

  loadVersionHistory: (skillId: string) => Promise<void>;
  rollbackVersion: (skillId: string, versionId: string) => Promise<boolean>;

  loadPatterns: () => Promise<void>;
  analyzePatterns: () => Promise<void>;
  acceptPattern: (patternId: string) => Promise<void>;
  dismissPattern: (patternId: string) => Promise<void>;

  loadConfig: () => Promise<void>;
  updateConfig: (config: { engine?: Partial<EvolutionEngineConfig>; analyzer?: Partial<PatternAnalyzerConfig> }) => Promise<void>;

  setSelectedSkill: (skillId: string | null) => void;
  clearError: () => void;
}

// ============================================
// IPC Helper
// ============================================

async function ipcInvoke(channel: string, ...args: unknown[]): Promise<any> {
  // Use the standard window.aicoBot API methods
  // For evolution IPC, we fall back to direct ipcRenderer-like access
  const aicoBot = (window as any).aicoBot;
  if (!aicoBot) return { success: false, error: 'API not available' };

  // Evolution channels use dynamic invoke
  if (aicoBot.invoke) {
    return aicoBot.invoke(channel, ...args);
  }

  return { success: false, error: 'invoke not available' };
}

// ============================================
// Store
// ============================================

export const useSkillEvolutionStore = create<SkillEvolutionState>((set, get) => ({
  // Initial state
  usageStats: new Map(),
  usageLeaderboard: [],
  usageHistory: [],
  selectedSkillId: null,
  suggestions: [],
  pendingSuggestions: [],
  versionHistory: [],
  patterns: [],
  engineConfig: null,
  analyzerConfig: null,
  loadingStats: false,
  loadingSuggestions: false,
  loadingVersions: false,
  loadingPatterns: false,
  evolving: false,
  error: null,

  // Actions
  loadUsageStats: async (skillId: string) => {
    set({ loadingStats: true, error: null });
    try {
      const result = await ipcInvoke('skill:evolution:usage-stats', skillId);
      if (result?.success) {
        const stats = new Map(get().usageStats);
        stats.set(skillId, result.data);
        set({ usageStats: stats, loadingStats: false });
      }
    } catch (error) {
      set({ error: String(error), loadingStats: false });
    }
  },

  loadLeaderboard: async () => {
    set({ loadingStats: true });
    try {
      const result = await ipcInvoke('skill:evolution:leaderboard', 20);
      if (result?.success) {
        set({ usageLeaderboard: result.data || [], loadingStats: false });
      }
    } catch (error) {
      set({ error: String(error), loadingStats: false });
    }
  },

  loadUsageHistory: async (skillId: string, limit?: number) => {
    set({ loadingStats: true });
    try {
      const result = await ipcInvoke('skill:evolution:usage-history', skillId, limit);
      if (result?.success) {
        set({ usageHistory: result.data || [], loadingStats: false });
      }
    } catch (error) {
      set({ error: String(error), loadingStats: false });
    }
  },

  loadSuggestions: async (skillId?: string) => {
    set({ loadingSuggestions: true });
    try {
      const result = await ipcInvoke('skill:evolution:suggestions', skillId);
      if (result?.success) {
        set({ suggestions: result.data || [], loadingSuggestions: false });
      }
    } catch (error) {
      set({ error: String(error), loadingSuggestions: false });
    }
  },

  loadPendingSuggestions: async (skillId?: string) => {
    try {
      const result = await ipcInvoke('skill:evolution:pending-suggestions', skillId);
      if (result?.success) {
        set({ pendingSuggestions: result.data || [] });
      }
    } catch (error) {
      set({ error: String(error) });
    }
  },

  confirmSuggestion: async (suggestionId: string) => {
    try {
      const result = await ipcInvoke('skill:evolution:confirm-suggestion', suggestionId);
      if (result?.success) {
        await get().loadPendingSuggestions();
        await get().loadSuggestions();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  },

  rejectSuggestion: async (suggestionId: string) => {
    try {
      await ipcInvoke('skill:evolution:reject-suggestion', suggestionId);
      await get().loadPendingSuggestions();
      await get().loadSuggestions();
    } catch (error) {
      set({ error: String(error) });
    }
  },

  rollbackSuggestion: async (suggestionId: string) => {
    try {
      const result = await ipcInvoke('skill:evolution:rollback-suggestion', suggestionId);
      if (result?.success) {
        await get().loadSuggestions();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  },

  evolveSkill: async (skillId: string) => {
    set({ evolving: true, error: null });
    try {
      const result = await ipcInvoke('skill:evolution:evolve-skill', skillId);
      set({ evolving: false });
      if (result?.success) {
        await get().loadSuggestions(skillId);
        return result.data;
      }
      return null;
    } catch (error) {
      set({ evolving: false, error: String(error) });
      return null;
    }
  },

  runEvolutionCycle: async () => {
    set({ evolving: true, error: null });
    try {
      const result = await ipcInvoke('skill:evolution:run-cycle');
      set({ evolving: false });
      if (result?.success) {
        await get().loadSuggestions();
        return result.data || [];
      }
      return [];
    } catch (error) {
      set({ evolving: false, error: String(error) });
      return [];
    }
  },

  loadVersionHistory: async (skillId: string) => {
    set({ loadingVersions: true });
    try {
      const result = await ipcInvoke('skill:evolution:version-history', skillId);
      if (result?.success) {
        set({ versionHistory: result.data || [], loadingVersions: false });
      }
    } catch (error) {
      set({ error: String(error), loadingVersions: false });
    }
  },

  rollbackVersion: async (skillId: string, versionId: string) => {
    try {
      const result = await ipcInvoke('skill:evolution:rollback', skillId, versionId);
      if (result?.success) {
        await get().loadVersionHistory(skillId);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  },

  loadPatterns: async () => {
    set({ loadingPatterns: true });
    try {
      const result = await ipcInvoke('skill:evolution:pending-patterns', 20);
      if (result?.success) {
        set({ patterns: result.data || [], loadingPatterns: false });
      }
    } catch (error) {
      set({ error: String(error), loadingPatterns: false });
    }
  },

  analyzePatterns: async () => {
    set({ loadingPatterns: true });
    try {
      const result = await ipcInvoke('skill:evolution:analyze-patterns');
      if (result?.success) {
        set({ patterns: result.data || [], loadingPatterns: false });
      }
    } catch (error) {
      set({ error: String(error), loadingPatterns: false });
    }
  },

  acceptPattern: async (patternId: string) => {
    try {
      await ipcInvoke('skill:evolution:accept-pattern', patternId);
      await get().loadPatterns();
    } catch (error) {
      set({ error: String(error) });
    }
  },

  dismissPattern: async (patternId: string) => {
    try {
      await ipcInvoke('skill:evolution:dismiss-pattern', patternId);
      await get().loadPatterns();
    } catch (error) {
      set({ error: String(error) });
    }
  },

  loadConfig: async () => {
    try {
      const result = await ipcInvoke('skill:evolution:config');
      if (result?.success) {
        set({
          engineConfig: result.data?.engine ?? null,
          analyzerConfig: result.data?.analyzer ?? null,
        });
      }
    } catch (error) {
      set({ error: String(error) });
    }
  },

  updateConfig: async (config) => {
    try {
      await ipcInvoke('skill:evolution:update-config', config);
      await get().loadConfig();
    } catch (error) {
      set({ error: String(error) });
    }
  },

  setSelectedSkill: (skillId) => set({ selectedSkillId: skillId }),
  clearError: () => set({ error: null }),
}));
