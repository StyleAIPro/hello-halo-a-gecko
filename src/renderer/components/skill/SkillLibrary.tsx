/**
 * SkillLibrary - 已安装技能库
 *
 * 显示已安装的技能列表，支持启用/禁用、卸载、导出等操作
 * 支持查看本地技能和远程服务器上的技能
 * 同时支持抽屉式文件浏览器
 */

import { useMemo, useState, useEffect, useRef, useCallback } from 'react'
import { useSkillStore } from '../../stores/skill/skill.store'
import { useTranslation } from '../../i18n'
import {
  Book,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Download,
  FileCode,
  FolderOpen,
  Folder,
  ChevronRight,
  ChevronDown,
  FileText,
  X,
  Loader2,
  CloudUpload,
  RefreshCw,
  Server,
  HardDrive,
  GripVertical
} from 'lucide-react'
import type { InstalledSkill, SkillFileNode } from '../../../shared/skill/skill-types'
import { api } from '../../api'
import { useConfirm } from '../ui/ConfirmDialog'

// 文件节点接口
interface FileNode {
  name: string
  type: 'file' | 'directory'
  path: string
  size?: number
  extension?: string
  children?: FileNode[]
}

// 技能来源类型
type SkillSource =
  | { type: 'local' }
  | { type: 'remote'; serverId: string; serverName: string }

