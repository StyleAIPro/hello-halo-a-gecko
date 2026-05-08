/**
 * Agent Log Panel Component
 *
 * Shows logs for the currently selected agent/server.
 * Displays progress, GPU utilization, and timestamped log entries.
 */

import { useHyperSpaceStore } from '@/stores/hyper-space.store';
import { useTranslation } from '@/i18n';

export function AgentLogPanel() {
  const { t } = useTranslation();
  const selectedAgentId = useHyperSpaceStore((s) => s.selectedAgentId);
  const agentLogs = useHyperSpaceStore((s) => s.agentLogs);
  const agentStatuses = useHyperSpaceStore((s) => s.agentStatuses);
  const setSelectedAgent = useHyperSpaceStore((s) => s.setSelectedAgent);

  if (!selectedAgentId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-gray-500">
        {t('Select a server to view logs')}
      </div>
    );
  }

  const logs = agentLogs.get(selectedAgentId) || [];
  const status = agentStatuses.get(selectedAgentId);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <span className="text-sm font-medium">{selectedAgentId}</span>
        {status && (
          <span className="text-xs text-gray-500">
            {t('Progress')}: {Math.round(status.progress * 100)}%
            {status.gpuUtilization != null &&
              ` \u00B7 GPU: ${status.gpuUtilization}%`}
          </span>
        )}
        <button
          onClick={() => setSelectedAgent(null)}
          className="text-xs text-gray-400 hover:text-gray-600"
        >
          {t('Close')}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 font-mono text-xs space-y-0.5">
        {logs.map((entry, i) => (
          <div key={i} className="text-gray-700">
            <span className="text-gray-400">
              [{new Date(entry.timestamp).toLocaleTimeString()}]
            </span>{' '}
            {entry.content}
          </div>
        ))}
        {logs.length === 0 && (
          <p className="text-gray-400">{t('No logs yet')}</p>
        )}
      </div>
    </div>
  );
}
