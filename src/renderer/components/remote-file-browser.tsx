/**
 * Remote File Browser - Browse files on remote SSH server
 */

import React, { useState, useEffect } from 'react'
import { FileIcon, FolderIcon, FolderOpen, ChevronRight, Home, RefreshCw, Loader2, FileText, Image, Music, Video, Archive, Code } from 'lucide-react'
import { api } from '../api'
import { useTranslation } from '../i18n'

export interface RemoteFile {
  name: string
  path: string
  type: 'file' | 'directory' | 'symlink'
  size?: number
  modified?: string
  isSymlink?: boolean
  symlinkTarget?: string
}

export interface RemoteFileBrowserProps {
  serverId: string
  onFileSelect?: (file: RemoteFile) => void
  readonly?: boolean
}

// Get file icon based on extension
function getFileIcon(filename: string, size = 16) {
  const ext = filename.split('.').pop()?.toLowerCase()
  const iconSize = `${size}px`

  if (!ext) return <FileIcon size={parseInt(iconSize)} />

  switch (ext) {
    case 'txt':
    case 'md':
    case 'rst':
      return <FileText size={parseInt(iconSize)} />
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'webp':
      return <Image size={parseInt(iconSize)} />
    case 'mp3':
    case 'wav':
    case 'ogg':
    case 'flac':
      return <Music size={parseInt(iconSize)} />
    case 'mp4':
    case 'mkv':
    case 'webm':
    case 'avi':
      return <Video size={parseInt(iconSize)} />
    case 'zip':
    case 'tar':
    case 'gz':
    case 'rar':
    case '7z':
      return <Archive size={parseInt(iconSize)} />
    case 'js':
    case 'ts':
    case 'tsx':
    case 'jsx':
    case 'py':
    case 'java':
    case 'cpp':
    case 'c':
    case 'go':
    case 'rs':
    case 'rb':
    case 'php':
    case 'sh':
    case 'json':
    case 'yaml':
    case 'yml':
    case 'xml':
    case 'html':
    case 'css':
    case 'scss':
    case 'sql':
      return <Code size={parseInt(iconSize)} />
    default:
      return <FileIcon size={parseInt(iconSize)} />
  }
}

