/**
 * Slash command dropdown menu
 *
 * Positioned above the textarea (same strategy as MentionPopup).
 * Displays command/subcommand list with icons, names, and descriptions.
 */

import { forwardRef } from 'react';
import { Wrench } from 'lucide-react';
import { useTranslation } from '../../i18n';
import type { SlashCommandMenuItem } from '../../hooks/slash-command/types';

interface SlashCommandMenuProps {
  items: SlashCommandMenuItem[];
  selectedIndex: number;
  onSelect: (item: SlashCommandMenuItem) => void;
}

export const SlashCommandMenu = forwardRef<HTMLDivElement, SlashCommandMenuProps>(
  function SlashCommandMenu({ items, selectedIndex, onSelect }, ref) {
    const { t } = useTranslation();

    if (items.length === 0) {
      return (
        <div
          ref={ref}
          className="absolute bottom-full left-0 mb-2 py-2 px-3 bg-popover border border-border
            rounded-lg shadow-lg min-w-[240px] z-50"
        >
          <span className="text-xs text-muted-foreground">{t('No matching commands')}</span>
        </div>
      );
    }

    return (
      <div
        ref={ref}
        className="absolute bottom-full left-0 mb-2 py-1 bg-popover border border-border
          rounded-lg shadow-lg min-w-[240px] max-h-[300px] overflow-y-auto z-50"
      >
        {items.map((item, index) => (
          <button
            key={`${item.type}-${item.command.name}${item.subcommand ? `-${item.subcommand.name}` : ''}`}
            onClick={() => onSelect(item)}
            className={`w-full px-3 py-2 flex items-center gap-2 text-sm
              transition-colors ${
                index === selectedIndex
                  ? 'bg-primary/10 text-primary'
                  : 'text-foreground hover:bg-secondary'
              }`}
          >
            {/* Icon */}
            {item.icon === 'Wrench' ? (
              <Wrench className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
            ) : (
              <span className="w-4 h-4 flex-shrink-0" />
            )}

            {/* Subcommand indicator */}
            {item.type === 'subcommand' && <span className="text-xs text-muted-foreground">/</span>}

            {/* Name */}
            <span className="flex-1 text-left font-medium">{item.label}</span>

            {/* Description */}
            <span className="text-xs text-muted-foreground truncate max-w-[160px]">
              {item.description}
            </span>
          </button>
        ))}
      </div>
    );
  },
);
