/**
 * SkillMarket - 技能市场
 *
 * 只支持 skills.sh 源
 * - 无限滚动加载
 * - 全局搜索
 * - 使用 npx 命令安装技能
 * - 支持选择本地/远程服务器安装/卸载
 * - 详情面板按已安装/未安装分区显示各环境
 */

import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useSkillStore } from '../../stores/skill/skill.store';
import { useTranslation } from '../../i18n';
import {
  Search,
  Trash2,
  ExternalLink,
  Loader2,
  X,
  Download,
  Store,
  Check,
  RefreshCw,
  Terminal,
  Monitor,
  Server,
  Github,
  Globe,
  Plus,
  Settings,
  ChevronDown,
} from 'lucide-react';
import type { RemoteSkillItem, SkillMarketSource } from '../../../shared/skill/skill-types';
import { api } from '../../api';
import { useConfirm } from '../ui/ConfirmDialog';

const PAGE_SIZE = 20;

/**
 * Extract appId from skill ID
 * ID format: "skills.sh:owner/repo/skillName"
 * AppId format: skill-name (lowercase with dashes)
 */
function extractAppId(skillId: string): string {
  const idParts = skillId.split(':');
  const fullPath = idParts[1] || '';
  const skillName = fullPath.includes('/') ? fullPath.split('/').pop() || '' : fullPath;
  return skillName
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '-');
}

interface InstallOutput {
  type: 'stdout' | 'stderr' | 'complete' | 'error';
  content: string;
  targetKey: string;
}

interface ServerInfo {
  id: string;
  name: string;
  host: string;
  status: string;
}

/** 每个环境（本地/远程服务器）的安装状态 */
interface EnvStatus {
  targetKey: string; // 'local' | 'remote:<serverId>'
  name: string; // 显示名称
  host: string; // 主机地址（远程时显示）
  type: 'local' | 'remote';
  serverId?: string;
  installed: boolean; // 是否已安装
  checking: boolean; // 是否正在查询状态
}

