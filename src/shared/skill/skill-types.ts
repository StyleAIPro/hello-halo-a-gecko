/**
 * Skill 管理系统类型定义
 */

import type { AppSpec } from '../apps/spec-types';

/**
 * Skill 元数据
 */
export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  triggerCommand: string; // 如 /code-commit
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Skill 规范（扩展 AppSpec）
 */
export interface SkillSpec extends Omit<AppSpec, 'type'> {
  type: 'skill';
  /** 触发命令，如 /code-commit */
  trigger_command?: string;
  /** 技能标签 */
  tags?: string[];
}

/**
 * Skill 市场项
 */
export interface SkillMarketItem {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  tags: string[];
  downloadUrl: string;
  sourceUrl?: string; // GitHub repo 等
  rating?: number;
  downloads?: number;
  lastUpdated: string;
}

/**
 * 扩展的技能市场项（包含来源信息）
 */
export interface RemoteSkillItem {
  /** 唯一标识，格式: source:skillId (如 skills.sh:find-skills) */
  id: string;
  /** 技能名称 */
  name: string;
  /** 简短描述 */
  description: string;
  /** 详细描述（markdown格式） */
  fullDescription?: string;
  /** 版本 */
  version: string;
  /** 作者 */
  author: string;
  /** 标签 */
  tags: string[];
  /** 安装数 */
  installs?: number;
  /** 星标数 */
  stars?: number;
  /** 最后更新时间 */
  lastUpdated: string;
  /** 来源 ID */
  sourceId: string;
  /** 远程仓库（GitHub / GitCode / 其他） */
  remoteRepo?: string;
  /** 远程仓库内的技能路径 */
  remotePath?: string;
  /** 下载URL */
  downloadUrl?: string;
  /** SKILL.md 内容 */
  skillContent?: string;
}

/**
 * Skill 市场源配置
 */
export interface SkillMarketSource {
  /** 源 ID */
  id: string;
  /** 显示名称 */
  name: string;
  /** 源类型 */
  type: 'builtin' | 'github' | 'gitcode' | 'custom';
  /** 源 URL 或 API 端点 */
  url: string;
  /** 是否启用 */
  enabled: boolean;
  /** 图标 */
  icon?: string;
  /** 描述 */
  description?: string;
  /** GitHub 仓库列表（用于 github 类型） */
  repos?: string[];
}

/**
 * 技能市场配置
 */
export interface SkillMarketConfig {
  /** 市场源列表 */
  sources: SkillMarketSource[];
  /** 当前选中的源 ID */
  activeSourceId: string;
}

/**
 * Skill 生成选项
 */
export interface SkillGenerateOptions {
  /** 会话 ID */
  conversationId?: string;
  /** 空间 ID */
  spaceId: string;
  /** 技能名称 */
  name: string;
  /** 技能描述 */
  description: string;
  /** 触发命令 */
  triggerCommand: string;
}

/**
 * Skill 生成结果
 */
export interface SkillGenerateResult {
  success: boolean;
  skill?: SkillSpec;
  error?: string;
}

/**
 * 已安装的 Skill 信息
 */
export interface InstalledSkill {
  appId: string;
  spec: SkillSpec;
  enabled: boolean;
  installedAt: string;
}

/**
 * Skill 库配置
 */
export interface SkillLibraryConfig {
  // 全局配置，所有 skills 都在 ~/.agents/skills/ 目录
}

/**
 * 技能文件树节点
 */
export interface SkillFileNode {
  name: string;
  type: 'file' | 'directory';
  path: string;
  size?: number;
  extension?: string;
  children?: SkillFileNode[];
}
