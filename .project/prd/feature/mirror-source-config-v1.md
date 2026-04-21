# PRD [功能级] -- 远程部署镜像源配置

> 版本：mirror-source-config-v1
> 日期：2026-04-20
> 指令人：@zhaoyinqi
> 归属模块：renderer/settings + shared + main/remote-deploy
> 状态：draft
> 优先级：P0（阻塞内网用户远程部署）

## 需求分析

### 背景

AICO-Bot 的远程部署功能会将 `remote-agent-proxy` 部署到远程服务器。部署过程中需要下载 Node.js 和 npm 依赖包。这些下载源在代码中硬编码，企业内网环境无法访问，导致远程部署完全失败。

### 当前硬编码分析（基于代码审计）

通过对 `remote-deploy.service.ts` 和 `deploy-remote-agent.sh` 的完整代码审计，远程部署涉及以下下载操作：

#### 1. npm Registry（影响所有 npm install 操作）

`npm config set registry` 在 5 处硬编码为 `https://registry.npmmirror.com`：

| # | 文件 | 行号(约) | 上下文 |
|---|------|---------|--------|
| 1 | `remote-deploy.service.ts` | ~1119 | `deployToServer()` — 安装项目依赖前配置 |
| 2 | `remote-deploy.service.ts` | ~3143 | `deployAgentSDK()` — Node.js 安装后配置 |
| 3 | `remote-deploy.service.ts` | ~3332 | `deployAgentSDK()` — 安装 SDK 前配置 |
| 4 | `deploy-remote-agent.sh` | 152 | `install_claude_code_cli()` — 安装 Claude CLI 前 |
| 5 | `deploy-remote-agent.sh` | 176 | `install_dependencies()` — 安装项目依赖前 |

影响的 `npm install` 操作：
- `npm install --legacy-peer-deps`（项目依赖）
- `npm install -g @anthropic-ai/claude-agent-sdk@${VERSION}`（SDK 全局安装）
- `npm install -g @anthropic-ai/claude-code`（Claude CLI 全局安装）
- `npm install -g npx --force`（npx 工具安装）
- `npm install --production`（shell 脚本中的生产依赖安装）

#### 2. Node.js 二进制下载（仅 EulerOS/openEuler 系统）

当远程服务器是 EulerOS/openEuler 时，通过 `curl` 下载 Node.js 二进制 tar.xz 包（`remote-deploy.service.ts` 行 ~978 和 ~3127）：

- **主源**：`https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-$NODE_ARCH.tar.xz`
- **备源**：`https://npmmirror.com/mirrors/node/$NODE_VER/node-$NODE_VER-$NODE_ARCH.tar.xz`

#### 3. NodeSource 设置脚本（Debian/Ubuntu 和 RHEL/CentOS 系统）

对于 Debian/RHEL 系系统，通过 NodeSource 脚本安装 Node.js（`remote-deploy.service.ts` 行 ~978 和 ~3127）：

- **Debian/Ubuntu**：`curl -fsSL https://deb.nodesource.com/setup_20.x | bash -`
- **RHEL/CentOS**：`curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -`

> **注意**：NodeSource 脚本本身会从 nodesource 的 apt/yum 仓库下载 Node.js 包。在内网环境中，这些脚本无法正常工作。**当用户配置了自定义 Node.js 镜像时，应统一使用二进制 tarball 方式安装 Node.js（而非 NodeSource），这样所有 Linux 发行版都能使用同一个镜像源。**

### 问题

1. **硬编码镜像源无法适配内网**：npm registry 和 Node.js 下载地址写死在代码中，内网用户无法使用远程部署
2. **镜像源分散**：npm registry 在 5 处硬编码、Node.js 下载 URL 在 2 处硬编码，修改一处容易遗漏
3. **缺乏配置入口**：设置页面没有镜像源配置区域，用户无法自定义下载源
4. **NodeSource 在内网不可用**：Debian/RHEL 系统通过 NodeSource 脚本安装 Node.js，内网中无法访问 nodesource.com

### 目标用户

- 企业内网环境（无外网访问）的系统管理员
- 需要通过自建镜像源加速下载的用户

### 使用场景

