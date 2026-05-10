---
时间: 2026-04-29
状态: done
指令人: misakamikoto
PRD 级别: feature
优先级: P1
---

# 用户配置异常引导

## 需求背景

AICO-Bot 的目标用户中有大量中国大陆用户，访问 GitHub API、Anthropic API 等外网服务通常需要配置网络代理。此外，技能市场（SkillMarket）需要 GitHub/GitCode PAT（Personal Access Token）才能正常拉取技能列表。

当前应用在以下两类配置缺失时，用户只能看到通用错误信息或静默失败，没有任何引导指向解决方案：

1. **网络代理未配置**：API 调用因网络问题（ECONNREFUSED、ETIMEDOUT、ENOTFOUND 等）失败时，用户看到 "Unknown error" 或 "Unexpected empty response"，无法判断是网络问题还是其他问题。
2. **GitHub/GitCode PAT 未配置**：SkillMarket 在 PAT 缺失时静默返回空列表，用户看到 "No skills found"，不知道需要去设置页面配置 Token。

## 问题分析

### 问题一：网络错误无引导

**现状分析**

| 环节 | 文件 | 当前行为 |
|------|------|---------|
| Agent 消息发送 | `src/main/services/agent/send-message.ts:745` | 所有错误统一处理为 `err.message \|\| "Unknown error"`，无网络错误分类 |
| 流式处理错误 | `src/main/services/agent/stream-processor.ts:1683-1695` | 错误真值表未区分网络错误，统一返回 "interrupted" 或 "empty response" |
| 技能市场 API 请求 | `src/main/services/skill/github-skill-source.service.ts:71` | `githubApiFetch` 使用原生 `fetch()`，不经过代理，网络失败时 throw generic Error |
| SDK 配置 | `src/main/services/agent/sdk-config.ts:486-487` | 仅设置 `NO_PROXY=localhost,127.0.0.1`，不校验代理配置是否存在 |
| 唯一的引导 | `src/main/services/agent/helpers.ts:218` | 仅 "No AI source configured" 一条引导，不覆盖网络问题 |

**根因**：错误处理缺乏按错误类型分类的机制。网络层错误（DNS 解析失败、连接被拒、超时）被当作通用错误处理，丢失了可操作性信息。

### 问题二：PAT 未配置无引导

**现状分析**

| 环节 | 文件 | 当前行为 |
|------|------|---------|
| GitHub 认证状态 | `src/main/services/github-auth.service.ts:379` | PAT 缺失返回 `{ authenticated: false }`，无原因说明 |
| GitCode 认证状态 | `src/main/services/gitcode-auth.service.ts:28` | PAT 缺失返回 `{ authenticated: false }`，无原因说明 |
| 技能市场加载 | `src/main/services/skill/skill-market-service.ts:728,810` | Token 为 undefined 时传入 `fetch`，API 返回 401/403 或网络错误 |
| 前端技能市场 UI | `src/renderer/components/skill/SkillMarket.tsx:787-791` | 空列表显示 "No skills found"，无 PAT 缺失提示 |
| 前端设置页面 | `src/renderer/components/settings/GitHubSection.tsx` | 已有 PAT 输入 UI，但技能市场无跳转入口 |

**根因**：SkillMarket 加载失败时未区分"PAT 未配置"和"网络/其他错误"两种情况，前端也没有检查认证状态的机制。

## 技术方案

### 场景一：网络错误引导

#### 1. 新建网络错误分类工具函数

**文件**：`src/main/services/agent/error-classifier.ts`（新建）

```typescript
/**
 * 网络错误分类结果
 */
interface ClassifiedError {
  type: 'network' | 'auth' | 'config' | 'mcp' | 'unknown';
  isNetworkError: boolean;
  userMessage: string;  // i18n key 或直接用户可读消息
  technicalMessage: string; // 原始错误信息，用于日志
}

/**
 * 分类错误类型并返回用户友好消息
 * - network: ECONNREFUSED, ETIMEDOUT, ENOTFOUND, ENETUNREACH, EPIPE, ECONNRESET
 *   以及 proxy 相关的错误（EPROTO bad Gateway, SOCKS 等）
 * - auth: 401, 403 API errors
 * - config: "No AI source configured" 等
 * - mcp: MCP server 连接/配置错误
 * - unknown: 其他错误
 */
function classifyError(error: unknown): ClassifiedError
```

