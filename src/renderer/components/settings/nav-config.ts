/**
 * Settings Navigation Configuration
 * Data-driven navigation items for the settings page
 */

import { Bot, Puzzle, Palette, Settings, Globe, Info, Bell } from 'lucide-react'
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
    id: 'mcp',
    labelKey: 'MCP',
    icon: Puzzle
  },
  // Future: Skills section
  // {
  //   id: 'skills',
  //   labelKey: 'Skills',
  //   icon: Wand
  // },
  {
    id: 'notification-channels',
    labelKey: 'Notification Channels',
    icon: Bell
  },
  {
    id: 'appearance',
    labelKey: 'Appearance',
    icon: Palette
  },
  {
    id: 'system',
    labelKey: 'System',
    icon: Settings,
    desktopOnly: true
  },
  {
    id: 'remote',
    labelKey: 'Remote Access',
    icon: Globe,
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
  return SETTINGS_NAV_ITEMS.filter(item => !item.desktopOnly || !isRemoteMode)
}
