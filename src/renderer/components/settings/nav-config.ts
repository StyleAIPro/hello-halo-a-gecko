/**
 * Settings Navigation Configuration
 * Data-driven navigation items for the settings page
 */

import { Bot, Puzzle, Palette, Settings, Globe, Info, Store, Server, Github } from 'lucide-react'
import type { SettingsNavItem } from './types'

/**
 * Navigation items for settings sidebar
 * Order determines display order in the navigation
 */
export const SETTINGS_NAV_ITEMS: SettingsNavItem[] = [
  {
    id: 'ai-model',
    labelKey: 'AI Model',
    icon: Bot
  },
  {
    id: 'remote-servers',
    labelKey: '远程服务器管理',
    icon: Server
  },
  {
    id: 'github',
    labelKey: 'GitHub 连接',
    icon: Github,
    desktopOnly: true
  },
  {
    id: 'gitcode',
    labelKey: 'GitCode 连接',
    icon: Globe,
    desktopOnly: true
  },
  {
    id: 'mcp',
    labelKey: 'MCP',
    icon: Puzzle
  },
  {
    id: 'appearance',
    labelKey: 'Appearance',
    icon: Palette
  },
  {
    id: 'remote',
    labelKey: 'Remote Access',
    icon: Globe,
    desktopOnly: true
  },
  {
    id: 'app-store',
    labelKey: 'App Store',
    icon: Store
  },
  {
    id: 'system',
    labelKey: 'System',
    icon: Settings,
    desktopOnly: true
  },
  {
    id: 'about',
    labelKey: 'About',
    icon: Info
  }
]

/**
 * Get filtered navigation items based on mode
 * @param isRemoteMode - Whether running in remote/web mode
 */
export function getFilteredNavItems(isRemoteMode: boolean): SettingsNavItem[] {
  return SETTINGS_NAV_ITEMS.filter(item => {
    // Keep desktop-only items out of remote mode
    if (isRemoteMode && item.desktopOnly) return false
    return true
  })
}