export function SkillLibrary() {
  const { t } = useTranslation()
  const { confirm: confirmDialog, ConfirmDialogElement } = useConfirm()
  const {
    installedSkills,
    selectedSkillId,
    setSelectedSkillId,
    toggleSkill,
    uninstallSkill,
    exportSkill,
    refreshSkills,
    syncSkillsToRemote,
    remoteSkills,
    remoteSkillsLoading,
    remoteSkillsError,
    loadRemoteSkills,
  } = useSkillStore()

  // 技能来源选择
  const [selectedSource, setSelectedSource] = useState<SkillSource>({ type: 'local' })
  const [showSourceDropdown, setShowSourceDropdown] = useState(false)

  // 组件挂载时不再自动刷新，由 SkillPage 统一管理
  // 用户可通过刷新按钮手动刷新

  // 抽屉状态
  const [showFilesDrawer, setShowFilesDrawer] = useState(false)
  const [fileTree, setFileTree] = useState<FileNode[] | null>(null)
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [loadingFiles, setLoadingFiles] = useState(false)

  // 抽屉宽度状态（支持拖动调整）
  const [drawerWidth, setDrawerWidth] = useState(384) // 默认 384px (w-96)
  const [isResizing, setIsResizing] = useState(false)
  const resizeRef = useRef<HTMLDivElement>(null)

  // 拖动调整宽度
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
  }, [])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return
      const newWidth = window.innerWidth - e.clientX
      // 限制最小和最大宽度
      const minWidth = 280
      const maxWidth = 600
      if (newWidth >= minWidth && newWidth <= maxWidth) {
        setDrawerWidth(newWidth)
      }
    }

    const handleMouseUp = () => {
      setIsResizing(false)
    }

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing])

  // 同步状态
  const [showSyncModal, setShowSyncModal] = useState(false)
  const [remoteServers, setRemoteServers] = useState<{ id: string; name: string; status: string }[]>([])
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState<string | null>(null)

  // 按名称排序的本地技能列表
  const sortedSkills = useMemo(() => {
    return [...installedSkills].sort((a, b) =>
      a.spec.name.localeCompare(b.spec.name)
    )
  }, [installedSkills])

  // 当前来源对应的技能列表
  const activeSkills = useMemo(() => {
    if (selectedSource.type === 'local') {
      return sortedSkills
    }
    return (remoteSkills[selectedSource.serverId] || []).sort((a, b) =>
      a.spec.name.localeCompare(b.spec.name)
    )
  }, [selectedSource, sortedSkills, remoteSkills])

  const activeLoading = selectedSource.type === 'remote'
    ? remoteSkillsLoading[selectedSource.serverId] || false
    : false

  const activeError = selectedSource.type === 'remote'
    ? remoteSkillsError[selectedSource.serverId] || null
    : null

  // 加载远程服务器列表（组件挂载时 + 打开同步模态框时）
  const loadRemoteServers = async () => {
    try {
      const result = await api.remoteServerList()
      if (result.success && result.data) {
        setRemoteServers(result.data.map(s => ({
          id: s.id,
          name: s.name,
          status: s.status || 'disconnected'
        })))
      }
    } catch (error) {
      console.error('Failed to load remote servers:', error)
    }
  }

  useEffect(() => {
    loadRemoteServers()
  }, [])

  // 选择远程服务器时加载远程技能
  useEffect(() => {
    if (selectedSource.type === 'remote') {
      const { serverId } = selectedSource
      if (!remoteSkills[serverId] && !remoteSkillsLoading[serverId]) {
        loadRemoteSkills(serverId)
      }
    }
  }, [selectedSource])

  // 点击外部关闭下拉菜单
  useEffect(() => {
    if (!showSourceDropdown) return
    const handleClickOutside = () => setShowSourceDropdown(false)
    document.addEventListener('click', handleClickOutside)
    return () => document.removeEventListener('click', handleClickOutside)
  }, [showSourceDropdown])

  // 加载文件树
  const loadFileTree = async (skillId: string) => {
    setLoadingFiles(true)
    try {
      let result
      if (selectedSource.type === 'remote') {
        result = await api.remoteServerListSkillFiles(selectedSource.serverId, skillId)
      } else {
        result = await api.skillFiles(skillId)
      }
      if (result.success && result.data) {
        setFileTree(result.data)
      } else {
        setFileTree([])
      }
    } catch (error) {
      console.error('Failed to load file tree:', error)
      setFileTree([])
    } finally {
      setLoadingFiles(false)
    }
  }

  // 加载文件内容
  const loadFileContent = async (skillId: string, filePath: string) => {
    try {
      let result
      if (selectedSource.type === 'remote') {
        result = await api.remoteServerReadSkillFile(selectedSource.serverId, skillId, filePath)
      } else {
        result = await api.skillFileContent(skillId, filePath)
      }
      if (result.success && result.data !== undefined) {
        setFileContent(result.data)
        setSelectedFilePath(filePath)
      }
    } catch (error) {
      console.error('Failed to load file content:', error)
    }
  }

  // 打开文件抽屉
  const handleOpenFiles = async (skillId: string) => {
    setShowFilesDrawer(true)
    await loadFileTree(skillId)
  }

  // 关闭文件抽屉
  const handleCloseFiles = () => {
    setShowFilesDrawer(false)
    setFileTree(null)
    setSelectedFilePath(null)
    setFileContent(null)
  }

  // 处理导出技能
  const handleExport = async (skillId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const yamlContent = await exportSkill(skillId)
    if (yamlContent) {
      // 创建下载
      const blob = new Blob([yamlContent], { type: 'application/x-yaml' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${skillId}-skill.yaml`
      a.click()
      URL.revokeObjectURL(url)
    }
  }

  // 处理卸载确认
  const handleUninstall = async (skillId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (await confirmDialog(t('Are you sure you want to uninstall this skill?'))) {
      await uninstallSkill(skillId)
    }
  }

  // 打开同步模态框
  const handleOpenSyncModal = async () => {
    await loadRemoteServers()
    setShowSyncModal(true)
    setSelectedServerId(null)
    setSyncMessage(null)
  }

  // 执行同步
  const handleSync = async () => {
    if (!selectedServerId) return

    setSyncing(true)
    setSyncMessage(null)
    try {
      const result = await syncSkillsToRemote(selectedServerId)
      if (result.success) {
        setSyncMessage(result.message || t('Skills synced successfully'))
      } else {
        setSyncMessage(result.message || t('Failed to sync skills'))
      }
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : t('Failed to sync skills'))
    } finally {
      setSyncing(false)
    }
  }

  // 刷新当前来源的技能列表
  const handleRefresh = () => {
    if (selectedSource.type === 'local') {
      refreshSkills()
    } else {
      loadRemoteSkills(selectedSource.serverId)
    }
  }

  const isLocal = selectedSource.type === 'local'

  // 空状态：本地无技能
  if (isLocal && sortedSkills.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-8">
        <Book className="w-16 h-16 text-muted-foreground/50 mb-4" />
        <h3 className="text-lg font-semibold text-foreground mb-2">{t('No skills installed')}</h3>
        <p className="text-sm text-muted-foreground mb-4">
          {t('Install skills from the market or create your own to get started.')}
        </p>
      </div>
    )
  }

  return (
    <>
      {ConfirmDialogElement}
    <div className="flex h-full">
      {/* 左侧：技能列表 */}
      <div className="w-80 border-r border-border overflow-y-auto flex flex-col">
        <div className="p-4 border-b border-border shrink-0">
          <div className="flex items-center justify-between">
            {/* 来源选择下拉 */}
            <div className="relative">
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setShowSourceDropdown(!showSourceDropdown)
                }}
                className="flex items-center gap-1.5 text-sm font-semibold text-foreground hover:text-primary/80 transition-colors"
              >
                {isLocal ? (
                  <HardDrive className="w-3.5 h-3.5" />
                ) : (
                  <Server className="w-3.5 h-3.5" />
                )}
                <span className="max-w-[120px] truncate">
                  {isLocal
                    ? t('Local')
                    : selectedSource.serverName}
                </span>
                <span className="text-muted-foreground">({activeSkills.length})</span>
                <ChevronDown className={`w-3 h-3 text-muted-foreground transition-transform ${showSourceDropdown ? 'rotate-180' : ''}`} />
              </button>

              {showSourceDropdown && (
                <div
                  className="absolute top-full left-0 mt-1 w-60 bg-popover border border-border rounded-lg shadow-lg z-50 py-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  {/* 本地选项 */}
                  <div
                    onClick={() => {
                      setSelectedSource({ type: 'local' })
                      setSelectedSkillId(null)
                      setShowSourceDropdown(false)
                    }}
                    className={`flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors ${isLocal ? 'bg-accent' : 'hover:bg-accent/50'}`}
                  >
                    <HardDrive className="w-4 h-4 text-muted-foreground" />
                    <div className="flex-1">
                      <span className="text-sm">{t('Local')}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">{sortedSkills.length}</span>
                  </div>

                  {remoteServers.length > 0 && <div className="border-t border-border my-1" />}

                  {/* 远程服务器选项 */}
                  {remoteServers.map((server) => {
                    const isSelected = selectedSource.type === 'remote' && selectedSource.serverId === server.id
                    const skillCount = remoteSkills[server.id]?.length
                    return (
                      <div
                        key={server.id}
                        onClick={() => {
                          setSelectedSource({ type: 'remote', serverId: server.id, serverName: server.name })
                          setSelectedSkillId(null)
                          setShowSourceDropdown(false)
                        }}
                        className={`flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors ${isSelected ? 'bg-accent' : 'hover:bg-accent/50'}`}
                      >
                        <Server className="w-4 h-4 text-muted-foreground shrink-0" />
                        <div className="flex-1 min-w-0">
                          <span className="text-sm truncate block">{server.name}</span>
                          <span className="text-xs text-muted-foreground">
                            {server.status === 'connected' ? t('Connected') : t('Disconnected')}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {server.status === 'connected' && (
                            <span className="w-2 h-2 rounded-full bg-green-500" />
                          )}
                          {skillCount !== undefined && (
                            <span className="text-xs text-muted-foreground">{skillCount}</span>
                          )}
                        </div>
                      </div>
                    )
                  })}

                  {remoteServers.length === 0 && (
                    <div className="px-3 py-2 text-xs text-muted-foreground">
                      {t('No remote servers')}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              {isLocal && (
                <button
                  onClick={handleOpenSyncModal}
                  className="flex items-center gap-1 text-xs text-primary hover:text-primary/80"
                >
                  <CloudUpload className="w-3 h-3" />
                  {t('Sync')}
                </button>
              )}
              <button
                onClick={handleRefresh}
                className="flex items-center gap-1 text-xs text-primary hover:text-primary/80"
              >
                <RefreshCw className="w-3 h-3" />
                {t('Refresh')}
              </button>
            </div>
          </div>
        </div>

        {/* 技能列表内容 */}
        <div className="flex-1 divide-y divide-border">
          {/* 加载状态 */}
          {activeLoading && (
            <div className="flex flex-col items-center justify-center py-12">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              <span className="mt-2 text-xs text-muted-foreground">{t('Loading remote skills...')}</span>
            </div>
          )}

          {/* 错误状态 */}
          {activeError && !activeLoading && (
            <div className="p-3 mx-2 mt-2 text-xs text-red-400 bg-red-500/10 rounded">
              {activeError}
              <button
                onClick={handleRefresh}
                className="ml-2 underline hover:text-red-300"
              >
                {t('Retry')}
              </button>
            </div>
          )}

          {/* 空状态（远程） */}
          {!activeLoading && !activeError && activeSkills.length === 0 && !isLocal && (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Server className="w-10 h-10 mb-3 opacity-50" />
              <p className="text-sm">{t('No skills on this server')}</p>
              <p className="text-xs mt-1">{t('Use Sync to upload local skills.')}</p>
            </div>
          )}

          {/* 技能卡片列表 */}
          {activeSkills.map((skill) => (
            <div
              key={skill.appId}
              onClick={() => setSelectedSkillId(skill.appId)}
              className={`
                p-4 cursor-pointer transition-colors
                ${selectedSkillId === skill.appId
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-accent/50'
                }
              `}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-medium truncate">{skill.spec.name}</h3>
                  <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                    {skill.spec.description}
                  </p>
                </div>
                {isLocal && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleSkill(skill.appId, !skill.enabled)
                    }}
                    className="ml-2"
                  >
                    {skill.enabled ? (
                      <ToggleRight className="w-5 h-5 text-green-500" />
                    ) : (
                      <ToggleLeft className="w-5 h-5 text-muted-foreground" />
                    )}
                  </button>
                )}
              </div>

              {/* 技能元数据 */}
              <div className="flex items-center gap-2 mt-2">
                <span className="text-xs text-muted-foreground">
                  v{skill.spec.version}
                </span>
                {skill.spec.trigger_command && (
                  <code className="text-xs bg-secondary px-1.5 py-0.5 rounded">
                    {skill.spec.trigger_command}
                  </code>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 右侧：技能详情 + 文件浏览器 */}
      <div className="flex-1 flex">
        {/* 主内容区域 */}
        <div className={`flex-1 overflow-y-auto p-6 ${showFilesDrawer ? 'pr-0' : ''}`}>
          {selectedSkillId ? (
            <SkillDetail
              skill={activeSkills.find(s => s.appId === selectedSkillId)!}
              isRemote={!isLocal}
              remoteServerName={selectedSource.type === 'remote' ? selectedSource.serverName : undefined}
              onToggle={isLocal ? () => toggleSkill(selectedSkillId, !sortedSkills.find(s => s.appId === selectedSkillId)!.enabled) : undefined}
              onExport={isLocal ? (e) => handleExport(selectedSkillId, e) : undefined}
              onUninstall={isLocal ? (e) => handleUninstall(selectedSkillId, e) : undefined}
              onOpenFiles={() => handleOpenFiles(selectedSkillId)}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground">
              <FileCode className="w-12 h-12 mb-4 opacity-50" />
              <p>{t('Select a skill to view details')}</p>
            </div>
          )}
        </div>

        {/* 文件抽屉 */}
        {showFilesDrawer && selectedSkillId && (
          <div
            className="border-l border-border flex flex-col relative"
            style={{ width: `${drawerWidth}px` }}
          >
            {/* 拖动调整宽度的手柄 */}
            <div
              ref={resizeRef}
              onMouseDown={handleMouseDown}
              className={`
                absolute left-0 top-0 bottom-0 w-1 cursor-ew-resize z-10
                hover:bg-primary/50 transition-colors
                ${isResizing ? 'bg-primary' : 'bg-transparent'}
              `}
            >
              <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 opacity-0 hover:opacity-100 transition-opacity">
                <GripVertical className="w-3 h-3 text-muted-foreground" />
              </div>
            </div>

            {/* 抽屉头部 */}
            <div className="flex items-center justify-between p-3 border-b border-border">
              <h3 className="text-sm font-medium text-foreground">
                {t('Skill Files')}
              </h3>
              <button
                onClick={handleCloseFiles}
                className="p-1 hover:bg-secondary rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 内容区域：文件树 + 文件预览 */}
            <div className="flex-1 flex flex-col min-h-0">
              {/* 文件树 - 紧凑显示，只占需要的空间 */}
              <div className="shrink-0 max-h-[40%] overflow-y-auto p-2">
                {loadingFiles ? (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                  </div>
                ) : fileTree && fileTree.length > 0 ? (
                  <div className="space-y-1">
                    {fileTree.map((node) => (
                      <FileTreeNode
                        key={node.path}
                        node={node}
                        level={0}
                        selectedPath={selectedFilePath}
                        onSelect={(path, type) => {
                          if (type === 'file') {
                            loadFileContent(selectedSkillId, path)
                          }
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="flex items-center justify-center py-4 text-muted-foreground">
                    <Folder className="w-5 h-5 mr-2 opacity-50" />
                    <span className="text-xs">{t('No files found')}</span>
                  </div>
                )}
              </div>

              {/* 文件预览 - 占满剩余空间到底部 */}
              {selectedFilePath && fileContent !== null && (
                <div className="border-t border-border flex flex-col min-h-0 flex-1">
                  <div className="flex items-center justify-between p-2 border-b border-border bg-secondary/50 shrink-0">
                    <span className="text-xs font-mono truncate">{selectedFilePath.split('/').pop()}</span>
                    <button
                      onClick={() => {
                        setSelectedFilePath(null)
                        setFileContent(null)
                      }}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      {t('Close')}
                    </button>
                  </div>
                  <div className="flex-1 min-h-0 overflow-y-auto p-2">
                    <pre className="text-xs font-mono whitespace-pre-wrap break-words">
                      {typeof fileContent === 'string' ? fileContent.slice(0, 5000) : 'No content'}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Sync Modal */}
      {showSyncModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background border border-border rounded-lg shadow-lg w-96 max-h-[80vh] overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b border-border">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <CloudUpload className="w-4 h-4" />
                {t('Sync Skills to Remote Server')}
              </h3>
              <button
                onClick={() => {
                  setShowSyncModal(false)
                  setSyncMessage(null)
                  setSelectedServerId(null)
                }}
                className="p-1 hover:bg-secondary rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              <p className="text-xs text-muted-foreground">
                {t('Select a remote server to sync your local skills to. This will upload all skills from ~/.agents/skills/ to the remote server.')}
              </p>

              {remoteServers.length === 0 ? (
                <div className="text-center py-4">
                  <Server className="w-8 h-8 mx-auto text-muted-foreground/50 mb-2" />
                  <p className="text-xs text-muted-foreground">{t('No remote servers configured')}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {t('Add a remote server in Settings first.')}
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <label className="text-xs font-medium text-foreground">{t('Remote Server')}</label>
                  <div className="space-y-1">
                    {remoteServers.map((server) => (
                      <div
                        key={server.id}
                        onClick={() => setSelectedServerId(server.id)}
                        className={`
                          flex items-center gap-2 p-2 rounded cursor-pointer border transition-colors
                          ${selectedServerId === server.id
                            ? 'border-primary bg-primary/10'
                            : 'border-border hover:bg-secondary'
                          }
                        `}
                      >
                        <Server className="w-4 h-4 text-muted-foreground" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{server.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {server.status === 'connected' ? t('Connected') : t('Disconnected')}
                          </p>
                        </div>
                        {server.status === 'connected' && (
                          <span className="w-2 h-2 rounded-full bg-green-500" />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {syncMessage && (
                <div className={`p-2 rounded text-xs ${syncMessage.includes('成功') || syncMessage.includes('successfully') ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
                  {syncMessage}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => {
                    setShowSyncModal(false)
                    setSyncMessage(null)
                    setSelectedServerId(null)
                  }}
                  className="px-3 py-1.5 text-xs rounded border border-border hover:bg-secondary transition-colors"
                >
                  {t('Close')}
                </button>
                <button
                  onClick={handleSync}
                  disabled={!selectedServerId || syncing || remoteServers.length === 0}
                  className={`
                    flex items-center gap-1 px-3 py-1.5 text-xs rounded transition-colors
                    ${(!selectedServerId || syncing || remoteServers.length === 0)
                      ? 'bg-muted text-muted-foreground cursor-not-allowed'
                      : 'bg-primary text-primary-foreground hover:bg-primary/90'
                    }
                  `}
                >
                  {syncing ? (
                    <>
                      <Loader2 className="w-3 h-3 animate-spin" />
                      {t('Syncing...')}
                    </>
                  ) : (
                    <>
                      <CloudUpload className="w-3 h-3" />
                      {t('Sync Skills')}
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
    </>
  )
}

// 技能详情组件
function SkillDetail({
  skill,
  isRemote,
  remoteServerName,
  onToggle,
  onExport,
  onUninstall,
  onOpenFiles
}: {
  skill: InstalledSkill
  isRemote?: boolean
  remoteServerName?: string
  onToggle?: () => void
  onExport?: (e: React.MouseEvent) => void
  onUninstall?: (e: React.MouseEvent) => void
  onOpenFiles?: () => void
}) {
  const { t } = useTranslation()

  return (
    <div className="max-w-2xl space-y-6">
      {/* 头部 */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <h2 className="text-xl font-semibold text-foreground">{skill.spec.name}</h2>
          {isRemote && remoteServerName && (
            <span className="text-xs px-2 py-0.5 bg-blue-500/20 text-blue-400 rounded flex items-center gap-1">
              <Server className="w-3 h-3" />
              {remoteServerName}
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground">{skill.spec.description}</p>
      </div>

      {/* 状态和版本 */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t('Status')}:</span>
          <span className={`text-xs px-2 py-0.5 rounded ${skill.enabled ? 'bg-green-500/20 text-green-400' : 'bg-gray-500/20 text-gray-400'}`}>
            {skill.enabled ? t('Enabled') : t('Disabled')}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t('Version')}:</span>
          <span className="text-xs text-foreground">{skill.spec.version}</span>
        </div>
        {skill.spec.author && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t('Author')}:</span>
            <span className="text-xs text-foreground">{skill.spec.author}</span>
          </div>
        )}
      </div>

      {/* 触发命令 */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-foreground">{t('Trigger Command')}</h3>
        <div className="bg-secondary rounded-lg p-3 font-mono text-sm">
          {skill.spec.trigger_command || `/${skill.appId}`}
        </div>
        <p className="text-xs text-muted-foreground">
          {t('Type this command in any conversation to use this skill.')}
        </p>
      </div>

      {/* 系统提示 */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-foreground">{t('System Prompt')}</h3>
        <div className="bg-secondary rounded-lg p-4 text-sm font-mono whitespace-pre-wrap max-h-64 overflow-y-auto">
          {skill.spec.system_prompt}
        </div>
      </div>

      {/* 标签 */}
      {skill.spec.tags && skill.spec.tags.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-foreground">{t('Tags')}</h3>
          <div className="flex flex-wrap gap-2">
            {skill.spec.tags.map((tag: string) => (
              <span
                key={tag}
                className="text-xs px-2 py-0.5 bg-accent text-accent-foreground rounded"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 文件浏览器按钮（本地技能） */}
      {!isRemote && onOpenFiles && (
        <div className="space-y-2">
          <button
            onClick={onOpenFiles}
            className="flex items-center gap-2 w-full px-4 py-2 bg-secondary/50 hover:bg-secondary text-secondary-foreground hover:text-foreground rounded-lg text-sm font-medium transition-colors"
          >
            <FolderOpen className="w-4 h-4" />
            {t('View Skill Files')}
            <ChevronRight className="w-4 h-4 ml-auto" />
          </button>
        </div>
      )}

      {/* 安装时间 */}
      {skill.installedAt && (
        <div className="text-xs text-muted-foreground">
          {t('Installed at')}: {new Date(skill.installedAt).toLocaleString()}
        </div>
      )}

      {/* 操作按钮（仅本地） */}
      {!isRemote && onToggle && onExport && onUninstall && (
        <div className="flex gap-2 pt-4 border-t border-border">
          <button
            onClick={onToggle}
            className={`
              flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors
              ${skill.enabled
                ? 'bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20'
                : 'bg-green-500/10 text-green-400 hover:bg-green-500/20'
              }
            `}
          >
            {skill.enabled ? <ToggleLeft className="w-4 h-4" /> : <ToggleRight className="w-4 h-4" />}
            {skill.enabled ? t('Disable') : t('Enable')}
          </button>

          <button
            onClick={onExport}
            className="flex items-center gap-2 px-4 py-2 bg-secondary text-secondary-foreground hover:bg-secondary/80 rounded-lg text-sm font-medium transition-colors"
          >
            <Download className="w-4 h-4" />
            {t('Export')}
          </button>

          <button
            onClick={onUninstall}
            className="flex items-center gap-2 px-4 py-2 bg-red-500/10 text-red-400 hover:bg-red-500/20 rounded-lg text-sm font-medium transition-colors"
          >
            <Trash2 className="w-4 h-4" />
            {t('Uninstall')}
          </button>
        </div>
      )}

      {/* 远程只读提示 */}
      {isRemote && (
        <div className="pt-4 border-t border-border">
          <p className="text-xs text-muted-foreground">
            {t('Remote skills are read-only. Use Sync to manage skills on this server.')}
          </p>
          <button
            onClick={onOpenFiles}
            className="flex items-center gap-2 w-full px-4 py-2 mt-2 bg-secondary/50 hover:bg-secondary text-secondary-foreground hover:text-foreground rounded-lg text-sm font-medium transition-colors"
          >
            <FolderOpen className="w-4 h-4" />
            {t('View Skill Files')}
            <ChevronRight className="w-4 h-4 ml-auto" />
          </button>
        </div>
      )}
    </div>
  )
}

// 文件树节点组件
function FileTreeNode({
  node,
  level,
  selectedPath,
  onSelect
}: {
  node: FileNode
  level: number
  selectedPath: string | null
  onSelect: (path: string, type: 'file' | 'directory') => void
}) {
  const [isExpanded, setIsExpanded] = useState(false)
  const isSelected = selectedPath === node.path

  const handleToggle = () => {
    if (node.type === 'directory') {
      setIsExpanded(!isExpanded)
    } else {
      onSelect(node.path, node.type)
    }
  }

  return (
    <div>
      <div
        onClick={handleToggle}
        className={`
          flex items-center gap-2 px-2 py-1 cursor-pointer rounded text-sm
          ${isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-secondary/50'}
        `}
        style={{ paddingLeft: `${level * 16 + 8}px` }}
      >
        {node.type === 'directory' ? (
          <span className="transition-transform duration-200" style={{ display: 'inline-block', transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
            <ChevronRight className="w-3 h-3 text-muted-foreground" />
          </span>
        ) : (
          <FileText className="w-3 h-3 text-muted-foreground" />
        )}
        <span className="truncate">{node.name}</span>
        {node.type === 'file' && node.size && (
          <span className="text-xs text-muted-foreground ml-auto">
            {formatSize(node.size)}
          </span>
        )}
      </div>

      {/* 子节点 */}
      {node.type === 'directory' && isExpanded && node.children && (
        <div className="mt-0.5">
          {node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              level={level + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// 格式化文件大小
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
