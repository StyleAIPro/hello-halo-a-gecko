/**
 * Skill Store - Zustand state management for Skill page
 */

import { create } from 'zustand';
import { api } from '../../api';
import type {
  InstalledSkill,
  RemoteSkillItem,
  SkillMarketSource,
  SkillLibraryConfig,
  SkillFileNode,
} from '../../../shared/skill/skill-types';

// ============================================
// Types
// ============================================

/**
 * 对话分析结果
 */
export interface ConversationAnalysis {
  userIntent: {
    taskType: string;
    primaryGoal: string;
    keywords: string[];
  };
  toolPattern: {
    toolSequence: string[];
    successPattern: string;
  };
  reusability: {
    score: number;
    patterns: string[];
  };
}

/**
 * 相似技能
 */
export interface SimilarSkill {
  skill: InstalledSkill;
  similarity: number;
  matchReasons: string[];
  suggestedImprovements: string[];
}

// ============================================
// State Interface
// ============================================

interface SkillState {
  // 已安装的技能
  installedSkills: InstalledSkill[];
  loading: boolean;
  error: string | null;

  // 市场技能
  marketSkills: RemoteSkillItem[];
  marketLoading: boolean;
  marketError: string | null;

  // 市场源
  marketSources: SkillMarketSource[];

  // 技能库配置
  config: SkillLibraryConfig | null;

  // 当前视图
  currentView: 'library' | 'market' | 'editor';
  searchQuery: string;
  selectedSkillId: string | null;

  // === 技能生成器状态 ===
  // 分析结果
  analysisResult: ConversationAnalysis | null;
  analysisLoading: boolean;
  analysisError: string | null;
  // 相似技能
  similarSkills: SimilarSkill[];
  // 生成的技能配置
  generatedSkillSpec: {
    name: string;
    description: string;
    triggerCommand: string;
    systemPrompt: string;
  } | null;

  // Agent 面板状态（仅用于控制面板显示）
  agentPanelOpen: boolean;

  // GitHub 推送状态
  pushLoading: boolean;
  pushError: string | null;
  pushResult: { prUrl: string; warning?: string } | null;

  // GitHub 仓库目录列表
  repoDirs: string[];
  repoDirsLoading: boolean;

  // Sync to remote server 状态
  syncLoading: boolean;
  syncError: string | null;
  syncResult: { serverId: string; success: boolean } | null;

  // Actions - 已安装技能
  loadInstalledSkills: () => Promise<void>;
  toggleSkill: (skillId: string, enabled: boolean) => Promise<boolean>;
  uninstallSkill: (skillId: string) => Promise<boolean>;
  exportSkill: (skillId: string) => Promise<string | null>;

  // Actions - 市场技能
  loadMarketSkills: () => Promise<void>;
  searchMarketSkills: (query: string) => Promise<void>;
  installFromMarket: (skillId: string) => Promise<boolean>;

  // Actions - 市场源
  loadMarketSources: () => Promise<void>;
  toggleMarketSource: (sourceId: string, enabled: boolean) => Promise<void>;
  setActiveMarketSource: (sourceId: string) => Promise<void>;
  addMarketSource: (source: {
    name: string;
    url: string;
    repos?: string[];
    description?: string;
  }) => Promise<void>;
  removeMarketSource: (sourceId: string) => Promise<void>;
  getMarketSkillDetail: (skillId: string) => Promise<RemoteSkillItem | null>;

  // Actions - 配置
  loadConfig: () => Promise<void>;
  updateConfig: (config: Partial<SkillLibraryConfig>) => Promise<void>;

  // Actions - UI
  setCurrentView: (view: 'library' | 'market' | 'editor') => void;
  setSearchQuery: (query: string) => void;
  setSelectedSkillId: (id: string | null) => void;
  refreshSkills: () => Promise<void>;

  // Actions - Remote skill listing
  remoteSkills: Record<string, InstalledSkill[]>;
  remoteSkillsLoading: Record<string, boolean>;
  remoteSkillsError: Record<string, string | null>;
  loadRemoteSkills: (serverId: string) => Promise<void>;

  // Actions - 文件操作
  loadSkillFiles: (skillId: string) => Promise<SkillFileNode[] | null>;
  loadSkillFileContent: (skillId: string, filePath: string) => Promise<string | null>;

