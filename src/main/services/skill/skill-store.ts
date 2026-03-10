/**
 * Skill 市场/商店服务
 * 负责从远程源获取可安装的技能列表
 */

import * as https from 'https';
import * as http from 'http';
import { SkillMarketItem, SkillMarketSource } from '../../shared/skill/skill-types';

/**
 * 预定义的市场源
 */
const DEFAULT_MARKET_SOURCES: SkillMarketSource[] = [
  {
    id: 'skills-sh',
    name: 'Skills.sh',
    url: 'https://skills.sh/api/skills',
    enabled: true
  },
  {
    id: 'skillsmp',
    name: 'SkillsMP (中文)',
    url: 'https://skillsmp.com/zh/api/skills',
    enabled: true
  }
];

/**
 * GitHub Skills 仓库配置
 */
const GITHUB_SKILLS_REPOS = [
  'anthropics/skills',
  // 可以添加更多社区仓库
];

export class SkillStoreService {
  private static instance: SkillStoreService;
  private sources: SkillMarketSource[] = [...DEFAULT_MARKET_SOURCES];
  private cache: Map<string, { items: SkillMarketItem[]; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 分钟缓存

  private constructor() {}

  static getInstance(): SkillStoreService {
    if (!SkillStoreService.instance) {
      SkillStoreService.instance = new SkillStoreService();
    }
    return SkillStoreService.instance;
  }

  /**
   * 获取所有市场源
   */
  getSources(): SkillMarketSource[] {
    return [...this.sources];
  }

  /**
   * 启用/禁用市场源
   */
  toggleSource(sourceId: string, enabled: boolean): void {
    const source = this.sources.find(s => s.id === sourceId);
    if (source) {
      source.enabled = enabled;
      // 清除缓存
      this.cache.delete(sourceId);
    }
  }

  /**
   * 添加自定义市场源
   */
  addSource(source: SkillMarketSource): void {
    if (!this.sources.find(s => s.id === source.id)) {
      this.sources.push(source);
    }
  }

  /**
   * 从所有启用的市场源获取技能列表
   */
  async fetchAllSkills(): Promise<SkillMarketItem[]> {
    const enabledSources = this.sources.filter(s => s.enabled);
    const allSkills: SkillMarketItem[] = [];

    for (const source of enabledSources) {
      try {
        const skills = await this.fetchFromSource(source);
        allSkills.push(...skills);
      } catch (error) {
        console.error(`[SkillStore] Failed to fetch from ${source.name}:`, error);
      }
    }

    return allSkills;
  }

  /**
   * 从单个市场源获取技能
   */
  private async fetchFromSource(source: SkillMarketSource): Promise<SkillMarketItem[]> {
    // 检查缓存
    const cached = this.cache.get(source.id);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.items;
    }

    // 如果是 skills.sh 或 skillsmp，使用特殊的获取逻辑
    if (source.id === 'skills-sh') {
      const skills = await this.fetchSkillsSh();
      this.cache.set(source.id, { items: skills, timestamp: Date.now() });
      return skills;
    }

    if (source.id === 'skillsmp') {
      const skills = await this.fetchSkillsMP();
      this.cache.set(source.id, { items: skills, timestamp: Date.now() });
      return skills;
    }

    // 通用 HTTP 获取
    const skills = await this.httpGet(source.url);
    const items = Array.isArray(skills) ? skills : [];
    this.cache.set(source.id, { items, timestamp: Date.now() });
    return items;
  }

  /**
   * 从 skills.sh 获取技能
   * 注意：skills.sh 可能没有公开的 API，这里使用网页抓取作为备选
   */
  private async fetchSkillsSh(): Promise<SkillMarketItem[]> {
    try {
      // 尝试从 GitHub 获取 anthropics/skills 仓库的内容
      const skills = await this.fetchGitHubSkills('anthropics/skills');
      return skills;
    } catch (error) {
      console.error('[SkillStore] Failed to fetch skills.sh:', error);
      return [];
    }
  }

  /**
   * 从 skillsmp.com 获取技能
   */
  private async fetchSkillsMP(): Promise<SkillMarketItem[]> {
    try {
      // skillsmp.com 可能有公开 API，如果没有则抓取网页
      // 这里假设一个 API 端点
      return [];
    } catch (error) {
      console.error('[SkillStore] Failed to fetch skillsmp:', error);
      return [];
    }
  }