1. **华为内网场景**：用户在华为内网环境中部署远程 Agent，需要将 npm registry 和 Node.js 下载源替换为华为内部镜像
2. **自定义私有镜像**：企业搭建了私有 npm registry 和 Node.js 镜像，希望部署时使用
3. **无特殊需求（默认）**：使用互联网默认源（当前行为），不做任何镜像配置

### 预期效果

- 用户在「远程服务器管理」设置区域中可以配置镜像源
- 提供预设方案（华为内网源），一键选择
- 支持自定义镜像源方案
- 配置 Node.js 镜像后，所有 Linux 发行版统一使用二进制 tarball 安装（绕过 NodeSource）
- 远程部署时自动使用已配置的镜像源
- 默认不配置镜像源，保持当前行为不变（向后兼容）

## 技术方案

### 架构概览

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Settings Page > 远程服务器管理                                           │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ MirrorSourceSection.tsx (新增组件)                                   │  │
│  │  - 镜像源方案选择（无配置 / 华为内网源 / 自定义）                        │  │
│  │  - 自定义方案编辑表单                                                  │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ AicoBotConfig (持久化)                                               │  │
│  │  deployMirror: {                                                     │  │
│  │    activeProfileId: string | null,  // null = 不配置镜像              │  │
│  │    profiles: MirrorSourceProfile[]                                   │  │
│  │  }                                                                   │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ remote-deploy.service.ts                                            │  │
│  │  - deployToServer() / deployAgentSDK() 读取 config.deployMirror     │  │
│  │  - npm config set registry 使用配置的 URL                            │  │
│  │  - Node.js 安装：配置镜像时统一用二进制 tarball（绕过 NodeSource）      │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ deploy-remote-agent.sh                                               │  │
│  │  - npm config set registry 使用传入的值（通过环境变量）                │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

### 1. 类型定义

**文件**：`src/shared/types/mirror-source.ts`（新增）

```typescript
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
  /** 各项镜像源 URL（空字符串表示使用默认值） */
  sources: MirrorSourceUrls;
}

/** 镜像源 URL 配置 */
export interface MirrorSourceUrls {
  /**
   * npm Registry 地址
   * 默认值（当前代码硬编码）: 'https://registry.npmmirror.com'
   * 影响: 所有 npm install 操作（项目依赖、SDK、Claude CLI、npx）
   */
  npmRegistry: string;

  /**
   * Node.js 二进制下载镜像（tarball URL 前缀）
   * 默认值（当前代码硬编码主源）: 'https://nodejs.org/dist/'
   * 影响: EulerOS/openEuler 系统安装 Node.js 二进制
   * 重要: 当配置了此值时，所有 Linux 发行版统一使用二进制 tarball 安装
   *       Node.js（绕过 NodeSource），格式为 '{prefix}v20.18.1/node-v20.18.1-{arch}.tar.xz'
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
```

### 2. 配置存储结构

在 `AicoBotConfig` 中新增 `deployMirror` 字段。

**文件**：`src/main/services/config.service.ts`（修改 `AicoBotConfig` interface）和 `src/renderer/types/index.ts`（同步修改）

```typescript
// 在 AicoBotConfig interface 中新增：
deployMirror?: {
  activeProfileId: string | null;
  profiles: Array<{
    id: string;
    name: string;
    isPreset: boolean;
    sources: {
      npmRegistry: string;
      nodeDownloadMirror: string;
    };
  }>;
};
```

**默认值**：`activeProfileId` 为 `null`，`profiles` 包含内置预设。首次加载配置时，如果 `deployMirror` 不存在，初始化为内置预设。

### 3. UI 设计

#### 3.1 组件结构

**文件**：`src/renderer/components/settings/MirrorSourceSection.tsx`（新增）

在设置页的「远程服务器管理」区域下方新增独立的镜像源配置区域。

#### 3.2 UI 布局

