# PRD [功能级] -- 网络代理配置

> 版本：network-proxy-v1
> 日期：2026-04-24
> 指令人：MoonSeeker
> 归属模块：settings + main/services
> 状态：in-progress
> 优先级：P1

## 需求分析

### 背景

AICO-Bot 是一个 Electron 桌面应用，在国内网络环境下经常需要通过 HTTP/HTTPS 代理访问外部 API。当前存在以下问题：

1. **GitCode API**（`gitcode-skill-source.service.ts`）仅通过 `process.env.HTTPS_PROXY` / `process.env.HTTP_PROXY` 环境变量获取代理配置，已实现了 `undici.ProxyAgent` 支持，但用户无法通过 UI 配置代理地址。
2. **GitHub API**（`github-skill-source.service.ts`）的 `githubApiFetch` 和 `fetchSkillFileContent` 直接使用原生 `fetch`，完全没有代理支持。
3. **Skill Market**（`skill-market-service.ts`）的多个 `fetch` 调用无代理支持。
4. **API 验证服务**（`api-validator.service.ts`）的 `fetch` 调用无代理支持。
5. **GitHub Copilot Provider**（`github-copilot.provider.ts`）的多个 `fetch` 调用无代理支持。
6. **服务探针**（`health-checker/probes/service-probe.ts`）的 `fetch` 调用无代理支持。

Electron 主进程不会自动继承系统代理环境变量（尤其是 Windows 平台），导致用户在国内网络环境下上述 API 请求全部失败。

### 问题

1. **无 UI 配置入口**：用户无法在应用内设置代理，必须手动设置环境变量后重启应用，体验极差
2. **代理覆盖不全**：即使设置了环境变量，也只有 GitCode 服务能走代理，其余服务（GitHub、Skill Market、API 验证等）全部直连
3. **无代理验证**：用户不知道配置的代理是否生效

### 预期效果

- 在设置页「系统」区域新增「网络代理」配置项，用户可输入一个代理地址（HTTP/HTTPS/SOCKS5）
- **该代理对所有外部请求（http:// 和 https:// 目标）均生效**，不区分目标协议
- 配置保存后，对 GitCode、GitHub、Skill Market、API 验证、GitHub Copilot 等所有外部请求生效
- 提供「测试连接」按钮，验证代理是否可用
- 代理地址为空时走直连，不影响正常使用

## 技术方案

### 1. 配置模型扩展

在 `AicoBotConfig` 中新增 `network` 字段：

```typescript
// src/renderer/types/index.ts
export interface NetworkConfig {
  /** 代理地址，格式: http://host:port / https://host:port / socks5://host:port。对所有 http 和 https 目标请求均生效 */
  proxyUrl: string;
  /** 是否启用代理 */
  enabled: boolean;
}

export interface AicoBotConfig {
  // ... 现有字段 ...
  network?: NetworkConfig;
}
```

### 2. 代理注入层 — 核心

创建一个统一的代理工具模块 `src/main/services/proxy/proxy-agent.ts`，为所有外部 HTTP 请求提供代理 dispatcher：

```typescript
// src/main/services/proxy/proxy-agent.ts
import { getDecryptedConfig } from '../config.service';

let _cachedDispatcher: any = null;
let _cachedProxyUrl: string | null = null;

/**
 * 获取代理 dispatcher（带缓存）。
 * 如果未配置代理或代理已禁用，返回 null（直连）。
 */
export async function getProxyDispatcher(): Promise<any | null>;

/**
 * 使缓存失效（代理配置变更时调用）。
 */
export function invalidateProxyCache(): void;

/**
 * 获取当前代理配置信息。
 */
export function getProxyConfig(): { enabled: boolean; proxyUrl: string };
```

实现要点：
- 读取 `config.network` 中的 `proxyUrl` 和 `enabled`
- 使用 `undici.ProxyAgent` 创建 dispatcher（项目已有 undici 依赖，GitCode 服务已使用）
- 支持 `http://`、`https://`、`socks5://` 协议（socks5 需要 `undici` v6+ 或 `socks-proxy-agent`）
- 缓存 dispatcher 实例，代理配置变更时通过 `invalidateProxyCache()` 清除缓存
- 代理 URL 为空或 `enabled === false` 时返回 `null`

### 3. 全局 fetch 封装

创建 `src/main/services/proxy/proxy-fetch.ts`，提供统一的 proxy-aware fetch：

```typescript
// src/main/services/proxy/proxy-fetch.ts
/**
 * 带 proxy 支持的 fetch 封装。
 * 自动从配置中读取代理设置，注入 undici dispatcher。
 * 所有主进程外部 HTTP 请求都应使用此方法。
 */
export async function proxyFetch(url: string, init?: RequestInit): Promise<Response>;
```