  // Actions - 技能生成器
  analyzeConversations: (spaceId: string, conversationIds: string[]) => Promise<void>;
  clearGeneratorState: () => void;
  setGeneratedSkillSpec: (spec: SkillState['generatedSkillSpec']) => void;

  // Actions - Agent 面板
  setAgentPanelOpen: (open: boolean) => void;

  // Actions - GitHub 推送
  pushSkillToGitHub: (
    skillId: string,
    targetRepo: string,
    targetPath?: string,
  ) => Promise<{ success: boolean; prUrl?: string }>;
  pushSkillToGitCode: (
    skillId: string,
    targetRepo: string,
    targetPath?: string,
  ) => Promise<{ success: boolean; prUrl?: string }>;
  loadRepoDirectories: (repo: string) => Promise<void>;
  validateGitHubRepo: (repo: string) => Promise<{
    valid: boolean;
    hasSkillsDir: boolean;
    skillCount: number;
    error?: string;
  } | null>;
  validateGitCodeRepo: (repo: string) => Promise<{
    valid: boolean;
    hasSkillsDir: boolean;
    skillCount: number;
    error?: string;
  } | null>;
  addGitHubSource: (repoUrl: string) => Promise<boolean>;
  clearPushState: () => void;

  // Actions - Sync to remote server
  syncSkillToRemote: (skillId: string, serverId: string) => Promise<boolean>;
  clearSyncState: () => void;

  // Actions - Sync from remote server
  syncSkillFromRemote: (skillId: string, serverId: string) => Promise<boolean>;
  clearSyncFromRemoteState: () => void;
}

// ============================================
// Initial State
// ============================================

const initialState = {
  installedSkills: [],
  loading: false,
  error: null,
  marketSkills: [],
  marketLoading: false,
  marketError: null,
  marketSources: [],
  config: null,
  currentView: 'library' as const,
  searchQuery: '',
  selectedSkillId: null,
  // 生成器状态
  analysisResult: null,
  analysisLoading: false,
  analysisError: null,
  similarSkills: [],
  generatedSkillSpec: null,
  // Agent 面板状态
  agentPanelOpen: false,
  // GitHub 推送状态
  pushLoading: false,
  pushError: null,
  pushResult: null,
  // GitHub 仓库目录列表
  repoDirs: [],
  repoDirsLoading: false,
  // Sync to remote server 状态
  syncLoading: false,
  syncError: null,
  syncResult: null,
  // Sync from remote server 状态
  syncFromRemoteLoading: false,
  syncFromRemoteError: null,
  syncFromRemoteResult: null,
  // 远程技能状态
  remoteSkills: {} as Record<string, InstalledSkill[]>,
  remoteSkillsLoading: {} as Record<string, boolean>,
  remoteSkillsError: {} as Record<string, string | null>,
};

// ============================================
// Store
// ============================================

