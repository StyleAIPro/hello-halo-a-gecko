/**
 * EvolutionPanel - Skill Self-Evolution Dashboard
 *
 * Displays usage stats, evolution suggestions, version history,
 * and pattern discoveries for the skill self-evolution system.
 */

import { useEffect, useState } from 'react';
import { useSkillEvolutionStore } from '../../stores/skill/skill-evolution.store';
import { useSkillStore } from '../../stores/skill/skill.store';
import { useTranslation } from '../../i18n';
import {
  Activity,
  TrendingUp,
  Clock,
  CheckCircle2,
  XCircle,
  RotateCcw,
  Zap,
  BarChart3,
  History,
  Lightbulb,
  Settings,
  RefreshCw,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import type { EvolutionSuggestion, SkillVersionSnapshot } from '../../../shared/skill/skill-evolution-types';

type TabId = 'stats' | 'suggestions' | 'versions' | 'patterns' | 'settings';

export function EvolutionPanel() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<TabId>('stats');

  const {
    loadLeaderboard,
    loadPendingSuggestions,
    loadConfig,
    evolving,
    error,
    clearError,
  } = useSkillEvolutionStore();

  useEffect(() => {
    loadLeaderboard();
    loadPendingSuggestions();
    loadConfig();
  }, []);

  const tabs: Array<{ id: TabId; label: string; icon: typeof Activity }> = [
    { id: 'stats', label: t('Usage Stats'), icon: BarChart3 },
    { id: 'suggestions', label: t('Suggestions'), icon: Lightbulb },
    { id: 'versions', label: t('Version History'), icon: History },
    { id: 'patterns', label: t('Patterns'), icon: Zap },
    { id: 'settings', label: t('Settings'), icon: Settings },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex border-b border-[var(--border)] px-2">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 transition-colors ${
                isActive
                  ? 'border-[var(--primary)] text-[var(--primary)]'
                  : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              <Icon size={14} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Error banner */}
      {error && (
        <div className="mx-4 mt-2 p-2 bg-red-500/10 text-red-400 text-sm rounded flex items-center justify-between">
          <span>{error}</span>
          <button onClick={clearError} className="text-red-400 hover:text-red-300">
            <XCircle size={14} />
          </button>
        </div>
      )}

      {/* Tab content */}
      <div className="flex-1 overflow-auto p-4">
        {activeTab === 'stats' && <StatsTab />}
        {activeTab === 'suggestions' && <SuggestionsTab />}
        {activeTab === 'versions' && <VersionsTab />}
        {activeTab === 'patterns' && <PatternsTab />}
        {activeTab === 'settings' && <SettingsTab />}
      </div>

      {/* Evolve button */}
      <div className="border-t border-[var(--border)] p-3">
        <EvolveButton />
      </div>
    </div>
  );
}

// ============================================
// Stats Tab
// ============================================

