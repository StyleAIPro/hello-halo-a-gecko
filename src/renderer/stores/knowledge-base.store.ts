import { create } from 'zustand';
import * as kbApi from '@/api/knowledge-base';

interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  icon: string;
  sourceCount: number;
  pageCount: number;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface KbSource {
  id: string;
  kbId: string;
  originalPath: string;
  storedName: string;
  fileType: string;
  fileSize: number;
  status: string;
  errorMessage: string;
}

interface WikiPage {
  title: string;
  path: string;
  type: string;
}

interface KnowledgeBaseState {
  knowledgeBases: KnowledgeBase[];
  currentKb: KnowledgeBase | null;
  sources: KbSource[];
  wikiPages: WikiPage[];
  loadingAction: string | null;
  loading: boolean;
  error: string | null;
  activeKnowledgeBaseIds: string[];
  ingestProgress: { current: number; total: number; fileName: string } | null;
  wikiUpdatedCounter: number;
  toggleActiveKb: (kbId: string) => void;

  loadKnowledgeBases: () => Promise<void>;
  createKnowledgeBase: (input: { name: string; description?: string }) => Promise<void>;
  deleteKnowledgeBase: (id: string) => Promise<void>;
  selectKb: (kb: KnowledgeBase | null) => void;

  loadSources: (kbId: string) => Promise<void>;
  importFiles: (kbId: string) => Promise<void>;
  importFolder: (kbId: string) => Promise<void>;
  removeSource: (kbId: string, sourceId: string) => Promise<void>;

  loadWikiPages: (kbId: string) => Promise<void>;
  ingestAll: (kbId: string) => Promise<void>;
  cancelIngest: (kbId: string) => Promise<void>;
  recompile: (kbId: string) => Promise<void>;
  compile: (kbId: string) => Promise<void>;
  query: (kbId: string, question: string) => Promise<{ answer: string; citedPages: string[] }>;
  lint: (kbId: string) => Promise<unknown>;
  clearError: () => void;
}

