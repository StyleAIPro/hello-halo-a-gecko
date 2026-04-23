/**
 * DiffResultViewer - Inline diff display for Edit/Write tool results
 *
 * Shows before/after comparison directly in the thought process timeline.
 * - Edit: diff between old_string and new_string from toolInput
 * - Write: shows content as all-new (diff against empty)
 * - Collapsed by default with summary stats
 * - Expandable to full diff view
 */

import { memo, useMemo, useState } from 'react';
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';
import { ChevronDown, FileEdit, FilePlus } from 'lucide-react';
import type { ViewerBaseProps } from './types';

// Detect if dark mode is active
function useIsDarkMode(): boolean {
  if (typeof document !== 'undefined') {
    return !document.documentElement.classList.contains('light');
  }
  return true;
}

// Custom styles matching AICO-Bot's dark theme (same as DiffContent.tsx)
const customStyles = {
  variables: {
    dark: {
      diffViewerBackground: 'transparent',
      diffViewerColor: 'hsl(var(--foreground))',
      addedBackground: 'hsla(142, 76%, 36%, 0.15)',
      addedColor: 'hsl(142, 76%, 60%)',
      removedBackground: 'hsla(0, 84%, 60%, 0.15)',
      removedColor: 'hsl(0, 84%, 70%)',
      wordAddedBackground: 'hsla(142, 76%, 36%, 0.35)',
      wordRemovedBackground: 'hsla(0, 84%, 60%, 0.35)',
      addedGutterBackground: 'hsla(142, 76%, 36%, 0.1)',
      removedGutterBackground: 'hsla(0, 84%, 60%, 0.1)',
      gutterBackground: 'hsl(var(--muted))',
      gutterBackgroundDark: 'hsl(var(--muted))',
      gutterColor: 'hsl(var(--muted-foreground))',
      addedGutterColor: 'hsl(142, 76%, 50%)',
      removedGutterColor: 'hsl(0, 84%, 60%)',
      codeFoldGutterBackground: 'hsl(var(--muted))',
      codeFoldBackground: 'hsl(var(--muted))',
      emptyLineBackground: 'transparent',
      highlightBackground: 'hsla(var(--primary), 0.1)',
      highlightGutterBackground: 'hsla(var(--primary), 0.2)',
    },
  },
};

export const DiffResultViewer = memo(function DiffResultViewer({ toolInput }: ViewerBaseProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const isDark = useIsDarkMode();

  // Extract old/new content from toolInput
  const { oldString, newString, type, filePath } = useMemo(() => {
    if (!toolInput) return { oldString: '', newString: '', type: 'edit' as const, filePath: '' };

    const fp = (toolInput.file_path as string) || '';

    // Edit tool: has old_string and new_string
    if (toolInput.old_string !== undefined || toolInput.new_string !== undefined) {
      return {
        oldString: (toolInput.old_string as string) || '',
        newString: (toolInput.new_string as string) || '',
        type: 'edit' as const,
        filePath: fp,
      };
    }

    // Write tool: has content (no old content)
    if (toolInput.content !== undefined) {
      return {
        oldString: '',
        newString: (toolInput.content as string) || '',
        type: 'write' as const,
        filePath: fp,
      };
    }

    return { oldString: '', newString: '', type: 'edit' as const, filePath: fp };
  }, [toolInput]);

  // Calculate stats
  const stats = useMemo(() => {
    if (type === 'write') {
      const lines = newString.split('\n').length;
      return { added: lines, removed: 0 };
    }
    const oldLines = oldString.split('\n');
    const newLines = newString.split('\n');
    return {
      added: Math.max(0, newLines.length - oldLines.length + 1),
      removed: Math.max(0, oldLines.length - newLines.length + 1),
    };
  }, [type, oldString, newString]);

  // Extract filename for display
  const fileName = filePath ? filePath.split(/[/\\]/).pop() || filePath : '';

  const Icon = type === 'write' ? FilePlus : FileEdit;

  return (
    <div className="rounded-lg overflow-hidden">
      {/* Collapsed: summary header */}
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/5 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <Icon size={13} className={type === 'write' ? 'text-green-400' : 'text-amber-400'} />
        <span className="text-[11px] font-medium text-foreground/80 flex-1 min-w-0 truncate">
          {fileName || (type === 'write' ? 'New file' : 'File edit')}
        </span>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-[10px] text-green-400/70">+{stats.added}</span>
          {stats.removed > 0 && (
            <>
              <span className="text-[10px] text-muted-foreground/40">/</span>
              <span className="text-[10px] text-red-400/70">-{stats.removed}</span>
            </>
          )}
        </div>
        <ChevronDown
          size={12}
          className={`text-muted-foreground/40 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Expanded: full diff view */}
      {isExpanded && (
        <div className="border-t border-border/20 max-h-[400px] overflow-auto">
          <ReactDiffViewer
            oldValue={oldString}
            newValue={newString}
            splitView={false}
            useDarkTheme={isDark}
            styles={customStyles}
            compareMethod={DiffMethod.WORDS}
            hideLineNumbers={false}
            showDiffOnly={type === 'edit'}
            extraLinesSurroundingDiff={3}
          />
        </div>
      )}
    </div>
  );
});
