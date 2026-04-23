import type { ToolCall } from '../types';
import { useTranslation } from '../i18n';
import { CheckCircle2, XCircle, Loader2, Wrench } from 'lucide-react';

interface ToolCallDisplayProps {
  toolCalls: ToolCall[];
}

/**
 * Component to display tool calls with their status and results
 */
export function ToolCallDisplay({ toolCalls }: ToolCallDisplayProps) {
  const { t } = useTranslation();

  if (!toolCalls || toolCalls.length === 0) return null;

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'success':
      case 'running':
        return 'text-blue-400';
      case 'completed':
        return 'text-green-400';
      case 'error':
      case 'failed':
        return 'text-red-400';
      case 'waiting':
      case 'pending':
      case 'waiting_approval':
        return 'text-yellow-400';
      default:
        return 'text-gray-400';
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'success':
      case 'completed':
        return { bg: 'bg-green-500/10 border-green-500/30', label: t('Completed') };
      case 'error':
      case 'failed':
        return { bg: 'bg-red-500/10 border-red-500/30', label: t('Failed') };
      case 'running':
        return { bg: 'bg-blue-500/10 border-blue-500/30', label: t('Running') };
      case 'pending':
      case 'waiting':
        return { bg: 'bg-yellow-500/10 border-yellow-500/30', label: t('Pending') };
      case 'waiting_approval':
        return { bg: 'bg-orange-500/10 border-orange-500/30', label: t('Waiting') };
      default:
        return { bg: 'bg-gray-500/10 border-gray-500/30', label: status };
    }
  };

  return (
    <div className="mt-4 space-y-2">
      <div className="text-xs text-muted-foreground font-medium mb-2">
        {t('Tool Calls')} ({toolCalls.length})
      </div>
      {toolCalls.map((tool) => {
        const statusInfo = getStatusBadge(tool.status);
        const isRunning = tool.status === 'running' || tool.status === 'pending';
        const isError = tool.status === 'error' || tool.status === 'failed';

        return (
          <div
            key={tool.id}
            className={`border rounded-lg p-3 bg-muted/50 ${
              isError ? 'border-destructive/30' : 'border-border/30'
            }`}
          >
            <div className="flex items-center gap-2 mb-2">
              <Wrench size={16} className={getStatusColor(tool.status)} />
              <span className="font-semibold text-sm">{tool.name}</span>
              {isRunning && <Loader2 size={14} className="animate-spin text-blue-400" />}
              <span className={`text-xs px-2 py-0.5 rounded border ${statusInfo.bg}`}>
                {statusInfo.label}
              </span>
            </div>

            {tool.description && (
              <div className="text-xs text-muted-foreground mb-2">{tool.description}</div>
            )}

            {tool.input && Object.keys(tool.input).length > 0 && (
              <details className="mt-2">
                <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors select-none">
                  {t('Input')}
                </summary>
                <pre className="mt-1.5 text-xs bg-background/50 p-2 rounded overflow-auto max-h-32 border border-border/20">
                  {JSON.stringify(tool.input, null, 2)}
                </pre>
              </details>
            )}

            {tool.output && (
              <details className="mt-2">
                <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors select-none">
                  {t('Output')}
                </summary>
                <pre
                  className={`mt-1.5 text-xs p-2 rounded overflow-auto max-h-48 border ${
                    isError
                      ? 'bg-destructive/10 border-destructive/30 text-destructive'
                      : 'bg-background/50 border-border/20'
                  }`}
                >
                  {typeof tool.output === 'string'
                    ? tool.output
                    : JSON.stringify(tool.output, null, 2)}
                </pre>
              </details>
            )}

            {tool.error && (
              <div className="mt-2 text-xs text-destructive">
                <div className="flex items-center gap-1 mb-1">
                  <XCircle size={14} />
                  <span className="font-medium">{t('Error')}</span>
                </div>
                <div className="bg-destructive/10 p-2 rounded border border-destructive/30">
                  {tool.error}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