// Format file size
function formatFileSize(bytes?: number): string {
  if (!bytes) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

// Format modified date
function formatDate(dateStr?: string): string {
  if (!dateStr) return '-'
  const date = new Date(dateStr)
  return date.toLocaleDateString()
}

export function RemoteFileBrowser({ serverId, onFileSelect, readonly = false }: RemoteFileBrowserProps) {
  const { t } = useTranslation()
  const [currentPath, setCurrentPath] = useState('/')
  const [files, setFiles] = useState<RemoteFile[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<RemoteFile | null>(null)
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set(['/']))

  // Load directory contents
  const loadDirectory = async (path: string) => {
    setLoading(true)
    setError(null)
    try {
      const result = await api.listRemoteFiles(serverId, path)
      if (result.success && result.data) {
        setFiles(result.data as RemoteFile[])
      } else {
        setError(result.error || t('Failed to load directory'))
      }
    } catch (err) {
      console.error('[RemoteFileBrowser] Failed to load directory:', err)
      setError(t('Failed to load directory'))
    } finally {
      setLoading(false)
    }
  }

  // Load initial directory on mount
  useEffect(() => {
    loadDirectory(currentPath)
  }, [serverId, currentPath])

  // Handle directory click
  const handleDirectoryClick = (file: RemoteFile) => {
    const newPath = file.path
    setCurrentPath(newPath)
    setExpandedDirs(prev => new Set([...prev, newPath]))
  }

  // Handle file click
  const handleFileClick = (file: RemoteFile) => {
    setSelectedFile(file)
    onFileSelect?.(file)
  }

  // Handle breadcrumb click
  const handleBreadcrumbClick = (index: number) => {
    const parts = currentPath.split('/').filter(Boolean)
    const newPath = '/' + parts.slice(0, index + 1).join('/')
    setCurrentPath(newPath)
  }

  // Handle go to parent
  const handleGoUp = () => {
    if (currentPath === '/') return
    const parentPath = currentPath.split('/').slice(0, -1).join('/') || '/'
    setCurrentPath(parentPath)
  }

  // Handle go to home
  const handleGoHome = () => {
    setCurrentPath('/')
    setExpandedDirs(new Set(['/']))
  }

  // Handle refresh
  const handleRefresh = () => {
    loadDirectory(currentPath)
  }

  // Generate breadcrumb parts
  const breadcrumbParts = currentPath.split('/').filter(Boolean)
  const canGoUp = currentPath !== '/'

  // Separate directories and files
  const directories = files.filter(f => f.type === 'directory')
  const regularFiles = files.filter(f => f.type === 'file')

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-card">
      {/* Breadcrumb navigation */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-muted/30">
        <button
          onClick={handleGoHome}
          className="p-1.5 hover:bg-secondary rounded-lg transition-colors"
          title={t('Go to home')}
        >
          <Home className="w-4 h-4" />
        </button>
        {canGoUp && (
          <button
            onClick={handleGoUp}
            className="p-1.5 hover:bg-secondary rounded-lg transition-colors"
            title={t('Go up')}
          >
            <ChevronRight className="w-4 h-4 rotate-[-90deg]" />
          </button>
        )}
        <div className="flex items-center gap-1 text-sm overflow-hidden">
          <button
            onClick={() => handleBreadcrumbClick(-1)}
            className="text-muted-foreground hover:text-foreground truncate"
          >
            /
          </button>
          {breadcrumbParts.map((part, index) => (
            <React.Fragment key={`${part}-${index}`}>
              <ChevronRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />
              <button
                onClick={() => handleBreadcrumbClick(index)}
                className={`truncate ${
                  index === breadcrumbParts.length - 1
                    ? 'text-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {part}
              </button>
            </React.Fragment>
          ))}
        </div>
        <div className="flex-1" />
        <button
          onClick={handleRefresh}
          disabled={loading}
          className="p-1.5 hover:bg-secondary rounded-lg transition-colors disabled:opacity-50"
          title={t('Refresh')}
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Error message */}
      {error && (
        <div className="px-4 py-3 bg-red-500/10 text-red-500 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* File list */}
      {!loading && files.length === 0 && !error && (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <span className="text-sm">{t('This directory is empty')}</span>
        </div>
      )}

      {!loading && (directories.length > 0 || regularFiles.length > 0) && (
        <div className="divide-y divide-border max-h-[500px] overflow-auto">
          {/* Directories */}
          {directories.map((dir) => (
            <div
              key={dir.path}
              onClick={() => !readonly && handleDirectoryClick(dir)}
              className={`flex items-center gap-3 px-4 py-2 hover:bg-secondary/50 transition-colors ${
                selectedFile?.path === dir.path ? 'bg-primary/10' : ''
              } ${!readonly ? 'cursor-pointer' : 'cursor-default'}`}
            >
              <FolderOpen className="w-4 h-4 text-amber-500 flex-shrink-0" />
              <span className="flex-1 truncate">{dir.name}</span>
              {dir.isSymlink && (
                <span className="text-xs text-muted-foreground flex-shrink-0">
                  → {dir.symlinkTarget}
                </span>
              )}
            </div>
          ))}

          {/* Files */}
          {regularFiles.map((file) => (
            <div
              key={file.path}
              onClick={() => !readonly && handleFileClick(file)}
              className={`flex items-center gap-3 px-4 py-2 hover:bg-secondary/50 transition-colors ${
                selectedFile?.path === file.path ? 'bg-primary/10' : ''
              } ${!readonly ? 'cursor-pointer' : 'cursor-default'}`}
            >
              <div className="flex-shrink-0 text-muted-foreground">
                {getFileIcon(file.name, 16)}
              </div>
              <span className="flex-1 truncate">{file.name}</span>
              <span className="text-xs text-muted-foreground w-20 text-right flex-shrink-0">
                {formatFileSize(file.size)}
              </span>
              <span className="text-xs text-muted-foreground w-24 text-right flex-shrink-0 hidden sm:block">
                {formatDate(file.modified)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