export const useKnowledgeBaseStore = create<KnowledgeBaseState>()((set, get) => ({
  knowledgeBases: [],
  currentKb: null,
  sources: [],
  wikiPages: [],
  loadingAction: null,
  loading: false,
  error: null,
  activeKnowledgeBaseIds: [],
  ingestProgress: null,
  wikiUpdatedCounter: 0,

  loadKnowledgeBases: async () => {
    set({ loading: true, error: null });
    try {
      const res = await kbApi.kbList();
      if (res.success) {
        set({ knowledgeBases: res.data as KnowledgeBase[], loadingAction: null, loading: false });
      } else {
        set({ error: res.error ?? 'Unknown error', loadingAction: null, loading: false });
      }
    } catch (err: unknown) {
      set({ error: (err as Error).message, loadingAction: null, loading: false });
    }
  },

  createKnowledgeBase: async (input: { name: string; description?: string }) => {
    set({ loadingAction: 'create', loading: true, error: null });
    try {
      const res = await kbApi.kbCreate(input);
      if (res.success) {
        await get().loadKnowledgeBases();
      } else {
        set({ error: res.error ?? 'Unknown error', loadingAction: null, loading: false });
      }
    } catch (err: unknown) {
      set({ error: (err as Error).message, loadingAction: null, loading: false });
    }
  },

  deleteKnowledgeBase: async (id: string) => {
    set({ loadingAction: 'delete', loading: true, error: null });
    try {
      const res = await kbApi.kbDelete(id);
      if (res.success) {
        const { currentKb } = get();
        if (currentKb?.id === id) {
          set({ currentKb: null, sources: [], wikiPages: [] });
        }
        await get().loadKnowledgeBases();
      } else {
        set({ error: res.error ?? 'Unknown error', loadingAction: null, loading: false });
      }
    } catch (err: unknown) {
      set({ error: (err as Error).message, loadingAction: null, loading: false });
    }
  },

  selectKb: (kb: KnowledgeBase | null) => {
    set({ currentKb: kb, sources: [], wikiPages: [], error: null });
  },

  loadSources: async (kbId: string) => {
    set({ loading: true, loadingAction: null, error: null });
    try {
      const res = await kbApi.kbListSources(kbId);
      if (res.success) {
        set({ sources: (res.data as KbSource[]) ?? [], loadingAction: null, loading: false });
      } else {
        set({ error: res.error ?? 'Unknown error', loadingAction: null, loading: false });
      }
    } catch (err: unknown) {
      set({ error: (err as Error).message, loadingAction: null, loading: false });
    }
  },

  importFiles: async (kbId: string) => {
    const fileRes = await kbApi.kbSelectFile();
    if (!fileRes.success || !fileRes.data || (fileRes.data as string[]).length === 0) return;
    const filePaths = fileRes.data as string[];
    set({ loadingAction: 'import', loading: true, error: null });
    try {
      const res = await kbApi.kbImportFiles(kbId, filePaths);
      if (res.success) {
        const data = res.data as { imported: number; failed: number; errors: Array<{ file: string; error: string }> };
        if (data.imported > 0) {
          await get().loadSources(kbId);
        }
        if (data.failed > 0 && data.errors.length > 0) {
          set({ loadingAction: null, loading: false, error: data.errors.map((e) => `${e.file}: ${e.error}`).join('\n') });
        } else {
          set({ loadingAction: null, loading: false });
        }
      } else {
        set({ loadingAction: null, loading: false, error: res.error ?? 'Unknown error' });
      }
    } catch (err: unknown) {
      set({ loadingAction: null, loading: false, error: (err as Error).message });
    }
  },

  importFolder: async (kbId: string) => {
    const folderRes = await kbApi.kbSelectFolder();
    if (!folderRes.success || !folderRes.data) return;
    const folderPath = folderRes.data as string;
    set({ loadingAction: 'importFolder', loading: true, error: null });
    try {
      const res = await kbApi.kbImportFolder(kbId, folderPath);
      if (res.success) {
        await get().loadSources(kbId);
        set({ loadingAction: null, loading: false });
      } else {
        set({ error: res.error ?? 'Unknown error', loadingAction: null, loading: false });
      }
    } catch (err: unknown) {
      set({ error: (err as Error).message, loadingAction: null, loading: false });
    }
  },

  removeSource: async (kbId: string, sourceId: string) => {
    set({ loadingAction: 'removeSource', loading: true, error: null });
    try {
      const res = await kbApi.kbRemoveSource(kbId, sourceId);
      if (res.success) {
        await get().loadSources(kbId);
        set({ loadingAction: null, loading: false });
      } else {
        set({ error: res.error ?? 'Unknown error', loadingAction: null, loading: false });
      }
    } catch (err: unknown) {
      set({ error: (err as Error).message, loadingAction: null, loading: false });
    }
  },

  loadWikiPages: async (kbId: string) => {
    set({ loading: true, loadingAction: null, error: null });
    try {
      const res = await kbApi.kbListPages(kbId);
      if (res.success) {
        set({ wikiPages: (res.data as WikiPage[]) ?? [], loadingAction: null, loading: false });
      } else {
        set({ error: res.error ?? 'Unknown error', loadingAction: null, loading: false });
      }
    } catch (err: unknown) {
      set({ error: (err as Error).message, loadingAction: null, loading: false });
    }
  },

  ingestAll: async (kbId: string) => {
    set({ loadingAction: 'ingest', loading: true, error: null, ingestProgress: null });
    try {
      const res = await kbApi.kbIngestAll(kbId);
      if (res.success) {
        const data = (res.data ?? {}) as Record<string, unknown>;
        const errors = (data.errors as string[] | undefined) ?? [];
        const pagesCreated = (data.pagesCreated as number) ?? 0;
        await Promise.all([get().loadWikiPages(kbId), get().loadSources(kbId)]);
        if (errors.length > 0 && pagesCreated === 0) {
          set({ error: errors.join('\n'), loadingAction: null, loading: false });
        } else if (errors.length > 0) {
          set({ error: `部分文件摄取失败: ${errors.join('\n')}`, loadingAction: null, loading: false });
        } else {
          set({ loadingAction: null, loading: false });
        }
      } else {
        if (res.error === 'NO_NEW_FILES') {
          set({ error: 'NO_NEW_FILES', loadingAction: null, loading: false });
        } else {
          set({ error: res.error ?? 'Unknown error', loadingAction: null, loading: false });
        }
      }
    } catch (err: unknown) {
      set({ error: (err as Error).message, loadingAction: null, loading: false });
    }
  },

  cancelIngest: async (kbId: string) => {
    await kbApi.kbCancelIngest(kbId);
    set({ loadingAction: null, loading: false, ingestProgress: null });
    await get().loadSources(kbId);
  },

  recompile: async (kbId: string) => {
    set({ loadingAction: 'recompile', loading: true, error: null, ingestProgress: null });
    try {
      const res = await kbApi.kbRecompile(kbId);
      if (res.success) {
        const data = (res.data ?? {}) as Record<string, unknown>;
        const errors = (data.errors as string[] | undefined) ?? [];
        await Promise.all([get().loadWikiPages(kbId), get().loadSources(kbId)]);
        if (errors.length > 0) {
          set({ error: `部分文件摄取失败: ${errors.join('\n')}`, loadingAction: null, loading: false });
        } else {
          set({ loadingAction: null, loading: false });
        }
      } else {
        set({ error: res.error ?? 'Unknown error', loadingAction: null, loading: false });
      }
    } catch (err: unknown) {
      set({ error: (err as Error).message, loadingAction: null, loading: false });
    }
  },

  compile: async (kbId: string) => {
    set({ loadingAction: 'compile', loading: true, error: null });
    try {
      const res = await kbApi.kbCompile(kbId);
      if (res.success) {
        await Promise.all([get().loadWikiPages(kbId), get().loadSources(kbId)]);
        set({ loadingAction: null, loading: false });
      } else {
        set({ error: res.error ?? 'Unknown error', loadingAction: null, loading: false });
      }
    } catch (err: unknown) {
      set({ error: (err as Error).message, loadingAction: null, loading: false });
    }
  },

  query: async (kbId: string, question: string) => {
    set({ loadingAction: 'query', loading: true, error: null });
    try {
      const res = await kbApi.kbQuery(kbId, question);
      if (res.success) {
        return res.data as { answer: string; citedPages: string[] };
      }
      set({ error: res.error, loadingAction: null, loading: false });
      return { answer: '', citedPages: [] };
    } catch (err: unknown) {
      set({ error: (err as Error).message, loadingAction: null, loading: false });
      return { answer: '', citedPages: [] };
    }
  },

  lint: async (kbId: string) => {
    set({ loadingAction: 'lint', loading: true, error: null });
    try {
      const res = await kbApi.kbLint(kbId);
      if (res.success) {
        set({ loadingAction: null, loading: false });
        return res.data;
      }
      set({ error: res.error ?? 'Unknown error', loadingAction: null, loading: false });
      return undefined;
    } catch (err: unknown) {
      set({ error: (err as Error).message, loadingAction: null, loading: false });
      return undefined;
    }
  },

  toggleActiveKb: (kbId: string) => {
    set((state) => {
      const ids = state.activeKnowledgeBaseIds;
      if (ids.includes(kbId)) {
        return { activeKnowledgeBaseIds: ids.filter((id) => id !== kbId) };
      }
      return { activeKnowledgeBaseIds: [...ids, kbId] };
    });
  },

  clearError: () => {
    set({ error: null });
  },
}));

