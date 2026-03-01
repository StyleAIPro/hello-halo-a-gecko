/**
 * Remote Agent Chat Page - Wrapper page for remote agent chat interface
 */

import React, { useState, useEffect } from 'react'
import { ArrowLeft, Server, LayoutGrid, Paperclip, X } from 'lucide-react'
import { Header } from '../components/layout/Header'
import { RemoteFileBrowser, type RemoteFile } from '../components/remote-file-browser'
import { RemoteAgentChat, type RemoteFileAttachment } from '../components/remote-agent-chat'
import { useAppStore } from '../stores/app.store'
import { useTranslation } from '../i18n'

interface RemoteAgentChatPageProps {
  serverId?: string
}

export function RemoteAgentChatPage({ serverId: propsServerId }: RemoteAgentChatPageProps = {}) {
  const { t } = useTranslation()
  const { goBack, remoteServerId } = useAppStore()
  const serverId = propsServerId || remoteServerId
  const [selectedFile, setSelectedFile] = useState<RemoteFile | null>(null)
  const [attachedFiles, setAttachedFiles] = useState<RemoteFileAttachment[]>([])
  const [sessionId, setSessionId] = useState<string | undefined>()
  const [showFileBrowser, setShowFileBrowser] = useState(true)
  const [serverName, setServerName] = useState<string>('')

  const handleFileSelect = (file: RemoteFile) => {
    setSelectedFile(file)
  }

  const handleAttachSelectedFile = () => {
    if (selectedFile) {
      const attachment: RemoteFileAttachment = {
        path: selectedFile.path,
        name: selectedFile.name,
        type: selectedFile.type
      }
      setAttachedFiles(prev => {
        // Check if file is already attached
        if (prev.some(f => f.path === attachment.path)) {
          return prev
        }
        return [...prev, attachment]
      })
    }
  }

  const handleRemoveAttachedFile = (path: string) => {
    setAttachedFiles(prev => prev.filter(f => f.path !== path))
    if (selectedFile?.path === path) {
      setSelectedFile(null)
    }
  }

  // Load server info on mount
  useEffect(() => {
    if (serverId) {
      loadServerInfo(serverId)
    }
  }, [serverId])

  const loadServerInfo = async (id: string) => {
    try {
      const result = await api.getRemoteServer(id)
      if (result.success && result.data) {
        const server = result.data as { name: string }
        setServerName(server.name)
      }
    } catch (err) {
      console.error('[RemoteAgentChatPage] Failed to load server info:', err)
    }
  }

  const handleBack = () => {
    goBack()
  }

  return (
    <div className="h-full w-full flex flex-col">
      {/* Header */}
      <Header
        left={
          <>
            <button
              onClick={handleBack}
              className="p-1.5 hover:bg-secondary rounded-lg transition-colors"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <span className="font-medium text-sm flex items-center gap-2">
              <Server className="w-4 h-4" />
              {serverName || t('Remote Agent')}
            </span>
          </>
        }
        right={
          <button
            onClick={() => setShowFileBrowser(!showFileBrowser)}
            className={`p-1.5 rounded-lg transition-colors ${
              showFileBrowser ? 'bg-secondary' : 'hover:bg-secondary'
            }`}
            title={t('Toggle file browser')}
          >
            <LayoutGrid className="w-5 h-5" />
          </button>
        }
      />

      {/* Content */}
      <main className="flex-1 overflow-auto p-4">
        <div className={`flex gap-4 h-full transition-all ${
          showFileBrowser ? 'flex-row' : 'flex-row'
        }`}>
          {/* File Browser Panel */}
          <div className={`transition-all duration-300 ${
            showFileBrowser ? 'w-80 flex-shrink-0' : 'w-0 overflow-hidden'
          }`}>
            {showFileBrowser && serverId && (
              <div className="h-full flex flex-col">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-medium text-muted-foreground">
                    {t('File Browser')}
                  </h3>
                  {selectedFile && (
                    <button
                      onClick={handleAttachSelectedFile}
                      className="flex items-center gap-1.5 px-2 py-1 text-xs bg-primary hover:bg-primary/90 text-primary-foreground rounded transition-colors"
                    >
                      <Paperclip className="w-3 h-3" />
                      {t('Attach')}
                    </button>
                  )}
                </div>
                <RemoteFileBrowser
                  serverId={serverId}
                  onFileSelect={handleFileSelect}
                  readonly={false}
                />
              </div>
            )}
          </div>

          {/* Chat Panel */}
          <div className={`flex-1 transition-all duration-300 ${
            showFileBrowser ? 'flex' : 'flex'
          }`}>
            <div className="h-full flex flex-col">
              {/* Attached files */}
              {attachedFiles.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-2 p-2 bg-secondary rounded-lg">
                  {attachedFiles.map((file) => (
                    <div
                      key={file.path}
                      className="flex items-center gap-2 px-2 py-1 bg-background rounded text-sm"
                    >
                      <Paperclip className="w-3 h-3 text-muted-foreground" />
                      <span className="truncate max-w-[120px]">{file.name}</span>
                      <button
                        onClick={() => handleRemoveAttachedFile(file.path)}
                        className="p-0.5 hover:bg-muted-foreground/20 rounded transition-colors"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <h3 className="text-sm font-medium text-muted-foreground mb-2">
                {t('Agent Chat')}
              </h3>
              {serverId && (
                <div className="flex-1 min-h-0">
                  <RemoteAgentChat
                    serverId={serverId}
                    sessionId={sessionId}
                    onSessionChange={setSessionId}
                    onFileAttachment={(file) => {
                      setAttachedFiles(prev => {
                        if (prev.some(f => f.path === file.path)) {
                          return prev
                        }
                        return [...prev, file]
                      })
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
