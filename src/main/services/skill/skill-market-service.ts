/**
 * Skill Market Service - 技能市场服务
 * 负责从多个源获取技能列表
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { RemoteSkillItem, SkillMarketSource, SkillMarketConfig } from '../../shared/skill/skill-types';
import { getAgentsSkillsDir } from '../config.service';

// 内置的市场源
const BUILTIN_SOURCES: SkillMarketSource[] = [
  {
    id: 'skills.sh',
    name: 'Skills.sh',
    type: 'builtin',
    url: 'https://skills.sh',
    enabled: true,
    icon: '🚀',
    description: 'Vercel\'s open agent skills ecosystem'
  },
  {
    id: 'anthropics',
    name: 'Anthropic Skills',
    type: 'github',
    url: 'https://github.com/anthropics/skills',
    enabled: true,
    icon: '🤖',
    description: 'Official Anthropic skills',
    repos: ['anthropics/skills']
  },
  {
    id: 'vercel-labs',
    name: 'Vercel Labs',
    type: 'github',
    url: 'https://github.com/vercel-labs/agent-skills',
    enabled: true,
    icon: '▲',
    description: 'Vercel agent skills collection',
    repos: ['vercel-labs/agent-skills', 'vercel-labs/skills']
  }
];

// 用于无限滚动的搜索词列表（当 API 不支持分页时使用）
const SEARCH_TERMS = [
  'skill',        // 默认/首次加载
  'react',        // React 相关
  'typescript',   // TypeScript
  'node',         // Node.js
  'python',       // Python
  'api',          // API 相关
  'test',         // 测试
  'git',          // Git
  'database',     // 数据库
  'deploy',       // 部署
  'security',     // 安全
  'performance',  // 性能
  'docker',       // Docker
  'nextjs',       // Next.js
  'design',       // 设计
];

export class SkillMarketService {
  private static instance: SkillMarketService;
  private configPath: string;
  private config: SkillMarketConfig;

  // 技能缓存：源ID -> 技能列表
  private skillsCache: Map<string, RemoteSkillItem[]> = new Map();
  // 已加载的搜索词索引：源ID -> 当前搜索词索引
  private searchTermIndex: Map<string, number> = new Map();
  // 当前搜索查询（用于重置）
  private currentSearchQuery: string = '';

  private constructor() {
    this.configPath = path.join(getAgentsSkillsDir(), '..', 'skill-market-config.json');
    this.config = {
      sources: [...BUILTIN_SOURCES],
      activeSourceId: 'skills.sh'
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
      const customSources = (savedConfig.sources || []).filter(s => s.type === 'custom' || s.type === 'github');
      const builtinIds = new Set(BUILTIN_SOURCES.map(s => s.id));

      // 更新内置源的启用状态
      const updatedBuiltinSources = BUILTIN_SOURCES.map(source => {
        const saved = (savedConfig.sources || []).find(s => s.id === source.id);
        return saved ? { ...source, enabled: saved.enabled } : source;
      });

      this.config = {
        sources: [...updatedBuiltinSources, ...customSources.filter(s => !builtinIds.has(s.id))],
        activeSourceId: savedConfig.activeSourceId || 'skills.sh'
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
   * 获取当前选中的源
   */
  getActiveSource(): SkillMarketSource | undefined {
    return this.config.sources.find(s => s.id === this.config.activeSourceId);
  }

  /**
   * 设置当前选中的源
   */
  async setActiveSource(sourceId: string): Promise<void> {
    if (this.config.sources.find(s => s.id === sourceId)) {
      this.config.activeSourceId = sourceId;
      await this.saveConfig();
    }
  }

  /**
   * 切换源的启用状态
   */
  async toggleSource(sourceId: string, enabled: boolean): Promise<void> {
    const source = this.config.sources.find(s => s.id === sourceId);
    if (source) {
      source.enabled = enabled;
      await this.saveConfig();
    }
  }

  /**
   * 添加自定义源
   */
  async addSource(source: Omit<SkillMarketSource, 'id' | 'type'> & { repos?: string[] }): Promise<SkillMarketSource> {
    const id = source.url.toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 20);

    const newSource: SkillMarketSource = {
      ...source,
      id: `custom-${id}-${Date.now()}`,
      type: 'custom',
      enabled: true
    };

    this.config.sources.push(newSource);
    await this.saveConfig();
    return newSource;
  }

  /**
   * 移除自定义源
   */
  async removeSource(sourceId: string): Promise<boolean> {
    const index = this.config.sources.findIndex(s => s.id === sourceId && s.type === 'custom');
    if (index !== -1) {
      this.config.sources.splice(index, 1);
      await this.saveConfig();
      return true;
    }
    return false;
  }

  /**
   * 获取技能列表（支持无限滚动）
   */
  async getSkills(sourceId?: string, page: number = 1, pageSize: number = 20): Promise<{ skills: RemoteSkillItem[]; total: number; hasMore: boolean }> {
    console.log('[SkillMarketService] getSkills called:', { sourceId, page, pageSize });
    const targetSourceId = sourceId || this.config.activeSourceId;
    const source = this.config.sources.find(s => s.id === targetSourceId);

    if (!source || !source.enabled) {
      console.log('[SkillMarketService] Source not found or disabled:', targetSourceId);
      return { skills: [], total: 0, hasMore: false };
    }

    try {
      switch (source.id) {
        case 'skills.sh':
          return await this.fetchFromSkillsShWithInfiniteScroll(page, pageSize);
        case 'anthropics':
        case 'vercel-labs':
          return await this.fetchFromGitHubPaginated(source.repos || [], source.id, page, pageSize);
        default:
          if (source.type === 'github' || source.type === 'custom') {
            return await this.fetchFromGitHubPaginated(source.repos || [], source.id, page, pageSize);
          }
          return { skills: [], total: 0, hasMore: false };
      }
    } catch (error) {
      console.error('[SkillMarketService] getSkills error:', error);
      return { skills: [], total: 0, hasMore: false };
    }
  }

  /**
   * 重置缓存（切换源或刷新时调用）
   */
  resetCache(sourceId?: string): void {
    if (sourceId) {
      this.skillsCache.delete(sourceId);
      this.searchTermIndex.delete(sourceId);
    } else {
      this.skillsCache.clear();
      this.searchTermIndex.clear();
    }
    this.currentSearchQuery = '';
    console.log('[SkillMarketService] Cache reset for:', sourceId || 'all');
  }

  /**
   * 从 skills.sh 获取技能（无限滚动）
   * 使用不同的搜索词来获取更多结果
   */
  private async fetchFromSkillsShWithInfiniteScroll(
    page: number = 1,
    pageSize: number = 20
  ): Promise<{ skills: RemoteSkillItem[]; total: number; hasMore: boolean }> {
    const sourceId = 'skills.sh';
    const offset = (page - 1) * pageSize;

    // 获取或初始化缓存
    let cachedSkills = this.skillsCache.get(sourceId) || [];
    let termIndex = this.searchTermIndex.get(sourceId) || 0;

    // 如果缓存不够，尝试从 API 加载更多
    while (cachedSkills.length < offset + pageSize && termIndex < SEARCH_TERMS.length) {
      const searchTerm = SEARCH_TERMS[termIndex];
      console.log(`[SkillMarketService] Fetching with search term "${searchTerm}" (index ${termIndex})`);

      const newSkills = await this.fetchFromSkillsShAPI(searchTerm);

      // 去重：只添加新的技能
      const existingIds = new Set(cachedSkills.map(s => s.id));
      const uniqueNewSkills = newSkills.filter(s => !existingIds.has(s.id));

      if (uniqueNewSkills.length > 0) {
        cachedSkills = [...cachedSkills, ...uniqueNewSkills];
        this.skillsCache.set(sourceId, cachedSkills);
        console.log(`[SkillMarketService] Added ${uniqueNewSkills.length} new skills, total cached: ${cachedSkills.length}`);
      }

      termIndex++;
      this.searchTermIndex.set(sourceId, termIndex);

      // 如果没有新技能，继续尝试下一个搜索词
      if (uniqueNewSkills.length === 0) {
        continue;
      }
    }

    // 从缓存中分页
    const total = cachedSkills.length;
    const hasMore = termIndex < SEARCH_TERMS.length || offset + pageSize < total;
    const skills = cachedSkills.slice(offset, offset + pageSize);

    console.log(`[SkillMarketService] Returning ${skills.length} skills, total: ${total}, hasMore: ${hasMore}`);

    return { skills, total, hasMore };
  }

  /**
   * 从 skills.sh API 获取原始数据
   */
  private async fetchFromSkillsShAPI(searchTerm: string): Promise<RemoteSkillItem[]> {
    try {
      const limit = 50;
      const url = `https://skills.sh/api/search?q=${encodeURIComponent(searchTerm)}&limit=${limit}`;
      console.log('[SkillMarketService] Fetching from skills.sh API:', url);

      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Halo-App'
        }
      });

      if (!response.ok) {
        console.error('[SkillMarketService] skills.sh API error:', response.status);
        return [];
      }

      const data = await response.json() as {
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

      return data.skills.map(skill => {
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
          githubRepo: skill.source,
          githubPath: `skills/${skillName}`,
          skillContent: undefined
        };
      });
    } catch (error) {
      console.error('[SkillMarketService] Failed to fetch from skills.sh:', error);
      return [];
    }
  }

  /**
   * 搜索技能（全局搜索，支持分页）
   */
  async searchSkills(query: string, sourceId?: string, page: number = 1, pageSize: number = 20): Promise<{ skills: RemoteSkillItem[]; total: number; hasMore: boolean }> {
    console.log('[SkillMarketService] searchSkills called:', { query, sourceId, page, pageSize });

    const targetSourceId = sourceId || this.config.activeSourceId;
    const source = this.config.sources.find(s => s.id === targetSourceId);

    if (!source || !source.enabled) {
      return { skills: [], total: 0, hasMore: false };
    }

    try {
      // For skills.sh, search directly with the query
      if (source.id === 'skills.sh') {
        const searchCacheKey = `search:${query}`;

        // Check if we have cached results for this query
        let cachedSkills = this.skillsCache.get(searchCacheKey);

        if (!cachedSkills) {
          // Fetch from API with the user's query
          console.log('[SkillMarketService] Searching skills.sh with query:', query);
          cachedSkills = await this.fetchFromSkillsShAPI(query);
          this.skillsCache.set(searchCacheKey, cachedSkills);
        }

        // Paginate from cache
        const offset = (page - 1) * pageSize;
        const total = cachedSkills.length;
        const hasMore = offset + pageSize < total;
        const skills = cachedSkills.slice(offset, offset + pageSize);

        return { skills, total, hasMore };
      }

      // For other sources, use local filtering
      const result = await this.getSkills(sourceId, 1, 10000);
      const lowerQuery = query.toLowerCase();
      const filtered = result.skills.filter(skill =>
        skill.name.toLowerCase().includes(lowerQuery) ||
        skill.description.toLowerCase().includes(lowerQuery) ||
        skill.author.toLowerCase().includes(lowerQuery) ||
        skill.tags.some(tag => tag.toLowerCase().includes(lowerQuery))
      );

      const total = filtered.length;
      const startIndex = (page - 1) * pageSize;
      const skills = filtered.slice(startIndex, startIndex + pageSize);
      const hasMore = startIndex + pageSize < total;

      return { skills, total, hasMore };
    } catch (error) {
      console.error('[SkillMarketService] searchSkills error:', error);
      return { skills: [], total: 0, hasMore: false };
    }
  }

  /**
   * 获取技能详情
   */
  async getSkillDetail(skillId: string): Promise<RemoteSkillItem | null> {
    console.log('[SkillMarketService] getSkillDetail called:', skillId);

    // Parse the skill ID - format is "sourceId:rest"
    const colonIndex = skillId.indexOf(':');
    if (colonIndex === -1) {
      return null;
    }
    const sourceId = skillId.substring(0, colonIndex);
    const id = skillId.substring(colonIndex + 1);

    // For skills.sh, construct skill details from the ID format
    // ID format: "skills.sh:owner/repo/skillName"
    if (sourceId === 'skills.sh') {
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
          githubRepo: repo,
          // Most skills are in a 'skills' subdirectory in the repo
          githubPath: `skills/${skillName}`
        };

        // Fetch content from GitHub
        try {
          const content = await this.fetchSkillContent(repo, `skills/${skillName}`);
          if (content) {
            skill.fullDescription = content;
            skill.skillContent = content;
            // Extract description from content
            const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('---'));
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

    // For other sources, use the original approach
    const result = await this.getSkills(sourceId, 1, 10000);
    const skill = result.skills.find(s => s.id === skillId);

    if (!skill) {
      return null;
    }

    // 如果还没有详细内容，尝试获取
    if (!skill.fullDescription && skill.githubRepo) {
      try {
        const content = await this.fetchSkillContent(skill.githubRepo, skill.githubPath || id);
        skill.fullDescription = content;
        skill.skillContent = content;
      } catch (error) {
        console.error('[SkillMarketService] Failed to fetch skill detail:', error);
      }
    }

    return skill;
  }

  /**
   * 从 GitHub 仓库获取技能（支持分页）
   */
  private async fetchFromGitHubPaginated(repos: string[], sourceId: string, page: number = 1, pageSize: number = 20): Promise<{ skills: RemoteSkillItem[]; total: number; hasMore: boolean }> {
    const skills: RemoteSkillItem[] = [];

    for (const repo of repos) {
      try {
        const response = await fetch(`https://api.github.com/repos/${repo}/contents`, {
          headers: {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Halo-App'
          }
        });

        if (!response.ok) continue;

        const data = await response.json();
        if (!Array.isArray(data)) continue;

        for (const item of data) {
          if (item.type === 'dir' && !item.name.startsWith('.') && !item.name.startsWith('_')) {
            skills.push({
              id: `${sourceId}:${item.name}`,
              name: this.formatSkillName(item.name),
              description: `Skill from ${repo}`,
              version: '1.0.0',
              author: repo.split('/')[0],
              tags: [],
              lastUpdated: new Date().toISOString(),
              sourceId,
              githubRepo: repo,
              githubPath: item.name,
              downloadUrl: `https://github.com/${repo}/tree/main/${item.name}`
            });
          }
        }
      } catch (error) {
        console.error(`[SkillMarketService] Failed to fetch from ${repo}:`, error);
      }
    }

    const total = skills.length;
    const startIndex = (page - 1) * pageSize;
    const pageSkills = skills.slice(startIndex, startIndex + pageSize);
    const hasMore = startIndex + pageSize < total;

    return { skills: pageSkills, total, hasMore };
  }

  /**
   * 从 GitHub 仓库获取技能
   */
  private async fetchFromGitHub(repos: string[], sourceId: string): Promise<RemoteSkillItem[]> {
    const skills: RemoteSkillItem[] = [];

    for (const repo of repos) {
      try {
        const response = await fetch(`https://api.github.com/repos/${repo}/contents`, {
          headers: {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Halo-App'
          }
        });

        if (!response.ok) continue;

        const data = await response.json();
        if (!Array.isArray(data)) continue;

        for (const item of data) {
          if (item.type === 'dir' && !item.name.startsWith('.') && !item.name.startsWith('_')) {
            let description = `Skill from ${repo}`;

            // 尝试获取 SKILL.md 的描述
            try {
              const skillContent = await this.fetchSkillContent(repo, item.name);
              if (skillContent) {
                // 提取第一段作为描述
                const lines = skillContent.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('---'));
                if (lines.length > 0) {
                  description = lines[0].substring(0, 150);
                }
              }
            } catch {
              // 忽略错误
            }

            skills.push({
              id: `${sourceId}:${item.name}`,
              name: this.formatSkillName(item.name),
              description,
              version: '1.0.0',
              author: repo.split('/')[0],
              tags: [],
              lastUpdated: new Date().toISOString(),
              sourceId,
              githubRepo: repo,
              githubPath: item.name,
              downloadUrl: `https://github.com/${repo}/tree/main/${item.name}`
            });
          }
        }
      } catch (error) {
        console.error(`[SkillMarketService] Failed to fetch from ${repo}:`, error);
      }
    }

    return skills;
  }

  /**
   * 获取技能内容
   */
  async fetchSkillContent(repo: string, skillPath: string): Promise<string> {
    // Extract skill name from path (could be "skills/xxx" or just "xxx")
    const skillName = skillPath.replace(/^skills\//, '').replace(/^skills-/, '')

    // Generate variations of the skill name to try
    // Some skills have prefixes like "vercel-" that don't match the directory name
    const skillNameVariations = [
      skillName,                              // Original name
      skillName.replace(/^[a-z]+-/, ''),      // Remove prefix (e.g., "vercel-react" -> "react")
    ]

    // Generate all possible base paths
    const basePaths: string[] = []
    for (const name of skillNameVariations) {
      basePaths.push(name)                    // Direct path
      basePaths.push(`skills/${name}`)        // In skills/ subdirectory
    }

    // Also try original path as-is
    basePaths.unshift(skillPath)

    console.log('[SkillMarketService] Trying paths:', basePaths)

    // 对每个路径尝试 SKILL.md 和 README.md
    for (const path of basePaths) {
      // 尝试获取 SKILL.md
      try {
        const skillMdUrl = `https://raw.githubusercontent.com/${repo}/main/${path}/SKILL.md`
        console.log('[SkillMarketService] Trying SKILL.md URL:', skillMdUrl)
        const response = await fetch(skillMdUrl)
        console.log('[SkillMarketService] SKILL.md response:', response.status, response.statusText)
        if (response.ok) {
          const text = await response.text()
          console.log('[SkillMarketService] Found SKILL.md at:', path, 'length:', text.length)
          return text
        }
      } catch (err) {
        console.log('[SkillMarketService] SKILL.md fetch error:', err)
      }

      // 尝试获取 README.md
      try {
        const readmeUrl = `https://raw.githubusercontent.com/${repo}/main/${path}/README.md`
        console.log('[SkillMarketService] Trying README.md URL:', readmeUrl)
        const response = await fetch(readmeUrl)
        console.log('[SkillMarketService] README.md response:', response.status, response.statusText)
        if (response.ok) {
          const text = await response.text()
          console.log('[SkillMarketService] Found README.md at:', path, 'length:', text.length)
          return text
        }
      } catch (err) {
        console.log('[SkillMarketService] README.md fetch error:', err)
      }
    }

    console.log('[SkillMarketService] No content found for:', repo, skillPath)
    return ''
  }

  /**
   * 下载技能并安装
   */
  async downloadSkill(skillId: string): Promise<{ success: boolean; content?: string; error?: string }> {
    console.log('[SkillMarketService] downloadSkill called:', skillId)
    const [sourceId, id] = skillId.split(':')
    const skill = await this.getSkillDetail(skillId)

    if (!skill) {
      console.log('[SkillMarketService] Skill not found')
      return { success: false, error: 'Skill not found' }
    }

    console.log('[SkillMarketService] Skill detail:', {
      name: skill.name,
      githubRepo: skill.githubRepo,
      githubPath: skill.githubPath,
      hasContent: !!skill.skillContent
    })

    try {
      let content = skill.skillContent

      // 如果没有缓存的内容，从 GitHub 获取
      if (!content && skill.githubRepo) {
        console.log('[SkillMarketService] Fetching content from GitHub:', skill.githubRepo, skill.githubPath || id)
        content = await this.fetchSkillContent(skill.githubRepo, skill.githubPath || id)
        console.log('[SkillMarketService] Fetched content length:', content?.length || 0)
      }

      if (!content) {
        console.log('[SkillMarketService] No content available')
        return { success: false, error: 'Failed to fetch skill content' }
      }

      return { success: true, content }
    } catch (error) {
      console.error('[SkillMarketService] Download error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Download failed' }
    }
  }

  /**
   * 格式化技能名称
   */
  private formatSkillName(name: string): string {
    return name
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }
}