// Subscribe to ingest progress events from main process
if (typeof window !== 'undefined' && window.aicoBot) {
  window.aicoBot.onKbIngestProgress((data) => {
    const state = useKnowledgeBaseStore.getState();
    const updates: Partial<KnowledgeBaseState> = {
      ingestProgress: data.total > 0 ? { current: data.current, total: data.total, fileName: data.fileName } : null,
    };
    // Ingest finished — clear any stale 'ingesting' statuses
    if (data.total === 0) {
      const hasIngesting = state.sources.some((s) => s.status === 'ingesting');
      if (hasIngesting && state.currentKb) {
        state.loadSources(state.currentKb.id);
      }
    }
    if (data.sourceId && data.total > 0 && !data.completedSourceId) {
      updates.sources = state.sources.map((s) =>
        s.id === data.sourceId ? { ...s, status: 'ingesting' } : s,
      );
    }
    if (data.completedSourceId) {
      updates.sources = state.sources.map((s) =>
        s.id === data.completedSourceId ? { ...s, status: 'compiled' } : s,
      );
      updates.wikiUpdatedCounter = state.wikiUpdatedCounter + 1;
      if (state.currentKb) {
        state.loadWikiPages(state.currentKb.id);
      }
    }
    useKnowledgeBaseStore.setState(updates);
  });
}
