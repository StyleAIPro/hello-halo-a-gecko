/**
 * 远程部署镜像源配置类型定义
 */

/** 单个镜像源配置方案 */
export interface MirrorSourceProfile {
  /** 唯一标识符（预设: 'preset-huawei'，自定义: 'custom-<uuid>'） */
  id: string;
  /** 方案名称（展示用） */
  name: string;
  /** 是否为内置预设方案（不可删除，不可修改名称和 URL） */
  isPreset: boolean;
  /** 各项镜像源 URL */
  sources: MirrorSourceUrls;
}

/** 镜像源 URL 配置 */
export interface MirrorSourceUrls {
  /**
   * npm Registry 地址
   * 默认值（当前代码硬编码）: 'https://registry.npmmirror.com'
   * 影响: 所有 npm install / npx 操作
   */
  npmRegistry: string;

  /**
   * Node.js 二进制下载镜像（tarball URL 前缀）
   * 默认值（当前代码硬编码主源）: 'https://nodejs.org/dist/'
   * 配置后所有 Linux 发行版统一使用二进制 tarball 安装（绕过 NodeSource）
   */
  nodeDownloadMirror: string;
}

/** 部署镜像配置（存储在 AicoBotConfig 中） */
export interface DeployMirrorConfig {
  /** 当前激活的方案 ID，null 表示不配置镜像（使用互联网默认值） */
  activeProfileId: string | null;
  /** 所有镜像源方案列表（包含内置预设和用户自定义） */
  profiles: MirrorSourceProfile[];
}

/** 内置预设方案 ID */
export const PRESET_HUAWEI_ID = 'preset-huawei';

/** 内置预设方案 */
export const BUILTIN_MIRROR_PRESETS: MirrorSourceProfile[] = [
  {
    id: PRESET_HUAWEI_ID,
    name: '华为内网源',
    isPreset: true,
    sources: {
      npmRegistry: 'https://registry.npmmirror.com',
      nodeDownloadMirror: 'https://mirrors.huaweicloud.com/nodejs/',
    },
  },
];

/**
 * 当前代码中的硬编码默认值
 * 当 activeProfileId 为 null 时，部署行为等同于使用这些默认值
 */
export const DEFAULT_MIRROR_URLS: MirrorSourceUrls = {
  npmRegistry: 'https://registry.npmmirror.com',
  nodeDownloadMirror: 'https://nodejs.org/dist/',
};

/**
 * 创建空白的自定义镜像源方案
 */
export function createEmptyCustomProfile(name: string): MirrorSourceProfile {
  return {
    id: `custom-${crypto.randomUUID()}`,
    name,
    isPreset: false,
    sources: { ...DEFAULT_MIRROR_URLS },
  };
}
