/**
 * SkillMarket - 技能市场
 *
 * 只支持 skills.sh 源
 * - 无限滚动加载
 * - 全局搜索
 * - 使用 npx 命令安装技能
 */

import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { useSkillStore } from '../../stores/skill/skill.store'
import { useTranslation } from '../../i18n'
import {
  Search,
  Plus,
  Trash2,
  ExternalLink,
  Loader2,
  X,
  Download,
  Store,
  Check,
  RefreshCw,
  Terminal
} from 'lucide-react'
import type { RemoteSkillItem } from '../../../shared/skill/skill-types'
import { api } from '../../api'

const PAGE_SIZE = 20

/**
 * Extract appId from skill ID
 * ID format: "skills.sh:owner/repo/skillName"
 * AppId format: skill-name (lowercase with dashes)
 */
function extractAppId(skillId: string): string {
  const idParts = skillId.split(':')
  const fullPath = idParts[1] || ''
  const skillName = fullPath.includes('/') ? fullPath.split('/').pop() || '' : fullPath
  return skillName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '-')
}

interface InstallOutput {
  type: 'stdout' | 'stderr' | 'complete' | 'error'
  content: string
}

export function SkillMarket() {
  const { t } = useTranslation()
  const { installedSkills, loadInstalledSkills } = useSkillStore()

  // 选中的技能
  const [selectedSkill, setSelectedSkill] = useState<RemoteSkillItem | null>(null)

  // 搜索查询
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')

  // 技能列表
  const [skills, setSkills] = useState<RemoteSkillItem[]>([])
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)

  // 安装中的技能 ID
  const [installingSkillId, setInstallingSkillId] = useState<string | null>(null)

  // 安装输出
  const [installOutputs, setInstallOutputs] = useState<InstallOutput[]>([])
  const outputRef = useRef<HTMLDivElement>(null)

  // 滚动容器引用
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const loadingRef = useRef(false)

  // 搜索防抖
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchQuery)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  // 当搜索词切换时重置
  useEffect(() => {
    setSkills([])
    setPage(1)
    setHasMore(true)
  }, [debouncedQuery])

  // 监听安装输出
  useEffect(() => {
    const cleanup = api.onSkillInstallOutput((data) => {
      setInstallOutputs(prev => [...prev, data.output])
      // 滚动到底部
      setTimeout(() => {
        if (outputRef.current) {
          outputRef.current.scrollTop = outputRef.current.scrollHeight
        }
      }, 0)
    })
    return cleanup
  }, [])

  // 加载已安装的技能列表 - 只在组件挂载时执行一次
  useEffect(() => {
    loadInstalledSkills()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 已安装的技能 ID 集合
  const installedSkillIds = useMemo(() => {
    return new Set(installedSkills.map(s => s.appId))
  }, [installedSkills])

  // 加载技能
  const loadSkills = useCallback(async (pageNum: number, reset: boolean = false) => {
    if (loadingRef.current) return
    loadingRef.current = true
    setLoading(true)

    try {
      let result
      if (debouncedQuery.trim()) {
        result = await api.skillMarketSearch(debouncedQuery, pageNum, PAGE_SIZE)
      } else {
        result = await api.skillMarketList(pageNum, PAGE_SIZE)
      }

      if (result.success && result.data) {
        const newSkills = result.data.skills || []
        if (reset || pageNum === 1) {
          setSkills(newSkills)
        } else {
          setSkills(prev => [...prev, ...newSkills])
        }
        setHasMore(result.data.hasMore || false)
        setTotal(result.data.total || 0)
        setPage(pageNum)
      }
    } catch (error) {
      console.error('Failed to load skills:', error)
    } finally {
      setLoading(false)
      loadingRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery])

  // 初始加载 - 当搜索词变化时重新加载
  useEffect(() => {
    loadSkills(1, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery])

  // 无限滚动处理
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const container = e.currentTarget
    const { scrollTop, scrollHeight, clientHeight } = container

    // 距离底部 100px 时加载更多
    if (scrollHeight - scrollTop - clientHeight < 100 && hasMore && !loading && !loadingRef.current) {
      loadSkills(page + 1)
    }
  }, [hasMore, loading, page, loadSkills])

  // 安装技能
  const handleInstall = async (skill: RemoteSkillItem) => {
    // 打开右侧详情面板
    setSelectedSkill(skill)
    // 清空之前的输出
    setInstallOutputs([])
    setInstallingSkillId(skill.id)

    try {
      const result = await api.skillInstall({ mode: 'market', skillId: skill.id })
      if (result.success) {
        await loadInstalledSkills()
      } else {
        console.error('Failed to install skill:', result.error)
        setInstallOutputs(prev => [...prev, { type: 'error', content: `\n✗ ${result.error || 'Unknown error'}\n` }])
      }
    } catch (error) {
      console.error('Failed to install skill:', error)
      setInstallOutputs(prev => [...prev, { type: 'error', content: `\n✗ ${error instanceof Error ? error.message : 'Unknown error'}\n` }])
    } finally {
      setInstallingSkillId(null)
    }
  }

  // 卸载技能
  const handleUninstall = async (skill: RemoteSkillItem) => {
    const appId = extractAppId(skill.id)
    try {
      const result = await api.skillUninstall(appId)
      if (result.success) {
        await loadInstalledSkills()
      }
    } catch (error) {
      console.error('Failed to uninstall skill:', error)
    }
  }

  return (
    <div className="flex h-full">
      {/* 左侧：技能列表 */}
      <div className="flex-1 flex flex-col">
        {/* 搜索栏 */}
        <div className="p-3 border-b border-border">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              placeholder={t('Search skills...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-10 py-2 bg-secondary border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            <button
              onClick={() => {
                setSkills([])
                setPage(1)
                setHasMore(true)
                loadSkills(1, true)
              }}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 text-muted-foreground hover:text-foreground transition-colors"
              title={t('Refresh')}
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
          <div className="mt-2 text-xs text-muted-foreground">
            {loading ? (
              <span className="flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" />
                {t('Loading...')}
              </span>
            ) : (
              <span>{total} {t('skills')}</span>
            )}
          </div>
        </div>

        {/* 技能列表 - 无限滚动 */}
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto p-3"
        >
          {skills.length === 0 && !loading ? (
            <div className="flex flex-col items-center justify-center h-64 text-center text-muted-foreground">
              <Store className="w-12 h-12 mb-4 opacity-50" />
              <p>{t('No skills found')}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {skills.map((skill) => {
                const appId = extractAppId(skill.id)
                const isInstalled = installedSkillIds.has(appId)
                const isInstalling = installingSkillId === skill.id

                return (
                  <div
                    key={skill.id}
                    onClick={() => setSelectedSkill(skill)}
                    className={`
                      bg-secondary rounded-lg p-3 cursor-pointer transition-all
                      hover:bg-secondary/80
                      ${selectedSkill?.id === skill.id ? 'ring-2 ring-primary' : ''}
                    `}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-medium text-foreground truncate">{skill.name}</h3>
                        <p className="text-xs text-muted-foreground">by {skill.author}</p>
                      </div>
                      {isInstalled && (
                        <span className="text-xs text-green-500 px-1.5 py-0.5 bg-green-500/10 rounded flex items-center gap-1">
                          <Check className="w-3 h-3" />
                          {t('Installed')}
                        </span>
                      )}
                    </div>

                    <p className="text-xs text-muted-foreground line-clamp-2 mb-2">
                      {skill.description}
                    </p>

                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">
                        {skill.installs?.toLocaleString()} {t('installs')}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          if (isInstalled) {
                            handleUninstall(skill)
                          } else {
                            handleInstall(skill)
                          }
                        }}
                        disabled={isInstalling}
                        className={`
                          flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors
                          ${isInstalled
                            ? 'text-red-500 hover:bg-red-500/10'
                            : 'bg-primary text-primary-foreground hover:bg-primary/90'
                          }
                          ${isInstalling ? 'opacity-50 cursor-not-allowed' : ''}
                        `}
                      >
                        {isInstalling ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : isInstalled ? (
                          <Trash2 className="w-3 h-3" />
                        ) : (
                          <Download className="w-3 h-3" />
                        )}
                        {isInstalling ? t('Installing...') : isInstalled ? t('Uninstall') : t('Install')}
                      </button>
                    </div>
                  </div>
                )
              })}

              {/* 加载更多指示器 */}
              {loading && skills.length > 0 && (
                <div className="col-span-full flex justify-center py-4">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              )}

              {/* 没有更多 */}
              {!hasMore && skills.length > 0 && (
                <div className="col-span-full text-center py-4 text-xs text-muted-foreground">
                  {t('No more skills')}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 右侧：技能详情 */}
      {selectedSkill && (
        <div className="w-96 border-l border-border flex flex-col">
          <div className="p-3 border-b border-border flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">{t('Details')}</h2>
            <button
              onClick={() => {
                setSelectedSkill(null)
                setInstallOutputs([])
              }}
              className="p-1 hover:bg-secondary rounded"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-3 space-y-3">
            <div>
              <h3 className="text-base font-semibold text-foreground">{selectedSkill.name}</h3>
              <p className="text-xs text-muted-foreground">by {selectedSkill.author}</p>
            </div>

            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              {selectedSkill.installs && (
                <span>{selectedSkill.installs.toLocaleString()} {t('installs')}</span>
              )}
              <span>v{selectedSkill.version}</span>
            </div>

            <div>
              <h4 className="text-xs font-medium text-foreground mb-1">{t('Description')}</h4>
              <p className="text-xs text-muted-foreground">
                {selectedSkill.description}
              </p>
            </div>

            {selectedSkill.fullDescription && (
              <div>
                <h4 className="text-xs font-medium text-foreground mb-1">{t('Full Description')}</h4>
                <div
                  className="text-xs text-muted-foreground prose prose-sm max-w-none"
                  dangerouslySetInnerHTML={{ __html: selectedSkill.fullDescription.slice(0, 1000) + '...' }}
                />
              </div>
            )}

            {selectedSkill.tags && selectedSkill.tags.length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-foreground mb-1">{t('Tags')}</h4>
                <div className="flex flex-wrap gap-1">
                  {selectedSkill.tags.map((tag) => (
                    <span
                      key={tag}
                      className="text-xs px-2 py-0.5 bg-accent/50 rounded"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {selectedSkill.githubRepo && (
              <a
                href={`https://github.com/${selectedSkill.githubRepo}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-xs text-primary hover:text-primary/80"
              >
                <ExternalLink className="w-3 h-3" />
                {t('View on GitHub')}
              </a>
            )}

            <div className="pt-3 border-t border-border">
              {(() => {
                const appId = extractAppId(selectedSkill.id)
                const isInstalled = installedSkillIds.has(appId)
                const isInstalling = installingSkillId === selectedSkill.id

                return (
                  <button
                    onClick={() => {
                      if (isInstalled) {
                        handleUninstall(selectedSkill)
                      } else {
                        handleInstall(selectedSkill)
                      }
                    }}
                    disabled={isInstalling}
                    className={`
                      w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors
                      ${isInstalled
                        ? 'bg-red-500/10 text-red-500 hover:bg-red-500/20'
                        : 'bg-primary text-primary-foreground hover:bg-primary/90'
                      }
                      ${isInstalling ? 'opacity-50 cursor-not-allowed' : ''}
                    `}
                  >
                    {isInstalling ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : isInstalled ? (
                      <Trash2 className="w-4 h-4" />
                    ) : (
                      <Download className="w-4 h-4" />
                    )}
                    {isInstalling ? t('Installing...') : isInstalled ? t('Uninstall') : t('Install')}
                  </button>
                )
              })()}
            </div>
          </div>

          {/* 终端输出区域 */}
          {installOutputs.length > 0 && (
            <div className="flex-1 border-t border-border flex flex-col min-h-0">
              <div className="px-3 py-2 border-b border-border flex items-center gap-2 bg-secondary/50">
                <Terminal className="w-4 h-4 text-muted-foreground" />
                <span className="text-xs font-medium text-foreground">{t('Terminal Output')}</span>
              </div>
              <div
                ref={outputRef}
                className="flex-1 overflow-y-auto bg-black p-3 font-mono text-xs leading-relaxed"
              >
                {installOutputs.map((output, index) => (
                  <div
                    key={index}
                    className={`whitespace-pre-wrap ${
                      output.type === 'stderr' || output.type === 'error'
                        ? 'text-red-400'
                        : output.type === 'complete'
                        ? 'text-green-400'
                        : 'text-green-400'
                    }`}
                  >
                    {output.content}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
