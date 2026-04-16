/**
 * AgentPanel Component
 *
 * Right sidebar for Hyper Space that displays all manually created agents
 * (leader + workers). Each agent has an independent conversation view.
 * The leader is the default/primary view.
 *
 * Visual indicators:
 * - Selected: primary background + left border
 * - Activated (by leader/foreman): pulsing blue dot
 */

import React, { useState } from 'react';
import { useTranslation } from '../../i18n';
import { useSpaceStore } from '../../stores/space.store';
import { useChatStore } from '../../stores/chat.store';
import { api } from '../../api';
import { Crown, Wrench, Cloud, Monitor, Plus, X } from 'lucide-react';
import type { AgentConfig } from '../../../shared/types/hyper-space';
import type { RemoteServer } from '../../../shared/types';

const DEFAULT_REMOTE_CAPABILITIES = ['NPU操作', '模型推理', '模型训练', 'AI计算优化'];

export function AgentPanel() {
  const { t } = useTranslation();

  const currentSpace = useSpaceStore((state) => state.currentSpace);
  const isHyperSpace = currentSpace?.spaceType === 'hyper';
  const agents = currentSpace?.agents || [];

  const activeAgentId = useChatStore((state) => state.activeAgentId);
  const setActiveAgentId = useChatStore((state) => state.setActiveAgentId);
  const activatedAgentIds = useChatStore((state) => state.activatedAgentIds);

  // Add worker inline form
  const [showAddForm, setShowAddForm] = useState(false);
  const [newWorkerName, setNewWorkerName] = useState('');
  const [newWorkerType, setNewWorkerType] = useState<'local' | 'remote'>('local');
  const [newWorkerServerId, setNewWorkerServerId] = useState('');
  const [remoteServers, setRemoteServers] = useState<RemoteServer[]>([]);

  if (!isHyperSpace) return null;

  // Sort: leader first, then workers
  const sortedAgents = [...agents].sort((a, b) => {
    if (a.role === 'leader') return -1;
    if (b.role === 'leader') return 1;
    return 0;
  });

  const handleOpenAddForm = async () => {
    // Load remote servers for the dropdown
    const result = await api.remoteServerList();
    if (result.success && result.data) {
      setRemoteServers(result.data);
    }
    setShowAddForm(true);
  };

  const handleAddWorker = async () => {
    if (!currentSpace) return;

    const capabilities = newWorkerType === 'remote' ? [...DEFAULT_REMOTE_CAPABILITIES] : [];
    const newAgent: AgentConfig = {
      id: `worker-${Date.now()}`,
      name:
        newWorkerName.trim() || `Worker ${agents.filter((a) => a.role === 'worker').length + 1}`,
      type: newWorkerType,
      role: 'worker',
      capabilities,
      ...(newWorkerType === 'remote' && newWorkerServerId
        ? { remoteServerId: newWorkerServerId }
        : {}),
    };

    // Auto-fill environment from server config
    if (newWorkerType === 'remote' && newWorkerServerId) {
      const server = remoteServers.find((s) => s.id === newWorkerServerId);
      if (server) {
        newAgent.environment = {
          ip: server.host,
          username: server.username,
          password: server.password || '',
          port: server.sshPort || 22,
        };
      }
    }

    await api.addAgentToHyperSpace(currentSpace.id, newAgent);
    setShowAddForm(false);
    setNewWorkerName('');
    setNewWorkerType('local');
    setNewWorkerServerId('');
  };

  const handleRemoveWorker = async (agentId: string) => {
    if (!currentSpace) return;
    await api.removeAgentFromHyperSpace(currentSpace.id, agentId);
  };

  return (
    <div className="w-[180px] min-w-[180px] border-r border-border bg-card/30 flex flex-col">
      {/* Header */}
      <div className="px-3 py-2 border-b border-border flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t('Agents')}
        </span>
        {!showAddForm && (
          <button
            onClick={handleOpenAddForm}
            className="p-0.5 hover:bg-primary/10 rounded transition-colors text-muted-foreground hover:text-primary"
            title={t('Add Worker')}
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Add Worker Inline Form */}
      {showAddForm && (
        <div className="p-2 border-b border-border space-y-2">
          <input
            type="text"
            value={newWorkerName}
            onChange={(e) => setNewWorkerName(e.target.value)}
            placeholder={t('Worker Name')}
            autoFocus
            className="w-full px-2 py-1 text-xs bg-secondary border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <div className="flex gap-2">
            <label className="flex items-center gap-1 cursor-pointer text-xs">
              <input
                type="radio"
                name="agentpanel-new-type"
                checked={newWorkerType === 'local'}
                onChange={() => setNewWorkerType('local')}
              />
              <Monitor className="w-3 h-3" />
              <span>{t('Local')}</span>
            </label>
            <label className="flex items-center gap-1 cursor-pointer text-xs">
              <input
                type="radio"
                name="agentpanel-new-type"
                checked={newWorkerType === 'remote'}
                onChange={() => setNewWorkerType('remote')}
              />
              <Cloud className="w-3 h-3" />
              <span>{t('Remote')}</span>
            </label>
          </div>
          {newWorkerType === 'remote' && remoteServers.length > 0 && (
            <select
              value={newWorkerServerId}
              onChange={(e) => setNewWorkerServerId(e.target.value)}
              className="w-full px-2 py-1 text-xs bg-secondary border border-border rounded"
            >
              <option value="">{t('Select server...')}</option>
              {remoteServers.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name}
                </option>
              ))}
            </select>
          )}
          <div className="flex gap-1 justify-end">
            <button
              onClick={() => {
                setShowAddForm(false);
                setNewWorkerName('');
                setNewWorkerType('local');
                setNewWorkerServerId('');
              }}
              className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {t('Cancel')}
            </button>
            <button
              onClick={handleAddWorker}
              disabled={
                newWorkerType === 'remote' && !newWorkerServerId && remoteServers.length > 0
              }
              className="px-2 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50"
            >
              {t('Add')}
            </button>
          </div>
        </div>
      )}

      {/* Agent List */}
      <div className="flex-1 overflow-y-auto py-1">
        {sortedAgents.map((agent) => {
          const isLeader = agent.role === 'leader';
          const isActive = isLeader
            ? activeAgentId === null || activeAgentId === agent.id
            : activeAgentId === agent.id;
          const isActivated = activatedAgentIds.has(agent.id);

          return (
            <button
              key={agent.id}
              onClick={() => setActiveAgentId(isLeader ? null : agent.id)}
              className={`
                w-full px-3 py-2.5 flex items-start gap-2 text-left transition-colors
                ${
                  isActive
                    ? 'bg-primary/10 border-l-2 border-l-primary'
                    : isActivated
                      ? 'bg-blue-500/5 border-l-2 border-l-blue-500 hover:bg-blue-500/10'
                      : 'border-l-2 border-l-transparent hover:bg-secondary/50'
                }
              `}
            >
              {/* Role icon */}
              <div className="mt-0.5 flex-shrink-0">
                {isLeader ? (
                  <Crown className="w-4 h-4 text-purple-500" />
                ) : (
                  <Wrench className="w-4 h-4 text-blue-500" />
                )}
              </div>

              {/* Agent info */}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate leading-tight">{agent.name}</div>
                <div className="flex items-center gap-1 mt-0.5">
                  {agent.type === 'remote' ? (
                    <Cloud className="w-3 h-3 text-muted-foreground" />
                  ) : (
                    <Monitor className="w-3 h-3 text-muted-foreground" />
                  )}
                  <span className="text-xs text-muted-foreground">
                    {agent.type === 'remote' ? t('Remote') : t('Local')}
                  </span>
                </div>
                {/* Capabilities tags */}
                {agent.capabilities && agent.capabilities.length > 0 && (
                  <div className="flex flex-wrap gap-0.5 mt-1">
                    {agent.capabilities.slice(0, 3).map((cap) => (
                      <span
                        key={cap}
                        className="px-1 py-px text-[10px] rounded bg-secondary text-muted-foreground leading-tight"
                      >
                        {cap}
                      </span>
                    ))}
                    {agent.capabilities.length > 3 && (
                      <span className="text-[10px] text-muted-foreground">
                        +{agent.capabilities.length - 3}
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Status indicators */}
              <div className="flex-shrink-0 mt-0.5 flex flex-col items-end gap-1">
                {isActivated && <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />}
                {!isLeader && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRemoveWorker(agent.id);
                    }}
                    className="p-0.5 hover:bg-destructive/20 rounded transition-colors opacity-0 group-hover:opacity-100"
                    title={t('Remove agent')}
                  >
                    <X className="w-3 h-3 text-muted-foreground hover:text-destructive" />
                  </button>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