网络错误判断规则：
- Node.js 系统错误 code：`ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, `ENETUNREACH`, `EPIPE`, `ECONNRESET`
- 错误消息包含：`network`, `proxy`, `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, `SOCKS`, `tunnel`, `socket hang up`, `connect ETIMEDOUT`
- 错误消息包含：`ENOTFOUND` 且域名非 localhost

网络错误的用户消息引导内容（中英文）：
- "网络连接失败，请检查网络代理配置。请在系统环境变量中设置 HTTP_PROXY / HTTPS_PROXY。"
- "Network connection failed. Please check your proxy configuration. Set HTTP_PROXY / HTTPS_PROXY in system environment variables."

#### 2. 增强 send-message.ts 错误处理

**文件**：`src/main/services/agent/send-message.ts`

在现有 catch 块（687-807 行）中，在 Windows Git Bash 检查之前，插入网络错误分类逻辑：

```
当前流程:
catch error → 检查 AbortError → 设置 errorMessage → Windows 检查 → stderr 提取 → 发送

新增流程:
catch error → 检查 AbortError → classifyError(error)
  → 如果是网络错误：使用 classifyError 返回的 userMessage
  → 否则：走现有流程（Windows 检查 → stderr 提取）
→ 发送
```

关键点：
- `classifyError` 在 stderr 提取之前执行，因为 stderr 可能包含有用信息，但网络错误的优先级更高
- 网络错误消息替代原始 `err.message`，但仍记录原始错误到日志
- 保持 AbortError 处理不变

#### 3. 增强流式处理错误检测

**文件**：`src/main/services/agent/stream-processor.ts`

在 `getInterruptedErrorMessage()` 函数（1683-1695 行）中，当检测到 `error_during_execution` 或 `empty response` 时，检查 error thought 内容是否包含网络错误关键字：

- 如果 error thought 内容包含网络关键字 → 返回网络错误引导消息替代 "interrupted" / "empty response"
- 新增 helper 函数 `extractNetworkErrorHint(thoughtContent: string): string | null`

#### 4. 技能市场 API 请求增加网络错误提示

**文件**：`src/main/services/skill/github-skill-source.service.ts`

`githubApiFetch` 函数（62-96 行）新增 try/catch 包裹 fetch 调用：
- 捕获网络错误后，使用 `classifyError` 生成用户友好消息
- 将错误类型信息附加到 throw 的 Error 中，供上层 skill-market-service.ts 使用

**文件**：`src/main/services/skill/skill-market-service.ts`

`fetchFromGitHubRepo`（728 行）和 `fetchFromGitCodeRepo`（810 行）：
- 在 catch 块中，当 token 未配置（`!token`）且请求失败时，附加 PAT 未配置的提示信息
- 在 catch 块中，当检测到网络错误时，附加代理配置的提示信息

### 场景二：PAT 缺失引导

#### 1. 技能市场增加认证状态检查

**文件**：`src/main/services/skill/skill-market-service.ts`

新增公开方法 `getSourceAuthStatus()`，返回当前活跃源（GitHub/GitCode）的认证状态：
```typescript
async getSourceAuthStatus(): Promise<{
  sourceType: 'github' | 'gitcode' | 'skills.sh';
  authenticated: boolean;
  reason?: 'no_pat' | 'invalid_pat' | 'network_error';
}>
```

#### 2. IPC 暴露认证状态查询

**文件**：`src/main/ipc/skill.ts`（或对应的 skill IPC handler 文件）

新增 IPC handler：`skill:market:auth-status`，调用 `getSourceAuthStatus()` 返回结果。

#### 3. Preload 暴露

**文件**：`src/preload/index.ts`

在 skill 相关的 API 中添加 `getMarketAuthStatus` 方法。

#### 4. Renderer API 层

**文件**：`src/renderer/api/index.ts` 和 `src/renderer/api/transport.ts`

添加 `skillMarketAuthStatus()` 方法。

#### 5. 技能市场 UI 增强

**文件**：`src/renderer/components/skill/SkillMarket.tsx`

在 `loadSkills` 初始化时，同时查询认证状态：

- 当 `authenticated === false && reason === 'no_pat'` 时：
  - 在技能列表顶部显示一个 **醒目的警告横幅**（黄色/橙色背景）
  - 文案："GitHub/GitCode PAT 未配置，技能列表可能无法加载。请前往 设置 > GitHub/GitCode 配置。"
  - 包含一个 **"前往设置"按钮**，点击导航到设置页面
- 当 `authenticated === false && reason === 'invalid_pat'` 时：
  - 显示警告："Token 已失效，请重新配置。"