### 4. 前端 UI

在 `SystemSection.tsx` 的「系统」区域中新增「网络代理」子区块，位于「Max Turns per Message」和「Log Files」之间：

UI 布局：
```
┌─────────────────────────────────────────────────┐
│ 网络代理                                        │
│ 通过代理服务器访问外部 API                         │
│                                                 │
│ [x] 启用代理                                     │
│ 代理地址: [http://127.0.0.1:7890        ] [测试] │
│ 提示: 支持 HTTP/HTTPS/SOCKS5 代理                │
└─────────────────────────────────────────────────┘
```

- Toggle 开关：启用/禁用代理
- 文本输入框：代理地址（placeholder: `http://host:port`）
- 「测试」按钮：验证代理是否可用（通过代理请求 `https://httpbin.org/ip` 或类似端点）
- 保存方式：与现有配置一致，通过 `api.setConfig({ network: {...} })` 保存

### 5. 服务适配

将以下服务中的原生 `fetch` 调用替换为 `proxyFetch`：

| 服务文件 | 当前 fetch 位置 | 改造方式 |
|----------|----------------|---------|
| `gitcode-skill-source.service.ts` | `gitcodeFetch()` 函数 | 复用已有的 `getProxyDispatcher`，改为从 proxy 模块读取配置 |
| `github-skill-source.service.ts` | `githubApiFetch()`、`fetchSkillFileContent()`、`pushSkillAsPR()` 中的 fetch | 改用 `proxyFetch` |
| `skill-market-service.ts` | 多处 `fetch('https://skills.sh', ...)` | 改用 `proxyFetch` |
| `api-validator.service.ts` | `fetchModelsFromApi()` 中的 fetch | 改用 `proxyFetch` |
| `github-copilot.provider.ts` | 多处 fetch（COPILOT_MODELS_URL、GITHUB_DEVICE_CODE_URL 等） | 改用 `proxyFetch` |
| `health-checker/probes/service-probe.ts` | 探针 fetch | 改用 `proxyFetch` |

### 6. GitCode 服务改造

`gitcode-skill-source.service.ts` 已有 `getProxyDispatcher()` 函数，当前仅从环境变量读取。改造方案：
- 删除现有的 `getProxyDispatcher()` / `resetProxyDispatcher()` 函数
- 将 `gitcodeFetch()` 改用统一的 `proxyFetch()`
- 或者：让现有的 `getProxyDispatcher()` 内部调用 `proxy/proxy-agent.ts`，优先从用户配置读取，回退到环境变量

### 7. 代理连接测试 IPC

新增 IPC 通道用于代理连接测试：

```
通道名: config:test-proxy
输入: { proxyUrl: string }
输出: { success: boolean, data?: { ip: string, proxyIp?: string }, error?: string }
```

测试逻辑：分别直连和通过代理请求 `https://httpbin.org/ip`，比较返回的 IP 地址，确认代理生效。

### 8. 默认值

```typescript
// DEFAULT_CONFIG 扩展
const DEFAULT_CONFIG: AicoBotConfig = {
  // ... 现有字段 ...
  network: {
    proxyUrl: '',
    enabled: false,
  },
};
```

## 开发前必读

