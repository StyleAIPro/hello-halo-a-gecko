/**
 * Skill Management Page
 *
 * Main page for managing skills including:
 * - Library: View and manage installed skills
 * - Market: Browse and install skills from market
 * - Generator: Create new skills from conversation history
 */

import { useEffect, useMemo } from 'react'
import { useSkillStore } from '../../stores/skill/skill.store'
import { useSpaceStore } from '../../stores/space.store'
import { useAppStore } from '../../stores/app.store'
import { Header } from '../../components/layout/Header'
import { SkillLibrary } from '../../components/skill/SkillLibrary'
import { SkillMarket } from '../../components/skill/SkillMarket'
import { SkillGenerator } from '../../components/skill/SkillGenerator'
import { useTranslation } from '../../i18n'
import { Book, Store, Sparkles, Settings, ArrowLeft } from 'lucide-react'

export function SkillPage() {
  const { t } = useTranslation()
  const currentSpace = useSpaceStore(state => state.currentSpace)
  const { setView } = useAppStore()

  const {
    currentView,
    setCurrentView,
    loading,
    marketLoading,
    loadInstalledSkills,
    loadMarketSources,
    loadConfig,
  } = useSkillStore()

  // Load skills on mount
  useEffect(() => {
    loadInstalledSkills()
    loadMarketSources()
    loadConfig()
  }, [])

  // Tab configuration
  const tabs = useMemo(() => [
    {
      id: 'library' as const,
      label: t('Skill Library'),
      icon: Book,
    },
    {
      id: 'market' as const,
      label: t('Skill Market'),
      icon: Store,
    },
    {
      id: 'generator' as const,
      label: t('Skill Generator'),
      icon: Sparkles,
    },
  ], [t])

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <Header
        spaceId={currentSpace?.id}
        left={
          <button
            onClick={() => setView('space')}
            className="p-1.5 hover:bg-secondary rounded-lg transition-colors"
            title={t('Back')}
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
        }
      />

      {/* Tab Bar */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-border">
        {tabs.map((tab) => {
          const Icon = tab.icon
          const isActive = currentView === tab.id

          return (
            <button
              key={tab.id}
              onClick={() => setCurrentView(tab.id)}
              className={`
                flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium
                transition-colors duration-150
                ${
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                }
              `}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          )
        })}

        {/* Settings button (future: skill library config) */}
        <button
          className="ml-auto p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-md"
          title={t('Settings')}
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-hidden">
        {loading && currentView === 'library' && (
          <div className="flex items-center justify-center h-full">
            <div className="text-muted-foreground">{t('Loading skills...')}</div>
          </div>
        )}

        {marketLoading && currentView === 'market' && (
          <div className="flex items-center justify-center h-full">
            <div className="text-muted-foreground">{t('Loading market...')}</div>
          </div>
        )}

        {!loading && currentView === 'library' && <SkillLibrary />}
        {!marketLoading && currentView === 'market' && <SkillMarket />}
        {currentView === 'generator' && <SkillGenerator />}
      </div>
    </div>
  )
}
