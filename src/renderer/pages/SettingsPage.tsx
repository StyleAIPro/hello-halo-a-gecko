/**
 * Settings Page - App configuration
 * Modular design with left sidebar navigation and right content area
 */

import { useState, useCallback } from 'react'
import { ArrowLeft } from 'lucide-react'
import { useAppStore } from '../stores/app.store'
import { api } from '../api'
import type { HaloConfig, McpServersConfig } from '../types'
import { Header } from '../components/layout/Header'
import { McpServerList } from '../components/settings/McpServerList'
import { useTranslation } from '../i18n'
import { useIsMobile } from '../hooks/useIsMobile'

// Import modular settings components
import {
  SettingsNav,
  scrollToSection,
  AISourcesSection,
  AppearanceSection,
  SystemSection,
  RemoteAccessSection,
  AboutSection,
  NotificationChannelsSection,
  RegistrySection
} from '../components/settings'

export function SettingsPage() {
  const { t } = useTranslation()
  const { config, setConfig, goBack } = useAppStore()
  const isMobile = useIsMobile()
  const isRemoteMode = api.isRemoteMode()

  // Active navigation section (click-only, no scroll spy - standard settings page behavior)
  const [activeSection, setActiveSection] = useState('ai-model')

  // Handle navigation click
  const handleNavClick = useCallback((sectionId: string) => {
    setActiveSection(sectionId)
    scrollToSection(sectionId)
  }, [])

  // Handle MCP servers save
  const handleMcpServersSave = async (servers: McpServersConfig) => {
    await api.setConfig({ mcpServers: servers })
    setConfig({ ...config, mcpServers: servers } as HaloConfig)
  }

  // Handle back - return to previous view
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
            <span className="font-medium text-sm">{t('Settings')}</span>
          </>
        }
      />

      {/* Main Content Area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Navigation - Desktop only */}
        {!isMobile && (
          <SettingsNav
            isRemoteMode={isRemoteMode}
            activeSection={activeSection}
            onSectionChange={handleNavClick}
          />
        )}

        {/* Right Content Area */}
        <main className="flex-1 overflow-auto">
          {/* Mobile Navigation Dropdown */}
          {isMobile && (
            <SettingsNav
              isRemoteMode={isRemoteMode}
              activeSection={activeSection}
              onSectionChange={handleNavClick}
            />
          )}

          {/* Scrollable Content */}
          <div className="p-6">
            <div className="max-w-2xl mx-auto space-y-6">
              {/* AI Sources Section (v2) */}
              <section id="ai-model" className="bg-card rounded-xl border border-border p-6">
                <h2 className="text-lg font-medium mb-4">{t('AI Model')}</h2>
                <AISourcesSection config={config as HaloConfig} setConfig={setConfig} />
              </section>

              {/* MCP Servers Section */}
              <section id="mcp" className="bg-card rounded-xl border border-border p-6">
                <McpServerList
                  servers={config?.mcpServers || {}}
                  onSave={handleMcpServersSave}
                />

                {/* Help text */}
                <div className="mt-4 pt-4 border-t border-border">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-muted-foreground">{t('Format compatible with Cursor / Claude Desktop')}</span>
                    <a
                      href="https://modelcontextprotocol.io/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-primary hover:text-primary/80 transition-colors"
                    >
                      {t('Learn about MCP')} →
                    </a>
                  </div>
                  <p className="text-xs text-amber-500/80">
                    ⚠️ {t('Configuration changes will take effect after starting a new conversation')}
                  </p>
                </div>
              </section>

              {/* Notification Channels Section */}
              <NotificationChannelsSection config={config} setConfig={setConfig} />

              {/* App Store Registry Section */}
              <RegistrySection />

              {/* Appearance Section */}
              <AppearanceSection config={config} setConfig={setConfig} />

              {/* System Section - Desktop only */}
              {!isRemoteMode && (
                <SystemSection config={config} setConfig={setConfig} />
              )}

              {/* Remote Access Section - Desktop only */}
              {!isRemoteMode && (
                <RemoteAccessSection />
              )}

              {/* About Section */}
              <AboutSection />
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