  /**
   * 从 GitHub 仓库获取 skills
   */
  private async fetchGitHubSkills(repo: string): Promise<SkillMarketItem[]> {
    const url = `https://api.github.com/repos/${repo}/contents`;

    try {
      const data = await this.httpGet(url, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Halo-Skill-Manager'
        }
      });

      if (!Array.isArray(data)) {
        return [];
      }

      const skills: SkillMarketItem[] = [];

      for (const item of data) {
        if (item.type === 'dir' && !item.name.startsWith('.')) {
          // 每个目录是一个 skill
          const skillInfo = await this.fetchGitHubSkillInfo(repo, item.name);
          if (skillInfo) {
            skills.push(skillInfo);
          }
        }
      }

      return skills;
    } catch (error) {
      console.error('[SkillStore] Failed to fetch GitHub skills:', error);
      return [];
    }
  }

  /**
   * 获取单个 GitHub skill 的详细信息
   */
  private async fetchGitHubSkillInfo(
    repo: string,
    skillName: string
  ): Promise<SkillMarketItem | null> {
    try {
      // 获取 SKILL.md 或 README.md
      const files = await this.httpGet(
        `https://api.github.com/repos/${repo}/contents/${skillName}`,
        {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Halo-Skill-Manager'
        }
      );

      let description = '';
      let downloadUrl = `https://github.com/${repo}/tree/main/${skillName}`;

      // 查找 SKILL.md 或 README.md
      for (const file of Array.isArray(files) ? files : []) {
        if (file.name === 'SKILL.md' || file.name === 'README.md') {
          // 获取文件内容
          const content = await this.httpGet(file.download_url);
          description = this.extractDescription(content);
          break;
        }
      }

      return {
        id: skillName,
        name: this.formatSkillName(skillName),
        description: description || skillName,
        version: '1.0',
        author: repo.split('/')[0],
        tags: [],
        downloadUrl,
        sourceUrl: `https://github.com/${repo}/tree/main/${skillName}`,
        lastUpdated: new Date().toISOString()
      };
    } catch (error) {
      console.error('[SkillStore] Failed to fetch skill info:', skillName, error);
      return null;
    }
  }

  /**
   * 从 markdown 内容提取描述
   */
  private extractDescription(content: string): string {
    if (typeof content !== 'string') {
      return '';
    }

    // 解码 base64 (GitHub API 返回的 content 可能是 base64)
    let decoded = content;
    try {
      if (content.match(/^[A-Za-z0-9+/=]+$/)) {
        decoded = Buffer.from(content, 'base64').toString('utf-8');
      }
    } catch {
      // 不是 base64，使用原始内容
    }

    // 提取第一段作为描述
    const lines = decoded.split('\n').filter(line => line.trim());
    for (const line of lines) {
      if (line && !line.startsWith('#') && line.trim().length > 10) {
        return line.trim();
      }
    }

    return '';
  }

  /**
   * 格式化技能名称
   */
  private formatSkillName(name: string): string {
    return name
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  /**
   * HTTP GET 请求
   */
  private httpGet(url: string, headers: Record<string, string> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;

      client.get(url, { headers }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        });
      }).on('error', reject);
    });
  }

  /**
   * 搜索技能
   */
  async searchSkills(query: string): Promise<SkillMarketItem[]> {
    const allSkills = await this.fetchAllSkills();
    const lowerQuery = query.toLowerCase();

    return allSkills.filter(skill =>
      skill.name.toLowerCase().includes(lowerQuery) ||
      skill.description.toLowerCase().includes(lowerQuery) ||
      skill.tags.some(tag => tag.toLowerCase().includes(lowerQuery))
    );
  }

  /**
   * 按标签筛选技能
   */
  async getSkillsByTag(tag: string): Promise<SkillMarketItem[]> {
    const allSkills = await this.fetchAllSkills();
    return allSkills.filter(skill =>
      skill.tags.some(t => t.toLowerCase() === tag.toLowerCase())
    );
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.cache.clear();
  }
}
