/**
 * HyperSpaceCreationDialog Component
 *
 * Multi-agent workspace creation dialog (v2)
 * - Leader: forced local, default capabilities for management
 * - Worker: local (user-defined capabilities) or remote (default AI/GPU capabilities)
 * - Environment credentials for remote workers (auto-filled from server config)
 */

import React, { useState, useEffect } from 'react';
import { useTranslation } from '../../i18n';
import { api } from '../../api';
import { SPACE_ICONS, DEFAULT_SPACE_ICON } from '../../types';
import type { SpaceIconId } from '../../types';
import type { AgentConfig } from '../../../shared/types/hyper-space';
import { Blocks, Plus, Trash2, Users, Cloud, FolderOpen, Monitor, X } from 'lucide-react';
import { SpaceIcon } from '../icons/ToolIcons';
import type { RemoteServer } from '../../../shared/types';

interface HyperSpaceCreationDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (spaceId: string) => void;
}

const DEFAULT_LEADER_CAPABILITIES = ['组织', '管理', '任务规划', '项目管理'];
const DEFAULT_REMOTE_CAPABILITIES = ['NPU操作', '模型推理', '模型训练', 'AI计算优化'];
const DEFAULT_REMOTE_SYSTEM_PROMPT = `1. 你是一个华为昇腾NPU服务器操作高手，精通各种NPU相关操作命令和模型迁移调优分析方法。
2. 当需要下载模型时，优先使用中国国内的模型网站，如modelscope
3. 当需要下载模型或者下载超大文件时，要先分析一下目标目录的剩余空间，不要直接下载`;

