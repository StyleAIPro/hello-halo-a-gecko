/**
 * CompactNotice - Displays a notice when context has been compressed
 *
 * Design principles:
 * - Appears as a system message in the conversation
 * - Subtle but informative
 * - Explains what happened in simple terms
 * - Shows estimated remaining capacity after compression
 */

import { useTranslation } from '../../i18n';
import type { CompactInfo } from '../../types';

interface CompactNoticeProps extends CompactInfo {
  className?: string;
  // Optional: estimated remaining tokens after compression
  remainingCapacity?: number;
}

// Format number to K format (e.g., 180000 -> "180K")
function formatTokens(tokens: number): string {
  if (tokens < 1000) return tokens.toString();
  return `${Math.round(tokens / 1000)}K`;
}

// Compression threshold (80% of context window)
const COMPRESSION_THRESHOLD = 0.8;
const DEFAULT_CONTEXT_WINDOW = 200000;

export function CompactNotice({
  trigger,
  preTokens,
  postTokens,
  remainingCapacity,
  className = '',
}: CompactNoticeProps) {
  const { t } = useTranslation();

  // Calculate estimated remaining capacity if not provided
  const estimatedRemaining =
    remainingCapacity ?? (postTokens ? DEFAULT_CONTEXT_WINDOW - postTokens : null);

  // Calculate compression ratio
  const compressionRatio =
    preTokens > 0 && postTokens ? Math.round((1 - postTokens / preTokens) * 100) : null;

  return (
    <div className={`flex justify-center my-4 ${className}`}>
      <div className="inline-flex items-center gap-2 px-4 py-2 bg-secondary/50 rounded-full text-xs text-muted-foreground">
        <span className="w-1.5 h-1.5 bg-amber-500/60 rounded-full" />
        <div className="flex flex-col gap-0.5">
          <span>
            {t('Context has been intelligently compressed')}
            {trigger === 'auto' && ` (${formatTokens(preTokens)} tokens)`}
          </span>
          {compressionRatio !== null && compressionRatio > 0 && (
            <span className="text-[10px] text-muted-foreground/60">
              {t('Reduced by')} {compressionRatio}%
              {estimatedRemaining && ` · ${t('Remaining')}: ${formatTokens(estimatedRemaining)}`}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
