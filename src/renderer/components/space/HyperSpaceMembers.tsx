/**
 * HyperSpaceMembers Component
 *
 * Shows the members (agents) of a Hyper Space in the sidebar.
 * Allows viewing, adding, and removing agents.
 */

import { useState, useEffect, useCallback, memo } from 'react'
import { useTranslation } from '../../i18n'
import { useSpaceStore } from '../../stores/space.store'
import { api } from '../../api'
import { Plus, Trash2, Cloud, Monitor, Crown, Wrench } from 'lucide-react'
import type { AgentConfig } from '../../../shared/types/hyper-space'
import type { RemoteServer, Space } from '../../../shared/types'

interface HyperSpaceMembersProps {
  /** Whether the section is visible */
  visible?: boolean
}

export const HyperSpaceMembers = memo(function HyperSpaceMembers({
  visible = true
}: HyperSpaceMembersProps) {
  const { t } = useTranslation()

  // Get current space
  const currentSpace = useSpaceStore(state => state.currentSpace) as Space | null

  // Check if this is a Hyper Space
  const isHyperSpace = currentSpace?.spaceType === 'hyper'

  // Agents state
  const [agents, setAgents] = useState<AgentConfig[]>([])
  const [remoteServers, setRemoteServers] = useState<RemoteServer[]>([])
  const [isAddingAgent, setIsAddingAgent] = useState(false)
  const [newAgent, setNewAgent] = useState<Partial<AgentConfig>>({
    name: '',
    type: 'local',
    role: 'worker',
    capabilities: []
  })

  // Load agents and remote servers when space changes
  useEffect(() => {
    if (isHyperSpace && currentSpace) {
      // Get agents from space
      const spaceAgents = currentSpace.agents || []
      console.log('[HyperSpaceMembers] Loading agents:', spaceAgents)
      setAgents(spaceAgents as AgentConfig[])

      // Load remote servers for adding remote agents
      api.remoteServerList().then(result => {
        if (result.success && result.data) {
          setRemoteServers(result.data)
        }
      })
    }
  }, [isHyperSpace, currentSpace?.id])

  // Reset state when hidden
  useEffect(() => {
    if (!visible) {
      setIsAddingAgent(false)
    }
  }, [visible])

  // Add agent handler
  const handleAddAgent = useCallback(async () => {
    if (!currentSpace || !newAgent.name?.trim()) return

    const agent: AgentConfig = {
      id: `agent-${Date.now()}`,
      name: newAgent.name.trim(),
      type: newAgent.type || 'local',
      role: newAgent.role || 'worker',
      capabilities: newAgent.capabilities || [],
      remoteServerId: newAgent.remoteServerId
    }

    const result = await api.addAgentToHyperSpace(currentSpace.id, agent)

    if (result.success) {
      setAgents([...agents, agent])
      setNewAgent({
        name: '',
        type: 'local',
        role: 'worker',
        capabilities: []
      })
      setIsAddingAgent(false)
    }
  }, [currentSpace, newAgent, agents])

  // Remove agent handler
  const handleRemoveAgent = useCallback(async (agentId: string) => {
    if (!currentSpace) return

    // Don't allow removing the only leader
    const agent = agents.find(a => a.id === agentId)
    if (agent?.role === 'leader' && agents.filter(a => a.role === 'leader').length === 1) {
      return
    }

    const result = await api.removeAgentFromHyperSpace(currentSpace.id, agentId)

    if (result.success) {
      setAgents(agents.filter(a => a.id !== agentId))
    }
  }, [currentSpace, agents])

  // Don't render if not a Hyper Space or not visible
  if (!isHyperSpace || !visible) return null

  return (
    <div className="border-b border-border">
      {/* Header */}
      <div className="px-3 py-2 flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t('Space Members')}
        </span>
        <button
          onClick={() => setIsAddingAgent(!isAddingAgent)}
          className="p-1 hover:bg-secondary rounded transition-colors text-muted-foreground hover:text-foreground"
          title={t('Add Agent')}
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Agent List */}
      <div className="pb-2">
        {agents.map((agent) => (
          <div
            key={agent.id}
            className="px-3 py-1.5 flex items-center gap-2 hover:bg-secondary/30 group"
          >
            {/* Role Icon */}
            {agent.role === 'leader' ? (
              <Crown className="w-3.5 h-3.5 text-purple-500 flex-shrink-0" />
            ) : (
              <Wrench className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
            )}

            {/* Type Icon */}
            {agent.type === 'remote' ? (
              <Cloud className="w-3 h-3 text-green-500 flex-shrink-0" />
            ) : (
              <Monitor className="w-3 h-3 text-gray-400 flex-shrink-0" />
            )}

            {/* Agent Name */}
            <span className="text-xs truncate flex-1">{agent.name}</span>

            {/* Role Badge */}
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${
              agent.role === 'leader'
                ? 'bg-purple-500/20 text-purple-500'
                : 'bg-blue-500/20 text-blue-500'
            }`}>
              {t(agent.role)}
            </span>

            {/* Remove Button */}
            {!(agents.filter(a => a.role === 'leader').length === 1 && agent.role === 'leader') && (
              <button
                onClick={() => handleRemoveAgent(agent.id)}
                className="p-0.5 opacity-0 group-hover:opacity-100 hover:bg-destructive/20 rounded transition-all text-muted-foreground hover:text-destructive"
                title={t('Remove')}
              >
                <Trash2 className="w-3 h-3" />
              </button>
            )}
          </div>
        ))}

        {/* Add Agent Form */}
        {isAddingAgent && (
          <div className="px-3 py-2 space-y-2 bg-secondary/20 border-t border-border">
            {/* Agent Name */}
            <input
              type="text"
              value={newAgent.name || ''}
              onChange={(e) => setNewAgent({ ...newAgent, name: e.target.value })}
              placeholder={t('Agent Name')}
              className="w-full px-2 py-1 text-xs bg-secondary border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary"
            />

            {/* Type Selection */}
            <div className="flex gap-2">
              <label className="flex items-center gap-1 cursor-pointer text-xs">
                <input
                  type="radio"
                  name="agent-type"
                  checked={newAgent.type === 'local'}
                  onChange={() => setNewAgent({ ...newAgent, type: 'local', remoteServerId: undefined })}
                  className="w-3 h-3"
                />
                <Monitor className="w-3 h-3" />
                <span>{t('Local')}</span>
              </label>
              <label className="flex items-center gap-1 cursor-pointer text-xs">
                <input
                  type="radio"
                  name="agent-type"
                  checked={newAgent.type === 'remote'}
                  onChange={() => setNewAgent({ ...newAgent, type: 'remote' })}
                  className="w-3 h-3"
                />
                <Cloud className="w-3 h-3" />
                <span>{t('Remote')}</span>
              </label>
            </div>

            {/* Remote Server Selection */}
            {newAgent.type === 'remote' && (
              <select
                value={newAgent.remoteServerId || ''}
                onChange={(e) => setNewAgent({ ...newAgent, remoteServerId: e.target.value })}
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

            {/* Role Selection */}
            <div className="flex gap-2">
              <label className="flex items-center gap-1 cursor-pointer text-xs">
                <input
                  type="radio"
                  name="agent-role"
                  checked={newAgent.role === 'leader'}
                  onChange={() => setNewAgent({ ...newAgent, role: 'leader' })}
                  className="w-3 h-3"
                />
                <Crown className="w-3 h-3 text-purple-500" />
                <span>{t('leader')}</span>
              </label>
              <label className="flex items-center gap-1 cursor-pointer text-xs">
                <input
                  type="radio"
                  name="agent-role"
                  checked={newAgent.role === 'worker'}
                  onChange={() => setNewAgent({ ...newAgent, role: 'worker' })}
                  className="w-3 h-3"
                />
                <Wrench className="w-3 h-3 text-blue-500" />
                <span>{t('worker')}</span>
              </label>
            </div>

            {/* Actions */}
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => setIsAddingAgent(false)}
                className="flex-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary rounded transition-colors"
              >
                {t('Cancel')}
              </button>
              <button
                onClick={handleAddAgent}
                disabled={!newAgent.name?.trim()}
                className="flex-1 px-2 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {t('Add')}
              </button>
            </div>
          </div>
        )}

        {/* Empty State */}
        {agents.length === 0 && !isAddingAgent && (
          <div className="px-3 py-2 text-xs text-muted-foreground text-center">
            {t('No agents in this space')}
          </div>
        )}
      </div>
    </div>
  )
})
