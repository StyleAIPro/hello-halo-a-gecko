/**
 * Remote Servers Section Component
 * Manages remote SSH server configurations with terminal output
 */

import React from 'react'
import { Server, Plus, Trash2, ExternalLink, Plug, PowerOff, CheckCircle, XCircle, Loader2, Terminal, ChevronDown, ChevronRight } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'

interface TerminalEntry {
  id: string
  timestamp: number
  type: 'command' | 'output' | 'error' | 'success'
  content: string
}

export function RemoteServersSection() {
  const { t } = useTranslation()
  const [servers, setServers] = React.useState<any[]>([])
  const [loading, setLoading] = React.useState(false)
  const [showAddDialog, setShowAddDialog] = React.useState(false)
  const [formData, setFormData] = React.useState({
    name: '',
    host: '',
    sshPort: 22,
    username: '',
    password: '',
    wsPort: 8080,
    claudeApiKey: '',
    claudeBaseUrl: '',
    claudeModel: ''
  })
  const [checkingSdk, setCheckingSdk] = React.useState<string | null>(null)
  const [deployingSdk, setDeployingSdk] = React.useState<string | null>(null)
  const [expandedServers, setExpandedServers] = React.useState<Set<string>>(new Set())
  const [terminalEntries, setTerminalEntries] = React.useState<Map<string, TerminalEntry[]>>(new Map())

  // Load servers on mount
  React.useEffect(() => {
    loadServers()
  }, [])

  // Listen for command output events from main process
  React.useEffect(() => {
    const handleCommandOutput = (data: { serverId: string; type: 'command' | 'output' | 'error' | 'success'; content: string; timestamp: number }) => {
      addTerminalEntry(data.serverId, data.type, data.content)
    }

    if (window.electron?.ipcRenderer) {
      window.electron.ipcRenderer.on('remote-server:command-output', handleCommandOutput)
    }

    return () => {
      window.electron?.ipcRenderer?.removeListener('remote-server:command-output', handleCommandOutput)
    }
  }, [])

  // Load servers
  const loadServers = async () => {
    setLoading(true)
    try {
      console.log('[RemoteServersSection] Loading servers...')
      const result = await api.remoteServerList()
      console.log('[RemoteServersSection] Load result:', result)
      console.log('[RemoteServersSection] Load result data:', JSON.stringify(result.data))
      if (result.success && result.data) {
        setServers(result.data)

        // Auto-connect all disconnected servers
        const disconnectedServers = result.data.filter((s: any) => s.status !== 'connected')
        if (disconnectedServers.length > 0) {
          console.log('[RemoteServersSection] Auto-connecting servers:', disconnectedServers.map((s: any) => s.name))
          for (const server of disconnectedServers) {
            try {
              await api.remoteServerConnect(server.id)
            } catch (error) {
              console.error('[RemoteServersSection] Failed to auto-connect server:', server.id, error)
            }
          }
          // Reload servers after connecting to update status
          await new Promise(resolve => setTimeout(resolve, 500))
          const reloadResult = await api.remoteServerList()
          if (reloadResult.success && reloadResult.data) {
            setServers(reloadResult.data)
          }
        }
      } else {
        console.error('[RemoteServersSection] Failed to load servers:', result.error)
      }
    } catch (error) {
      console.error('[RemoteServersSection] Error loading servers:', error)
    } finally {
      setLoading(false)
    }
  }

  // Add terminal entry for a specific server
  const addTerminalEntry = (serverId: string, type: TerminalEntry['type'], content: string) => {
    const entry: TerminalEntry = {
      id: `entry-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      type,
      content
    }
    setTerminalEntries(prev => {
      const newMap = new Map(prev)
      const existing = newMap.get(serverId) || []
      newMap.set(serverId, [...existing, entry].slice(-50)) // Keep last 50 entries
      return newMap
    })
  }

  // Clear terminal for a server
  const clearTerminal = (serverId: string) => {
    setTerminalEntries(prev => {
      const newMap = new Map(prev)
      newMap.delete(serverId)
      return newMap
    })
  }

  // Toggle server expansion
  const toggleExpand = (serverId: string) => {
    setExpandedServers(prev => {
      const newSet = new Set(prev)
      if (newSet.has(serverId)) {
        newSet.delete(serverId)
      } else {
        newSet.add(serverId)
      }
      return newSet
    })
  }

  // Expand server card
  const expandServer = (serverId: string) => {
    setExpandedServers(prev => new Set([...prev, serverId]))
  }

  const handleAddServer = async () => {
    console.log('[RemoteServersSection] Add server clicked, formData:', formData)

    // Transform flat form data to format expected by backend
    const serverInput = {
      name: formData.name,
      ssh: {
        host: formData.host,
        port: formData.sshPort,
        username: formData.username,
        password: formData.password,
      },
      wsPort: formData.wsPort,
      claudeApiKey: formData.claudeApiKey,
      claudeBaseUrl: formData.claudeBaseUrl,
      claudeModel: formData.claudeModel
    }

    try {
      const result = await api.remoteServerAdd(serverInput)
      console.log('[RemoteServersSection] Add result:', result)
      if (result.success && result.data) {
        setShowAddDialog(false)
        setFormData({
          name: '',
          host: '',
          sshPort: 22,
          username: '',
          password: '',
          wsPort: 8080,
          claudeApiKey: '',
          claudeBaseUrl: '',
          claudeModel: ''
        })
        await loadServers()

        // Auto-connect the newly added server
        console.log('[RemoteServersSection] Auto-connecting newly added server:', result.data.id)
        await api.remoteServerConnect(result.data.id)

        // Reload servers to update status
        await new Promise(resolve => setTimeout(resolve, 500))
        await loadServers()
      } else {
        console.error('[RemoteServersSection] Add failed:', result.error)
        alert(result.error || t('Failed to add server'))
      }
    } catch (error) {
      console.error('[RemoteServersSection] Add error:', error)
      alert(t('Failed to add server'))
    }
  }

  const handleDeleteServer = async (serverId: string) => {
    if (!confirm(t('Are you sure you want to delete this server?'))) return
    try {
      const result = await api.remoteServerDelete(serverId)
      if (result.success) {
        await loadServers()
      }
    } catch (error) {
      console.error('Failed to delete server:', error)
    }
  }

  const handleConnectServer = async (serverId: string) => {
    try {
      const result = await api.remoteServerConnect(serverId)
      if (result.success) {
        await loadServers()
      } else {
        alert(result.error || t('Failed to connect'))
      }
    } catch (error) {
      console.error('Failed to connect server:', error)
      alert(t('Failed to connect'))
    }
  }

  const handleDisconnectServer = async (serverId: string) => {
    try {
      const result = await api.remoteServerDisconnect(serverId)
      if (result.success) {
        await loadServers()
      }
    } catch (error) {
      console.error('Failed to disconnect server:', error)
    }
  }

  const handleCheckSdk = async (serverId: string) => {
    setCheckingSdk(serverId)
    expandServer(serverId)
    clearTerminal(serverId)

    console.log('[RemoteServersSection] Checking SDK for server:', serverId)
    try {
      const result = await api.remoteServerCheckAgent(serverId)
      console.log('[RemoteServersSection] SDK check result:', result)
      if (result.success && result.data) {
        alert(
          result.data.installed
            ? t('SDK already installed, version: {{version}}', { version: result.data.version })
            : t('SDK not installed, will deploy now')
        )
        await loadServers()
      } else {
        addTerminalEntry(serverId, 'error', `Failed to check SDK: ${result.error}`)
        alert(result.error || t('Failed to check SDK'))
      }
    } catch (error) {
      addTerminalEntry(serverId, 'error', `Error checking SDK: ${error}`)
      console.error('[RemoteServersSection] Check SDK error:', error)
      alert(t('Failed to check SDK'))
    } finally {
      setCheckingSdk(null)
    }
  }

  const handleDeploySdk = async (serverId: string) => {
    if (!confirm(t('Are you sure you want to deploy claude-agent-sdk?'))) return
    setDeployingSdk(serverId)
    expandServer(serverId)
    clearTerminal(serverId)

    console.log('[RemoteServersSection] Deploying SDK for server:', serverId)
    try {
      const result = await api.remoteServerDeployAgent(serverId)
      console.log('[RemoteServersSection] Deploy result:', result)
      if (result.success) {
        alert(t('SDK deployed successfully'))
        await loadServers()
      } else {
        addTerminalEntry(serverId, 'error', `Deployment failed: ${result.error}`)
        alert(result.error || t('Failed to deploy SDK'))
      }
    } catch (error) {
      addTerminalEntry(serverId, 'error', `Error deploying SDK: ${error}`)
      console.error('[RemoteServersSection] Deploy SDK error:', error)
      alert(t('Failed to deploy SDK'))
    } finally {
      setDeployingSdk(null)
    }
  }

  const getSdkStatusBadge = (server: any) => {
    if (server.sdkInstalled) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-green-500/10 text-green-600 text-xs rounded-full">
          <CheckCircle className="w-3 h-3" />
          <span>{t('SDK Installed')} {server.sdkVersion ? `(${server.sdkVersion})` : ''}</span>
        </span>
      )
    } else if (checkingSdk === server.id || deployingSdk === server.id) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-yellow-500/10 text-yellow-600 text-xs rounded-full">
          {checkingSdk === server.id ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <span>{t('Deploying...')}</span>
          )}
        </span>
      )
    } else {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-red-500/10 text-red-600 text-xs rounded-full">
          <XCircle className="w-3 h-3" />
          <span>{t('SDK Not Installed')}</span>
        </span>
      )
    }
  }

  return (
    <section id="remote-servers" className="bg-card rounded-xl border border-border p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">{t('远程服务器管理')}</h2>
          <p className="text-sm text-muted-foreground">{t('Manage and connect to remote SSH servers')}</p>
        </div>
        <button
          onClick={() => setShowAddDialog(true)}
          className="px-4 py-2 bg-primary text-primary-foreground rounded-lg flex items-center gap-2 hover:bg-primary/90 transition-colors"
        >
          <Plus className="w-4 h-4" />
          {t('Add Server')}
        </button>
      </div>

      {/* Servers List */}
      {loading ? (
        <div className="text-center py-12">
          <div className="inline-block w-8 h-8 border-2 border-primary/20 rounded-full animate-spin"></div>
        </div>
      ) : servers.length === 0 ? (
        <div className="text-center py-12">
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <Plug className="w-12 h-12" />
            <p>{t('No remote servers configured')}</p>
            <p className="text-sm">{t('Add a server to get started')}</p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {servers.map((server: any) => {
            const isExpanded = expandedServers.has(server.id)
            const entries = terminalEntries.get(server.id) || []

            return (
              <div key={server.id} className="border border-border rounded-lg overflow-hidden">
                {/* Server Card Header */}
                <div className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => toggleExpand(server.id)}
                        className="p-1 hover:bg-secondary/10 rounded-lg transition-colors"
                      >
                        {isExpanded ? (
                          <ChevronDown className="w-4 h-4 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="w-4 h-4 text-muted-foreground" />
                        )}
                      </button>
                      <div>
                        <h3 className="font-semibold">{server.name || t('Unknown')}</h3>
                        <p className="text-sm text-muted-foreground">
                          {server.host || ''}:{server.wsPort || ''}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {getSdkStatusBadge(server)}
                      <span className="text-xs text-muted-foreground">
                        {server.status || 'disconnected'}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between mt-3">
                    <div className="flex items-center gap-2">
                      {server.status === 'connected' ? (
                        <button
                          onClick={() => handleDisconnectServer(server.id)}
                          className="p-1.5 hover:bg-destructive/10 text-destructive hover:text-destructive rounded-lg transition-colors"
                          title={t('Disconnect')}
                        >
                          <PowerOff className="w-4 h-4" />
                        </button>
                      ) : (
                        <button
                          onClick={() => handleConnectServer(server.id)}
                          className="p-1.5 hover:bg-primary/10 text-primary hover:text-primary-foreground rounded-lg transition-colors"
                          title={t('Connect')}
                        >
                          <Plug className="w-4 h-4" />
                        </button>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleCheckSdk(server.id)}
                        disabled={checkingSdk === server.id || deployingSdk === server.id}
                        className="p-1.5 hover:bg-secondary/10 rounded-lg transition-colors disabled:opacity-50"
                        title={t('Check SDK Installation')}
                      >
                        <Terminal className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDeploySdk(server.id)}
                        disabled={checkingSdk === server.id || deployingSdk === server.id}
                        className="p-1.5 hover:bg-blue-500/10 rounded-lg transition-colors disabled:opacity-50"
                        title={t('Deploy SDK')}
                      >
                        <ExternalLink className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDeleteServer(server.id)}
                        className="p-1.5 hover:bg-destructive/10 text-destructive hover:text-destructive rounded-lg transition-colors"
                        title={t('Delete')}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>

                {/* Expandable Terminal Section */}
                {isExpanded && (
                  <div className="border-t border-border">
                    <div className="bg-neutral-950 p-4 max-h-80 overflow-auto">
                      {entries.length === 0 ? (
                        <div className="flex items-center justify-center h-full text-muted-foreground">
                          <p className="text-sm">{t('No output')}</p>
                        </div>
                      ) : (
                        <div className="space-y-2 font-mono text-sm">
                          {entries.map((entry) => (
                            <div key={entry.id} className="flex gap-2">
                              <span className="text-muted-foreground/50 text-xs shrink-0">
                                {new Date(entry.timestamp).toLocaleTimeString()}
                              </span>
                              {entry.type === 'command' && (
                                <span className="text-primary font-semibold">$ {entry.content}</span>
                              )}
                              {entry.type === 'output' && (
                                <span className="text-green-400">{entry.content}</span>
                              )}
                              {entry.type === 'error' && (
                                <span className="text-red-400 flex items-start gap-1.5">
                                  <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
                                  <span>{entry.content}</span>
                                </span>
                              )}
                              {entry.type === 'success' && (
                                <span className="text-green-500 flex items-start gap-1.5">
                                  <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" />
                                  <span>{entry.content}</span>
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Add Server Dialog */}
      {showAddDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100]">
          <div className="bg-card border border-border rounded-xl p-6 w-full max-w-md">
            <h3 className="text-lg font-semibold mb-4">{t('Add Remote Server')}</h3>
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-1 block">{t('Server Name')}</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full px-3 py-2 bg-input border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
                  placeholder={t('My Server')}
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">{t('Host')}</label>
                <input
                  type="text"
                  value={formData.host}
                  onChange={(e) => setFormData({ ...formData, host: e.target.value })}
                  className="w-full px-3 py-2 bg-input border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
                  placeholder="192.168.1.100"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium mb-1 block">{t('SSH Port')}</label>
                  <input
                    type="number"
                    value={formData.sshPort}
                    onChange={(e) => setFormData({ ...formData, sshPort: parseInt(e.target.value) || 22 })}
                    className="w-full px-3 py-2 bg-input border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium mb-1 block">{t('WebSocket Port')}</label>
                  <input
                    type="number"
                    value={formData.wsPort}
                    onChange={(e) => setFormData({ ...formData, wsPort: parseInt(e.target.value) || 8080 })}
                    className="w-full px-3 py-2 bg-input border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
                  />
                </div>
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">{t('Username')}</label>
                <input
                  type="text"
                  value={formData.username}
                  onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                  className="w-full px-3 py-2 bg-input border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
                  placeholder="ubuntu"
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">{t('Password')}</label>
                <input
                  type="password"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  className="w-full px-3 py-2 bg-input border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
                  placeholder="•••••"
                />
              </div>
              <div className="pt-2 border-t border-border">
                <h4 className="text-sm font-medium mb-3">Claude API 配置（可选）</h4>
                <div className="space-y-3">
                  <div>
                    <label className="text-sm font-medium mb-1 block">API Key</label>
                    <input
                      type="password"
                      value={formData.claudeApiKey}
                      onChange={(e) => setFormData({ ...formData, claudeApiKey: e.target.value })}
                      className="w-full px-3 py-2 bg-input border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
                      placeholder="sk-xxx"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium mb-1 block">API Base URL（可选）</label>
                    <input
                      type="text"
                      value={formData.claudeBaseUrl}
                      onChange={(e) => setFormData({ ...formData, claudeBaseUrl: e.target.value })}
                      className="w-full px-3 py-2 bg-input border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
                      placeholder="https://api.anthropic.com"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium mb-1 block">Model（可选）</label>
                    <input
                      type="text"
                      value={formData.claudeModel}
                      onChange={(e) => setFormData({ ...formData, claudeModel: e.target.value })}
                      className="w-full px-3 py-2 bg-input border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
                      placeholder="claude-sonnet-4-20250514"
                    />
                  </div>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setShowAddDialog(false)}
                className="px-4 py-2 border border-border rounded-lg hover:bg-secondary transition-colors"
              >
                {t('Cancel')}
              </button>
              <button
                onClick={handleAddServer}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
              >
                {t('Add Server')}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
