/**
 * Pipeline Dashboard Component
 *
 * Displays running pipelines with their stage progress.
 * Each pipeline shows as a card with stages listed below.
 */

import { useHyperSpaceStore } from '@/stores/hyper-space.store';
import { useTranslation } from '@/i18n';

export function PipelineDashboard() {
  const { t } = useTranslation();
  const pipelines = useHyperSpaceStore((s) => s.pipelines);

  return (
    <div className="flex flex-col gap-4 p-4">
      {Array.from(pipelines.entries()).map(([id, pipeline]) => (
        <div key={id} className="rounded-lg border p-4">
          <div className="flex items-center justify-between">
            <h3 className="font-medium">{pipeline.name}</h3>
            <span
              className={`text-sm ${
                pipeline.status === 'running'
                  ? 'text-blue-500'
                  : pipeline.status === 'completed'
                    ? 'text-green-500'
                    : 'text-red-500'
              }`}
            >
              {pipeline.status}
            </span>
          </div>
          <div className="mt-2 space-y-1">
            {Array.from(pipeline.stages.entries()).map(([stageId, stage]) => (
              <div key={stageId} className="flex items-center gap-2 text-sm">
                <span>
                  {stage.status === 'completed'
                    ? '\u2705'
                    : stage.status === 'running'
                      ? '\uD83D\uDD04'
                      : stage.status === 'failed'
                        ? '\u274C'
                        : '\u23F3'}
                </span>
                <span>{stage.name}</span>
                {stage.status === 'running' && (
                  <div className="flex-1 h-1.5 rounded bg-gray-200">
                    <div
                      className="h-full rounded bg-blue-500"
                      style={{ width: `${stage.progress * 100}%` }}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
      {pipelines.size === 0 && (
        <p className="text-sm text-gray-500">{t('No active pipelines')}</p>
      )}
    </div>
  );
}
