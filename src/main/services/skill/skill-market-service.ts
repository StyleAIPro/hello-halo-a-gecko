/**
 * Skill Market Service - 技能市场服务
 *
 * 支持多种技能来源：
 * - builtin (skills.sh)
 * - github (用户指定的 GitHub 仓库)
 * - custom (自定义源)
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { BrowserWindow } from 'electron';
import type {
  RemoteSkillItem,
  SkillMarketSource,
  SkillMarketConfig,
} from '../../shared/skill/skill-types';
import { getAgentsSkillsDir } from '../config.service';
import { proxyFetch } from '../proxy';
import { invalidateProxyCache } from '../proxy';
import * as githubSkillSource from './github-skill-source.service';
import * as gitcodeSkillSource from './gitcode-skill-source.service';

// 唯一的市场源
const BUILTIN_SOURCES: SkillMarketSource[] = [
  {
    id: 'skills.sh',
    name: 'Skills.sh',
    type: 'builtin',
    url: 'https://skills.sh',
    enabled: true,
    icon: '🚀',
    description: "Vercel's open agent skills ecosystem",
  },
];

export class SkillMarketService {
  private static instance: SkillMarketService;
  private configPath: string;
  private config: SkillMarketConfig;

  // 技能缓存：源ID -> 技能列表
  private skillsCache: Map<string, RemoteSkillItem[]> = new Map();

  private constructor() {
    this.configPath = path.join(getAgentsSkillsDir(), '..', 'skill-market-config.json');
    this.config = {
      sources: [...BUILTIN_SOURCES],
      activeSourceId: 'skills.sh',
    };
  }

  static getInstance(): SkillMarketService {
    if (!SkillMarketService.instance) {
      SkillMarketService.instance = new SkillMarketService();
    }
    return SkillMarketService.instance;
  }

  /**
   * 初始化服务
   */
  async initialize(): Promise<void> {
    await this.loadConfig();
  }

  /**
   * 加载配置
   */
  private async loadConfig(): Promise<void> {
    try {
      const content = await fs.readFile(this.configPath, 'utf-8');
      const savedConfig = JSON.parse(content) as Partial<SkillMarketConfig>;

      // 合并内置源和保存的自定义源
      const customSources = (savedConfig.sources || []).filter(
        (s) => s.type === 'custom' || s.type === 'github' || s.type === 'gitcode',
      );
      const builtinIds = new Set(BUILTIN_SOURCES.map((s) => s.id));

      // 更新内置源的启用状态
      const updatedBuiltinSources = BUILTIN_SOURCES.map((source) => {
        const saved = (savedConfig.sources || []).find((s) => s.id === source.id);
        return saved ? { ...source, enabled: saved.enabled } : source;
      });

      this.config = {
        sources: [...updatedBuiltinSources, ...customSources.filter((s) => !builtinIds.has(s.id))],
        activeSourceId: savedConfig.activeSourceId || 'skills.sh',
      };
    } catch {
      // 配置文件不存在，使用默认配置
      await this.saveConfig();
    }
  }

  /**
   * 保存配置
   */
  private async saveConfig(): Promise<void> {
    try {
      await fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (error) {
      console.error('[SkillMarketService] Failed to save config:', error);
    }
  }

  /**
   * 获取所有市场源
   */
  getSources(): SkillMarketSource[] {
    return this.config.sources;
  }

  /**
   * 获取当前选中的源 ID
   */
  getActiveSourceId(): string {
    return this.config.activeSourceId;
  }

  /**
   * 获取当前选中的源
   */
  getActiveSource(): SkillMarketSource | undefined {
    return this.config.sources.find((s) => s.id === this.config.activeSourceId);
  }

  /**
   * 设置当前选中的源
   */
  async setActiveSource(sourceId: string): Promise<void> {
    if (this.config.sources.find((s) => s.id === sourceId)) {
      this.config.activeSourceId = sourceId;
      await this.saveConfig();
    }
  }

  /**
   * 切换源的启用状态
   */
  async toggleSource(sourceId: string, enabled: boolean): Promise<void> {
    const source = this.config.sources.find((s) => s.id === sourceId);
    if (source) {
      source.enabled = enabled;
      await this.saveConfig();
    }
  }

  /**
   * 添加自定义源或 GitHub 源
   * 如果 URL 匹配 GitHub 仓库格式，自动设为 github 类型
   */
  async addSource(
    source: Omit<SkillMarketSource, 'id' | 'type'> & {
      repos?: string[];
      type?: 'custom' | 'github' | 'gitcode';
    },
  ): Promise<SkillMarketSource> {
    const id = source.url
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 20);

    // Auto-detect GitHub or GitCode source from URL
    let sourceType: 'custom' | 'github' | 'gitcode' = source.type || 'custom';
    let repos = source.repos;

    const githubMatch = source.url.match(/github\.com\/([^/]+\/[^/]+)/);
    if (githubMatch && !source.type) {
      sourceType = 'github';
      repos = repos || [githubMatch[1].replace(/\.git$/, '')];
    }

    const gitcodeMatch = source.url.match(/gitcode\.com\/([^/]+\/[^/]+)/);
    if (gitcodeMatch && !source.type) {
      sourceType = 'gitcode';
      repos = repos || [gitcodeMatch[1].replace(/\.git$/, '')];
    }

    const newSource: SkillMarketSource = {
      ...source,
      id:
        sourceType === 'github'
          ? `github-${id}-${Date.now()}`
          : sourceType === 'gitcode'
            ? `gitcode-${id}-${Date.now()}`
            : `custom-${id}-${Date.now()}`,
      type: sourceType,
      repos,
      enabled: true,
    };

    this.config.sources.push(newSource);
    await this.saveConfig();
    return newSource;
  }

  /**
   * 移除自定义源或 GitHub 源
   */
  async removeSource(sourceId: string): Promise<boolean> {
    const index = this.config.sources.findIndex(
      (s) =>
        s.id === sourceId && (s.type === 'custom' || s.type === 'github' || s.type === 'gitcode'),
    );
    if (index !== -1) {
      this.config.sources.splice(index, 1);
      await this.saveConfig();
      return true;
    }
    return false;
  }

  /**
   * 获取技能列表（支持无限滚动）
   * 根据当前活跃源类型分发到不同的获取逻辑
   */
  async getSkills(
    page: number = 1,
    pageSize: number = 20,
  ): Promise<{ skills: RemoteSkillItem[]; total: number; hasMore: boolean }> {
    console.log('[SkillMarketService] getSkills called:', { page, pageSize });

    const activeSource = this.getActiveSource();
    const sourceType = activeSource?.type || 'builtin';

    if (sourceType === 'github') {
      return await this.fetchFromGitHubRepo(activeSource!, page, pageSize);
    }

    if (sourceType === 'gitcode') {
      return await this.fetchFromGitCodeRepo(activeSource!, page, pageSize);
    }

    // Default: skills.sh
    return await this.fetchFromSkillsShWithInfiniteScroll(page, pageSize);
  }

  /**
   * 重置缓存（切换源或刷新时调用）
   */
  resetCache(sourceId?: string): void {
    if (sourceId) {
      this.skillsCache.delete(sourceId);
    } else {
      this.skillsCache.clear();
    }
    console.log('[SkillMarketService] Cache reset for:', sourceId || 'all');
  }

  /**
   * Find a skill in cache by ID to retrieve original-case remotePath.
   * IDs contain lowercased paths, but cache preserves original casing.
   */
  private findSkillInCache(skillId: string): RemoteSkillItem | null {
    for (const skills of this.skillsCache.values()) {
      const found = skills.find((s) => s.id === skillId);
      if (found) return found;
    }
    return null;
  }

  /**
   * 从 skills.sh 获取技能（按下载量排序）
   * 直接爬取网站首页，获取按下载量排序的技能列表
   */
  private async fetchFromSkillsShWithInfiniteScroll(
    page: number = 1,
    pageSize: number = 20,
  ): Promise<{ skills: RemoteSkillItem[]; total: number; hasMore: boolean }> {
    const sourceId = 'skills.sh';
    const offset = (page - 1) * pageSize;

    // 获取或初始化缓存
    let cachedSkills = this.skillsCache.get(sourceId) || [];

    // 如果缓存为空，从首页爬取
    if (cachedSkills.length === 0) {
      console.log('[SkillMarketService] Fetching skills from skills.sh homepage');
      cachedSkills = await this.fetchFromSkillsShHomepage();
      this.skillsCache.set(sourceId, cachedSkills);
      console.log(`[SkillMarketService] Cached ${cachedSkills.length} skills from homepage`);
    }

    // 从缓存中分页
    const total = cachedSkills.length;
    const hasMore = offset + pageSize < total;
    const skills = cachedSkills.slice(offset, offset + pageSize);

    console.log(
      `[SkillMarketService] Returning ${skills.length} skills, total: ${total}, hasMore: ${hasMore}`,
    );

    return { skills, total, hasMore };
  }

  /**
   * 从 skills.sh 首页爬取按下载量排序的技能列表
   */
  private async fetchFromSkillsShHomepage(): Promise<RemoteSkillItem[]> {
    try {
      const response = await proxyFetch('https://skills.sh', {
        headers: {
          Accept: 'text/html',
          'User-Agent': 'AICO-Bot-App',
        },
      });

      if (!response.ok) {
        console.error('[SkillMarketService] skills.sh homepage error:', response.status);
        return [];
      }

      const html = await response.text();
      return this.parseSkillsFromHTML(html);
    } catch (error) {
      console.error('[SkillMarketService] Failed to fetch skills.sh homepage:', error);
      return [];
    }
  }

  /**
   * 从 HTML 中解析技能列表
   */
  private parseSkillsFromHTML(html: string): RemoteSkillItem[] {
    const skills: RemoteSkillItem[] = [];

    // 匹配技能卡片的正则表达式
    // 使用特定的类名来精确定位技能卡片：grid grid-cols-[auto_1fr_auto]
    // 格式：<a ... grid grid-cols-[auto_1fr_auto] ... href="/owner/repo/skillId">...<rank>...<name>...<source>...<installs>...</a>
    const cardPattern =
      /<a[^>]*grid grid-cols-\[auto_1fr_auto\][^>]*href="\/([^/]+)\/([^/]+)\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;

    let match: RegExpExecArray | null;
    while ((match = cardPattern.exec(html)) !== null) {
      const [, owner, repo, skillId, content] = match;

      // 提取排名
      const rankMatch = content.match(/font-mono[^>]*>\s*(\d+)\s*<\/span>/);
      if (!rankMatch) continue;

      // 提取技能名称
      const nameMatch = content.match(/<h3[^>]*>\s*([^<]+)\s*<\/h3>/);
      if (!nameMatch) continue;
      const skillName = nameMatch[1].trim();

      // 提取来源
      const sourceMatch = content.match(/<p[^>]*>\s*([^<]+)\s*<\/p>/);
      const source = sourceMatch ? sourceMatch[1].trim() : `${owner}/${repo}`;

      // 提取下载量（最后一个 font-mono span）
      const installsMatches = content.matchAll(/font-mono[^>]*>\s*([\d.]+[KMB]?)\s*<\/span>/g);
      const installsArray = Array.from(installsMatches, (m) => m[1]);
      const installsStr = installsArray.length > 0 ? installsArray[installsArray.length - 1] : '0';

      // 解析下载量（转换为数字）
      let installs = 0;
      if (installsStr) {
        const num = parseFloat(
          installsStr.replace(/[KMB]/g, (m: string) => {
            if (m === 'K') return 'e3';
            if (m === 'M') return 'e6';
            if (m === 'B') return 'e9';
            return '';
          }),
        );
        installs = Math.floor(num);
      }

      skills.push({
        id: `skills.sh:${owner}/${repo}/${skillId}`,
        name: this.formatSkillName(skillId),
        description: `Skill from ${source}`,
        version: '1.0.0',
        author: owner,
        tags: [],
        installs,
        lastUpdated: new Date().toISOString(),
        sourceId: 'skills.sh',
        remoteRepo: `${owner}/${repo}`,
        remotePath: `skills/${skillId}`,
        skillContent: undefined,
      });
    }

    console.log('[SkillMarketService] Parsed', skills.length, 'skills from HTML');
    return skills;
  }

  /**
   * 从 skills.sh API 获取原始数据
   */
  private async fetchFromSkillsShAPI(searchTerm: string): Promise<RemoteSkillItem[]> {
    try {
      const limit = 50;
      const url = `https://skills.sh/api/search?q=${encodeURIComponent(searchTerm)}&limit=${limit}`;
      console.log('[SkillMarketService] Fetching from skills.sh API:', url);

      const response = await proxyFetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'AICO-Bot-App',
        },
      });

      if (!response.ok) {
        console.error('[SkillMarketService] skills.sh API error:', response.status);
        return [];
      }

      const data = (await response.json()) as {
        skills: Array<{
          id: string;
          skillId: string;
          name: string;
          installs: number;
          source: string;
        }>;
        count: number;
      };

      console.log('[SkillMarketService] skills.sh API returned:', data.skills.length, 'skills');

      return data.skills.map((skill) => {
        const sourceParts = skill.source.split('/');
        const author = sourceParts[0] || 'Unknown';
        const skillName = skill.skillId || skill.name;

        return {
          id: `skills.sh:${skill.id}`,
          name: this.formatSkillName(skillName),
          description: `Skill from ${skill.source}`,
          version: '1.0.0',
          author: author,
          tags: [],
          installs: skill.installs,
          lastUpdated: new Date().toISOString(),
          sourceId: 'skills.sh',
          remoteRepo: skill.source,
          remotePath: `skills/${skillName}`,
          skillContent: undefined,
        };
      });
    } catch (error) {
      console.error('[SkillMarketService] Failed to fetch from skills.sh:', error);
      return [];
    }
  }

  /**
   * 搜索技能（支持分页）
   * GitHub 源使用客户端过滤
   */
  async searchSkills(
    query: string,
    page: number = 1,
    pageSize: number = 20,
  ): Promise<{ skills: RemoteSkillItem[]; total: number; hasMore: boolean }> {
    console.log('[SkillMarketService] searchSkills called:', { query, page, pageSize });

    const activeSource = this.getActiveSource();
    const sourceType = activeSource?.type || 'builtin';

    if (sourceType === 'github') {
      return await this.searchGitHubRepo(activeSource!, query, page, pageSize);
    }

    if (sourceType === 'gitcode') {
      return await this.searchGitCodeRepo(activeSource!, query, page, pageSize);
    }

    // Default: skills.sh API search
    const searchCacheKey = `search:${query}`;

    // 检查是否有缓存
    let cachedSkills = this.skillsCache.get(searchCacheKey);

    if (!cachedSkills) {
      // 从 API 获取
      console.log('[SkillMarketService] Searching skills.sh with query:', query);
      cachedSkills = await this.fetchFromSkillsShAPI(query);
      this.skillsCache.set(searchCacheKey, cachedSkills);
    }

    // 分页
    const offset = (page - 1) * pageSize;
    const total = cachedSkills.length;
    const hasMore = offset + pageSize < total;

    // 按下载量从高到低排序
    const sortedSkills = [...cachedSkills].sort((a, b) => (b.installs || 0) - (a.installs || 0));
    const skills = sortedSkills.slice(offset, offset + pageSize);

    return { skills, total, hasMore };
  }

  /**
   * 获取技能详情
   * 支持 skills.sh: 和 github: 前缀的 ID
   */
  async getSkillDetail(skillId: string): Promise<RemoteSkillItem | null> {
    console.log('[SkillMarketService] getSkillDetail called:', skillId);

    // GitHub source: ID format "github:owner/repo:full/path/to/skill"
    if (skillId.startsWith('github:')) {
      const parts = skillId.split(':');
      if (parts.length >= 3) {
        const repo = parts[1];
        // Resolve original-case remotePath from cache (ID has lowercased path)
        let skillPath = parts.slice(2).join(':');
        const cachedItem = this.findSkillInCache(skillId);
        if (cachedItem?.remotePath) {
          skillPath = cachedItem.remotePath;
        }
        const token = githubSkillSource.getGitHubToken();
        return githubSkillSource.getSkillDetailFromRepo(repo, skillPath, token);
      }
      return null;
    }

    // GitCode source: ID format "gitcode:owner/repo:full/path/to/skill"
    if (skillId.startsWith('gitcode:')) {
      const parts = skillId.split(':');
      if (parts.length >= 3) {
        const repo = parts[1];
        let skillPath = parts.slice(2).join(':');
        console.log('[SkillMarket] getSkillDetail GitCode:', {
          skillId,
          repo,
          rawSkillPath: skillPath,
        });
        const cachedItem = this.findSkillInCache(skillId);
        if (cachedItem?.remotePath) {
          skillPath = cachedItem.remotePath;
          console.log('[SkillMarket] getSkillDetail: cache hit, path =', skillPath);
        } else {
          // Cache miss: skillId path is lowercased, but GitCode API is case-sensitive.
          // Use findSkillDirsViaContents to resolve the original-case path.
          console.log('[SkillMarket] getSkillDetail: cache miss, resolving case-sensitive path...');
          try {
            const token = gitcodeSkillSource.getGitCodeToken();
            const allDirs = await gitcodeSkillSource.findSkillDirsViaContents(repo, token);
            console.log('[SkillMarket] getSkillDetail: found', allDirs.length, 'skill dirs');
            const normalized = skillPath.toLowerCase();
            const match = allDirs.find(
              (d) =>
                d.path.toLowerCase() === normalized ||
                d.path.toLowerCase().endsWith(`/${normalized}`),
            );
            if (match) {
              skillPath = match.path;
              console.log('[SkillMarket] getSkillDetail: resolved path =', skillPath);
            } else {
              console.warn(
                '[SkillMarket] getSkillDetail: could not resolve path for',
                skillId,
                '(normalized:',
                normalized,
                ')',
              );
            }
          } catch (e: any) {
            console.warn('[SkillMarket] getSkillDetail: path resolution failed:', e.message);
          }
        }
        const token = gitcodeSkillSource.getGitCodeToken();
        console.log('[SkillMarket] getSkillDetail: calling getSkillDetailFromRepo with', {
          repo,
          skillPath,
        });
        return gitcodeSkillSource.getSkillDetailFromRepo(repo, skillPath, token);
      }
      return null;
    }

    // skills.sh source: ID format "skills.sh:owner/repo/skillName"
    if (skillId.startsWith('skills.sh:')) {
      const id = skillId.substring('skills.sh:'.length);
      const parts = id.split('/');

      if (parts.length >= 3) {
        const skillName = parts[parts.length - 1];
        const repo = parts.slice(0, parts.length - 1).join('/');
        const author = parts[0];

        const skill: RemoteSkillItem = {
          id: skillId,
          name: this.formatSkillName(skillName),
          description: `Skill from ${repo}`,
          version: '1.0.0',
          author: author,
          tags: [],
          lastUpdated: new Date().toISOString(),
          sourceId: 'skills.sh',
          remoteRepo: repo,
          remotePath: `skills/${skillName}`,
        };

        // 从 GitHub 获取内容
        try {
          const content = await this.fetchSkillContent(repo, `skills/${skillName}`);
          if (content) {
            skill.fullDescription = content;
            skill.skillContent = content;
            // 提取第一段作为描述
            const lines = content
              .split('\n')
              .filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('---'));
            if (lines.length > 0) {
              skill.description = lines[0].substring(0, 150);
            }
          }
        } catch (error) {
          console.error('[SkillMarketService] Failed to fetch skill content:', error);
        }

        return skill;
      }
    }

    return null;
  }

  /**
   * 下载技能并返回安装信息（仓库路径和技能名称）
   */
  async downloadSkill(
    skillId: string,
    onOutput?: (data: { type: 'stdout' | 'stderr'; content: string }) => void,
  ): Promise<{
    success: boolean;
    remoteRepo?: string;
    skillName?: string;
    sourceType: 'github' | 'gitcode' | 'skills.sh';
    error?: string;
  }> {
    // Determine source type from skillId prefix first (always correct)
    let sourceType: 'github' | 'gitcode' | 'skills.sh' = 'skills.sh';
    if (skillId.startsWith('github:')) {
      sourceType = 'github';
    } else if (skillId.startsWith('gitcode:')) {
      sourceType = 'gitcode';
    }

    onOutput?.({ type: 'stdout', content: '  Resolving skill metadata...\n' });
    console.log('[SkillMarketService] downloadSkill: calling getSkillDetail for', skillId);
    const skill = await this.getSkillDetail(skillId);
    console.log(
      '[SkillMarketService] downloadSkill: getSkillDetail returned',
      skill ? { remoteRepo: skill.remoteRepo, remotePath: skill.remotePath } : null,
    );

    if (!skill) {
      // getSkillDetail failed — try cache first to preserve original-case path
      const cachedItem = this.findSkillInCache(skillId);
      if (cachedItem?.remotePath && cachedItem?.remoteRepo) {
        onOutput?.({ type: 'stdout', content: '  Using cached skill path (API unavailable)\n' });
        const cachedSourceType: 'github' | 'gitcode' | 'skills.sh' = cachedItem.sourceId.startsWith(
          'gitcode:',
        )
          ? 'gitcode'
          : cachedItem.sourceId.startsWith('github:')
            ? 'github'
            : 'skills.sh';
        return {
          success: true,
          remoteRepo: cachedItem.remoteRepo,
          skillName: cachedItem.remotePath,
          sourceType: cachedSourceType || sourceType,
        };
      }
      // Fallback: extract repo/skillName from the ID (lowercase path)
      if (
        (skillId.startsWith('gitcode:') || skillId.startsWith('github:')) &&
        skillId.split(':').length >= 3
      ) {
        const parts = skillId.split(':');
        return {
          success: true,
          remoteRepo: parts[1],
          skillName: parts.slice(2).join(':'),
          sourceType,
        };
      }
      return { success: false, sourceType, error: 'Skill not found' };
    }

    // Use skill object's sourceId as secondary check
    if (skill.sourceId.startsWith('gitcode:')) {
      sourceType = 'gitcode';
    } else if (skill.sourceId.startsWith('github:')) {
      sourceType = 'github';
    }

    if (!skill.remoteRepo) {
      return { success: false, sourceType, error: 'No repo available' };
    }

    const result = {
      success: true,
      remoteRepo: skill.remoteRepo,
      skillName: skill.remotePath || skill.name.toLowerCase().replace(/\s+/g, '-'),
      sourceType,
    };
    console.log('[SkillMarketService] downloadSkill: returning', result);
    return result;
  }

  /**
   * 获取技能内容（SKILL.md 或 README.md）
   */
  async fetchSkillContent(repo: string, skillPath: string): Promise<string> {
    const lastSegment = skillPath.split('/').pop() || skillPath;

    // Build path variants, prioritizing the full skillPath
    const basePaths: string[] = [skillPath, `skills/${lastSegment}`, lastSegment];
    const branches = ['main', 'master'];

    for (const branch of branches) {
      for (const bp of basePaths) {
        try {
          const skillMdUrl = `https://raw.githubusercontent.com/${repo}/${branch}/${bp}/SKILL.md`;
          const response = await proxyFetch(skillMdUrl);
          if (response.ok) {
            return await response.text();
          }
        } catch {
          // continue
        }

        try {
          const readmeUrl = `https://raw.githubusercontent.com/${repo}/${branch}/${bp}/README.md`;
          const response = await proxyFetch(readmeUrl);
          if (response.ok) {
            return await response.text();
          }
        } catch {
          // continue
        }
      }
    }

    return '';
  }

  /**
   * 格式化技能名称
   */
  private formatSkillName(name: string): string {
    return name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // ── GitHub source specific methods ─────────────────────────────────

  /**
   * 从 GitHub 仓库获取技能列表（分页）
   */
  private async fetchFromGitHubRepo(
    source: SkillMarketSource,
    page: number,
    pageSize: number,
  ): Promise<{ skills: RemoteSkillItem[]; total: number; hasMore: boolean }> {
    const repos = source.repos || [];
    if (repos.length === 0) {
      return { skills: [], total: 0, hasMore: false };
    }

    const sourceId = source.id;
    const offset = (page - 1) * pageSize;

    let cachedSkills = this.skillsCache.get(sourceId);
    if (!cachedSkills) {
      cachedSkills = [];
      const token = await githubSkillSource.getGitHubToken();

      const sendProgress = (progress: { phase: string; current: number; total: number }) => {
        const mainWindow = BrowserWindow.getAllWindows()[0];
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('skill:market:fetch-progress', progress);
        }
      };

      for (const repo of repos) {
        try {
          const repoSkills = await githubSkillSource.listSkillsFromRepo(repo, token, sendProgress);
          cachedSkills.push(...repoSkills);
        } catch (error) {
          console.error(`[SkillMarketService] Failed to fetch from GitHub repo ${repo}:`, error);
        }
      }

      sendProgress({ phase: 'scanning', current: 0, total: 0 });
      this.skillsCache.set(sourceId, cachedSkills);
    }

    const total = cachedSkills.length;
    const hasMore = offset + pageSize < total;
    const skills = cachedSkills.slice(offset, offset + pageSize);
    return { skills, total, hasMore };
  }

  /**
   * 在 GitHub 仓库源中搜索技能（客户端过滤）
   */
  private async searchGitHubRepo(
    source: SkillMarketSource,
    query: string,
    page: number,
    pageSize: number,
  ): Promise<{ skills: RemoteSkillItem[]; total: number; hasMore: boolean }> {
    const searchCacheKey = `github-search:${source.id}:${query}`;
    let cachedSkills = this.skillsCache.get(searchCacheKey);

    if (!cachedSkills) {
      // Get all skills from the source cache
      const allSkills = this.skillsCache.get(source.id) || [];

      // If no skills cached yet, fetch them
      if (allSkills.length === 0) {
        await this.fetchFromGitHubRepo(source, 1, 999999);
      }

      const allCached = this.skillsCache.get(source.id) || [];
      const lowerQuery = query.toLowerCase();

      cachedSkills = allCached.filter(
        (skill) =>
          skill.name.toLowerCase().includes(lowerQuery) ||
          skill.description.toLowerCase().includes(lowerQuery) ||
          skill.author.toLowerCase().includes(lowerQuery) ||
          skill.tags?.some((tag) => tag.toLowerCase().includes(lowerQuery)),
      );

      this.skillsCache.set(searchCacheKey, cachedSkills);
    }

    const offset = (page - 1) * pageSize;
    const total = cachedSkills.length;
    const hasMore = offset + pageSize < total;
    const skills = cachedSkills.slice(offset, offset + pageSize);

    return { skills, total, hasMore };
  }

  /**
   * 从 GitCode 仓库源获取技能列表
   */
  private async fetchFromGitCodeRepo(
    source: SkillMarketSource,
    page: number,
    pageSize: number,
  ): Promise<{ skills: RemoteSkillItem[]; total: number; hasMore: boolean }> {
    const sourceId = source.id;
    const offset = (page - 1) * pageSize;
    const repos = source.repos || [];
    const token = gitcodeSkillSource.getGitCodeToken();

    let cachedSkills = this.skillsCache.get(sourceId);
    if (!cachedSkills) {
      invalidateProxyCache();

      cachedSkills = [];
      const errors: string[] = [];

      const sendProgress = (progress: { phase: string; current: number; total: number }) => {
        const mainWindow = BrowserWindow.getAllWindows()[0];
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('skill:market:fetch-progress', progress);
        }
      };

      for (const repo of repos) {
        try {
          const repoSkills = await gitcodeSkillSource.listSkillsFromRepo(repo, token, sendProgress);
          cachedSkills.push(...repoSkills);
        } catch (error: any) {
          const msg = error?.message || String(error);
          errors.push(`${repo}: ${msg}`);
          console.error(`[SkillMarketService] Failed to fetch from GitCode repo ${repo}:`, error);
        }
      }

      sendProgress({ phase: 'scanning', current: 0, total: 0 });

      if (cachedSkills.length > 0 || errors.length === 0) {
        this.skillsCache.set(sourceId, cachedSkills);
      }

      if (cachedSkills.length === 0 && errors.length > 0) {
        throw new Error(`Failed to fetch GitCode skills: ${errors.join('; ')}`);
      }
    }

    const total = cachedSkills.length;
    const hasMore = offset + pageSize < total;
    const skills = cachedSkills.slice(offset, offset + pageSize);
    return { skills, total, hasMore };
  }

  /**
   * 在 GitCode 仓库源中搜索技能（客户端过滤）
   */
  private async searchGitCodeRepo(
    source: SkillMarketSource,
    query: string,
    page: number,
    pageSize: number,
  ): Promise<{ skills: RemoteSkillItem[]; total: number; hasMore: boolean }> {
    const searchCacheKey = `gitcode-search:${source.id}:${query}`;
    let cachedSkills = this.skillsCache.get(searchCacheKey);

    if (!cachedSkills) {
      // Load all skills first
      const allResult = await this.fetchFromGitCodeRepo(source, 1, 999999);
      const allCached = allResult.skills;
      const lowerQuery = query.toLowerCase();

      cachedSkills = allCached.filter(
        (skill) =>
          skill.name.toLowerCase().includes(lowerQuery) ||
          skill.description.toLowerCase().includes(lowerQuery) ||
          skill.author.toLowerCase().includes(lowerQuery) ||
          skill.tags?.some((tag) => tag.toLowerCase().includes(lowerQuery)),
      );
      this.skillsCache.set(searchCacheKey, cachedSkills);
    }

    const offset = (page - 1) * pageSize;
    const total = cachedSkills.length;
    const hasMore = offset + pageSize < total;
    const skills = cachedSkills.slice(offset, offset + pageSize);
    return { skills, total, hasMore };
  }
}