```
┌─────────────────────────────────────────────────────────────┐
│  镜像源配置                                                   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  当前方案: [▼ 不配置镜像源 (互联网默认)    ]                   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ ● 不配置镜像源                                       │   │
│  │   使用互联网默认源，适合有外网访问的环境                  │   │
│  │                                                      │   │
│  │ ● 华为内网源 (预设)                                   │   │
│  │   npm: registry.npmmirror.com                        │   │
│  │   Node.js: mirrors.huaweicloud.com/nodejs/           │   │
│  │                                                      │   │
│  │ ● 我的自定义源                                        │   │
│  │   npm: my-registry.example.com                       │   │
│  │                                                      │   │
│  │   [+ 新增自定义方案]                                   │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ── 选中方案详情（预设只读，自定义可编辑） ──                    │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 方案名称: [华为内网源          ] (预设不可编辑)        │   │
│  │                                                      │   │
│  │ npm Registry:                                        │   │
│  │ [https://registry.npmmirror.com          ]           │   │
│  │ 影响所有 npm install 操作                              │   │
│  │                                                      │   │
│  │ Node.js 下载镜像:                                     │   │
│  │ [https://mirrors.huaweicloud.com/nodejs/   ]         │   │
│  │ 配置后所有系统统一使用二进制包安装 Node.js               │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  [保存]                          (自定义方案: [删除方案])     │
└─────────────────────────────────────────────────────────────┘
```

#### 3.3 交互说明

1. **方案选择**：单选按钮组，选择「不配置镜像源」时下方详情区域折叠
2. **预设方案**：名称和 URL 只读展示，不可编辑
3. **自定义方案**：
   - 点击「+ 新增自定义方案」弹出输入名称的对话框
   - 名称和 2 个 URL 均可编辑
   - URL 字段为空时使用默认值（placeholder 提示默认值）
   - 可删除自定义方案（如果正在使用则提示先切换）
4. **保存行为**：保存到 `AicoBotConfig.deployMirror`，通过 `api.setConfig()` 持久化
5. **即时生效**：配置保存后，下次远程部署自动使用新的镜像源

#### 3.4 设置页集成

**文件**：`src/renderer/pages/SettingsPage.tsx`（修改）

在 `<RemoteServersSection />` 组件下方添加 `<MirrorSourceSection />`：

```tsx
{/* Remote Servers Section */}
<RemoteServersSection />

{/* Mirror Source Configuration Section */}
<section id="mirror-source" className="bg-card rounded-xl border border-border p-6">
  <h2 className="text-lg font-medium mb-4">{t('Mirror Source Config')}</h2>
  <MirrorSourceSection config={config} setConfig={setConfig} />
</section>
```

**注意**：不在 `nav-config.ts` 中新增导航项。镜像源配置作为「远程服务器管理」的子区域显示。

### 4. 部署集成方案

#### 4.1 配置读取

**文件**：`src/main/services/remote-deploy/remote-deploy.service.ts`（修改）

在 `RemoteDeployService` 中新增辅助方法：

```typescript
import type { MirrorSourceUrls } from '../../../shared/types/mirror-source';
import { DEFAULT_MIRROR_URLS } from '../../../shared/types/mirror-source';

/**
 * 获取当前激活的镜像源配置
 * 如果未配置镜像源，返回 null（表示使用代码中的默认值）
 */
private getActiveMirrorUrls(): MirrorSourceUrls | null {
  const config = getConfig();
  const mirrorConfig = config.deployMirror;
  if (!mirrorConfig || !mirrorConfig.activeProfileId) {
    return null;
  }
  const profile = mirrorConfig.profiles.find(p => p.id === mirrorConfig.activeProfileId);
  if (!profile) {
    return null;
  }
  return profile.sources;
}
```

#### 4.2 npm Registry 替换（5 处）

所有 `npm config set registry https://registry.npmmirror.com` 统一替换为：

```typescript
// 获取镜像源配置
const mirrorUrls = this.getActiveMirrorUrls();
const npmRegistry = mirrorUrls?.npmRegistry || DEFAULT_MIRROR_URLS.npmRegistry;
await manager.executeCommand(`npm config set registry ${escapeEnvValue(npmRegistry)}`);
```

涉及的 5 处位置：

| # | 文件 | 行号(约) | 方法 |
|---|------|---------|------|
| 1 | `remote-deploy.service.ts` | ~1119 | `deployToServer()` |
| 2 | `remote-deploy.service.ts` | ~3143 | `deployAgentSDK()` |
| 3 | `remote-deploy.service.ts` | ~3332 | `deployAgentSDK()` |
| 4 | `deploy-remote-agent.sh` | 152 | `install_claude_code_cli()` |
| 5 | `deploy-remote-agent.sh` | 176 | `install_dependencies()` |

