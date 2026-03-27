/**
 * Remote Servers Page - Manage remote SSH servers
 */

import React, { useState, useEffect } from 'react'
import { ArrowLeft, Plus, Server, Trash2, Edit, Globe, FolderOpen, Terminal, AlertCircle, CheckCircle, Loader2, MessageSquare, Rocket, Link as LinkIcon, Info, X } from 'lucide-react'
import { Header } from '../components/layout/Header'
import { api } from '../api'
import { useAppStore } from '../stores/app.store'
import { useSpaceStore } from '../stores/space.store'
import { useChatStore } from '../stores/chat.store'
import { useTranslation } from '../i18n'

export interface RemoteServer {
  id: string
  name: string
  host: string
  port: number
  username?: string
  authType: 'password' | 'key'
  workDir?: string
  status?: 'connected' | 'disconnected' | 'connecting' | 'deploying' | 'error'
  deployed?: boolean
  lastConnected?: string
  agentStatus?: 'running' | 'stopped' | 'error'
  claudeApiKey?: string
  claudeBaseUrl?: string
  claudeModel?: string
}

export function RemoteServersPage() {
  const { t } = useTranslation()
  const { goBack, setView } = useAppStore()
  const { spaces, loadSpaces, setCurrentSpace } = useSpaceStore()
  const { selectConversation } = useChatStore()
  const [servers, setServers] = useState<RemoteServer[]>([])
  const [showAddModal, setShowAddModal] = useState(false)
  const [showDetailsModal, setShowDetailsModal] = useState(false)
  const [editingServer, setEditingServer] = useState<RemoteServer | null>(null)
  const [selectedServerDetails, setSelectedServerDetails] = useState<RemoteServer | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<string | null>(null)
  const [testConnectionId, setTestConnectionId] = useState<string | null>(null)
  const [deployingId, setDeployingId] = useState<string | null>(null)
  const [connectingId, setConnectingId] = useState<string | null>(null)

  // Form state
  const [serverName, setServerName] = useState('')
  const [serverHost, setServerHost] = useState('')
  const [serverPort, setServerPort] = useState('22')
  const [serverUsername, setServerUsername] = useState('')
  const [authType, setAuthType] = useState<'password' | 'key'>('password')
  const [password, setPassword] = useState('')
  const [keyPath, setKeyPath] = useState('')
  const [workDir, setWorkDir] = useState('')

  // Load servers on mount
  useEffect(() => {
    loadServers()
  }, [])

  // Reset form state
  const resetForm = () => {
    setServerName('')
    setServerHost('')
    setServerPort('22')
    setServerUsername('')
    setAuthType('password')
    setPassword('')
    setKeyPath('')
    setWorkDir('')
  }

  const loadServers = async () => {
    setLoading(true)
    try {
      const result = await api.getRemoteServers()
      if (result.success && result.data) {
        setServers(result.data as RemoteServer[])
      }
    } catch (err) {
      console.error('[RemoteServersPage] Failed to load servers:', err)
    } finally {
      setLoading(false)
    }
  }

  // Open remote space chat - unified with local space flow
  const openRemoteSpaceChat = async (server: RemoteServer) => {
    try {
      // Ensure spaces are loaded
      if (spaces.length === 0) {
        await loadSpaces()
      }

      // Find existing remote space for this server
      const existingSpace = spaces.find(s => s.remoteServerId === server.id)

      if (existingSpace) {
        // Use existing space
        setCurrentSpace(existingSpace)
        setView('space')
      } else {
        // Create new remote space
        const result = await api.createSpace({
          name: server.name,
          icon: 'server',
          claudeSource: 'remote',
          remoteServerId: server.id,
          remotePath: server.workDir || '/home',
          useSshTunnel: true
        })

        if (result.success && result.data) {
          const newSpace = result.data as any
          setCurrentSpace(newSpace)
          // Reload spaces to include the new one
          await loadSpaces()
          setView('space')
        } else {
          console.error('[RemoteServersPage] Failed to create remote space:', result.error)
        }
      }
    } catch (err) {
      console.error('[RemoteServersPage] Failed to open remote space chat:', err)
    }
  }

  const handleAddServer = async () => {
    if (!serverName.trim() || !serverHost.trim()) return

    // Prevent concurrent calls (multiple quick clicks)
    if (saving) return

    setSaving(true)
    setSaveStatus(t('Adding server...'))
    try {
      const newServer: Omit<RemoteServer, 'id'> = {
        name: serverName.trim(),
        host: serverHost.trim(),
        port: parseInt(serverPort, 10) || 22,
        username: serverUsername.trim() || undefined,
        authType,
        workDir: workDir.trim() || undefined,
      }

      setSaveStatus(t('Connecting to server...'))
      const result = await api.addRemoteServer(newServer)
      if (result.success) {
        setSaveStatus(t('Verifying installation...'))
        await loadServers()
        setShowAddModal(false)
        resetForm()
      }
    } catch (err) {
      console.error('[RemoteServersPage] Failed to add server:', err)
    } finally {
      setSaving(false)
      setSaveStatus(null)
    }
  }

  const handleEditServer = async () => {
    if (!editingServer || !serverName.trim() || !serverHost.trim()) return

    // Prevent concurrent calls (multiple quick clicks)
    if (saving) return

    setSaving(true)
    setSaveStatus(t('Updating server...'))
    try {
      // Use 'as any' to handle type mismatch between local RemoteServer and shared RemoteServer
      // The backend expects: host, sshPort, username, password (flat structure)
      const updatedServer: any = {
        id: editingServer.id,
        name: serverName.trim(),
        host: serverHost.trim(),
        sshPort: parseInt(serverPort, 10) || 22,
        username: serverUsername.trim() || undefined,
        // Pass password - if empty, backend will preserve original
        password: password.trim() || '',
        workDir: workDir.trim() || undefined,
        claudeApiKey: (editingServer as any).claudeApiKey,
        claudeBaseUrl: (editingServer as any).claudeBaseUrl,
        claudeModel: (editingServer as any).claudeModel,
      }

      const result = await api.updateRemoteServer(updatedServer)
      if (result.success) {
        await loadServers()
        setEditingServer(null)
        resetForm()
      }
    } catch (err) {
      console.error('[RemoteServersPage] Failed to update server:', err)
    } finally {
      setSaving(false)
      setSaveStatus(null)
    }
  }

  const handleDeleteServer = async (id: string) => {
    if (!confirm(t('Are you sure you want to delete this remote server?'))) {
      return
    }

    try {
      const result = await api.deleteRemoteServer(id)
      if (result.success) {
        await loadServers()
      }
    } catch (err) {
      console.error('[RemoteServersPage] Failed to delete server:', err)
    }
  }

  const handleTestConnection = async (server: RemoteServer) => {
    setTestConnectionId(server.id)
    try {
      const result = await api.testRemoteConnection(server.id)
      if (result.success) {
        setServers(prev => prev.map(s =>
          s.id === server.id
            ? { ...s, status: 'connected', lastConnected: new Date().toISOString() }
            : s
        ))
      }
    } catch (err) {
      console.error('[RemoteServersPage] Failed to test connection:', err)
      setServers(prev => prev.map(s =>
        s.id === server.id ? { ...s, status: 'disconnected' } : s
      ))
    } finally {
      setTestConnectionId(null)
    }
  }

  const handleDeploy = async (server: RemoteServer) => {
    setDeployingId(server.id)
    try {
      setServers(prev => prev.map(s =>
        s.id === server.id ? { ...s, status: 'deploying' } : s
      ))
      const result = await api.deployRemoteAgent(server.id)
      if (result.success) {
        setServers(prev => prev.map(s =>
          s.id === server.id
            ? { ...s, status: 'connected', deployed: true, agentStatus: 'running' }
            : s
        ))
      } else {
        setServers(prev => prev.map(s =>
          s.id === server.id ? { ...s, status: 'error' } : s
        ))
      }
    } catch (err) {
      console.error('[RemoteServersPage] Failed to deploy agent:', err)
      setServers(prev => prev.map(s =>
        s.id === server.id ? { ...s, status: 'error' } : s
      ))
    } finally {
      setDeployingId(null)
    }
  }

  const handleConnect = async (server: RemoteServer) => {
    setConnectingId(server.id)
    try {
      setServers(prev => prev.map(s =>
        s.id === server.id ? { ...s, status: 'connecting' } : s
      ))
      const result = await api.connectRemoteAgent(server.id)
      if (result.success) {
        setServers(prev => prev.map(s =>
          s.id === server.id
            ? { ...s, status: 'connected', agentStatus: 'running' }
            : s
        ))
        // Navigate to chat view (unified with local space)
        openRemoteSpaceChat(server)
      } else {
        setServers(prev => prev.map(s =>
          s.id === server.id ? { ...s, status: 'error' } : s
        ))
      }
    } catch (err) {
      console.error('[RemoteServersPage] Failed to connect to agent:', err)
      setServers(prev => prev.map(s =>
        s.id === server.id ? { ...s, status: 'error' } : s
      ))
    } finally {
      setConnectingId(null)
    }
  }

  const openDetailsModal = (server: RemoteServer) => {
    setSelectedServerDetails(server)
    setShowDetailsModal(true)
  }

  const openAddModal = () => {
    resetForm()
    setShowAddModal(true)
  }

  const openEditModal = (server: RemoteServer) => {
    setEditingServer(server)
    setServerName(server.name)
    setServerHost(server.host)
    setServerPort(server.port.toString())
    setServerUsername(server.username || '')
    setAuthType(server.authType)
    setWorkDir(server.workDir || '')
  }

  const closeModal = () => {
    setShowAddModal(false)
    setEditingServer(null)
    resetForm()
  }

  // In edit mode, password can be empty (will preserve original)
  // In add mode, password is required
  const isFormValid = serverName.trim() && serverHost.trim() &&
    (authType === 'password'
      ? (editingServer ? true : password.trim())
      : keyPath.trim())

  return (
    <div className="h-full w-full flex flex-col">
      {/* Header */}
      <Header
        left={
          <>
            <button
              onClick={goBack}
              className="p-1.5 hover:bg-secondary rounded-lg transition-colors"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <span className="font-medium text-sm">{t('Remote Servers')}</span>
          </>
        }
        right={
          <button
            onClick={openAddModal}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-primary hover:bg-primary/10 rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" />
            {t('Add Server')}
          </button>
        }
      />

      {/* Content */}
      <main className="flex-1 overflow-auto p-6">
        <div className="max-w-3xl mx-auto">
          {/* Description */}
          <div className="mb-6 text-sm text-muted-foreground">
            {t('Manage remote SSH servers for running AI agents. Connect to servers to deploy and manage remote agents.')}
          </div>

          {/* Server list */}
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
          ) : servers.length === 0 ? (
            <div className="text-center py-12 border border-dashed border-border rounded-xl">
              <Server className="w-16 h-16 mx-auto text-muted-foreground/30 mb-4" />
              <h3 className="text-lg font-medium mb-2">{t('No remote servers configured')}</h3>
              <p className="text-sm text-muted-foreground mb-4">
                {t('Add your first remote server to start deploying AI agents.')}
              </p>
              <button
                onClick={openAddModal}
                className="flex items-center gap-1.5 px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors"
              >
                <Plus className="w-4 h-4" />
                {t('Add Your First Server')}
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {servers.map((server) => (
                <div
                  key={server.id}
                  className="border border-border rounded-xl p-4 hover:border-primary/40 transition-colors cursor-pointer"
                  onClick={() => openDetailsModal(server)}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3">
                      {/* Icon */}
                      <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                        server.status === 'connected'
                          ? 'bg-green-500/10'
                          : server.status === 'connecting' || server.status === 'deploying'
                          ? 'bg-blue-500/10'
                          : server.status === 'error'
                          ? 'bg-red-500/10'
                          : 'bg-muted'
                      }`}>
                        {server.status === 'connecting' || server.status === 'deploying' ? (
                          <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
                        ) : server.status === 'connected' ? (
                          <CheckCircle className="w-5 h-5 text-green-500" />
                        ) : server.status === 'error' ? (
                          <AlertCircle className="w-5 h-5 text-red-500" />
                        ) : (
                          <Server className="w-5 h-5 text-muted-foreground" />
                        )}
                      </div>

                      {/* Server info */}
                      <div>
                        <h3 className="font-medium text-foreground">{server.name}</h3>
                        <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1">
                          <Globe className="w-3.5 h-3.5" />
                          <span>{server.host}:{server.port}</span>
                        </div>
                        {server.workDir && (
                          <div className="flex items-center gap-2 text-sm text-muted-foreground mt-0.5">
                            <FolderOpen className="w-3.5 h-3.5" />
                            <span className="truncate">{server.workDir}</span>
                          </div>
                        )}
                        {/* Status badge */}
                        <div className="flex items-center gap-2 mt-1">
                          {server.status === 'deploying' && (
                            <span className="text-xs text-blue-500">
                              {t('Deploying...')}
                            </span>
                          )}
                          {server.deployed && server.agentStatus === 'running' && (
                            <span className="text-xs text-green-500">
                              {t('Agent Running')}
                            </span>
                          )}
                          {server.deployed && server.agentStatus === 'stopped' && (
                            <span className="text-xs text-amber-500">
                              {t('Agent Stopped')}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                      {/* Deploy button for disconnected/not deployed servers */}
                      {!server.deployed && server.status !== 'deploying' && (
                        <button
                          onClick={() => handleDeploy(server)}
                          disabled={deployingId === server.id}
                          className="flex items-center gap-1 px-3 py-1.5 text-sm bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors disabled:opacity-50"
                          title={t('Deploy agent to this server')}
                        >
                          {deployingId === server.id ? (
                            <>
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              {t('Deploying...')}
                            </>
                          ) : (
                            <>
                              <Rocket className="w-3.5 h-3.5" />
                              {t('Deploy')}
                            </>
                          )}
                        </button>
                      )}

                      {/* Connect button for deployed servers */}
                      {server.deployed && server.status !== 'connected' && server.status !== 'deploying' && (
                        <button
                          onClick={() => handleConnect(server)}
                          disabled={connectingId === server.id}
                          className="flex items-center gap-1 px-3 py-1.5 text-sm bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors disabled:opacity-50"
                          title={t('Connect to agent')}
                        >
                          {connectingId === server.id ? (
                            <>
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              {t('Connecting...')}
                            </>
                          ) : (
                            <>
                              <LinkIcon className="w-3.5 h-3.5" />
                              {t('Connect')}
                            </>
                          )}
                        </button>
                      )}

                      <button
                        onClick={() => openRemoteSpaceChat(server)}
                        className="p-2 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-lg transition-colors"
                        title={t('Chat')}
                      >
                        <MessageSquare className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleTestConnection(server)}
                        disabled={testConnectionId === server.id}
                        className="p-2 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg transition-colors disabled:opacity-50"
                        title={t('Test connection')}
                      >
                        {testConnectionId === server.id ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Terminal className="w-4 h-4" />
                        )}
                      </button>
                      <button
                        onClick={() => openEditModal(server)}
                        className="p-2 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg transition-colors"
                        title={t('Edit')}
                      >
                        <Edit className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDeleteServer(server.id)}
                        className="p-2 text-muted-foreground hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-colors"
                        title={t('Delete')}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>

      {/* Add/Edit Server Modal */}
      {(showAddModal || editingServer) && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card border border-border rounded-xl w-full max-w-md animate-fade-in">
            <div className="p-6 border-b border-border">
              <h2 className="text-lg font-medium">
                {editingServer ? t('Edit Server') : t('Add Remote Server')}
              </h2>
            </div>

            <div className="p-6 space-y-4">
              {/* Server name */}
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-1.5">
                  {t('Server Name')}
                </label>
                <input
                  type="text"
                  value={serverName}
                  onChange={e => setServerName(e.target.value)}
                  placeholder="My Production Server"
                  className="w-full px-3 py-2 border border-border rounded-lg bg-input text-foreground focus:ring-2 focus:ring-primary focus:border-transparent transition-colors"
                  autoFocus
                />
              </div>

              {/* Host */}
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-1.5">
                  {t('Host')}
                </label>
                <input
                  type="text"
                  value={serverHost}
                  onChange={e => setServerHost(e.target.value)}
                  placeholder="192.168.1.100"
                  className="w-full px-3 py-2 border border-border rounded-lg bg-input text-foreground focus:ring-2 focus:ring-primary focus:border-transparent transition-colors font-mono text-sm"
                />
              </div>

              {/* Port */}
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-1.5">
                  {t('Port')}
                </label>
                <input
                  type="number"
                  value={serverPort}
                  onChange={e => setServerPort(e.target.value)}
                  placeholder="22"
                  className="w-full px-3 py-2 border border-border rounded-lg bg-input text-foreground focus:ring-2 focus:ring-primary focus:border-transparent transition-colors font-mono text-sm"
                />
              </div>

              {/* Username */}
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-1.5">
                  {t('Username (optional)')}
                </label>
                <input
                  type="text"
                  value={serverUsername}
                  onChange={e => setServerUsername(e.target.value)}
                  placeholder="user"
                  className="w-full px-3 py-2 border border-border rounded-lg bg-input text-foreground focus:ring-2 focus:ring-primary focus:border-transparent transition-colors"
                />
              </div>

              {/* Auth Type */}
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-1.5">
                  {t('Authentication Type')}
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setAuthType('password')}
                    className={`flex-1 px-4 py-2 rounded-lg transition-colors ${
                      authType === 'password'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-secondary text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {t('Password')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setAuthType('key')}
                    className={`flex-1 px-4 py-2 rounded-lg transition-colors ${
                      authType === 'key'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-secondary text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {t('SSH Key')}
                  </button>
                </div>
              </div>

              {/* Password or Key Path */}
              {authType === 'password' ? (
                <div>
                  <label className="block text-sm font-medium text-muted-foreground mb-1.5">
                    {t('Password')}
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder={editingServer ? '••••••••' : '••••••••'}
                    className="w-full px-3 py-2 border border-border rounded-lg bg-input text-foreground focus:ring-2 focus:ring-primary focus:border-transparent transition-colors"
                  />
                  {editingServer && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {t('Leave blank to keep current password')}
                    </p>
                  )}
                </div>
              ) : (
                <div>
                  <label className="block text-sm font-medium text-muted-foreground mb-1.5">
                    {t('SSH Key Path')}
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={keyPath}
                      onChange={e => setKeyPath(e.target.value)}
                      placeholder={window.platform.isWindows ? 'C:\\Users\\<user>\\.ssh\\id_rsa' : '~/.ssh/id_rsa'}
                      className="flex-1 px-3 py-2 border border-border rounded-lg bg-input text-foreground focus:ring-2 focus:ring-primary focus:border-transparent transition-colors font-mono text-sm"
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        const result = await api.selectFile()
                        if (result.success && result.data) {
                          setKeyPath(result.data as string)
                        }
                      }}
                      className="px-3 py-2 bg-secondary hover:bg-secondary/80 rounded-lg transition-colors text-sm"
                    >
                      {t('Browse')}
                    </button>
                  </div>
                </div>
              )}

              {/* Work Directory */}
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-1.5">
                  {t('Work Directory (optional)')}
                </label>
                <input
                  type="text"
                  value={workDir}
                  onChange={e => setWorkDir(e.target.value)}
                  placeholder="/home/user/workspace"
                  className="w-full px-3 py-2 border border-border rounded-lg bg-input text-foreground focus:ring-2 focus:ring-primary focus:border-transparent transition-colors font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {t('Directory where remote agent will operate')}
                </p>
              </div>

              {/* Claude API Config */}
              <div className="pt-4 border-t border-border">
                <h3 className="text-sm font-medium mb-3">Claude API 配置（可选）</h3>
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-muted-foreground mb-1.5">
                      API Key
                    </label>
                    <input
                      type="password"
                      value={(editingServer as any)?.claudeApiKey || ''}
                      onChange={e => {
                        setEditingServer(prev => prev ? { ...prev, claudeApiKey: e.target.value } : null)
                      }}
                      placeholder="sk-xxx"
                      className="w-full px-3 py-2 border border-border rounded-lg bg-input text-foreground focus:ring-2 focus:ring-primary focus:border-transparent transition-colors"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-muted-foreground mb-1.5">
                      API Base URL（可选）
                    </label>
                    <input
                      type="text"
                      value={(editingServer as any)?.claudeBaseUrl || ''}
                      onChange={e => {
                        setEditingServer(prev => prev ? { ...prev, claudeBaseUrl: e.target.value } : null)
                      }}
                      placeholder="https://api.anthropic.com"
                      className="w-full px-3 py-2 border border-border rounded-lg bg-input text-foreground focus:ring-2 focus:ring-primary focus:border-transparent transition-colors font-mono text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-muted-foreground mb-1.5">
                      Model（可选）
                    </label>
                    <input
                      type="text"
                      value={(editingServer as any)?.claudeModel || ''}
                      onChange={e => {
                        setEditingServer(prev => prev ? { ...prev, claudeModel: e.target.value } : null)
                      }}
                      placeholder="claude-sonnet-4-20250514"
                      className="w-full px-3 py-2 border border-border rounded-lg bg-input text-foreground focus:ring-2 focus:ring-primary focus:border-transparent transition-colors font-mono text-sm"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Status indicator during saving */}
            {saving && saveStatus && (
              <div className="px-6 py-3 bg-blue-50 dark:bg-blue-950/30 border-t border-border">
                <div className="flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>{saveStatus}</span>
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="p-6 border-t border-border flex justify-end gap-3">
              <button
                onClick={closeModal}
                className="px-4 py-2 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg transition-colors"
              >
                {t('Cancel')}
              </button>
              <button
                onClick={editingServer ? handleEditServer : handleAddServer}
                disabled={!isFormValid || saving}
                className="flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground text-primary-foreground rounded-lg transition-colors"
              >
                {saving ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {saveStatus || t('Saving...')}
                  </>
                ) : (
                  <>
                    <CheckCircle className="w-4 h-4" />
                    {editingServer ? t('Save') : t('Add')}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Server Details Modal */}
      {showDetailsModal && selectedServerDetails && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card border border-border rounded-xl w-full max-w-lg animate-fade-in">
            <div className="p-6 border-b border-border flex items-center justify-between">
              <h2 className="text-lg font-medium">{t('Server Details')}</h2>
              <button
                onClick={() => setShowDetailsModal(false)}
                className="p-1.5 hover:bg-secondary rounded-lg transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              {/* Status */}
              <div className="flex items-center gap-3 p-4 rounded-lg bg-muted/30">
                <div className={`w-12 h-12 rounded-lg flex items-center justify-center ${
                  selectedServerDetails.status === 'connected'
                    ? 'bg-green-500/10'
                    : selectedServerDetails.status === 'connecting' || selectedServerDetails.status === 'deploying'
                    ? 'bg-blue-500/10'
                    : selectedServerDetails.status === 'error'
                    ? 'bg-red-500/10'
                    : 'bg-muted'
                }`}>
                  {selectedServerDetails.status === 'connecting' || selectedServerDetails.status === 'deploying' ? (
                    <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
                  ) : selectedServerDetails.status === 'connected' ? (
                    <CheckCircle className="w-6 h-6 text-green-500" />
                  ) : selectedServerDetails.status === 'error' ? (
                    <AlertCircle className="w-6 h-6 text-red-500" />
                  ) : (
                    <Server className="w-6 h-6 text-muted-foreground" />
                  )}
                </div>
                <div>
                  <p className="text-sm font-medium">
                    {selectedServerDetails.status === 'connected' && t('Connected')}
                    {selectedServerDetails.status === 'connecting' && t('Connecting...')}
                    {selectedServerDetails.status === 'deploying' && t('Deploying...')}
                    {selectedServerDetails.status === 'error' && t('Connection Error')}
                    {!selectedServerDetails.status && t('Unknown')}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {selectedServerDetails.lastConnected
                      ? t('Last connected: {{date}}', { date: new Date(selectedServerDetails.lastConnected).toLocaleString() })
                      : t('Never connected')
                    }
                  </p>
                </div>
              </div>

              {/* Server Information */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-muted-foreground">{t('Server Information')}</h3>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <span className="text-muted-foreground">{t('Name')}</span>
                    <p className="font-medium">{selectedServerDetails.name}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">{t('Host')}</span>
                    <p className="font-mono">{selectedServerDetails.host}:{selectedServerDetails.port}</p>
                  </div>
                  {selectedServerDetails.username && (
                    <div>
                      <span className="text-muted-foreground">{t('Username')}</span>
                      <p className="font-medium">{selectedServerDetails.username}</p>
                    </div>
                  )}
                  <div>
                    <span className="text-muted-foreground">{t('Auth Type')}</span>
                    <p className="font-medium">{selectedServerDetails.authType === 'password' ? t('Password') : t('SSH Key')}</p>
                  </div>
                  {selectedServerDetails.workDir && (
                    <div className="col-span-2">
                      <span className="text-muted-foreground">{t('Work Directory')}</span>
                      <p className="font-mono">{selectedServerDetails.workDir}</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Agent Status */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-muted-foreground">{t('Agent Status')}</h3>
                <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/30">
                  {selectedServerDetails.deployed ? (
                    selectedServerDetails.agentStatus === 'running' ? (
                      <>
                        <CheckCircle className="w-5 h-5 text-green-500" />
                        <span className="text-sm font-medium text-green-500">{t('Agent is running')}</span>
                      </>
                    ) : selectedServerDetails.agentStatus === 'error' ? (
                      <>
                        <AlertCircle className="w-5 h-5 text-red-500" />
                        <span className="text-sm font-medium text-red-500">{t('Agent error')}</span>
                      </>
                    ) : (
                      <>
                        <Server className="w-5 h-5 text-muted-foreground" />
                        <span className="text-sm font-medium">{t('Agent is stopped')}</span>
                      </>
                    )
                  ) : (
                    <>
                      <Server className="w-5 h-5 text-muted-foreground" />
                      <span className="text-sm font-medium">{t('Agent not deployed')}</span>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="p-6 border-t border-border flex justify-between">
              <button
                onClick={() => {
                  setShowDetailsModal(false)
                  openEditModal(selectedServerDetails)
                }}
                className="px-4 py-2 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg transition-colors"
              >
                {t('Edit Server')}
              </button>
              <div className="flex gap-2">
                {!selectedServerDetails.deployed && (
                  <button
                    onClick={() => {
                      setShowDetailsModal(false)
                      handleDeploy(selectedServerDetails)
                    }}
                    className="flex items-center gap-1.5 px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors"
                  >
                    <Rocket className="w-4 h-4" />
                    {t('Deploy')}
                  </button>
                )}
                {selectedServerDetails.deployed && selectedServerDetails.status === 'connected' && (
                  <button
                    onClick={() => {
                      setShowDetailsModal(false)
                      openRemoteSpaceChat(selectedServerDetails)
                    }}
                    className="flex items-center gap-1.5 px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors"
                  >
                    <MessageSquare className="w-4 h-4" />
                    {t('Open Chat')}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
