/**
 * Cluster Grid Component
 *
 * Displays NPU servers as a clickable grid.
 * Clicking a server selects it in the store for log viewing.
 */

import { useHyperSpaceStore } from '@/stores/hyper-space.store';
import { useTranslation } from '@/i18n';

export function ClusterGrid() {
  const { t } = useTranslation();
  const servers = useHyperSpaceStore((s) => s.servers);
  const setSelectedAgent = useHyperSpaceStore((s) => s.setSelectedAgent);

  const statusColor: Record<string, string> = {
    online: 'bg-green-500',
    offline: 'bg-red-500',
    busy: 'bg-yellow-500',
    error: 'bg-red-700',
  };

  return (
    <div className="grid grid-cols-2 gap-2 p-4">
      {Array.from(servers.values()).map((server) => (
        <button
          key={server.id}
          onClick={() => setSelectedAgent(server.id)}
          className="flex items-center gap-2 rounded-lg border p-3 text-left hover:bg-gray-50"
        >
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              statusColor[server.status] || 'bg-gray-400'
            }`}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{server.name}</p>
            <p className="text-xs text-gray-500">
              {server.capabilities.npuType} &middot;{' '}
              {server.load.runningTasks} {t('tasks')}
            </p>
          </div>
        </button>
      ))}
      {servers.size === 0 && (
        <p className="col-span-2 text-sm text-gray-500">
          {t('No servers registered')}
        </p>
      )}
    </div>
  );
}