#### 4.3 Node.js 安装命令改造（2 处，行 ~978 和 ~3127）

**核心逻辑变更**：当用户配置了 `nodeDownloadMirror` 时，**所有 Linux 发行版**统一使用二进制 tarball 方式安装 Node.js（绕过 NodeSource），而不是仅 EulerOS 才用 tarball。

```typescript
const mirrorUrls = this.getActiveMirrorUrls();
const nodeMirror = mirrorUrls?.nodeDownloadMirror || DEFAULT_MIRROR_URLS.nodeDownloadMirror;
const nodeFallback = 'https://npmmirror.com/mirrors/node/';

// 关键变化：当配置了自定义 Node.js 镜像时，所有系统都用二进制 tarball 安装
const useBinaryInstall = !!mirrorUrls?.nodeDownloadMirror;

const installNodeCmd = useBinaryInstall
  ? // 所有系统统一使用二进制 tarball 安装
    `ARCH=$(uname -m) && NODE_ARCH=$([ "$ARCH" = "aarch64" ] && echo "linux-arm64" || echo "linux-x64") && NODE_VER="v20.18.1" && if node --version > /dev/null 2>&1; then echo "Node.js already installed and working"; else echo "Using mirror: ${escapeEnvValue(nodeMirror)}" && rm -rf /usr/local/node-v* /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx 2>/dev/null && (curl -fsSL "${escapeEnvValue(nodeMirror)}$NODE_VER/node-$NODE_VER-$NODE_ARCH.tar.xz" -o /tmp/node.tar.xz || curl -fsSL "${escapeEnvValue(nodeFallback)}$NODE_VER/node-$NODE_VER-$NODE_ARCH.tar.xz" -o /tmp/node.tar.xz) && tar -xJf /tmp/node.tar.xz -C /usr/local && rm /tmp/node.tar.xz && ln -sf /usr/local/node-$NODE_VER-$NODE_ARCH/bin/node /usr/local/bin/node && ln -sf /usr/local/node-$NODE_VER-$NODE_ARCH/bin/npm /usr/local/bin/npm && ln -sf /usr/local/node-$NODE_VER-$NODE_ARCH/bin/npx /usr/local/bin/npx; fi`
  : // 未配置镜像：保持原有行为（Debian/RHEL 用 NodeSource，EulerOS 用 tarball）
    `ARCH=$(uname -m) && NODE_ARCH=$([ "$ARCH" = "aarch64" ] && echo "linux-arm64" || echo "linux-x64") && NODE_VER="v20.18.1" && if node --version > /dev/null 2>&1; then echo "Node.js already installed and working"; elif [ -f /etc/debian_version ]; then curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs; elif [ -f /etc/redhat-release ]; then curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && yum install -y nodejs; elif grep -qE "EulerOS|openEuler|hce" /etc/os-release 2>/dev/null; then ... (原有 EulerOS tarball 逻辑) ...; elif command -v apk > /dev/null 2>&1; then apk add nodejs npm; else echo "Unsupported OS" && exit 1; fi`;
```

#### 4.4 deploy-remote-agent.sh 修改

**文件**：`packages/remote-agent-proxy/scripts/deploy-remote-agent.sh`（修改）

由于 shell 脚本通过 SSH 执行，镜像源通过环境变量传递：

```bash
# 新增环境变量参数（第 7 个参数）
NPM_REGISTRY="${7:-https://registry.npmmirror.com}"

# 修改 install_claude_code_cli() 中的 npm registry 设置（行 152）：
npm config set registry ${NPM_REGISTRY}

# 修改 install_dependencies() 中的 npm registry 设置（行 176）：
npm config set registry ${NPM_REGISTRY}
```

> 注意：`deploy-remote-agent.sh` 主要是手动部署脚本，AICO-Bot 的 Electron 部署流程主要走 `remote-deploy.service.ts`。shell 脚本的修改是辅助性的，确保一致性。

### 5. IPC 通道