function StatsTab() {
  const { t } = useTranslation();
  const { usageLeaderboard, loadingStats } = useSkillEvolutionStore();

  if (loadingStats && usageLeaderboard.length === 0) {
    return <div className="text-center text-[var(--text-secondary)] py-8">{t('Loading...')}</div>;
  }

  if (usageLeaderboard.length === 0) {
    return (
      <div className="text-center text-[var(--text-secondary)] py-8">
        {t('No skill usage data yet. Use skills in conversations to start tracking.')}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {usageLeaderboard.map((stats) => (
        <div
          key={stats.skillId}
          className="p-3 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="font-medium text-sm">{stats.skillId}</span>
            <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
              <TrendingUp size={12} />
              {stats.usageTrend}
            </div>
          </div>
          <div className="grid grid-cols-4 gap-2 text-xs">
            <div>
              <div className="text-[var(--text-secondary)]">{t('Uses')}</div>
              <div className="font-medium">{stats.totalUses}</div>
            </div>
            <div>
              <div className="text-[var(--text-secondary)]">{t('Success')}</div>
              <div className="font-medium">{(stats.successRate * 100).toFixed(0)}%</div>
            </div>
            <div>
              <div className="text-[var(--text-secondary)]">{t('Compliance')}</div>
              <div className="font-medium">{(stats.avgProcessCompliance * 100).toFixed(0)}%</div>
            </div>
            <div>
              <div className="text-[var(--text-secondary)]">{t('Feedback')}</div>
              <div className="font-medium">{(stats.positiveFeedbackRate * 100).toFixed(0)}%</div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ============================================
// Suggestions Tab
// ============================================

function SuggestionsTab() {
  const { t } = useTranslation();
  const { pendingSuggestions, suggestions, loadingSuggestions, confirmSuggestion, rejectSuggestion, rollbackSuggestion } =
    useSkillEvolutionStore();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (loadingSuggestions && suggestions.length === 0) {
    return <div className="text-center text-[var(--text-secondary)] py-8">{t('Loading...')}</div>;
  }

  const allSuggestions = [...pendingSuggestions, ...suggestions.filter((s) => s.status !== 'pending')];
  const unique = allSuggestions.filter((s, i, arr) => arr.findIndex((x) => x.id === s.id) === i);

  if (unique.length === 0) {
    return (
      <div className="text-center text-[var(--text-secondary)] py-8">
        {t('No evolution suggestions yet. Run an evolution cycle to generate suggestions.')}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {unique.map((suggestion) => {
        const isExpanded = expandedId === suggestion.id;
        const isPending = suggestion.status === 'pending';
        const isApplied = suggestion.status === 'auto-applied' || suggestion.status === 'confirmed';

        return (
          <div
            key={suggestion.id}
            className="border border-[var(--border)] rounded-lg overflow-hidden"
          >
            <button
              className="w-full p-3 flex items-center justify-between text-left hover:bg-[var(--bg-secondary)]"
              onClick={() => setExpandedId(isExpanded ? null : suggestion.id)}
            >
              <div className="flex items-center gap-2">
                <ConfidenceBadge confidence={suggestion.confidence} />
                <div>
                  <div className="text-sm font-medium">{suggestion.skillId}</div>
                  <div className="text-xs text-[var(--text-secondary)]">
                    {suggestion.type} - {(suggestion.scores.improvement * 100).toFixed(0)}% {t('improvement')}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge status={suggestion.status} />
                {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </div>
            </button>

            {isExpanded && (
              <div className="p-3 border-t border-[var(--border)] bg-[var(--bg-secondary)] space-y-2">
                <p className="text-xs text-[var(--text-secondary)]">{suggestion.explanation}</p>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <div className="text-[var(--text-secondary)]">{t('Baseline Score')}</div>
                    <div>{(suggestion.scores.baseline.overall * 100).toFixed(0)}%</div>
                  </div>
                  <div>
                    <div className="text-[var(--text-secondary)]">{t('Evolved Score')}</div>
                    <div>{(suggestion.scores.evolved.overall * 100).toFixed(0)}%</div>
                  </div>
                </div>

                {isPending && (
                  <div className="flex gap-2 pt-2">
                    <button
                      onClick={() => confirmSuggestion(suggestion.id)}
                      className="flex items-center gap-1 px-3 py-1 text-xs bg-green-500/20 text-green-400 rounded hover:bg-green-500/30"
                    >
                      <CheckCircle2 size={12} /> {t('Apply')}
                    </button>
                    <button
                      onClick={() => rejectSuggestion(suggestion.id)}
                      className="flex items-center gap-1 px-3 py-1 text-xs bg-red-500/20 text-red-400 rounded hover:bg-red-500/30"
                    >
                      <XCircle size={12} /> {t('Reject')}
                    </button>
                  </div>
                )}

                {isApplied && (
                  <button
                    onClick={() => rollbackSuggestion(suggestion.id)}
                    className="flex items-center gap-1 px-3 py-1 text-xs bg-yellow-500/20 text-yellow-400 rounded hover:bg-yellow-500/30"
                  >
                    <RotateCcw size={12} /> {t('Rollback')}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ============================================
// Versions Tab
// ============================================

function VersionsTab() {
  const { t } = useTranslation();
  const { versionHistory, loadingVersions, loadVersionHistory, rollbackVersion, selectedSkillId } =
    useSkillEvolutionStore();
  const installedSkills = useSkillStore((s) => s.installedSkills);

  if (!selectedSkillId) {
    return (
      <div className="text-center text-[var(--text-secondary)] py-8">
        {t('Select a skill to view version history')}
      </div>
    );
  }

  useEffect(() => {
    if (selectedSkillId) loadVersionHistory(selectedSkillId);
  }, [selectedSkillId]);

  if (loadingVersions) {
    return <div className="text-center text-[var(--text-secondary)] py-8">{t('Loading...')}</div>;
  }

  if (versionHistory.length === 0) {
    return (
      <div className="text-center text-[var(--text-secondary)] py-8">
        {t('No version history yet for this skill.')}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {versionHistory.map((version) => (
        <VersionItem key={version.id} version={version} onRollback={(id) => rollbackVersion(selectedSkillId, id)} />
      ))}
    </div>
  );
}

function VersionItem({ version, onRollback }: { version: SkillVersionSnapshot; onRollback: (id: string) => void }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-[var(--border)] rounded-lg overflow-hidden">
      <button
        className="w-full p-3 flex items-center justify-between text-left hover:bg-[var(--bg-secondary)]"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2">
          <History size={12} className="text-[var(--text-secondary)]" />
          <div>
            <span className="text-sm font-medium">{version.version}</span>
            <span className="text-xs text-[var(--text-secondary)] ml-2">
              {new Date(version.createdAt).toLocaleDateString()}
            </span>
          </div>
        </div>
        <span className="text-xs px-2 py-0.5 rounded bg-[var(--bg-secondary)]">{version.reason}</span>
      </button>

      {expanded && (
        <div className="p-3 border-t border-[var(--border)] bg-[var(--bg-secondary)] space-y-2">
          <pre className="text-xs overflow-auto max-h-40 p-2 rounded bg-[var(--bg-primary)] whitespace-pre-wrap">
            {version.systemPrompt.slice(0, 500)}
            {version.systemPrompt.length > 500 ? '...' : ''}
          </pre>
          {version.fitnessScore && (
            <div className="text-xs">
              {t('Score')}: {(version.fitnessScore.overall * 100).toFixed(0)}%
            </div>
          )}
          <button
            onClick={() => onRollback(version.id)}
            className="flex items-center gap-1 px-3 py-1 text-xs bg-yellow-500/20 text-yellow-400 rounded hover:bg-yellow-500/30"
          >
            <RotateCcw size={12} /> {t('Rollback to this version')}
          </button>
        </div>
      )}
    </div>
  );
}

// ============================================
// Patterns Tab
// ============================================

function PatternsTab() {
  const { t } = useTranslation();
  const { patterns, loadingPatterns, analyzePatterns, acceptPattern, dismissPattern } =
    useSkillEvolutionStore();

  if (loadingPatterns && patterns.length === 0) {
    return <div className="text-center text-[var(--text-secondary)] py-8">{t('Loading...')}</div>;
  }

  return (
    <div className="space-y-3">
      <button
        onClick={() => analyzePatterns()}
        disabled={loadingPatterns}
        className="flex items-center gap-1 px-3 py-1.5 text-xs bg-[var(--primary)] text-white rounded hover:opacity-90 disabled:opacity-50"
      >
        <RefreshCw size={12} className={loadingPatterns ? 'animate-spin' : ''} />
        {t('Run Analysis')}
      </button>

      {patterns.length === 0 ? (
        <div className="text-center text-[var(--text-secondary)] py-8">
          {t('No patterns discovered yet. Run analysis to discover reusable patterns.')}
        </div>
      ) : (
        patterns.map((pattern) => (
          <div key={pattern.id} className="p-3 border border-[var(--border)] rounded-lg space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{pattern.description}</span>
              <span className="text-xs px-2 py-0.5 rounded bg-blue-500/20 text-blue-400">
                {pattern.type === 'new-skill' ? t('New Skill') : t('Optimize')}
              </span>
            </div>
            <div className="text-xs text-[var(--text-secondary)]">
              {t('Frequency')}: {pattern.frequency}x | {t('Reusability')}: {(pattern.reusabilityScore * 100).toFixed(0)}%
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => acceptPattern(pattern.id)}
                className="px-3 py-1 text-xs bg-green-500/20 text-green-400 rounded hover:bg-green-500/30"
              >
                {t('Accept')}
              </button>
              <button
                onClick={() => dismissPattern(pattern.id)}
                className="px-3 py-1 text-xs bg-red-500/20 text-red-400 rounded hover:bg-red-500/30"
              >
                {t('Dismiss')}
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

// ============================================
// Settings Tab
// ============================================

function SettingsTab() {
  const { t } = useTranslation();
  const { engineConfig, analyzerConfig, updateConfig } = useSkillEvolutionStore();

  if (!engineConfig || !analyzerConfig) {
    return <div className="text-center text-[var(--text-secondary)] py-8">{t('Loading configuration...')}</div>;
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h3 className="text-sm font-medium">{t('Evolution Engine')}</h3>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={engineConfig.enabled}
            onChange={(e) => updateConfig({ engine: { enabled: e.target.checked } })}
          />
          {t('Enable auto-evolution')}
        </label>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <label className="text-[var(--text-secondary)]">{t('Min Usage Count')}</label>
            <input
              type="number"
              value={engineConfig.minUsageCount}
              onChange={(e) => updateConfig({ engine: { minUsageCount: Number(e.target.value) } })}
              className="w-full mt-1 px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg-primary)] text-sm"
            />
          </div>
          <div>
            <label className="text-[var(--text-secondary)]">{t('GEPA Steps')}</label>
            <input
              type="number"
              value={engineConfig.gepaSteps}
              onChange={(e) => updateConfig({ engine: { gepaSteps: Number(e.target.value) } })}
              className="w-full mt-1 px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg-primary)] text-sm"
            />
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">{t('Pattern Analyzer')}</h3>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={analyzerConfig.enabled}
            onChange={(e) => updateConfig({ analyzer: { enabled: e.target.checked } })}
          />
          {t('Enable background analysis')}
        </label>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <label className="text-[var(--text-secondary)]">{t('Frequency Threshold')}</label>
            <input
              type="number"
              value={analyzerConfig.frequencyThreshold}
              onChange={(e) => updateConfig({ analyzer: { frequencyThreshold: Number(e.target.value) } })}
              className="w-full mt-1 px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg-primary)] text-sm"
            />
          </div>
          <div>
            <label className="text-[var(--text-secondary)]">{t('Lookback (days)')}</label>
            <input
              type="number"
              value={analyzerConfig.lookbackDays}
              onChange={(e) => updateConfig({ analyzer: { lookbackDays: Number(e.target.value) } })}
              className="w-full mt-1 px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg-primary)] text-sm"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================
// Shared Components
// ============================================

function ConfidenceBadge({ confidence }: { confidence: string }) {
  const colors: Record<string, string> = {
    high: 'bg-green-500/20 text-green-400',
    medium: 'bg-yellow-500/20 text-yellow-400',
    low: 'bg-gray-500/20 text-gray-400',
  };
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded ${colors[confidence] || colors.low}`}>
      {confidence}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: 'bg-blue-500/20 text-blue-400',
    'auto-applied': 'bg-green-500/20 text-green-400',
    confirmed: 'bg-green-500/20 text-green-400',
    rejected: 'bg-red-500/20 text-red-400',
    'rolled-back': 'bg-yellow-500/20 text-yellow-400',
  };
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded ${colors[status] || 'bg-gray-500/20 text-gray-400'}`}>
      {status}
    </span>
  );
}

function EvolveButton() {
  const { t } = useTranslation();
  const { evolving, runEvolutionCycle } = useSkillEvolutionStore();

  return (
    <button
      onClick={() => runEvolutionCycle()}
      disabled={evolving}
      className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-[var(--primary)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
    >
      {evolving ? (
        <>
          <RefreshCw size={14} className="animate-spin" />
          {t('Evolving...')}
        </>
      ) : (
        <>
          <Zap size={14} />
          {t('Run Evolution Cycle')}
        </>
      )}
    </button>
  );
}
