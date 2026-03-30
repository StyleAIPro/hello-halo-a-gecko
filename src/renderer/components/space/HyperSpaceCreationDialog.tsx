/**
 * HyperSpaceCreationDialog Component
 *
 * Multi-agent workspace creation dialog
 */

import React, { useState, useEffect } from 'react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import { SPACE_ICONS, DEFAULT_SPACE_ICON } from '../../types'
import type { SpaceIconId } from '../../types'
import type { AgentConfig, OrchestrationConfig } from '../../../shared/types/hyper-space'
import { DEFAULT_ORCHESTRATION_CONFIG } from '../../../shared/types/hyper-space'
import { Blocks, Plus, Trash2, Users, Cloud, FolderOpen } from 'lucide-react'
import { SpaceIcon } from '../icons/ToolIcons'
import type { RemoteServer } from '../../../shared/types'

interface HyperSpaceCreationDialogProps {
  isOpen: boolean
  onClose: () => void
  onSuccess: (spaceId: string) => void
}

export function HyperSpaceCreationDialog({ isOpen, onClose, onSuccess }: HyperSpaceCreationDialogProps) {
  const { t } = useTranslation()

  // Form state
  const [name, setName] = useState('')
  const [icon, setIcon] = useState<SpaceIconId>(DEFAULT_SPACE_ICON)
  const [customPath, setCustomPath] = useState<string>('')

  // Agents configuration
  const [agents, setAgents] = useState<AgentConfig[]>([
    { id: 'leader-1', name: 'Leader', type: 'local', role: 'leader', capabilities: ['orchestration'] }
  ])

  // Orchestration config
  const [orchestration, setOrchestration] = useState<OrchestrationConfig>(
    DEFAULT_ORCHESTRATION_CONFIG
  )

  // Remote servers for agent selection
  const [remoteServers, setRemoteServers] = useState<RemoteServer[]>([])

  // Load remote servers
  useEffect(() => {
    if (isOpen) {
      api.remoteServerList().then(result => {
        if (result.success && result.data) {
          setRemoteServers(result.data)
        }
      })
    }
  }, [isOpen])

  // Reset form when dialog opens
  useEffect(() => {
    if (isOpen) {
      setName('')
      setIcon(DEFAULT_SPACE_ICON)
      setCustomPath('')
      setAgents([
        { id: 'leader-1', name: 'Leader', type: 'local', role: 'leader', capabilities: ['orchestration'] }
      ])
      setOrchestration(DEFAULT_ORCHESTRATION_CONFIG)
    }
  }, [isOpen])

  // Add agent handler
  const handleAddAgent = () => {
    const newAgent: AgentConfig = {
      id: `worker-${Date.now()}`,
      name: `Worker ${agents.length}`,
      type: 'local',
      role: 'worker',
      capabilities: []
    }
    setAgents([...agents, newAgent])
  }

  // Remove agent handler
  const handleRemoveAgent = (agentId: string) => {
    const agent = agents.find(a => a.id === agentId)
    // Cannot remove the only leader
    if (agent?.role === 'leader' && agents.filter(a => a.role === 'leader').length === 1) {
      return
    }
    setAgents(agents.filter(a => a.id !== agentId))
  }

  // Update agent handler
  const handleUpdateAgent = (agentId: string, updates: Partial<AgentConfig>) => {
    setAgents(agents.map(a => a.id === agentId ? { ...a, ...updates } : a))
  }

  // Handle folder selection
  const handleSelectFolder = async () => {
    const res = await api.selectFolder()
    if (res.success && res.data) {
      setCustomPath(res.data as string)
      // Extract directory name as suggested space name
      const dirName = (res.data as string).split(/[/\\]/).pop() || ''
      if (dirName && !name.trim()) {
        setName(dirName)
      }
    }
  }

  // Submit handler
  const handleSubmit = async () => {
    if (!name.trim()) return

    try {
      const result = await api.createHyperSpace({
        name: name.trim(),
        icon,
        customPath: customPath || undefined,
        spaceType: 'hyper',
        agents,
        orchestration
      })

      console.log('[HyperSpaceDialog] Create result:', result)

      if (result.success) {
        // IPC returns { success: true, space: {...} }
        const spaceData = (result as any).space || (result as any).data
        const spaceId = spaceData?.id
        if (spaceId) {
          onSuccess(spaceId)
        }
        onClose()
      } else {
        console.error('[HyperSpaceDialog] Failed to create:', result.error)
      }
    } catch (error) {
      console.error('[HyperSpaceDialog] Error creating Hyper Space:', error)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="relative w-full max-w-2xl mx-4 bg-card border border-border rounded-xl shadow-xl animate-fade-in max-h-[90vh] overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Blocks className="w-5 h-5 text-purple-500" />
              <span>{t('Create Hyper Space')}</span>
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              {t('Multi-agent workspace for parallel task execution')}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg"
          >
            <Plus className="w-4 h-4 rotate-45" />
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
              <button
                onClick={handleAddAgent}
                className="flex items-center gap-1 px-2 py-1 text-xs text-primary hover:bg-primary/10 rounded-md transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                {t('Add Agent')}
              </button>
            </div>

            {/* Agent Cards */}
            <div className="space-y-3">
              {agents.map((agent) => (
                <div key={agent.id} className="p-4 bg-secondary/30 rounded-lg border border-border space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-0.5 text-xs rounded-full ${
                        agent.role === 'leader'
                          ? 'bg-purple-500/20 text-purple-500'
                          : 'bg-blue-500/20 text-blue-500'
                      }`}>
                        {t(agent.role)}
                      </span>
                      <input
                        type="text"
                        value={agent.name}
                        onChange={(e) => handleUpdateAgent(agent.id, { name: e.target.value })}
                        className="text-sm font-medium bg-transparent border-none focus:outline-none"
                        placeholder={t('Agent Name')}
                      />
                    </div>
                    {!(agents.filter(a => a.role === 'leader').length === 1 && agent.role === 'leader') && (
                      <button
                        onClick={() => handleRemoveAgent(agent.id)}
                        className="p-1 hover:bg-destructive/20 rounded transition-colors"
                      >
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </button>
                    )}
                  </div>

                  {/* Agent Type */}
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 cursor-pointer text-sm">
                      <input
                        type="radio"
                        name={`type-${agent.id}`}
                        checked={agent.type === 'local'}
                        onChange={() => handleUpdateAgent(agent.id, { type: 'local', remoteServerId: undefined })}
                      />
                      <span>{t('Local')}</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer text-sm">
                      <input
                        type="radio"
                        name={`type-${agent.id}`}
                        checked={agent.type === 'remote'}
                        onChange={() => handleUpdateAgent(agent.id, { type: 'remote' })}
                      />
                      <Cloud className="w-3.5 h-3.5" />
                      <span>{t('Remote')}</span>
                    </label>
                  </div>

                  {/* Remote Server (if remote) */}
                  {agent.type === 'remote' && (
                    <div className="space-y-1.5">
                      {remoteServers.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          {t('No remote servers available. Add a remote server first.')}
                        </p>
                      ) : (
                        <select
                          value={agent.remoteServerId || ''}
                          onChange={(e) => handleUpdateAgent(agent.id, { remoteServerId: e.target.value })}
                          className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg"
                        >
                          <option value="">{t('Select server...')}</option>
                          {remoteServers.map((server) => (
                            <option key={server.id} value={server.id}>
                              {server.name} ({server.status})
                            </option>
                          ))}
                        </select>
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
                      onChange={(e) => handleUpdateAgent(agent.id, {
                        capabilities: e.target.value.split(',').map(c => c.trim()).filter(Boolean)
                      })}
                      placeholder={t('code, testing, documentation')}
                      className="w-full px-3 py-1.5 text-sm bg-secondary border border-border rounded-lg"
                    />
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Orchestration Section */}
          <section className="space-y-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
              {t('Orchestration')}
            </h3>

            {/* Execution Mode */}
            <div className="space-y-2">
              <label className="text-sm text-foreground">{t('Execution Mode')}</label>
              <div className="flex flex-wrap gap-1.5">
                {(['parallel', 'sequential', 'adaptive'] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setOrchestration({ ...orchestration, mode })}
                    className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                      orchestration.mode === mode
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80'
                    }`}
                  >
                    {t(mode)}
                  </button>
                ))}
              </div>
            </div>

            {/* Routing Strategy */}
            <div className="space-y-2">
              <label className="text-sm text-foreground">{t('Routing Strategy')}</label>
              <div className="flex flex-wrap gap-1.5">
                {(['capability', 'round-robin', 'manual'] as const).map((strategy) => (
                  <button
                    key={strategy}
                    onClick={() => setOrchestration({
                      ...orchestration,
                      routing: { ...orchestration.routing!, strategy }
                    })}
                    className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                      orchestration.routing?.strategy === strategy
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80'
                    }`}
                  >
                    {t(strategy)}
                  </button>
                ))}
              </div>
            </div>

            {/* Aggregation Strategy */}
            <div className="space-y-2">
              <label className="text-sm text-foreground">{t('Result Aggregation')}</label>
              <div className="flex flex-wrap gap-1.5">
                {(['concat', 'summarize', 'vote'] as const).map((strategy) => (
                  <button
                    key={strategy}
                    onClick={() => setOrchestration({
                      ...orchestration,
                      aggregation: { ...orchestration.aggregation!, strategy }
                    })}
                    className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                      orchestration.aggregation?.strategy === strategy
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80'
                    }`}
                  >
                    {t(strategy)}
                  </button>
                ))}
              </div>
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
  )
}