镜像源配置不需要独立的 IPC 通道。它通过现有的 `config:get` 和 `config:set` 通道读写 `AicoBotConfig.deployMirror` 字段。

### 6. 国际化

**文件**：`src/renderer/i18n/locales/*.json`（修改）

新增 key（以 `zh-CN.json` 为例）：

```json
{
  "Mirror Source Config": "镜像源配置",
  "Mirror source configuration for remote deployment": "远程部署镜像源配置",
  "mirror.noConfig": "不配置镜像源",
  "mirror.noConfigDesc": "使用互联网默认源，适合有外网访问的环境",
  "mirror.presetHuawei": "华为内网源 (预设)",
  "mirror.custom": "自定义源",
  "mirror.profileName": "方案名称",
  "mirror.npmRegistry": "npm Registry",
  "mirror.npmRegistryDesc": "影响所有 npm install 操作",
  "mirror.npmRegistryPlaceholder": "默认: https://registry.npmmirror.com",
  "mirror.nodeDownloadMirror": "Node.js 下载镜像",
  "mirror.nodeDownloadMirrorDesc": "配置后所有系统统一使用二进制包安装 Node.js",
  "mirror.nodeDownloadMirrorPlaceholder": "默认: https://nodejs.org/dist/",
  "mirror.addCustom": "新增自定义方案",
  "mirror.addCustomTitle": "创建自定义镜像源方案",
  "mirror.addCustomPlaceholder": "请输入方案名称",
  "mirror.save": "保存",
  "mirror.delete": "删除方案",
  "mirror.deleteConfirm": "确定删除方案「{{name}}」吗？",
  "mirror.deleteInUseConfirm": "方案「{{name}}」正在使用中，请先切换到其他方案",
  "mirror.saved": "镜像源配置已保存",
  "mirror.currentProfile": "当前方案"
}
```

### 7. 安全考虑

- **URL 验证**：用户输入的 URL 必须以 `http://` 或 `https://` 开头，否则拒绝保存
- **Shell 注入防护**：所有 URL 在拼接到 shell 命令前必须通过 `escapeEnvValue()` 转义（已有的工具函数）
- **无远程执行风险**：镜像源配置仅影响部署时 `npm install` 和 `curl` 下载的 URL，不涉及远程代码执行

## 涉及文件

| # | 文件 | 改动类型 | 说明 |
|---|------|---------|------|
| 1 | `src/shared/types/mirror-source.ts` | 新增 | 镜像源类型定义、预设常量、辅助函数 |
| 2 | `src/shared/types/index.ts` | 修改 | 导出 mirror-source 模块类型 |
| 3 | `src/main/services/config.service.ts` | 修改 | `AicoBotConfig` interface 新增 `deployMirror` 字段 |
| 4 | `src/renderer/types/index.ts` | 修改 | `AicoBotConfig` interface 新增 `deployMirror` 字段 |
| 5 | `src/renderer/components/settings/MirrorSourceSection.tsx` | 新增 | 镜像源配置 UI 组件 |
| 6 | `src/renderer/components/settings/index.ts` | 修改 | 导出 MirrorSourceSection |
| 7 | `src/renderer/pages/SettingsPage.tsx` | 修改 | 在远程服务器区域下方新增 MirrorSourceSection |
| 8 | `src/main/services/remote-deploy/remote-deploy.service.ts` | 修改 | 替换 5 处硬编码 npm registry + 改造 2 处 Node.js 安装命令 |
| 9 | `packages/remote-agent-proxy/scripts/deploy-remote-agent.sh` | 修改 | npm registry 参数化（2 处） |
| 10 | `src/renderer/i18n/locales/zh-CN.json` | 修改 | 新增镜像源相关中文翻译 |
| 11 | `src/renderer/i18n/locales/en.json` | 修改 | 新增镜像源相关英文翻译 |
| 12 | `src/renderer/i18n/locales/zh-TW.json` | 修改 | 新增镜像源相关繁体中文翻译 |
| 13 | `src/renderer/i18n/locales/ja.json` | 修改 | 新增镜像源相关日文翻译 |
| 14 | `src/renderer/i18n/locales/de.json` | 修改 | 新增镜像源相关德文翻译 |
| 15 | `src/renderer/i18n/locales/es.json` | 修改 | 新增镜像源相关西班牙文翻译 |
| 16 | `src/renderer/i18n/locales/fr.json` | 修改 | 新增镜像源相关法文翻译 |