- 当加载失败且错误为网络类型时：
  - 显示提示："网络连接失败，请检查网络代理配置。"

导航到设置页面的实现：
```typescript
import { useNavigate } from 'react-router-dom';
// 或者通过 store 中的 navigateToSettings 方法
const navigate = useNavigate();
navigate('/settings?tab=github'); // 或 gitcode
```

#### 6. 空列表状态优化

当 skills 为空但不是因为错误时（正常空列表），保留现有 "No skills found" 显示。
当 skills 为空且 `loadError` 包含网络/PAT 相关错误时，显示对应的引导信息。

### 场景一 + 场景二：i18n 国际化

**文件**：`src/renderer/i18n/locales/en.json` 和 `src/renderer/i18n/locales/zh-CN.json`

新增以下 i18n key（示例）：

| Key | en | zh-CN |
|-----|----|-------|
| `error.network.failed` | Network connection failed. Please check your proxy settings. | 网络连接失败，请检查网络代理配置。 |
| `error.network.proxy.hint` | Set HTTP_PROXY / HTTPS_PROXY environment variables and restart the app. | 请在系统环境变量中设置 HTTP_PROXY / HTTPS_PROXY 后重启应用。 |
| `error.pat.notConfigured` | {source} PAT not configured. Skill list may not load. | {source} PAT 未配置，技能列表可能无法加载。 |
| `error.pat.goToSettings` | Go to Settings | 前往设置 |
| `error.pat.invalidToken` | Token is invalid or expired. Please reconfigure. | Token 已失效或过期，请重新配置。 |
| `error.skillMarket.networkError` | Failed to load skills due to network issues. | 因网络问题无法加载技能列表。 |
| `error.skillMarket.patMissing` | Please configure your {source} PAT in Settings to load skills. | 请在设置中配置 {source} PAT 以加载技能。 |

> **注意**：主进程的错误消息需要以硬编码方式提供中英文（主进程不使用 i18n 系统），或使用 locale 检测来选择语言。

### 不在范围内

- **不新增代理配置 UI**：应用当前依赖系统环境变量（HTTP_PROXY, HTTPS_PROXY），本 PRD 仅增加引导提示，不新增代理设置界面
- **不修改代理传递逻辑**：`sdk-config.ts` 中 NO_PROXY 配置保持不变
- **不修改 fetch 的代理支持**：`githubApiFetch` 不在本 PRD 中增加 proxy agent 支持（可作为后续 PRD）

## 开发前必读

| 类别 | 文件 | 阅读目的 |
|------|------|---------|
| 模块设计文档 | `.project/modules/agent/agent-core-v1.md` | 了解 Agent 模块整体架构、IPC 通道定义、内部组件关系 |
| 模块设计文档 | `.project/modules/settings/settings-v1.md` | 了解设置系统架构、配置管理方式、设置页面组件结构 |
| 功能设计文档 | `.project/modules/agent/features/message-send/design.md` | 了解消息发送流程、异常处理路径、认证重试机制 |
| 功能设计文档 | `.project/modules/agent/features/stream-processing/design.md` | 了解流式处理错误真值表、中断检测逻辑、错误通知机制 |
| 源码文件 | `src/main/services/agent/send-message.ts:687-807` | 理解当前错误处理 catch 块的完整逻辑，确定插入网络分类的位置 |
| 源码文件 | `src/main/services/agent/stream-processor.ts:1580-1710` | 理解错误真值表和 `getInterruptedErrorMessage()` 函数 |
| 源码文件 | `src/main/services/agent/helpers.ts:200-240` | 理解凭证获取流程和 "No AI source configured" 错误产生位置 |
| 源码文件 | `src/main/services/skill/github-skill-source.service.ts:62-96` | 理解 `githubApiFetch` 的错误处理（当前无 try/catch） |
| 源码文件 | `src/main/services/skill/skill-market-service.ts:700-850` | 理解 GitHub/GitCode 仓库源加载逻辑和错误传播路径 |
| 源码文件 | `src/main/services/github-auth.service.ts:370-393` | 理解 GitHub PAT 认证状态返回格式 |
| 源码文件 | `src/main/services/gitcode-auth.service.ts:25-50` | 理解 GitCode PAT 认证状态返回格式 |
| 源码文件 | `src/renderer/components/skill/SkillMarket.tsx:374-430,770-800` | 理解前端 loadSkills 流程和空列表/错误状态 UI |
| 源码文件 | `src/renderer/components/settings/GitHubSection.tsx:1-55` | 理解 GitHub 设置页面 PAT 输入 UI 结构 |
| 源码文件 | `src/renderer/components/settings/GitCodeSection.tsx` | 理解 GitCode 设置页面 PAT 输入 UI 结构 |
| 源码文件 | `src/main/services/agent/sdk-config.ts:486-487` | 理解当前 NO_PROXY 配置，确认不在本 PRD 修改范围 |
| 源码文件 | `src/preload/index.ts` | 理解 preload 暴露 API 的模式，用于新增 auth-status 通道 |
| 源码文件 | `src/renderer/api/index.ts` | 理解 renderer API 层结构，用于新增 `skillMarketAuthStatus` |
| 源码文件 | `src/renderer/api/transport.ts` | 理解 IPC/HTTP 双模式 transport，用于注册新方法 |
| 编码规范 | `docs/Development-Standards-Guide.md` | 遵循 TypeScript strict、命名规范、IPC 通道常量化等编码规则 |

