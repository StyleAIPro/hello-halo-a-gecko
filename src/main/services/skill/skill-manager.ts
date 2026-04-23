/**
 * Skill 管理器 - 核心服务
 * 负责技能的加载、安装、卸载、启用/禁用
 *
 * 存储结构：
 * - 全局 skills: ~/.agents/skills/
 * - Claude 原生 skills: ~/.claude/skills/
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type {
  SkillSpec,
  InstalledSkill,
  SkillLibraryConfig,
  SkillFileNode,
} from '../../shared/skill/skill-types';
import { getAgentsSkillsDir, getClaudeSkillsDir, getAllSkillsDirs } from '../config.service';

export class SkillManager {
  private static instance: SkillManager;
  private skillsDirs: string[];
  private configPath: string;

  // 已安装的技能缓存
  private installedSkills: Map<string, InstalledSkill> = new Map();

  // 技能来源目录映射 (skillId -> skillsDir)
  private skillDirMap: Map<string, string> = new Map();

  // 技能配置
  private config: SkillLibraryConfig = {};

  private constructor() {
    this.skillsDirs = getAllSkillsDirs();
    this.configPath = path.join(getAgentsSkillsDir(), '..', 'skill-config.json');
  }

  static getInstance(): SkillManager {
    if (!SkillManager.instance) {
      SkillManager.instance = new SkillManager();
    }
    return SkillManager.instance;
  }

  /**
   * 初始化技能管理器
   */
  async initialize(): Promise<void> {
    // 确保所有技能目录存在
    for (const dir of this.skillsDirs) {
      await fs.mkdir(dir, { recursive: true });
    }

    // 加载配置
    await this.loadConfig();

    // 加载已安装的 skills
    await this.loadSkills();

    console.log(
      '[SkillManager] Initialized with',
      this.installedSkills.size,
      'skills from',
      this.skillsDirs.length,
      'directories',
    );
  }

  /**
   * 加载配置
   */
  private async loadConfig(): Promise<void> {
    try {
      const content = await fs.readFile(this.configPath, 'utf-8');
      this.config = JSON.parse(content);
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
      console.error('[SkillManager] Failed to save config:', error);
    }
  }

  /**
   * 加载已安装的 skills（从所有搜索目录）
   * 同名 skill 取修改时间最新的版本
   */
  private async loadSkills(): Promise<void> {
    this.installedSkills.clear();
    this.skillDirMap.clear();

    // 临时收集所有候选 skill，按名称分组
    const candidates = new Map<string, { dir: string; mtime: number; skill: InstalledSkill }>();

    for (const skillsDir of this.skillsDirs) {
      console.log('[SkillManager] Loading skills from:', skillsDir);

      try {
        const entries = await fs.readdir(skillsDir, { withFileTypes: true });
        console.log('[SkillManager] Found', entries.length, 'entries in', skillsDir);

        for (const entry of entries) {
          if (!entry.isDirectory()) continue;

          const skillDir = path.join(skillsDir, entry.name);
          try {
            const stat = await fs.stat(skillDir);
            const mtime = stat.mtimeMs;

            const skill = await this.loadSkillFromDir(skillDir, entry.name);
            if (!skill) {
              console.warn('[SkillManager] Failed to parse skill:', entry.name);
              continue;
            }

            const existing = candidates.get(entry.name);
            if (!existing || mtime > existing.mtime) {
              candidates.set(entry.name, { dir: skillsDir, mtime, skill });
              console.log(
                '[SkillManager] Candidate skill:',
                entry.name,
                'from',
                skillsDir,
                'mtime:',
                new Date(mtime).toISOString(),
                existing ? '(replacing older version)' : '',
              );
            } else {
              console.log(
                '[SkillManager] Skipping older duplicate skill:',
                entry.name,
                'from',
                skillsDir,
                'mtime:',
                new Date(mtime).toISOString(),
              );
            }
          } catch (error) {
            console.error(`[SkillManager] Failed to load skill ${entry.name}:`, error);
          }
        }
      } catch (error) {
        console.error('[SkillManager] Failed to load skills from', skillsDir, ':', error);
      }
    }

    // 将最终候选写入缓存
    for (const [skillId, candidate] of candidates) {
      this.installedSkills.set(skillId, candidate.skill);
      this.skillDirMap.set(skillId, candidate.dir);
      console.log('[SkillManager] Loaded skill:', skillId, 'from', candidate.dir);
    }
  }

  /**
   * 从目录加载 skill（优先 SKILL.md，回退 SKILL.yaml）
   * SKILL.md 是 Claude Code 原生格式（YAML frontmatter + markdown body）
   * SKILL.yaml 是 AICO-Bot 自有格式
   */
  private async loadSkillFromDir(
    skillDir: string,
    skillId: string,
  ): Promise<InstalledSkill | null> {
    const mdFile = path.join(skillDir, 'SKILL.md');
    const yamlFile = path.join(skillDir, 'SKILL.yaml');

    // 读取 META.json
    const metaFile = path.join(skillDir, 'META.json');
    let meta: Partial<InstalledSkill> = {};
    try {
      const metaContent = await fs.readFile(metaFile, 'utf-8');
      meta = JSON.parse(metaContent);
    } catch {
      // meta 文件不存在，使用默认值
    }

    // 优先尝试 SKILL.md (Claude Code 原生格式)
    try {
      const mdContent = await fs.readFile(mdFile, 'utf-8');
      const spec = this.parseSkillMd(mdContent, skillId);
      if (spec) {
        return {
          appId: skillId,
          spec,
          enabled: meta.enabled ?? true,
          installedAt: meta.installedAt ?? new Date().toISOString(),
        };
      }
    } catch {
      // SKILL.md 不存在，尝试 SKILL.yaml
    }

    // 回退到 SKILL.yaml (AICO-Bot 格式)
    try {
      const yamlContent = await fs.readFile(yamlFile, 'utf-8');
      const spec = parseYaml(yamlContent) as SkillSpec;
      return {
        appId: skillId,
        spec,
        enabled: meta.enabled ?? true,
        installedAt: meta.installedAt ?? new Date().toISOString(),
      };
    } catch {
      // SKILL.yaml 也不存在
    }

    return null;
  }

  /**
   * 解析 SKILL.md 格式（Claude Code 原生格式）
   * 格式：YAML frontmatter + markdown body
   */
  private parseSkillMd(content: string, skillId: string): SkillSpec | null {
    // 解析 YAML frontmatter
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!frontmatterMatch) {
      // 没有 frontmatter，使用默认值
      return {
        name: skillId,
        type: 'skill',
        description: `Skill: ${skillId}`,
        system_prompt: content,
        version: '1.0',
        author: 'Unknown',
        trigger_command: `/${skillId}`,
      };
    }

    try {
      const frontmatter = parseYaml(frontmatterMatch[1]) as Record<string, unknown>;
      const body = content.slice(frontmatterMatch[0].length).trim();

      return {
        name: (frontmatter.name as string) || skillId,
        type: 'skill',
        description: (frontmatter.description as string) || '',
        system_prompt: body || content,
        version: (frontmatter.version as string) || '1.0',
        author: (frontmatter.author as string) || 'Unknown',
        trigger_command: (frontmatter.trigger_command as string) || `/${skillId}`,
        tags: frontmatter.tags as string[] | undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * 获取所有已安装的 skills
   */
  getInstalledSkills(): InstalledSkill[] {
    // 返回所有技能（包括禁用的），让前端显示状态
    return Array.from(this.installedSkills.values());
  }

  /**
   * 获取技能目录下的文件结构
   */
  async getSkillFiles(skillId: string): Promise<SkillFileNode[]> {
    const baseDir = this.skillDirMap.get(skillId) || this.skillsDirs[0];
    const skillDir = path.join(baseDir, skillId);

    try {
      return await this.buildFileTree(skillDir, '');
    } catch (error) {
      console.error('[SkillManager] Failed to get skill files:', error);
      return [];
    }
  }

  /**
   * 递归构建文件树
   */
  private async buildFileTree(dirPath: string, relativePath: string): Promise<SkillFileNode[]> {
    const nodes: SkillFileNode[] = [];

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const entryPath = path.join(dirPath, entry.name);
        const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          // 递归获取子目录内容
          const children = await this.buildFileTree(entryPath, entryRelativePath);
          nodes.push({
            name: entry.name,
            type: 'directory',
            path: entryRelativePath,
            children,
          });
        } else {
          // 获取文件信息
          const stats = await fs.stat(entryPath);
          nodes.push({
            name: entry.name,
            type: 'file',
            path: entryRelativePath,
            size: stats.size,
            extension: path.extname(entry.name).toLowerCase(),
          });
        }
      }

      // 排序：目录在前，然后按名称排序
      return nodes.sort((a, b) => {
        if (a.type === 'directory' && b.type !== 'directory') return -1;
        if (a.type !== 'directory' && b.type === 'directory') return 1;
        return a.name.localeCompare(b.name);
      });
    } catch {
      return [];
    }
  }

  /**
   * 读取技能文件内容
   */
  async getSkillFileContent(skillId: string, filePath: string): Promise<string | null> {
    const baseDir = this.skillDirMap.get(skillId) || this.skillsDirs[0];
    const fullPath = path.join(baseDir, skillId, filePath);

    try {
      // 安全检查：确保路径在技能目录内
      const normalizedPath = path.normalize(fullPath);
      const skillDir = path.join(baseDir, skillId) + path.sep;
      if (!normalizedPath.startsWith(skillDir)) {
        console.error('[SkillManager] Invalid file path:', filePath);
        return null;
      }

      const content = await fs.readFile(normalizedPath, 'utf-8');
      return content;
    } catch (error) {
      console.error('[SkillManager] Failed to read file:', filePath, error);
      return null;
    }
  }

  /**
   * 保存技能文件内容
   */
  async saveSkillFileContent(skillId: string, filePath: string, content: string): Promise<boolean> {
    const baseDir = this.skillDirMap.get(skillId) || this.skillsDirs[0];
    const fullPath = path.join(baseDir, skillId, filePath);

    try {
      // 安全检查：确保路径在技能目录内
      const normalizedPath = path.normalize(fullPath);
      const skillDir = path.join(baseDir, skillId) + path.sep;
      if (!normalizedPath.startsWith(skillDir)) {
        console.error('[SkillManager] Invalid file path:', filePath);
        return false;
      }

      // 确保目录存在
      const dir = path.dirname(normalizedPath);
      await fs.mkdir(dir, { recursive: true });

      await fs.writeFile(normalizedPath, content, 'utf-8');
      return true;
    } catch (error) {
      console.error('[SkillManager] Failed to save file:', filePath, error);
      return false;
    }
  }

  /**
   * 安装 skill（安装到主目录 ~/.agents/skills/）
   */
  async installSkill(
    spec: SkillSpec,
    skillData: {
      systemPrompt: string;
      triggerCommand?: string;
    },
  ): Promise<string> {
    const skillId = spec.name.toLowerCase().replace(/\s+/g, '-');
    const primaryDir = this.skillsDirs[0];
    const skillDir = path.join(primaryDir, skillId);

    // 创建技能目录
    await fs.mkdir(skillDir, { recursive: true });

    // 构建完整的 skill spec
    const fullSpec: SkillSpec = {
      ...spec,
      type: 'skill',
      system_prompt: skillData.systemPrompt,
      trigger_command: skillData.triggerCommand || `/${skillId}`,
      version: spec.version || '1.0',
      author: spec.author || 'User',
    };

    // 写入 SKILL.yaml
    const yamlContent = stringifyYaml(fullSpec);
    await fs.writeFile(path.join(skillDir, 'SKILL.yaml'), yamlContent, 'utf-8');

    // 写入 META.json
    const meta: InstalledSkill = {
      appId: skillId,
      spec: fullSpec,
      enabled: true,
      installedAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(skillDir, 'META.json'), JSON.stringify(meta, null, 2), 'utf-8');

    // 更新缓存
    this.installedSkills.set(skillId, meta);
    this.skillDirMap.set(skillId, primaryDir);
    console.log('[SkillManager] Installed skill:', skillId);

    return skillId;
  }

  /**
   * 卸载 skill
   */
  async uninstallSkill(skillId: string): Promise<boolean> {
    const baseDir = this.skillDirMap.get(skillId) || this.skillsDirs[0];
    const skillDir = path.join(baseDir, skillId);

    try {
      // 删除技能目录
      await fs.rm(skillDir, { recursive: true, force: true });

      // 从缓存中移除
      this.installedSkills.delete(skillId);
      this.skillDirMap.delete(skillId);
      console.log('[SkillManager] Uninstalled skill:', skillId);
      return true;
    } catch (error) {
      console.error('[SkillManager] Failed to uninstall skill:', error);
      return false;
    }
  }

  /**
   * 启用/禁用 skill
   */
  async toggleSkill(skillId: string, enabled: boolean): Promise<boolean> {
    const skill = this.installedSkills.get(skillId);
    if (!skill) {
      return false;
    }

    skill.enabled = enabled;
    this.installedSkills.set(skillId, skill);

    // 更新 META.json
    const baseDir = this.skillDirMap.get(skillId) || this.skillsDirs[0];
    const skillDir = path.join(baseDir, skillId);
    const metaFile = path.join(skillDir, 'META.json');
    await fs.writeFile(metaFile, JSON.stringify(skill, null, 2), 'utf-8');

    console.log(`[SkillManager] Toggled skill ${skillId} enabled:`, enabled);
    return true;
  }

  /**
   * 获取 skill 详情
   */
  getSkill(skillId: string): InstalledSkill | undefined {
    return this.installedSkills.get(skillId);
  }

  /**
   * 获取 skill 所在的基础目录
   */
  getSkillBaseDir(skillId: string): string {
    return this.skillDirMap.get(skillId) || this.skillsDirs[0];
  }

  /**
   * 获取所有 skills 搜索目录
   */
  getSkillsDirs(): string[] {
    return [...this.skillsDirs];
  }

  /**
   * 导出 skill 为 YAML
   */
  async exportSkill(skillId: string): Promise<string | null> {
    const skill = this.getSkill(skillId);
    if (!skill) {
      return null;
    }

    return stringifyYaml(skill.spec);
  }

  /**
   * 从 YAML 导入 skill
   */
  async importSkill(yamlContent: string): Promise<string> {
    const spec = parseYaml(yamlContent) as SkillSpec;

    // 验证 spec
    if (!spec.name || !spec.system_prompt) {
      throw new Error('Invalid skill spec: missing name or system_prompt');
    }

    // 安装 skill
    return this.installSkill(spec, {
      systemPrompt: spec.system_prompt,
      triggerCommand: spec.trigger_command,
    });
  }

  /**
   * 更新配置
   */
  async updateConfig(config: Partial<SkillLibraryConfig>): Promise<void> {
    this.config = { ...this.config, ...config };
    await this.saveConfig();
  }

  /**
   * 获取配置
   */
  getConfig(): SkillLibraryConfig {
    return this.config;
  }

  /**
   * 刷新技能列表
   */
  async refresh(): Promise<void> {
    await this.loadSkills();
    console.log('[SkillManager] Refreshed skills');
  }
}
