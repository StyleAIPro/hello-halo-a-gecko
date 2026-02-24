/**
 * Store Card
 *
 * Compact card showing app summary in the store grid.
 * Clicking navigates to the detail view.
 */

import type { RegistryEntry } from '../../../shared/store/store-types'
import { useTranslation } from '../../i18n'

interface StoreCardProps {
  entry: RegistryEntry
  onClick: () => void
}

/** Max number of tags displayed on the card */
const MAX_VISIBLE_TAGS = 3

export function StoreCard({ entry, onClick }: StoreCardProps) {
  const { t } = useTranslation()
  const visibleTags = entry.tags.slice(0, MAX_VISIBLE_TAGS)

  return (
    <button
      onClick={onClick}
      className="w-full text-left p-4 rounded-xl border border-border hover:border-primary/40 hover:bg-secondary/50 transition-colors cursor-pointer"
    >
      {/* First line: icon + name + version */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {entry.icon && (
            <span className="text-base flex-shrink-0">{entry.icon}</span>
          )}
          <span className="text-sm font-medium text-foreground truncate">
            {entry.name}
          </span>
        </div>
        <span className="text-xs text-muted-foreground flex-shrink-0">
          v{entry.version}
        </span>
      </div>

      {/* Author */}
      <p className="text-xs text-muted-foreground mt-1">
        {t('by')} {entry.author}
      </p>

      {/* Description (2 lines max) */}
      <p className="text-xs text-muted-foreground mt-2 line-clamp-2">
        {entry.description}
      </p>

      {/* Tags */}
      {visibleTags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-3">
          {visibleTags.map(tag => (
            <span
              key={tag}
              className="text-xs px-2 py-0.5 rounded-full bg-secondary text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </button>
  )
}