export function SkillMarket() {
  const { t } = useTranslation();
  const { confirm: confirmDialog, ConfirmDialogElement } = useConfirm();
  const {
    installedSkills,
    loadInstalledSkills,
    marketSources,
    loadMarketSources,
    setActiveMarketSource,
    addMarketSource,
    removeMarketSource,
    toggleMarketSource,
    validateGitHubRepo,
    validateGitCodeRepo,
  } = useSkillStore();

  // 选中的技能
  const [selectedSkill, setSelectedSkill] = useState<RemoteSkillItem | null>(null);

  // 搜索查询
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  // 技能列表
  const [skills, setSkills] = useState<RemoteSkillItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fetchProgress, setFetchProgress] = useState<{
    phase: string;
    current: number;
    total: number;
  } | null>(null);

  // 操作状态：正在操作的 skill ID 集合（支持同时操作多个环境）
  const [operatingTargets, setOperatingTargets] = useState<Set<string>>(new Set());

  // 安装输出 - 按目标分组的输出
  const [installOutputs, setInstallOutputs] = useState<InstallOutput[]>([]);
  const outputRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // 滚动容器引用
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const fetchGenerationRef = useRef(0); // Race condition guard

  // 远程服务器列表
  const [servers, setServers] = useState<ServerInfo[]>([]);

  // 远程服务器已安装技能映射: serverId -> Set<appId>
  const [remoteInstalledMap, setRemoteInstalledMap] = useState<Record<string, Set<string>>>({});

  // 当前选中技能的各环境安装状态
  const [envStatuses, setEnvStatuses] = useState<EnvStatus[]>([]);

  // 激活的终端输出标签页
  const [activeOutputTab, setActiveOutputTab] = useState<string>('local');

  // 源管理状态
  const [showSourcePanel, setShowSourcePanel] = useState(false);
  const [showSourceDropdown, setShowSourceDropdown] = useState(false);
  const [newRepoUrl, setNewRepoUrl] = useState('');
  const [validating, setValidating] = useState(false);
  const [addingSource, setAddingSource] = useState(false);
  const [validationResult, setValidationResult] = useState<{
    valid: boolean;
    hasSkillsDir: boolean;
    skillCount: number;
    error?: string;
  } | null>(null);
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);

  // 当前活跃源：优先使用 activeSourceId，否则 fallback 到第一个 enabled 的源
  const activeSource = activeSourceId
    ? marketSources.find((s) => s.id === activeSourceId)
    : marketSources.find((s) => s.enabled) || marketSources[0];

  // 搜索防抖
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // 当搜索词切换时重置
  useEffect(() => {
    setSkills([]);
    setPage(1);
    setHasMore(true);
  }, [debouncedQuery]);

  // 加载远程服务器列表，同时查询每个服务器上已安装的技能
  const loadServers = useCallback(async () => {
    try {
      const result = await api.remoteServerList();
      if (result.success && result.data) {
        const serverList = result.data as ServerInfo[];
        setServers(serverList);

        // 并行查询每个服务器的已安装技能
        const map: Record<string, Set<string>> = {};
        const queries = serverList.map(async (server) => {
          try {
            const res = await api.remoteServerListSkills(server.id);
            if (res.success && res.data) {
              map[server.id] = new Set((res.data as Array<{ appId: string }>).map((s) => s.appId));
            }
          } catch {
            // ignore individual server query failure
          }
        });
        await Promise.all(queries);
        setRemoteInstalledMap(map);
      }
    } catch (error) {
      console.error('Failed to load servers:', error);
    }
  }, []);

  // 初始化加载
  useEffect(() => {
    loadInstalledSkills();
    loadServers();
    loadMarketSources().then(() => {
      // Use backend's activeSourceId directly to ensure UI matches fetch source
      const { marketSources, _activeSourceId } = useSkillStore.getState();
      if (marketSources.length > 0) {
        const backendActive = _activeSourceId;
        const fallback = marketSources.find((s) => s.enabled) || marketSources[0];
        setActiveSourceId(backendActive || fallback?.id || null);
      }
    });
  }, []);

  // 监听安装/卸载输出
  useEffect(() => {
    const cleanupProgress = api.onSkillMarketFetchProgress((progress) => {
      setFetchProgress(progress);
    });
    return () => cleanupProgress();
  }, []);

  useEffect(() => {
    const cleanupInstall = api.onSkillInstallOutput((data) => {
      setInstallOutputs((prev) => [
        ...prev,
        {
          ...data.output,
          targetKey: (data.output as any).targetKey || 'local',
        },
      ]);
    });

    const cleanupUninstall = api.onSkillUninstallOutput((data) => {
      setInstallOutputs((prev) => [
        ...prev,
        {
          ...data.output,
          targetKey: (data.output as any).targetKey || 'local',
        },
      ]);
    });

    return () => {
      cleanupInstall();
      cleanupUninstall();
    };
  }, [activeOutputTab]);

  // 新输出时自动滚到底部（仅当用户已在底部时）
  const lastOutputLength = useRef(0);
  useEffect(() => {
    if (installOutputs.length <= lastOutputLength.current) {
      lastOutputLength.current = installOutputs.length;
      return;
    }
    lastOutputLength.current = installOutputs.length;
    const el = outputRefs.current[activeOutputTab];
    if (el) {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      if (atBottom) {
        el.scrollTop = el.scrollHeight;
      }
    }
  }, [installOutputs, activeOutputTab]);

  // 已安装的技能 ID 集合（本地）
  const installedSkillIds = useMemo(() => {
    return new Set(installedSkills.map((s) => s.appId));
  }, [installedSkills]);

  // 查询某个 appId 在哪些环境安装了
  const getInstalledTargets = useCallback(
    (appId: string) => {
      const targets: Array<{ key: string; name: string; type: 'local' | 'remote' }> = [];
      if (installedSkillIds.has(appId)) {
        targets.push({ key: 'local', name: t('Local'), type: 'local' });
      }
      for (const server of servers) {
        if (remoteInstalledMap[server.id]?.has(appId)) {
          targets.push({ key: `remote:${server.id}`, name: server.name, type: 'remote' });
        }
      }
      return targets;
    },
    [installedSkillIds, remoteInstalledMap, servers, t],
  );

  // 当选中技能变化时，查询所有环境的安装状态
  useEffect(() => {
    if (!selectedSkill) {
      setEnvStatuses([]);
      return;
    }

    const appId = extractAppId(selectedSkill.id);
    const localInstalled = installedSkillIds.has(appId);

    // 构建初始状态列表
    const statuses: EnvStatus[] = [
      {
        targetKey: 'local',
        name: t('Local Machine'),
        host: '',
        type: 'local',
        installed: localInstalled,
        checking: false,
      },
    ];

    // 对每个远程服务器，异步查询安装状态
    setEnvStatuses(statuses);

    servers.forEach((server) => {
      const targetKey = `remote:${server.id}`;
      // 先添加 checking 状态
      setEnvStatuses((prev) => [
        ...prev,
        {
          targetKey,
          name: server.name,
          host: server.host,
          type: 'remote',
          serverId: server.id,
          installed: false,
          checking: true,
        },
      ]);

      // 异步查询
      api
        .remoteServerListSkills(server.id)
        .then((result) => {
          if (result.success && result.data) {
            const remoteSkills = result.data as Array<{ appId: string }>;
            const installed = remoteSkills.some((s) => s.appId === appId);
            setEnvStatuses((prev) =>
              prev.map((env) =>
                env.targetKey === targetKey ? { ...env, installed, checking: false } : env,
              ),
            );
          } else {
            setEnvStatuses((prev) =>
              prev.map((env) => (env.targetKey === targetKey ? { ...env, checking: false } : env)),
            );
          }
        })
        .catch(() => {
          setEnvStatuses((prev) =>
            prev.map((env) => (env.targetKey === targetKey ? { ...env, checking: false } : env)),
          );
        });
    });
  }, [selectedSkill, installedSkills, servers]);

  // 分区：已安装 / 未安装
  const { installedEnvs, notInstalledEnvs } = useMemo(() => {
    const installed: EnvStatus[] = [];
    const notInstalled: EnvStatus[] = [];
    envStatuses.forEach((env) => {
      if (env.checking) {
        // 查询中的归入未安装
        notInstalled.push(env);
      } else if (env.installed) {
        installed.push(env);
      } else {
        notInstalled.push(env);
      }
    });
    return { installedEnvs: installed, notInstalledEnvs: notInstalled };
  }, [envStatuses]);

  // 加载技能
  const loadSkills = useCallback(
    async (pageNum: number, reset: boolean = false) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      const generation = ++fetchGenerationRef.current;
      setLoading(true);
      setLoadError(null);
      if (reset) setFetchProgress(null);

      try {
        let result;
        if (debouncedQuery.trim()) {
          result = await api.skillMarketSearch(debouncedQuery, pageNum, PAGE_SIZE);
        } else {
          result = await api.skillMarketList(pageNum, PAGE_SIZE);
        }

        // Discard stale results if a newer fetch was started
        if (generation !== fetchGenerationRef.current) return;

        if (result.success && result.data) {
          const newSkills = result.data.skills || [];
          if (reset || pageNum === 1) {
            setSkills(newSkills);
          } else {
            setSkills((prev) => [...prev, ...newSkills]);
          }
          setHasMore(result.data.hasMore || false);
          setTotal(result.data.total || 0);
          setPage(pageNum);
        } else if (!result.success) {
          setLoadError(result.error || t('Failed to load skills'));
        }
      } catch (error) {
        if (generation !== fetchGenerationRef.current) return;
        console.error('Failed to load skills:', error);
        setLoadError(error instanceof Error ? error.message : t('Failed to load skills'));
      } finally {
        if (generation === fetchGenerationRef.current) {
          setLoading(false);
          loadingRef.current = false;
          setFetchProgress(null);
        }
      }
    },
    [debouncedQuery, t],
  );

  // 初始加载 - 当搜索词变化时重新加载
  useEffect(() => {
    loadSkills(1, true);
  }, [debouncedQuery]);

  // 无限滚动处理
  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const container = e.currentTarget;
      const { scrollTop, scrollHeight, clientHeight } = container;

      if (
        scrollHeight - scrollTop - clientHeight < 100 &&
        hasMore &&
        !loading &&
        !loadingRef.current
      ) {
        loadSkills(page + 1);
      }
    },
    [hasMore, loading, page, loadSkills],
  );

  // 安装到单个目标
  const handleInstallToTarget = async (skill: RemoteSkillItem, env: EnvStatus) => {
    const target =
      env.type === 'local'
        ? { type: 'local' as const }
        : { type: 'remote' as const, serverId: env.serverId! };

    const targetKey = env.targetKey;
    setOperatingTargets((prev) => new Set(prev).add(targetKey));
    setInstallOutputs([]);
    setActiveOutputTab(targetKey);

    try {
      await api.skillInstallMulti({ skillId: skill.id, targets: [target] });
      // 安装成功后直接标记为已安装，不依赖可能滞后的 installedSkillIds 闭包
      setEnvStatuses((prev) =>
        prev.map((e) => (e.targetKey === targetKey ? { ...e, installed: true } : e)),
      );
      await loadInstalledSkills();
      // 刷新远程已安装映射（用于卡片标记）
      if (env.type === 'remote' && env.serverId) {
        refreshRemoteInstalledMap(env.serverId);
      }
    } catch (error) {
      console.error('Failed to install skill:', error);
    } finally {
      setOperatingTargets((prev) => {
        const next = new Set(prev);
        next.delete(targetKey);
        return next;
      });
    }
  };

  // 从单个目标卸载
  const handleUninstallFromTarget = async (skill: RemoteSkillItem, env: EnvStatus) => {
    // Remote uninstall requires confirmation
    if (env.type === 'remote') {
      const confirmed = await confirmDialog(
        t('Are you sure you want to uninstall this skill from {name}?', {
          name: env.name,
        }),
        { title: t('Uninstall Skill'), confirmLabel: t('Uninstall'), cancelLabel: t('Cancel') },
      );
      if (!confirmed) return;
    }

    const appId = extractAppId(skill.id);
    const target =
      env.type === 'local'
        ? { type: 'local' as const }
        : { type: 'remote' as const, serverId: env.serverId! };

    const targetKey = env.targetKey;
    setOperatingTargets((prev) => new Set(prev).add(targetKey));
    setInstallOutputs([]);
    setActiveOutputTab(targetKey);

    try {
      await api.skillUninstallMulti({ appId, targets: [target] });
      // 卸载成功后直接标记为未安装
      setEnvStatuses((prev) =>
        prev.map((e) => (e.targetKey === targetKey ? { ...e, installed: false } : e)),
      );
      await loadInstalledSkills();
      // 刷新远程已安装映射
      if (env.type === 'remote' && env.serverId) {
        refreshRemoteInstalledMap(env.serverId);
      }
    } catch (error) {
      console.error('Failed to uninstall skill:', error);
    } finally {
      setOperatingTargets((prev) => {
        const next = new Set(prev);
        next.delete(targetKey);
        return next;
      });
    }
  };

  // 刷新单个远程服务器的已安装技能映射（用于卡片标记）
  const refreshRemoteInstalledMap = (serverId: string) => {
    api
      .remoteServerListSkills(serverId)
      .then((result) => {
        if (result.success && result.data) {
          const appIds = new Set((result.data as Array<{ appId: string }>).map((s) => s.appId));
          setRemoteInstalledMap((prev) => ({ ...prev, [serverId]: appIds }));
        }
      })
      .catch(() => {});
  };

  // 获取目标名称
  const getTargetName = (targetKey: string): string => {
    if (targetKey === 'local') return t('Local');
    const env = envStatuses.find((e) => e.targetKey === targetKey);
    return env?.name || targetKey.replace('remote:', '');
  };

  // 获取目标图标
  const getTargetIcon = (targetKey: string) => {
    if (targetKey === 'local') return <Monitor className="w-3 h-3" />;
    return <Server className="w-3 h-3" />;
  };

  // 可用的输出标签页
  const activeOutputTabs = useMemo(() => {
    const keys = new Set(installOutputs.map((o) => o.targetKey));
    return Array.from(keys);
  }, [installOutputs]);

  // 按目标筛选输出
  const filteredOutputs = useMemo(() => {
    if (!activeOutputTab || installOutputs.length === 0) return installOutputs;
    return installOutputs.filter((o) => o.targetKey === activeOutputTab);
  }, [installOutputs, activeOutputTab]);

  // 某个目标是否正在操作
  const isOperating = (targetKey: string) => operatingTargets.has(targetKey);

  // 渲染单个环境行
  const renderEnvRow = (env: EnvStatus, skill: RemoteSkillItem) => {
    const operating = isOperating(env.targetKey);

    return (
      <div
        key={env.targetKey}
        className={`
          flex items-center gap-2 px-2 py-2 rounded text-xs transition-colors
          ${env.installed ? 'bg-green-500/5' : ''}
        `}
      >
        {env.type === 'local' ? (
          <Monitor className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        ) : (
          <Server className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-medium text-foreground">{env.name}</span>
            {env.checking && (
              <Loader2 className="w-3 h-3 animate-spin text-muted-foreground shrink-0" />
            )}
          </div>
          {env.host && (
            <span className="text-[10px] text-muted-foreground truncate block">{env.host}</span>
          )}
        </div>
        {env.installed && !env.checking ? (
          <span className="flex items-center gap-1 text-[10px] text-green-500 shrink-0 mr-1">
            <Check className="w-3 h-3" />
          </span>
        ) : null}
        {env.checking ? (
          <span className="text-[10px] text-muted-foreground shrink-0">{t('Checking...')}</span>
        ) : env.installed ? (
          <button
            onClick={() => handleUninstallFromTarget(skill, env)}
            disabled={operating}
            className={`
              flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-colors shrink-0
              text-red-500 hover:bg-red-500/10
              ${operating ? 'opacity-50 cursor-not-allowed' : ''}
            `}
          >
            {operating ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Trash2 className="w-3 h-3" />
            )}
            {operating ? t('Removing...') : t('Remove')}
          </button>
        ) : (
          <button
            onClick={() => handleInstallToTarget(skill, env)}
            disabled={operating}
            className={`
              flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-colors shrink-0
              bg-primary text-primary-foreground hover:bg-primary/90
              ${operating ? 'opacity-50 cursor-not-allowed' : ''}
            `}
          >
            {operating ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Download className="w-3 h-3" />
            )}
            {operating ? t('Installing...') : t('Install')}
          </button>
        )}
      </div>
    );
  };

  return (
    <>
      {ConfirmDialogElement}
      <div className="flex h-full">
        {/* 左侧：技能列表 */}
        <div className="flex-1 flex flex-col">
          {/* 搜索栏 + 源选择器 */}
          <div className="p-3 border-b border-border">
            <div className="flex items-center gap-2">
              {/* 源选择器 */}
              <div className="relative">
                <button
                  onClick={() => setShowSourceDropdown(!showSourceDropdown)}
                  className="flex items-center gap-1.5 px-3 py-2 bg-secondary border border-border rounded-lg text-sm text-foreground hover:bg-secondary/80 transition-colors whitespace-nowrap"
                >
                  {activeSource?.type === 'github' ? (
                    <Github className="w-4 h-4" />
                  ) : activeSource?.type === 'gitcode' ? (
                    <Globe className="w-4 h-4" />
                  ) : (
                    <Store className="w-4 h-4" />
                  )}
                  <span className="max-w-[120px] truncate">
                    {activeSource?.name || t('Skills.sh')}
                  </span>
                  <ChevronDown className="w-3 h-3 text-muted-foreground" />
                </button>
                {showSourceDropdown && (
                  <>
                    <div
                      className="fixed inset-0 z-10"
                      onClick={() => setShowSourceDropdown(false)}
                    />
                    <div className="absolute top-full left-0 mt-1 bg-popover border border-border rounded-lg shadow-lg z-20 min-w-[220px] py-1">
                      {marketSources
                        .filter((s) => s.enabled)
                        .map((source) => (
                          <button
                            key={source.id}
                            onClick={async () => {
                              setActiveSourceId(source.id);
                              await setActiveMarketSource(source.id);
                              setShowSourceDropdown(false);
                              setSkills([]);
                              setPage(1);
                              setHasMore(true);
                              loadSkills(1, true);
                            }}
                            className={`w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors ${
                              source.id === activeSource?.id
                                ? 'text-primary font-medium'
                                : 'text-foreground'
                            }`}
                          >
                            {source.type === 'github' ? (
                              <Github className="w-4 h-4 shrink-0" />
                            ) : source.type === 'gitcode' ? (
                              <Globe className="w-4 h-4 shrink-0" />
                            ) : (
                              <Store className="w-4 h-4 shrink-0" />
                            )}
                            <span className="truncate">{source.name}</span>
                            {source.id === activeSource?.id && (
                              <Check className="w-3.5 h-3.5 ml-auto text-primary" />
                            )}
                          </button>
                        ))}
                      <div className="border-t border-border my-1" />
                      <button
                        onClick={() => {
                          setShowSourceDropdown(false);
                          setShowSourcePanel(true);
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                      >
                        <Settings className="w-4 h-4" />
                        {t('Manage Sources')}
                      </button>
                    </div>
                  </>
                )}
              </div>

              {/* 搜索框 */}
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input
                  type="text"
                  placeholder={t('Search skills...')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-10 py-2 bg-secondary border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
                <button
                  onClick={() => {
                    setSkills([]);
                    setPage(1);
                    setHasMore(true);
                    loadSkills(1, true);
                  }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 text-muted-foreground hover:text-foreground transition-colors"
                  title={t('Refresh')}
                >
                  <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                </button>
              </div>
            </div>
            <div className="mt-2 text-xs text-muted-foreground">
              {loading ? (
                fetchProgress && fetchProgress.total > 0 ? (
                  <div className="space-y-1">
                    <span className="flex items-center gap-1">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      {fetchProgress.phase === 'scanning'
                        ? `${t('Scanning directories...')} (${fetchProgress.current})`
                        : `${t('Loading skill details...')} (${fetchProgress.current}/${fetchProgress.total})`}
                    </span>
                    {fetchProgress.phase === 'fetching-metadata' && (
                      <div className="w-full bg-secondary rounded-full h-1.5">
                        <div
                          className="bg-primary h-1.5 rounded-full transition-all duration-300"
                          style={{
                            width: `${Math.round((fetchProgress.current / fetchProgress.total) * 100)}%`,
                          }}
                        />
                      </div>
                    )}
                  </div>
                ) : (
                  <span className="flex items-center gap-1">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    {t('Loading...')}
                  </span>
                )
              ) : (
                <span>
                  {total} {t('skills')}
                </span>
              )}
            </div>
          </div>

          {/* 技能列表 - 无限滚动 */}
          <div
            ref={scrollContainerRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto p-3"
          >
            {loadError && skills.length === 0 && !loading ? (
              <div className="flex flex-col items-center justify-center h-64 text-center text-muted-foreground">
                <X className="w-12 h-12 mb-4 opacity-50 text-destructive" />
                <p className="text-destructive mb-1">{loadError}</p>
                <button
                  onClick={() => loadSkills(1, true)}
                  className="text-sm text-primary hover:underline mt-2"
                >
                  {t('Retry')}
                </button>
              </div>
            ) : skills.length === 0 && !loading ? (
              <div className="flex flex-col items-center justify-center h-64 text-center text-muted-foreground">
                <Store className="w-12 h-12 mb-4 opacity-50" />
                <p>{t('No skills found')}</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {skills.map((skill) => {
                  const appId = extractAppId(skill.id);
                  const installedTargets = getInstalledTargets(appId);
                  const isInstalled = installedTargets.length > 0;

                  return (
                    <div
                      key={skill.id}
                      onClick={() => {
                        setSelectedSkill(skill);
                        setInstallOutputs([]);
                      }}
                      className={`
                      bg-secondary rounded-lg p-3 cursor-pointer transition-all
                      hover:bg-secondary/80
                      ${selectedSkill?.id === skill.id ? 'ring-2 ring-primary' : ''}
                    `}
                    >
                      <div className="flex items-start justify-between mb-2">
                        <div className="flex-1 min-w-0">
                          <h3 className="text-sm font-medium text-foreground truncate">
                            {skill.name}
                          </h3>
                          <p className="text-xs text-muted-foreground">
                            {t('by')} {skill.author}
                          </p>
                        </div>
                        {isInstalled && (
                          <span className="text-xs text-green-500 px-1.5 py-0.5 bg-green-500/10 rounded flex items-center gap-1 shrink-0">
                            <Check className="w-3 h-3" />
                            {installedTargets.length}
                          </span>
                        )}
                      </div>

                      {/* 安装位置标签 */}
                      {isInstalled && (
                        <div className="flex flex-wrap gap-1 mb-2">
                          {installedTargets.map((target) => (
                            <span
                              key={target.key}
                              className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground bg-secondary/80 px-1.5 py-0.5 rounded"
                            >
                              {target.type === 'local' ? (
                                <Monitor className="w-2.5 h-2.5" />
                              ) : (
                                <Server className="w-2.5 h-2.5" />
                              )}
                              {target.name}
                            </span>
                          ))}
                        </div>
                      )}

                      <p className="text-xs text-muted-foreground line-clamp-2 mb-3">
                        {skill.description}
                      </p>

                      <div className="flex items-center justify-end">
                        <span className="text-xs text-muted-foreground mr-2">
                          {skill.installs?.toLocaleString()} {t('installs')}
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedSkill(skill);
                            setInstallOutputs([]);
                          }}
                          className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-primary hover:bg-primary/10 transition-colors"
                        >
                          {t('Details')}
                        </button>
                      </div>
                    </div>
                  );
                })}

                {/* 加载更多指示器 */}
                {loading && skills.length > 0 && (
                  <div className="col-span-full flex justify-center py-4">
                    <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                  </div>
                )}

                {/* 没有更多 */}
                {!hasMore && skills.length > 0 && (
                  <div className="col-span-full text-center py-4 text-xs text-muted-foreground">
                    {t('No more skills')}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* 右侧：技能详情 + 环境列表 + 终端输出 */}
        {selectedSkill && (
          <div className="w-96 border-l border-border flex flex-col">
            <div className="p-3 border-b border-border flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground">{t('Details')}</h2>
              <button
                onClick={() => {
                  setSelectedSkill(null);
                  setInstallOutputs([]);
                }}
                className="p-1 hover:bg-secondary rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 可滚动的详情区域 */}
            <div className="flex-1 overflow-y-auto">
              <div className="p-3 space-y-3">
                <div>
                  <h3 className="text-base font-semibold text-foreground">{selectedSkill.name}</h3>
                  <p className="text-xs text-muted-foreground">
                    {t('by')} {selectedSkill.author}
                  </p>
                </div>

                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  {selectedSkill.installs && (
                    <span>
                      {selectedSkill.installs.toLocaleString()} {t('installs')}
                    </span>
                  )}
                  <span>v{selectedSkill.version}</span>
                </div>

                <div>
                  <h4 className="text-xs font-medium text-foreground mb-1">{t('Description')}</h4>
                  <p className="text-xs text-muted-foreground">{selectedSkill.description}</p>
                </div>

                {selectedSkill.fullDescription && (
                  <div>
                    <h4 className="text-xs font-medium text-foreground mb-1">
                      {t('Full Description')}
                    </h4>
                    <div
                      className="text-xs text-muted-foreground prose prose-sm max-w-none"
                      dangerouslySetInnerHTML={{
                        __html: selectedSkill.fullDescription.slice(0, 1000) + '...',
                      }}
                    />
                  </div>
                )}

                {selectedSkill.tags && selectedSkill.tags.length > 0 && (
                  <div>
                    <h4 className="text-xs font-medium text-foreground mb-1">{t('Tags')}</h4>
                    <div className="flex flex-wrap gap-1">
                      {selectedSkill.tags.map((tag) => (
                        <span key={tag} className="text-xs px-2 py-0.5 bg-accent/50 rounded">
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {selectedSkill.remoteRepo && (
                  <a
                    href={
                      selectedSkill.sourceId?.startsWith('gitcode:')
                        ? `https://gitcode.com/${selectedSkill.remoteRepo}`
                        : `https://github.com/${selectedSkill.remoteRepo}`
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-xs text-primary hover:text-primary/80"
                  >
                    <ExternalLink className="w-3 h-3" />
                    {selectedSkill.sourceId?.startsWith('gitcode:')
                      ? t('View on GitCode')
                      : t('View on GitHub')}
                  </a>
                )}

                {/* 环境安装状态 */}
                <div className="pt-3 border-t border-border">
                  <h4 className="text-xs font-medium text-foreground mb-2">
                    {t('Environments')}
                    <span className="text-muted-foreground font-normal ml-1">
                      ({envStatuses.length})
                    </span>
                  </h4>
                  <div className="space-y-1">
                    {/* 已安装的环境 */}
                    {installedEnvs.length > 0 && (
                      <>
                        <div className="text-[10px] text-green-500 font-medium uppercase tracking-wider px-2 pt-1 pb-0.5">
                          {t('Installed')} ({installedEnvs.length})
                        </div>
                        {installedEnvs.map((env) => renderEnvRow(env, selectedSkill))}
                      </>
                    )}

                    {/* 未安装的环境 */}
                    {notInstalledEnvs.length > 0 && (
                      <>
                        {installedEnvs.length > 0 && <div className="h-2" />}
                        <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider px-2 pt-1 pb-0.5">
                          {t('Not Installed')} ({notInstalledEnvs.length})
                        </div>
                        {notInstalledEnvs.map((env) => renderEnvRow(env, selectedSkill))}
                      </>
                    )}

                    {envStatuses.length === 0 && (
                      <div className="text-xs text-muted-foreground text-center py-4">
                        {t('No environments available')}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* 终端输出区域 */}
            {installOutputs.length > 0 && (
              <div className="border-t border-border flex flex-col min-h-[200px] max-h-[300px]">
                {/* 输出标签页 */}
                {activeOutputTabs.length > 1 && (
                  <div className="flex border-b border-border bg-secondary/30 overflow-x-auto">
                    {activeOutputTabs.map((key) => (
                      <button
                        key={key}
                        onClick={() => setActiveOutputTab(key)}
                        className={`
                        flex items-center gap-1 px-3 py-1.5 text-xs whitespace-nowrap transition-colors
                        ${
                          activeOutputTab === key
                            ? 'text-foreground border-b-2 border-primary bg-secondary/50'
                            : 'text-muted-foreground hover:text-foreground'
                        }
                      `}
                      >
                        {getTargetIcon(key)}
                        {getTargetName(key)}
                      </button>
                    ))}
                  </div>
                )}
                <div className="px-3 py-1.5 border-b border-border flex items-center gap-2 bg-secondary/50">
                  <Terminal className="w-4 h-4 text-muted-foreground" />
                  <span className="text-xs font-medium text-foreground">
                    {t('Terminal Output')}
                    {activeOutputTabs.length > 0 && (
                      <span className="text-muted-foreground ml-1">
                        - {getTargetName(activeOutputTab)}
                      </span>
                    )}
                  </span>
                </div>
                <div
                  ref={(el) => {
                    outputRefs.current[activeOutputTab] = el;
                  }}
                  className="flex-1 overflow-y-auto bg-black p-3 font-mono text-xs leading-relaxed"
                >
                  {filteredOutputs.map((output, index) => (
                    <div
                      key={index}
                      className={`whitespace-pre-wrap ${
                        output.type === 'stderr' || output.type === 'error'
                          ? 'text-red-400'
                          : output.type === 'complete'
                            ? 'text-green-400'
                            : 'text-green-400'
                      }`}
                    >
                      {output.content}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 源管理面板 */}
        {showSourcePanel && (
          <div className="fixed inset-0 z-50 flex justify-end">
            <div
              className="absolute inset-0 bg-black/30"
              onClick={() => setShowSourcePanel(false)}
            />
            <div className="relative w-96 bg-background border-l border-border flex flex-col z-10">
              <div className="p-4 border-b border-border flex items-center justify-between">
                <h2 className="text-sm font-semibold text-foreground">{t('Manage Sources')}</h2>
                <button
                  onClick={() => setShowSourcePanel(false)}
                  className="p-1 hover:bg-secondary rounded"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {/* 已有源列表 */}
                <div className="space-y-2">
                  <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    {t('Sources')}
                  </h3>
                  {marketSources.map((source) => (
                    <div
                      key={source.id}
                      className="flex items-center gap-2 p-2 rounded-lg bg-secondary/50"
                    >
                      {source.type === 'github' ? (
                        <Github className="w-4 h-4 shrink-0" />
                      ) : source.type === 'gitcode' ? (
                        <Globe className="w-4 h-4 shrink-0" />
                      ) : (
                        <Store className="w-4 h-4 shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-foreground truncate">
                          {source.name}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">{source.url}</div>
                      </div>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                          source.type === 'builtin'
                            ? 'bg-blue-500/10 text-blue-500'
                            : source.type === 'github'
                              ? 'bg-purple-500/10 text-purple-500'
                              : source.type === 'gitcode'
                                ? 'bg-orange-500/10 text-orange-500'
                                : 'bg-green-500/10 text-green-500'
                        }`}
                      >
                        {source.type === 'github'
                          ? 'GitHub'
                          : source.type === 'gitcode'
                            ? 'GitCode'
                            : source.type === 'builtin'
                              ? t('Built-in')
                              : source.type}
                      </span>
                      {source.type !== 'builtin' && (
                        <button
                          onClick={async () => {
                            await removeMarketSource(source.id);
                          }}
                          className="p-1 text-muted-foreground hover:text-red-500 transition-colors"
                          title={t('Remove')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                {/* 添加 GitHub / GitCode 源 */}
                <div className="space-y-2">
                  <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    <span className="flex items-center gap-1">
                      <Github className="w-3 h-3" />
                      {t('Add Git Source')}
                    </span>
                  </h3>
                  <div className="space-y-2">
                    <input
                      type="text"
                      placeholder={t(
                        'https://github.com/owner/repo or https://gitcode.com/owner/repo',
                      )}
                      value={newRepoUrl}
                      onChange={(e) => {
                        setNewRepoUrl(e.target.value);
                        setValidationResult(null);
                      }}
                      className="w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />

                    {/* 校验 + 添加按钮 */}
                    <div className="flex items-center gap-2">
                      <button
                        onClick={async () => {
                          const githubMatch = newRepoUrl.match(/github\.com\/([^/]+\/[^/]+)/);
                          const gitcodeMatch = newRepoUrl.match(/gitcode\.com\/([^/]+\/[^/]+)/);
                          const repo = (githubMatch || gitcodeMatch)?.[1].replace(/\.git$/, '');
                          if (!repo) return;
                          setValidating(true);
                          try {
                            let result;
                            if (gitcodeMatch) {
                              result = await validateGitCodeRepo(repo);
                            } else {
                              result = await validateGitHubRepo(repo);
                            }
                            setValidationResult(
                              result || { valid: false, hasSkillsDir: false, skillCount: 0 },
                            );
                          } catch {
                            setValidationResult({
                              valid: false,
                              hasSkillsDir: false,
                              skillCount: 0,
                              error: t('Validation failed'),
                            });
                          }
                          setValidating(false);
                        }}
                        disabled={
                          (!newRepoUrl.includes('github.com') &&
                            !newRepoUrl.includes('gitcode.com')) ||
                          validating
                        }
                        className="flex items-center gap-1 px-3 py-1.5 rounded text-xs font-medium bg-secondary text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50"
                      >
                        {validating ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Check className="w-3 h-3" />
                        )}
                        {t('Validate')}
                      </button>
                      <button
                        onClick={async () => {
                          if (
                            !newRepoUrl.includes('github.com') &&
                            !newRepoUrl.includes('gitcode.com')
                          )
                            return;
                          setAddingSource(true);
                          try {
                            const { addGitHubSource } = useSkillStore.getState();
                            const success = await addGitHubSource(newRepoUrl);
                            if (success) {
                              setNewRepoUrl('');
                              setValidationResult(null);
                              setShowSourcePanel(false);
                              const sources = useSkillStore.getState().marketSources;
                              const newSource = sources[sources.length - 1];
                              if (newSource) {
                                await setActiveMarketSource(newSource.id);
                              }
                              setSkills([]);
                              setPage(1);
                              setHasMore(true);
                              loadSkills(1, true);
                            }
                          } finally {
                            setAddingSource(false);
                          }
                        }}
                        disabled={
                          (!newRepoUrl.includes('github.com') &&
                            !newRepoUrl.includes('gitcode.com')) ||
                          addingSource
                        }
                        className="flex items-center gap-1 px-3 py-1.5 rounded text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                      >
                        {addingSource ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Plus className="w-3 h-3" />
                        )}
                        {addingSource ? t('Adding...') : t('Add')}
                      </button>
                    </div>

                    {/* 校验结果 */}
                    {validationResult && (
                      <div
                        className={`text-xs p-2 rounded ${validationResult.valid ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`}
                      >
                        {validationResult.valid ? (
                          <span>
                            {t('Valid repository')} - {validationResult.skillCount}{' '}
                            {t('skills found')}
                            {validationResult.hasSkillsDir && ` (${t('skills/ directory')})`}
                          </span>
                        ) : (
                          <span>
                            {validationResult.error || t('Invalid or inaccessible repository')}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