## 涉及文件

> 实际修改清单（简化方案，未新增 IPC 通道）

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `src/main/services/agent/error-classifier.ts` | **新建** | 网络错误分类工具函数 `classifyError()` + `extractNetworkErrorHint()` |
| `src/main/services/agent/send-message.ts` | 修改 | catch 块中插入 `classifyError()` 网络错误分类，网络错误时使用友好消息 |
| `src/main/services/agent/stream-processor.ts` | 修改 | `getInterruptedErrorMessage()` 中检查 error thought 是否包含网络关键字 |
| `src/main/services/skill/skill-market-service.ts` | 修改 | `fetchFromGitHubRepo`/`fetchFromGitCodeRepo` 增加 PAT 缺失和网络错误的友好提示 |
| `src/renderer/components/skill/SkillMarket.tsx` | 修改 | 新增 `classifySkillMarketError()` + 黄色警告横幅 + "前往设置"按钮 |
| `src/renderer/i18n/locales/en.json` | 修改 | 新增 `Go to Settings` key |
| `src/renderer/i18n/locales/zh-CN.json` | 修改 | 新增 `前往设置` key |

## 验收标准

### 场景一：网络错误引导

- [ ] **1.1** 当 Claude API 调用因网络错误（ECONNREFUSED、ETIMEDOUT、ENOTFOUND）失败时，聊天界面显示明确的网络错误引导消息（而非 "Unknown error"）
- [ ] **1.2** 网络错误消息包含代理配置提示（"请设置 HTTP_PROXY / HTTPS_PROXY 环境变量"）
- [ ] **1.3** 当流式处理过程中出现网络中断（error_during_execution 且内容含网络关键字），显示网络错误引导而非 "interrupted unexpectedly"
- [ ] **1.4** 当技能市场 GitHub/GitCode 源因网络问题加载失败时，错误消息包含网络问题提示（而非通用的 "Failed to load skills"）
- [ ] **1.5** 非网络类错误（如 MCP 配置错误、权限错误）的错误消息保持原有行为不变，不受影响
- [ ] **1.6** AbortError（用户主动停止）的处理逻辑不受影响

### 场景二：PAT 缺失引导

- [ ] **2.1** 技能市场使用 GitHub 源且 PAT 未配置时，列表顶部显示醒目的黄色警告横幅，提示用户配置 PAT
- [ ] **2.2** 技能市场使用 GitCode 源且 PAT 未配置时，列表顶部显示醒目的黄色警告横幅，提示用户配置 PAT
- [ ] **2.3** 警告横幅包含"前往设置"按钮，点击可导航到对应的设置页面（GitHub 或 GitCode）
- [ ] **2.4** 当 PAT 已配置但 Token 无效/过期时，显示"Token 已失效"的提示
- [ ] **2.5** PAT 已正确配置且认证成功时，不显示任何警告横幅
- [ ] **2.6** 技能市场使用 skills.sh 源时，不显示 PAT 相关警告（skills.sh 不需要 PAT）

### 通用

- [ ] **3.1** 所有新增用户可见文本均有中英文 i18n 翻译
- [ ] **3.2** 主进程中使用的错误消息包含中英文（主进程无 i18n 系统）
- [ ] **3.3** `npm run typecheck && npm run lint && npm run build` 全部通过
- [ ] **3.4** `npm run i18n` 执行成功，提取并翻译新增的 i18n key
- [ ] **3.5** IPC 通道常量化，handler 有 try/catch + `{ success, data/error }` 返回格式
- [ ] **3.6** 编辑后运行 `npx eslint --fix <file>` 并 re-read 确认逻辑未被覆盖