## 开发前必读

### 模块设计文档

| # | 文档/文件 | 阅读目的 |
|---|---------|---------|
| 1 | `docs/Development-Standards-Guide.md` | 编码规范（TypeScript strict、禁止 any、纯类型导入、命名规范、i18n t() 使用） |
| 2 | `docs/vibecoding-doc-standard.md` | 文档管理规范（PRD 状态流转、changelog 更新规则） |

### 源码文件

| # | 文档/文件 | 阅读目的 |
|---|---------|---------|
| 3 | `src/shared/types/index.ts` | 理解共享类型导出方式 |
| 4 | `src/shared/types/ai-sources.ts` | 参考类型组织方式（内置预设 vs 用户自定义的模式） |
| 5 | `src/main/services/config.service.ts`（L309-389） | 理解 `AicoBotConfig` interface 定义和新增字段位置 |
| 6 | `src/renderer/types/index.ts`（L180-192） | 理解渲染进程的 `AicoBotConfig` 定义 |
| 7 | `src/renderer/components/settings/RemoteServersSection.tsx` | 理解远程服务器管理组件结构、UI 模式 |
| 8 | `src/renderer/components/settings/AISourcesSection.tsx` | 参考设置区域组件的通用模式（config 读写、保存逻辑） |
| 9 | `src/renderer/pages/SettingsPage.tsx` | 理解设置页布局，确认 MirrorSourceSection 插入位置 |
| 10 | `src/main/services/remote-deploy/remote-deploy.service.ts`（L970-990, L1115-1120, L3120-3145, L3325-3340） | 理解硬编码镜像 URL 的上下文，确认替换方案 |
| 11 | `packages/remote-agent-proxy/scripts/deploy-remote-agent.sh`（L140-188） | 理解 shell 脚本中 2 处 npm registry 硬编码 |
| 12 | `src/renderer/i18n/locales/zh-CN.json` | 理解 i18n key 的命名和组织方式 |

## 验收标准

- [ ] 设置页面「远程服务器管理」下方显示「镜像源配置」区域
- [ ] 默认方案为「不配置镜像源 (互联网默认)」
- [ ] 可选择「华为内网源」预设方案，显示其 npm registry、Node.js 镜像地址
- [ ] 预设方案名称和 URL 不可编辑
- [ ] 可新增自定义镜像源方案，输入名称后创建
- [ ] 自定义方案可编辑名称和所有 URL 字段
- [ ] 自定义方案可删除（使用中的方案删除时提示先切换）
- [ ] URL 输入验证：必须以 `http://` 或 `https://` 开头
- [ ] 保存配置后，配置持久化到 `AicoBotConfig.deployMirror`
- [ ] 重新打开设置页面后，配置正确恢复
- [ ] 远程部署时，`remote-deploy.service.ts` 中的 5 处 npm registry 使用配置的值
- [ ] 选择华为内网源后部署，`npm config set registry` 使用 `https://registry.npmmirror.com`
- [ ] 选择自定义 npm registry 后部署，使用用户配置的 registry URL
- [ ] 配置了 Node.js 镜像后部署，所有 Linux 发行版统一使用二进制 tarball 安装（绕过 NodeSource）
- [ ] 未配置 Node.js 镜像时部署，保持原有行为（Debian/RHEL 用 NodeSource，EulerOS 用 tarball）
- [ ] 所有用户可见文本使用 `t()` 国际化
- [ ] 所有 shell 拼接的 URL 经过 `escapeEnvValue()` 转义
- [ ] `npm run typecheck` 通过
- [ ] `npm run lint` 通过
- [ ] `npm run build` 通过
- [ ] `npm run i18n` 无新增未翻译 key

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-20 | 初稿 | @zhaoyinqi |
| 2026-04-21 | 修订：去掉 jq 等部署代码中不存在的配置项，对齐实际代码审计结果；仅保留 npm Registry 和 Node.js 下载镜像两项配置；Node.js 镜像配置后统一用二进制 tarball 安装绕过 NodeSource | @zhaoyinqi |
