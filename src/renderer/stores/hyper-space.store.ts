/**
 * Hyper Space Store
 *
 * Zustand store for pipeline dashboard, cluster grid, and agent log state.
 * Organized around three main data maps:
 * - pipelines: running pipeline metadata and stage progress
 * - servers: registered NPU server cluster
 * - agentStatuses / agentLogs: per-agent runtime state and log tail
 */

import { create } from 'zustand';
import type { PipelineStatus } from '@shared/types/pipeline';
import type { NpuServer } from '@shared/types/cluster';

interface PipelineInfo {
  name: string;
  status: PipelineStatus;
  stages: Map<string, { name: string; status: string; progress: number }>;
}

interface AgentStatus {
  progress: number;
  gpuUtilization?: number;
  metrics?: Record<string, unknown>;
  logTail?: string;
}

interface AgentLogEntry {
  agentId: string;
  timestamp: number;
  content: string;
}

interface HyperSpaceState {
  pipelines: Map<string, PipelineInfo>;
  servers: Map<string, NpuServer>;
  agentStatuses: Map<string, AgentStatus>;
  agentLogs: Map<string, AgentLogEntry[]>;
  selectedAgentId: string | null;

  setServers: (servers: NpuServer[]) => void;
  updatePipelineStage: (
    pipelineId: string,
    stageId: string,
    name: string,
    status: string,
    progress: number,
  ) => void;
  updatePipelineStatus: (pipelineId: string, status: PipelineStatus) => void;
  addPipeline: (pipelineId: string, name: string) => void;
  updateAgentStatus: (agentId: string, status: AgentStatus) => void;
  appendAgentLog: (agentId: string, content: string) => void;
  setSelectedAgent: (agentId: string | null) => void;
}

export const useHyperSpaceStore = create<HyperSpaceState>((set) => ({
  pipelines: new Map(),
  servers: new Map(),
  agentStatuses: new Map(),
  agentLogs: new Map(),
  selectedAgentId: null,

  setServers: (servers) =>
    set((state) => {
      const map = new Map(state.servers);
      for (const s of servers) map.set(s.id, s);
      return { servers: map };
    }),

  addPipeline: (pipelineId, name) =>
    set((state) => {
      const map = new Map(state.pipelines);
      map.set(pipelineId, { name, status: 'running', stages: new Map() });
      return { pipelines: map };
    }),

  updatePipelineStatus: (pipelineId, status) =>
    set((state) => {
      const map = new Map(state.pipelines);
      const p = map.get(pipelineId);
      if (p) map.set(pipelineId, { ...p, status });
      return { pipelines: map };
    }),

  updatePipelineStage: (pipelineId, stageId, name, status, progress) =>
    set((state) => {
      const map = new Map(state.pipelines);
      const p = map.get(pipelineId);
      if (p) {
        const stages = new Map(p.stages);
        stages.set(stageId, { name, status, progress });
        map.set(pipelineId, { ...p, stages });
      }
      return { pipelines: map };
    }),

  updateAgentStatus: (agentId, status) =>
    set((state) => {
      const map = new Map(state.agentStatuses);
      map.set(agentId, status);
      return { agentStatuses: map };
    }),

  appendAgentLog: (agentId, content) =>
    set((state) => {
      const map = new Map(state.agentLogs);
      const logs = [...(map.get(agentId) || [])];
      logs.push({ agentId, timestamp: Date.now(), content });
      if (logs.length > 100) logs.splice(0, logs.length - 100);
      map.set(agentId, logs);
      return { agentLogs: map };
    }),

  setSelectedAgent: (agentId) => set({ selectedAgentId: agentId }),
}));
