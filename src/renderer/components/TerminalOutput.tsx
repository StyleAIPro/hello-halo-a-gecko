import { TerminalOutputData } from '../types'
import { useTranslation } from '../i18n'
import { Terminal, ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'

interface TerminalOutputProps {
  outputs: TerminalOutputData[]
}

/**
 * Component to display terminal output with expand/collapse functionality
 */
export function TerminalOutput({ outputs }: TerminalOutputProps) {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(false)

  if (!outputs || outputs.length === 0) return null

  const combinedOutput = outputs.map(o => o.content).join('')

  return (
    <div className="mt-4 border rounded-lg border-border/30 bg-muted/30 overflow-hidden">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-2 w-full px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-white/5 transition-all"
      >
        <Terminal size={14} />
        <span className="font-medium">{t('Terminal Output')}</span>
        <span className="text-muted-foreground/50">
          ({outputs.length} {outputs.length === 1 ? t('line_one') : t('line_other')})
        </span>
        <div className="ml-auto">
          {isExpanded ? (
            <ChevronDown size={14} />
          ) : (
            <ChevronRight size={14} />
          )}
        </div>
      </button>

      {isExpanded && (
        <div className="border-t border-border/30">
          <div className="bg-black text-green-400 font-mono text-xs p-4 overflow-auto max-h-96 leading-relaxed">
            {outputs.map((output, index) => (
              <div
                key={index}
                className={output.type === 'stderr' ? 'text-red-400' : ''}
              >
                {output.content}
              </div>
            ))}
            {!combinedOutput && (
              <div className="text-muted-foreground/50 italic">
                {t('No output')}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
