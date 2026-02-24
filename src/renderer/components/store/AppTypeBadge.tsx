/**
 * AppTypeBadge
 *
 * Displays a type badge for store app entries.
 * Each AppType gets a distinct icon, color, and hover tooltip.
 *
 * The `automation` type receives special primary-color styling as it is
 * Halo's signature "Digital Human" feature.
 *
 * Note: all t() calls use string literals so i18next-parser can extract them.
 */

import { useState } from 'react'
import { Bot, Plug, Wand2, Package } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { AppType } from '../../../shared/apps/spec-types'
import { useTranslation } from '../../i18n'

// ---------------------------------------------------------------------------
// Resolved metadata (populated inside the hook so t() gets literal strings)
// ---------------------------------------------------------------------------

interface AppTypeMetaResolved {
  Icon: LucideIcon
  label: string
  tooltipTitle: string
  tooltipDesc: string
  badgeClassName: string
  iconClassName: string
  textClassName: string
}

function useAppTypeMeta(type: AppType): AppTypeMetaResolved | null {
  const { t } = useTranslation()

  switch (type) {
    case 'automation':
      return {
        Icon: Bot,
        label: t('Digital Human'),
        tooltipTitle: t('7×24 hrs Digital Human'),
        tooltipDesc: t(
          'An always-on AI agent that runs autonomously on schedule or events — working for you around the clock.'
        ),
        badgeClassName: 'bg-primary/10 border border-primary/30 hover:bg-primary/15',
        iconClassName: 'text-primary',
        textClassName: 'text-primary font-semibold',
      }
    case 'mcp':
      return {
        Icon: Plug,
        label: t('MCP'),
        tooltipTitle: t('Model Context Protocol'),
        tooltipDesc: t(
          'Extends AI capabilities with external tools, APIs, and data sources via the MCP standard.'
        ),
        badgeClassName: 'bg-blue-500/10 border border-blue-500/30 hover:bg-blue-500/15',
        iconClassName: 'text-blue-500',
        textClassName: 'text-blue-500',
      }
    case 'skill':
      return {
        Icon: Wand2,
        label: t('Skill'),
        tooltipTitle: t('AI Skill'),
        tooltipDesc: t(
          'A reusable AI capability you can invoke on demand across any conversation or workflow.'
        ),
        badgeClassName: 'bg-emerald-500/10 border border-emerald-500/30 hover:bg-emerald-500/15',
        iconClassName: 'text-emerald-500',
        textClassName: 'text-emerald-500',
      }
    case 'extension':
      return {
        Icon: Package,
        label: t('Extension'),
        tooltipTitle: t('Halo Extension'),
        tooltipDesc: t(
          'Enhances the Halo platform with additional UI or system-level functionality.'
        ),
        badgeClassName: 'bg-amber-500/10 border border-amber-500/30 hover:bg-amber-500/15',
        iconClassName: 'text-amber-500',
        textClassName: 'text-amber-500',
      }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface AppTypeBadgeProps {
  type: AppType
  /**
   * Controls tooltip open direction.
   * 'down' (default) — tooltip below the badge, for card grids.
   * 'up'             — tooltip above the badge, for detail headers.
   */
  tooltipDirection?: 'down' | 'up'
}

export function AppTypeBadge({ type, tooltipDirection = 'down' }: AppTypeBadgeProps) {
  const [showTooltip, setShowTooltip] = useState(false)
  const meta = useAppTypeMeta(type)

  if (!meta) return null

  const { Icon, label, tooltipTitle, tooltipDesc, badgeClassName, iconClassName, textClassName } =
    meta

  const tooltipPositionClass =
    tooltipDirection === 'up' ? 'bottom-full mb-1.5 left-0' : 'top-full mt-1.5 left-0'

  return (
    <div
      className="relative inline-flex flex-shrink-0"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      {/* Badge */}
      <span
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs transition-colors ${badgeClassName}`}
      >
        <Icon className={`w-3 h-3 flex-shrink-0 ${iconClassName}`} />
        <span className={`text-xs leading-none ${textClassName}`}>{label}</span>
      </span>

      {/* Tooltip */}
      {showTooltip && (
        <div className={`absolute ${tooltipPositionClass} z-50 pointer-events-none`}>
          <div className="bg-popover border border-border rounded-lg shadow-lg px-3 py-2.5 w-56">
            <div className="flex items-center gap-1.5 mb-1">
              <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${iconClassName}`} />
              <span className={`text-xs font-semibold ${textClassName}`}>{tooltipTitle}</span>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">{tooltipDesc}</p>
          </div>
        </div>
      )}
    </div>
  )
}