export const useSkillStore = create<SkillState>((set, get) => ({
  ...initialState,

  // ==========================================
  // 已安装技能
  // ==========================================

  loadInstalledSkills: async () => {
    set({ loading: true, error: null });
    try {
      const result = await api.skillList();
      if (result.success) {
        set({ installedSkills: result.data || [], loading: false });
      } else {
        set({ error: result.error || 'Failed to load skills', loading: false });
      }
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to load skills',
        loading: false,
      });
    }
  },

  toggleSkill: async (skillId: string, enabled: boolean) => {
    try {
      const result = await api.skillToggle(skillId, enabled);
      if (result.success) {
        set((state) => ({
          installedSkills: state.installedSkills.map((skill) =>
            skill.appId === skillId ? { ...skill, enabled } : skill,
          ),
        }));
        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to toggle skill:', error);
      return false;
    }
  },

  uninstallSkill: async (skillId: string) => {
    try {
      const result = await api.skillUninstall(skillId);
      if (result.success) {
        set((state) => ({
          installedSkills: state.installedSkills.filter((skill) => skill.appId !== skillId),
          selectedSkillId: state.selectedSkillId === skillId ? null : state.selectedSkillId,
        }));
        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to uninstall skill:', error);
      return false;
    }
  },

  exportSkill: async (skillId: string) => {
    try {
      const result = await api.skillExport(skillId);
      if (result.success) {
        return result.data || null;
      }
      return null;
    } catch (error) {
      console.error('Failed to export skill:', error);
      return null;
    }
  },

  // ==========================================
  // 市场技能
  // ==========================================

  loadMarketSkills: async (sourceId?: string) => {
    set({ marketLoading: true, marketError: null });
    try {
      const result = await api.skillMarketList(sourceId);
      if (result.success) {
        set({ marketSkills: result.data || [], marketLoading: false });
      } else {
        set({ marketError: result.error || 'Failed to load market skills', marketLoading: false });
      }
    } catch (error) {
      set({
        marketError: error instanceof Error ? error.message : 'Failed to load market skills',
        marketLoading: false,
      });
    }
  },

  searchMarketSkills: async (query: string) => {
    if (!query.trim()) {
      get().loadMarketSkills();
      return;
    }

    try {
      const result = await api.skillMarketSearch(query);
      if (result.success) {
        set({ marketSkills: result.data || [] });
      }
    } catch (error) {
      console.error('Failed to search skills:', error);
    }
  },

  installFromMarket: async (skillId: string) => {
    try {
      const result = await api.skillInstall({ mode: 'market', skillId });
      return result.success || false;
    } catch (error) {
      console.error('Failed to install skill from market:', error);
      return false;
    }
  },

  // ==========================================
  // 市场源
  // ==========================================

  loadMarketSources: async () => {
    try {
      const result = await api.skillMarketSources();
      if (result.success) {
        set({ marketSources: result.data || [] });
      }
    } catch (error) {
      console.error('Failed to load market sources:', error);
    }
  },

  toggleMarketSource: async (sourceId: string, enabled: boolean) => {
    try {
      await api.skillMarketToggleSource(sourceId, enabled);
      set((state) => ({
        marketSources: state.marketSources.map((source) =>
          source.id === sourceId ? { ...source, enabled } : source,
        ),
      }));
    } catch (error) {
      console.error('Failed to toggle market source:', error);
    }
  },

  setActiveMarketSource: async (sourceId: string) => {
    try {
      await api.skillMarketSetActiveSource(sourceId);
    } catch (error) {
      console.error('Failed to set active market source:', error);
    }
  },

  addMarketSource: async (source: {
    name: string;
    url: string;
    repos?: string[];
    description?: string;
  }) => {
    try {
      const result = await api.skillMarketAddSource(source);
      if (result.success && result.data) {
        set((state) => ({
          marketSources: [...state.marketSources, result.data],
        }));
      }
    } catch (error) {
      console.error('Failed to add market source:', error);
    }
  },

  removeMarketSource: async (sourceId: string) => {
    try {
      await api.skillMarketRemoveSource(sourceId);
      set((state) => ({
        marketSources: state.marketSources.filter((s) => s.id !== sourceId),
      }));
    } catch (error) {
      console.error('Failed to remove market source:', error);
    }
  },

  getMarketSkillDetail: async (skillId: string) => {
    try {
      const result = await api.skillMarketDetail(skillId);
      if (result.success) {
        return result.data || null;
      }
      return null;
    } catch (error) {
      console.error('Failed to get market skill detail:', error);
      return null;
    }
  },

  // ==========================================
  // 配置
  // ==========================================

  loadConfig: async () => {
    try {
      const result = await api.skillConfigGet();
      if (result.success) {
        set({ config: result.data || null });
      }
    } catch (error) {
      console.error('Failed to load skill config:', error);
    }
  },

  updateConfig: async (config: Partial<SkillLibraryConfig>) => {
    try {
      await api.skillConfigUpdate(config);
      set((state) => ({
        config: state.config ? { ...state.config, ...config } : null,
      }));
    } catch (error) {
      console.error('Failed to update skill config:', error);
    }
  },

  // ==========================================
  // UI
  // ==========================================

  refreshSkills: async () => {
    try {
      await api.skillRefresh();
      await get().loadInstalledSkills();
    } catch (error) {
      console.error('Failed to refresh skills:', error);
    }
  },

  setCurrentView: (view) => set({ currentView: view }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setSelectedSkillId: (id) => set({ selectedSkillId: id }),

  // ==========================================
  // 文件操作
  // ==========================================

  loadSkillFiles: async (skillId: string): Promise<SkillFileNode[] | null> => {
    try {
      const result = await api.skillFiles(skillId);
      if (result.success) {
        return result.data || null;
      }
      return null;
    } catch (error) {
      console.error('Failed to load skill files:', error);
      return null;
    }
  },

  loadSkillFileContent: async (skillId: string, filePath: string): Promise<string | null> => {
    try {
      const result = await api.skillFileContent(skillId, filePath);
      if (result.success) {
        return result.data || null;
      }
      return null;
    } catch (error) {
      console.error('Failed to load skill file content:', error);
      return null;
    }
  },

  // ==========================================
  // 技能生成器
  // ==========================================

  analyzeConversations: async (spaceId: string, conversationIds: string[]) => {
    set({ analysisLoading: true, analysisError: null });

    try {
      const result = await api.skillAnalyzeConversations(spaceId, conversationIds);

      if (result.success && result.data) {
        set({
          analysisResult: result.data.analysisResult,
          similarSkills: result.data.similarSkills || [],
          analysisLoading: false,
        });
      } else {
        set({
          analysisError: result.error || 'Failed to analyze conversations',
          analysisLoading: false,
        });
      }
    } catch (error) {
      set({
        analysisError: error instanceof Error ? error.message : 'Failed to analyze conversations',
        analysisLoading: false,
      });
    }
  },

  clearGeneratorState: () => {
    set({
      analysisResult: null,
      analysisError: null,
      similarSkills: [],
      generatedSkillSpec: null,
      agentPanelOpen: false,
    });
  },

  setGeneratedSkillSpec: (spec) => set({ generatedSkillSpec: spec }),

  // ==========================================
  // Agent 面板
  // ==========================================

  setAgentPanelOpen: (open) => set({ agentPanelOpen: open }),

  // ==========================================
  // Remote skill listing
  // ==========================================

  loadRemoteSkills: async (serverId: string) => {
    set((state) => ({
      remoteSkillsLoading: { ...state.remoteSkillsLoading, [serverId]: true },
      remoteSkillsError: { ...state.remoteSkillsError, [serverId]: null },
    }));
    try {
      const result = await api.remoteServerListSkills(serverId);
      if (result.success && result.data) {
        set((state) => ({
          remoteSkills: { ...state.remoteSkills, [serverId]: result.data },
          remoteSkillsLoading: { ...state.remoteSkillsLoading, [serverId]: false },
        }));
      } else {
        set((state) => ({
          remoteSkillsLoading: { ...state.remoteSkillsLoading, [serverId]: false },
          remoteSkillsError: {
            ...state.remoteSkillsError,
            [serverId]: result.error || 'Failed to load remote skills',
          },
        }));
      }
    } catch (error) {
      set((state) => ({
        remoteSkillsLoading: { ...state.remoteSkillsLoading, [serverId]: false },
        remoteSkillsError: {
          ...state.remoteSkillsError,
          [serverId]: error instanceof Error ? error.message : 'Failed to load remote skills',
        },
      }));
    }
  },

  // ==========================================
  // GitHub 推送
  // ==========================================

  pushSkillToGitHub: async (skillId: string, targetRepo: string, targetPath?: string) => {
    set({ pushLoading: true, pushError: null, pushResult: null });
    try {
      const result = await api.skillMarketPushToGitHub(skillId, targetRepo, targetPath);
      if (result.success && result.data?.prUrl) {
        set({ pushLoading: false, pushResult: { prUrl: result.data.prUrl } });
        return { success: true, prUrl: result.data.prUrl };
      } else {
        set({ pushLoading: false, pushError: result.error || 'Failed to push skill' });
        return { success: false };
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to push skill';
      set({ pushLoading: false, pushError: msg });
      return { success: false };
    }
  },

  pushSkillToGitCode: async (skillId: string, targetRepo: string, targetPath?: string) => {
    set({ pushLoading: true, pushError: null, pushResult: null });
    try {
      const result = await api.skillMarketPushToGitCode(skillId, targetRepo, targetPath);
      const mrUrl = (result as any)?.mrUrl || (result as any)?.data?.mrUrl;
      const warning = (result as any)?.warning || (result as any)?.data?.warning;
      if (result.success && mrUrl) {
        set({ pushLoading: false, pushResult: { prUrl: mrUrl, warning } });
        return { success: true, prUrl: mrUrl };
      } else {
        set({ pushLoading: false, pushError: result.error || 'Failed to push skill to GitCode' });
        return { success: false };
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to push skill to GitCode';
      set({ pushLoading: false, pushError: msg });
      return { success: false };
    }
  },

  loadRepoDirectories: async (repo: string) => {
    set({ repoDirsLoading: true });
    try {
      const result = await api.skillMarketListRepoDirs(repo);
      if (result.success && result.data) {
        set({ repoDirs: result.data as string[], repoDirsLoading: false });
      } else {
        set({ repoDirs: [], repoDirsLoading: false });
      }
    } catch (error) {
      console.error('[SkillStore] loadRepoDirectories error:', error);
      set({ repoDirs: [], repoDirsLoading: false });
    }
  },

  validateGitHubRepo: async (repo: string) => {
    try {
      const result = await api.skillMarketValidateRepo(repo);
      if (result.success && result.data) {
        return result.data as {
          valid: boolean;
          hasSkillsDir: boolean;
          skillCount: number;
          error?: string;
        };
      }
      return {
        valid: false,
        hasSkillsDir: false,
        skillCount: 0,
        error: result.error || 'Validation failed',
      };
    } catch (error) {
      console.error('Failed to validate GitHub repo:', error);
      return {
        valid: false,
        hasSkillsDir: false,
        skillCount: 0,
        error: error instanceof Error ? error.message : 'Validation failed',
      };
    }
  },

  validateGitCodeRepo: async (repo: string) => {
    try {
      const result = await api.skillMarketValidateGitCodeRepo(repo);
      if (result.success && result.data) {
        return result.data as {
          valid: boolean;
          hasSkillsDir: boolean;
          skillCount: number;
          error?: string;
        };
      }
      return {
        valid: false,
        hasSkillsDir: false,
        skillCount: 0,
        error: result.error || 'Validation failed',
      };
    } catch (error) {
      console.error('Failed to validate GitCode repo:', error);
      return {
        valid: false,
        hasSkillsDir: false,
        skillCount: 0,
        error: error instanceof Error ? error.message : 'Validation failed',
      };
    }
  },

  addGitHubSource: async (repoUrl: string) => {
    try {
      const githubMatch = repoUrl.match(/github\.com\/([^/]+\/[^/]+)/);
      const gitcodeMatch = repoUrl.match(/gitcode\.com\/([^/]+\/[^/]+)/);
      const match = githubMatch || gitcodeMatch;
      if (!match) return false;

      const repo = match[1].replace(/\.git$/, '');
      const isGitCode = !!gitcodeMatch;

      const validation = isGitCode
        ? await get().validateGitCodeRepo(repo)
        : await get().validateGitHubRepo(repo);
      if (!validation?.valid) {
        return false;
      }

      await get().addMarketSource({
        name: repo,
        url: repoUrl,
        repos: [repo],
        description: `${isGitCode ? 'GitCode' : 'GitHub'}: ${repo} (${validation.skillCount} skills)`,
      });

      return true;
    } catch (error) {
      console.error('Failed to add git source:', error);
      return false;
    }
  },

  clearPushState: () => {
    set({ pushLoading: false, pushError: null, pushResult: null });
  },

  // ==========================================
  // Sync to remote server
  // ==========================================

  syncSkillToRemote: async (skillId: string, serverId: string) => {
    set({ syncLoading: true, syncError: null, syncResult: null });
    try {
      const result = await api.skillSyncToRemote({ skillId, serverId });
      if (result.success) {
        set({ syncLoading: false, syncResult: { serverId, success: true } });
        // Refresh remote skills for the target server
        get().loadRemoteSkills(serverId);
        return true;
      } else {
        set({ syncLoading: false, syncError: result.error || 'Failed to sync skill' });
        return false;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to sync skill';
      set({ syncLoading: false, syncError: msg });
      return false;
    }
  },

  clearSyncState: () => {
    set({ syncLoading: false, syncError: null, syncResult: null });
  },

  // ==========================================
  // Sync from remote server
  // ==========================================

  syncSkillFromRemote: async (skillId: string, serverId: string) => {
    set({ syncFromRemoteLoading: true, syncFromRemoteError: null, syncFromRemoteResult: null });
    try {
      const result = await api.skillSyncFromRemote({ skillId, serverId });
      if (result.success) {
        set({
          syncFromRemoteLoading: false,
          syncFromRemoteResult: { skillId, success: true },
        });
        // Refresh local skills list
        get().refreshSkills();
        return true;
      } else {
        set({
          syncFromRemoteLoading: false,
          syncFromRemoteError: result.error || 'Failed to sync skill from remote',
        });
        return false;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to sync skill from remote';
      set({ syncFromRemoteLoading: false, syncFromRemoteError: msg });
      return false;
    }
  },

  clearSyncFromRemoteState: () => {
    set({ syncFromRemoteLoading: false, syncFromRemoteError: null, syncFromRemoteResult: null });
  },
}));