export function HyperSpaceCreationDialog({
  isOpen,
  onClose,
  onSuccess,
}: HyperSpaceCreationDialogProps) {
  const { t } = useTranslation();

  // Form state
  const [name, setName] = useState('');
  const [icon, setIcon] = useState<SpaceIconId>(DEFAULT_SPACE_ICON);
  const [customPath, setCustomPath] = useState<string>('');

  // Agents configuration
  const [agents, setAgents] = useState<AgentConfig[]>([
    {
      id: 'leader-1',
      name: 'Leader',
      type: 'local',
      role: 'leader',
      capabilities: [...DEFAULT_LEADER_CAPABILITIES],
    },
  ]);

  // Show inline add-worker form
  const [showAddForm, setShowAddForm] = useState(false);
  const [newWorkerName, setNewWorkerName] = useState('');
  const [newWorkerType, setNewWorkerType] = useState<'local' | 'remote'>('local');
  const [newWorkerServerId, setNewWorkerServerId] = useState('');

  // Remote servers for agent selection
  const [remoteServers, setRemoteServers] = useState<RemoteServer[]>([]);

  // Load remote servers
  useEffect(() => {
    if (isOpen) {
      api.remoteServerList().then((result) => {
        if (result.success && result.data) {
          setRemoteServers(result.data);
        }
      });
    }
  }, [isOpen]);

  // Reset form when dialog opens
  useEffect(() => {
    if (isOpen) {
      setName('');
      setIcon(DEFAULT_SPACE_ICON);
      setCustomPath('');
      setAgents([
        {
          id: 'leader-1',
          name: 'Leader',
          type: 'local',
          role: 'leader',
          capabilities: [...DEFAULT_LEADER_CAPABILITIES],
        },
      ]);
      setShowAddForm(false);
      setNewWorkerName('');
      setNewWorkerType('local');
      setNewWorkerServerId('');
    }
  }, [isOpen]);

  // Add worker handler
  const handleAddWorker = () => {
    const capabilities = newWorkerType === 'remote' ? [...DEFAULT_REMOTE_CAPABILITIES] : [];
    const newAgent: AgentConfig = {
      id: `worker-${Date.now()}`,
      name:
        newWorkerName.trim() || `Worker ${agents.filter((a) => a.role === 'worker').length + 1}`,
      type: newWorkerType,
      role: 'worker',
      capabilities,
      ...(newWorkerType === 'remote' ? { systemPromptAddition: DEFAULT_REMOTE_SYSTEM_PROMPT } : {}),
      ...(newWorkerType === 'remote' && newWorkerServerId
        ? { remoteServerId: newWorkerServerId }
        : {}),
    };

    // Auto-fill environment from server config for remote workers
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

    setAgents([...agents, newAgent]);
    setShowAddForm(false);
    setNewWorkerName('');
    setNewWorkerType('local');
    setNewWorkerServerId('');
  };

  // Remove agent handler (cannot remove leader)
  const handleRemoveAgent = (agentId: string) => {
    const agent = agents.find((a) => a.id === agentId);
    if (agent?.role === 'leader') return;
    setAgents(agents.filter((a) => a.id !== agentId));
  };

  // Update agent type with auto-capability management
  const handleUpdateAgentType = (agentId: string, newType: 'local' | 'remote') => {
    setAgents(
      agents.map((a) => {
        if (a.id !== agentId) return a;
        const updated = { ...a, type: newType };
        if (newType === 'remote') {
          // Auto-fill remote capabilities if currently empty
          if (!updated.capabilities || updated.capabilities.length === 0) {
            updated.capabilities = [...DEFAULT_REMOTE_CAPABILITIES];
          }
          // Auto-fill system prompt if currently empty
          if (!updated.systemPromptAddition) {
            updated.systemPromptAddition = DEFAULT_REMOTE_SYSTEM_PROMPT;
          }
          if (!updated.remoteServerId) {
            // Auto-select first remote server if available
            if (remoteServers.length > 0) {
              updated.remoteServerId = remoteServers[0].id;
              const server = remoteServers[0];
              updated.environment = {
                ip: server.host,
                username: server.username,
                password: server.password || '',
                port: server.sshPort || 22,
              };
            }
          }
        } else {
          // Switching to local: clear environment and system prompt
          updated.remoteServerId = undefined;
          updated.environment = undefined;
          updated.systemPromptAddition = undefined;
        }
        return updated;
      }),
    );
  };

  // Update agent remote server (auto-fill environment)
  const handleUpdateAgentServer = (agentId: string, serverId: string) => {
    setAgents(
      agents.map((a) => {
        if (a.id !== agentId) return a;
        const server = remoteServers.find((s) => s.id === serverId);
        return {
          ...a,
          remoteServerId: serverId,
          environment: server
            ? {
                ip: server.host,
                username: server.username,
                password: server.password || '',
                port: server.sshPort || 22,
              }
            : undefined,
        };
      }),
    );
  };

  // Handle folder selection
  const handleSelectFolder = async () => {
    const res = await api.selectFolder();
    if (res.success && res.data) {
      setCustomPath(res.data as string);
      const dirName = (res.data as string).split(/[/\\]/).pop() || '';
      if (dirName && !name.trim()) {
        setName(dirName);
      }
    }
  };

  // Submit handler
  const handleSubmit = async () => {
    if (!name.trim()) return;

    try {
      const result = await api.createHyperSpace({
        name: name.trim(),
        icon,
        customPath: customPath || undefined,
        spaceType: 'hyper',
        agents,
      });

      console.log('[HyperSpaceDialog] Create result:', result);

      if (result.success) {
        const spaceData = (result as any).space || (result as any).data;
        const spaceId = spaceData?.id;
        if (spaceId) {
          onSuccess(spaceId);
        }
        onClose();
      } else {
        console.error('[HyperSpaceDialog] Failed to create:', result.error);
      }
    } catch (error) {
      console.error('[HyperSpaceDialog] Error creating Hyper Space:', error);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-2xl mx-4 bg-card border border-border rounded-xl shadow-xl animate-fade-in max-h-[90vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Blocks className="w-5 h-5 text-purple-500" />
              <span>{t('Create Hyper Space')}</span>
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              {t('Multi-agent workspace with independent agent conversations')}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content - Scrollable */}
        <div className="p-6 overflow-y-auto max-h-[60vh] space-y-6">
          {/* Basic Info Section */}
          <section className="space-y-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('Basic Info')}
            </h3>

            {/* Name */}
            <div className="space-y-1.5">
              <label className="text-sm text-foreground">{t('Name')}</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('My Hyper Space')}
                autoFocus
                className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            {/* Icon */}
            <div className="space-y-1.5">
              <label className="text-sm text-foreground">{t('Icon')}</label>
              <div className="flex flex-wrap gap-2">
                {SPACE_ICONS.map((iconId) => (
                  <button
                    key={iconId}
                    onClick={() => setIcon(iconId)}
                    className={`w-10 h-10 rounded-lg flex items-center justify-center transition-all ${
                      icon === iconId
                        ? 'bg-primary/20 border-2 border-primary'
                        : 'bg-secondary hover:bg-secondary/80 border border-transparent'
                    }`}
                  >
                    <SpaceIcon iconId={iconId} size={20} />
                  </button>
                ))}
              </div>
            </div>

            {/* Working Directory */}
            <div className="space-y-1.5">
              <label className="text-sm text-foreground">{t('Working Directory (optional)')}</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={customPath}
                  onChange={(e) => setCustomPath(e.target.value)}
                  placeholder={t('Select a folder...')}
                  className="flex-1 px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
                  readOnly
                />
                <button
                  onClick={handleSelectFolder}
                  className="flex items-center gap-1 px-3 py-2 text-sm text-muted-foreground hover:text-foreground bg-secondary hover:bg-secondary/80 rounded-lg transition-colors"
                >
                  <FolderOpen className="w-4 h-4" />
                  <span>{t('Select')}</span>
                </button>
              </div>
            </div>
          </section>

          {/* Agents Section */}
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5" />
                {t('Agents')}
              </h3>
              {!showAddForm && (
                <button
                  onClick={() => setShowAddForm(true)}
                  className="flex items-center gap-1 px-2 py-1 text-xs text-primary hover:bg-primary/10 rounded-md transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  {t('Add Worker')}
                </button>
              )}
            </div>

            {/* Add Worker Inline Form */}
            {showAddForm && (
              <div className="p-3 bg-primary/5 border border-primary/20 rounded-lg space-y-3">
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 text-xs rounded-full bg-blue-500/20 text-blue-500">
                    {t('worker')}
                  </span>
                  <input
                    type="text"
                    value={newWorkerName}
                    onChange={(e) => setNewWorkerName(e.target.value)}
                    placeholder={t('Worker Name')}
                    autoFocus
                    className="flex-1 px-2 py-1 text-sm bg-transparent border-b border-border focus:outline-none focus:border-primary"
                  />
                </div>

                {/* Type selection */}
                <div className="flex gap-3">
                  <label className="flex items-center gap-2 cursor-pointer text-sm">
                    <input
                      type="radio"
                      name="new-worker-type"
                      checked={newWorkerType === 'local'}
                      onChange={() => setNewWorkerType('local')}
                    />
                    <Monitor className="w-3.5 h-3.5" />
                    <span>{t('Local')}</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer text-sm">
                    <input
                      type="radio"
                      name="new-worker-type"
                      checked={newWorkerType === 'remote'}
                      onChange={() => setNewWorkerType('remote')}
                    />
                    <Cloud className="w-3.5 h-3.5" />
                    <span>{t('Remote')}</span>
                  </label>
                </div>

                {/* Remote server selection */}
                {newWorkerType === 'remote' && (
                  <div className="space-y-1.5">
                    {remoteServers.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        {t('No remote servers available. Add a remote server first.')}
                      </p>
                    ) : remoteServers.filter((s) => s.sdkInstalled && s.proxyRunning).length ===
                      0 ? (
                      <p className="text-xs text-amber-500">
                        {t(
                          'No servers with SDK and Bot Proxy ready. Please deploy the agent first.',
                        )}
                      </p>
                    ) : (
                      <select
                        value={newWorkerServerId}
                        onChange={(e) => setNewWorkerServerId(e.target.value)}
                        className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg"
                      >
                        <option value="">{t('Select server...')}</option>
                        {remoteServers
                          .filter((s) => s.sdkInstalled && s.proxyRunning)
                          .map((server) => (
                            <option key={server.id} value={server.id}>
                              {server.name} ({server.host})
                            </option>
                          ))}
                      </select>
                    )}
                  </div>
                )}

                {/* Action buttons */}
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => {
                      setShowAddForm(false);
                      setNewWorkerName('');
                      setNewWorkerType('local');
                      setNewWorkerServerId('');
                    }}
                    className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {t('Cancel')}
                  </button>
                  <button
                    onClick={handleAddWorker}
                    disabled={
                      newWorkerType === 'remote' &&
                      (!newWorkerServerId ||
                        remoteServers.filter((s) => s.sdkInstalled && s.proxyRunning).length === 0)
                    }
                    className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50"
                  >
                    {t('Add')}
                  </button>
                </div>
              </div>
            )}

            {/* Agent Cards */}
            <div className="space-y-3">
              {agents.map((agent) => (
                <div
                  key={agent.id}
                  className="p-4 bg-secondary/30 rounded-lg border border-border space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span
                        className={`px-2 py-0.5 text-xs rounded-full ${
                          agent.role === 'leader'
                            ? 'bg-purple-500/20 text-purple-500'
                            : 'bg-blue-500/20 text-blue-500'
                        }`}
                      >
                        {t(agent.role)}
                      </span>
                      <input
                        type="text"
                        value={agent.name}
                        onChange={(e) =>
                          setAgents(
                            agents.map((a) =>
                              a.id === agent.id ? { ...a, name: e.target.value } : a,
                            ),
                          )
                        }
                        className="text-sm font-medium bg-transparent border-none focus:outline-none"
                        placeholder={t('Agent Name')}
                      />
                    </div>
                    {agent.role !== 'leader' && (
                      <button
                        onClick={() => handleRemoveAgent(agent.id)}
                        className="p-1 hover:bg-destructive/20 rounded transition-colors"
                      >
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </button>
                    )}
                  </div>

                  {/* Agent Type - Hidden for Leader (forced local) */}
                  <div className="flex items-center gap-2">
                    {agent.role === 'leader' ? (
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Monitor className="w-3.5 h-3.5" />
                        <span>{t('Local (Leader)')}</span>
                      </div>
                    ) : (
                      <div className="flex gap-3">
                        <label className="flex items-center gap-2 cursor-pointer text-sm">
                          <input
                            type="radio"
                            name={`type-${agent.id}`}
                            checked={agent.type === 'local'}
                            onChange={() => handleUpdateAgentType(agent.id, 'local')}
                          />
                          <Monitor className="w-3.5 h-3.5" />
                          <span>{t('Local')}</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer text-sm">
                          <input
                            type="radio"
                            name={`type-${agent.id}`}
                            checked={agent.type === 'remote'}
                            onChange={() => handleUpdateAgentType(agent.id, 'remote')}
                          />
                          <Cloud className="w-3.5 h-3.5" />
                          <span>{t('Remote')}</span>
                        </label>
                      </div>
                    )}
                  </div>

                  {/* Remote Server (if remote worker) */}
                  {agent.role === 'worker' && agent.type === 'remote' && (
                    <div className="space-y-2">
                      {remoteServers.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          {t('No remote servers available. Add a remote server first.')}
                        </p>
                      ) : remoteServers.filter((s) => s.sdkInstalled && s.proxyRunning).length ===
                        0 ? (
                        <p className="text-xs text-amber-500">
                          {t(
                            'No servers with SDK and Bot Proxy ready. Please deploy the agent first.',
                          )}
                        </p>
                      ) : (
                        <select
                          value={agent.remoteServerId || ''}
                          onChange={(e) => handleUpdateAgentServer(agent.id, e.target.value)}
                          className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg"
                        >
                          <option value="">{t('Select server...')}</option>
                          {remoteServers
                            .filter((s) => s.sdkInstalled && s.proxyRunning)
                            .map((server) => (
                              <option key={server.id} value={server.id}>
                                {server.name} ({server.host})
                              </option>
                            ))}
                        </select>
                      )}

                      {/* Environment Info (read-only) */}
                      {agent.environment && (
                        <div className="px-3 py-2 bg-secondary rounded-md text-xs text-muted-foreground space-y-0.5">
                          <div>
                            {t('Server')}: {agent.environment.ip}
                            {agent.environment.port && agent.environment.port !== 22
                              ? `:${agent.environment.port}`
                              : ''}
                          </div>
                          <div>
                            {t('User')}: {agent.environment.username}
                          </div>
                          <div>
                            {t('Password')}:{' '}
                            {'*'.repeat(Math.min((agent.environment.password || '').length, 8))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Capabilities */}
                  <div className="space-y-1.5">
                    <label className="text-xs text-muted-foreground">
                      {t('Capabilities (comma-separated)')}
                    </label>
                    <input
                      type="text"
                      value={agent.capabilities?.join(', ') || ''}
                      onChange={(e) =>
                        setAgents(
                          agents.map((a) =>
                            a.id === agent.id
                              ? {
                                  ...a,
                                  capabilities: e.target.value
                                    .split(',')
                                    .map((c) => c.trim())
                                    .filter(Boolean),
                                }
                              : a,
                          ),
                        )
                      }
                      placeholder={
                        agent.role === 'leader'
                          ? '组织, 管理, 任务规划, 项目管理'
                          : 'code, testing, documentation'
                      }
                      className="w-full px-3 py-1.5 text-sm bg-secondary border border-border rounded-lg"
                    />
                  </div>

                  {/* System Prompt (only for remote workers) */}
                  {agent.type === 'remote' && (
                    <div className="space-y-1.5">
                      <label className="text-xs text-muted-foreground">{t('System Prompt')}</label>
                      <textarea
                        value={agent.systemPromptAddition || ''}
                        onChange={(e) =>
                          setAgents(
                            agents.map((a) =>
                              a.id === agent.id
                                ? {
                                    ...a,
                                    systemPromptAddition: e.target.value,
                                  }
                                : a,
                            ),
                          )
                        }
                        placeholder={t('Custom instructions for the remote AI agent...')}
                        rows={3}
                        className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary resize-y"
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-border flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-muted-foreground hover:text-foreground transition-colors"
          >
            {t('Cancel')}
          </button>
          <button
            onClick={handleSubmit}
            disabled={!name.trim() || agents.length === 0}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {t('Create Hyper Space')}
          </button>
        </div>
      </div>
    </div>
  );
}