| 类型 | 文件 | 阅读目的 |
|------|------|---------|
| 模块设计文档 | `.project/modules/settings/settings-v1.md` | 理解设置模块架构、配置管理流程、IPC 通道规范 |
| 模块设计文档 | `.project/modules/settings/features/system-settings/design.md` | 理解系统设置区域的现有实现和交互模式 |
| 模块设计文档 | `.project/modules/settings/features/settings-page/design.md` | 理解设置页面布局、导航机制 |
| 源码文件 | `src/main/services/config.service.ts` | 理解配置持久化、`getConfig()` / `saveConfig()` 逻辑 |
| 源码文件 | `src/main/services/skill/gitcode-skill-source.service.ts` | 理解现有代理实现（`getProxyDispatcher`、`gitcodeFetch`），确定改造策略 |
| 源码文件 | `src/main/services/skill/github-skill-source.service.ts` | 理解 GitHub API fetch 模式，确定适配点 |
| 源码文件 | `src/main/services/skill/skill-market-service.ts` | 理解 Skill Market fetch 调用位置 |
| 源码文件 | `src/main/services/api-validator.service.ts` | 理解 API 验证 fetch 调用 |
| 源码文件 | `src/main/services/ai-sources/providers/github-copilot.provider.ts` | 理解 GitHub Copilot fetch 调用 |
| 源码文件 | `src/renderer/types/index.ts` | 理解 `AicoBotConfig` 类型定义，确定扩展点 |
| 源码文件 | `src/renderer/components/settings/SystemSection.tsx` | 理解系统设置区域现有 UI 结构 |
| 源码文件 | `src/renderer/components/settings/nav-config.ts` | 理解导航配置（本次无需新增导航项，网络代理嵌入 System 区块） |
| 源码文件 | `src/main/ipc/config.ts` | 理解 IPC handler 注册模式 |
| 源码文件 | `src/preload/index.ts` | 理解 preload API 暴露方式 |
| 源码文件 | `src/renderer/api/index.ts` | 理解渲染器 API 层封装 |
| 编码规范 | `docs/Development-Standards-Guide.md` | TypeScript strict、IPC 常量化、UI 国际化等编码规范 |

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/services/proxy/proxy-agent.ts` | 新增 | 代理 dispatcher 管理（缓存、配置读取、失效） |
| `src/main/services/proxy/proxy-fetch.ts` | 新增 | 统一的 proxy-aware fetch 封装 |
| `src/main/services/proxy/index.ts` | 新增 | 代理模块导出 |
| `src/renderer/types/index.ts` | 修改 | 新增 `NetworkConfig` 类型，扩展 `AicoBotConfig` |
| `src/main/services/config.service.ts` | 修改 | 确保 `getDecryptedConfig` 能读取 `network` 字段 |
| `src/renderer/components/settings/SystemSection.tsx` | 修改 | 新增网络代理配置 UI（toggle + input + test button） |
| `src/main/services/skill/gitcode-skill-source.service.ts` | 修改 | 改造 `getProxyDispatcher`，从用户配置优先读取代理 |
| `src/main/services/skill/github-skill-source.service.ts` | 修改 | `githubApiFetch` / `fetchSkillFileContent` / `pushSkillAsPR` 使用 `proxyFetch` |
| `src/main/services/skill/skill-market-service.ts` | 修改 | 所有 fetch 调用改用 `proxyFetch` |
| `src/main/services/api-validator.service.ts` | 修改 | fetch 调用改用 `proxyFetch` |
| `src/main/services/ai-sources/providers/github-copilot.provider.ts` | 修改 | 所有 fetch 调用改用 `proxyFetch` |
| `src/main/services/health/health-checker/probes/service-probe.ts` | 修改 | fetch 调用改用 `proxyFetch` |
| `src/main/ipc/config.ts` | 修改 | 新增 `config:test-proxy` IPC handler |
| `src/preload/index.ts` | 修改 | 暴露 `testProxy` API |
| `src/renderer/api/index.ts` | 修改 | 新增 `testProxy` API 方法 |
| `src/renderer/api/transport.ts` | 修改 | 新增 `testProxy` transport 映射 |
| `src/renderer/components/settings/index.ts` | 修改 | 导出新增组件（如独立为 NetworkSection） |
| `src/renderer/i18n/locales/zh-CN.json` | 修改 | 新增网络代理相关中文翻译 |
| `src/renderer/i18n/locales/en.json` | 修改 | 新增网络代理相关英文翻译 |
| `src/renderer/i18n/locales/*.json` | 修改 | 其余 5 种语言翻译（通过 `npm run i18n` 自动生成） |

## 验收标准

- [ ] 设置页「系统」区域新增「网络代理」配置区块（toggle + 代理地址输入框 + 测试按钮）
- [ ] 代理地址格式校验：输入非空时校验 URL 格式（`http://`、`https://`、`socks5://`），不合法时提示错误
- [ ] 代理配置通过 `api.setConfig({ network: {...} })` 持久化，重启应用后配置保留
- [ ] GitCode API 请求（技能列表、文件内容、MR 创建）走配置的代理
- [ ] GitHub API 请求（技能列表、文件内容、PR 创建）走配置的代理
- [ ] Skill Market 请求走配置的代理
- [ ] API 验证请求走配置的代理
- [ ] GitHub Copilot Provider 请求走配置的代理
- [ ] 代理禁用（toggle 关闭）或代理地址为空时，所有请求直连，功能不受影响
- [ ] 「测试」按钮点击后返回代理连接结果（成功/失败 + IP 信息），超时 10s 内响应
- [ ] 代理配置变更后，已有缓存的 dispatcher 失效，下次请求使用新配置
- [ ] TypeScript 类型检查通过（`npm run typecheck`）
- [ ] ESLint 检查通过（`npm run lint`）
- [ ] 构建通过（`npm run build`）
- [ ] 国际化：新增文本通过 `npm run i18n` 提取和翻译
- [ ] UI 文本不硬编码，全部使用 `t()` 函数
