# PRD [模块级] — services 目录大文件拆分重构

> 版本：services-refactor-v2
> 日期：2026-05-06
> 状态：done
> 指令人：@moonseeker
> 归属模块：codebase（工程基础设施）
> 优先级：P1
> 影响范围：全栈（主进程 import 路径更新，编译验证）

## 前置 PRD

本 PRD 是 `services-refactor-v1`（已完成）的后续。v1 将散落的顶层 `.ts` 文件收敛到子目录中；本 PRD 专注于拆分子目录内的超大文件（>1000 行），按功能职责拆分为独立模块。

## 需求分析

### 现状

经过 v1 重构后，`src/main/services/` 的子目录已形成清晰模块边界，但部分子目录内仍存在超大单文件：

| 文件 | 行数 | 模块 |
|------|------|------|
| `remote-deploy/remote-deploy.service.ts` | 4,915 | remote-deploy |
| `agent/orchestrator.ts` | 3,673 | agent |
| `agent/send-message.ts` | 1,771 | agent |
| `agent/stream-processor.ts` | 1,721 | agent |
| `ai-browser/context.ts` | 1,634 | ai-browser |
| `ai-browser/sdk-mcp-server.ts` | 1,603 | ai-browser |
| `remote-ws/remote-ws-client.ts` | 1,261 | remote-ws |
| `skill/gitcode-skill-source.service.ts` | 1,104 | skill |
| `agent/session-manager.ts` | 1,098 | agent |
| `gh-search/sdk-mcp-server.ts` | 1,082 | gh-search |
| `skill/github-skill-source.service.ts` | 1,028 | skill |

### 问题

1. **维护困难**：单个文件超过 1000 行（最大 4915 行），IDE 打开和搜索缓慢
2. **职责不清**：一个文件承载多种不相关的功能区域，难以快速定位代码
3. **协作冲突**：多人修改同一超大文件时 Git 冲突概率极高
4. **测试困难**：无法针对单一功能区域独立编写测试

### 目标

将 11 个超大文件按功能职责拆分为独立子文件，原文件变为薄聚合层（re-export），保持向后兼容。**纯重构，功能零变更。**

## 技术方案

### 拆分原则

1. **单一职责**：每个子文件只负责一个明确的功能领域
2. **向后兼容**：原文件变为薄聚合层，re-export 所有公开 API
3. **命名清晰**：新文件名体现其职责
4. **验证通过**：拆分后必须 `npm run typecheck && npm run build` 通过
5. **不改变外部 API**：IPC 接口、模块导出保持不变

### 拆分方案

---

#### 批次 1：agent 模块（4 个文件，共 8,265 行）

##### 1.1 `agent/orchestrator.ts`（3,673 行 → 5 个子文件）

**现有内部结构分析**：

| 功能区域 | 行范围 | 方法数 |
|---------|--------|-------|
| Types（接口定义） | 39-94 | 5 个 interface/type |
| Team Management | 185-1196 | 8 个方法 |
| Team Configuration | 1198-1255 | 2 个方法 |
| Persistent Worker Management | 1257-1332 | 5 个方法 |
| Task Dispatching | 1333-1592 | 5 个方法 |
| Task Status Management | 1593-1640 | 3 个方法 |
| Announcement System | 1641-1854 | 2 个方法 |
| Utility Methods | 1855-1911 | 3 个方法 |
| Task Execution（本地/远程） | 1912-2663 | 6 个方法 |
| Stall Detection | 2665-2787 | 5 个方法 |
| Inter-Agent Messaging | 2788-3219 | 3 个方法 |
| Announcement Injection | 3220-3398 | 3 个方法 |
| Hyper Space Tool Call Handler | 3399-3603 | 1 个方法 |
| Worker Proactive Communication | 3604-3673 | 1 个方法 |

**拆分方案**：

| 新文件 | 职责 | 行数（估） | 导出 |
|--------|------|-----------|------|
| `orchestrator/types.ts` | AgentInstance、AgentTeam、OrchestratorEvent、StallDetectionConfig 等类型定义 | ~60 | 类型导出 |
| `orchestrator/team-lifecycle.ts` | 团队创建/销毁/查询、成员增删、配置更新、持久 Worker 管理 | ~600 | 函数（挂载到 orchestrator 实例） |
| `orchestrator/task-execution.ts` | 任务分发（dispatch/routing）、子任务执行（本地+远程）、结果聚合、Subagent prompt 构建 | ~1,400 | 函数 |
| `orchestrator/stall-detection.ts` | 停滞检测定时器、心跳超时、任务超时检查 | ~150 | 函数 |
| `orchestrator/messaging.ts` | 代理间消息传递（sendAgentMessage、broadcastAgentMessage）、公告注入、Worker 主动汇报 | ~800 | 函数 |

**orchestrator.ts 变为薄聚合层**（~200 行）：
- re-export 所有类型
- 定义 AgentOrchestrator 类，import 各子模块的方法
- 保持 `agentOrchestrator` 单例导出

**注意**：由于 orchestrator 是单例类，拆分需要将方法提取为独立函数，接受 orchestrator 实例（`this`）作为参数。替代方案：使用 mixin 模式或直接在 orchestrator.ts 中调用子模块函数。

##### 1.2 `agent/send-message.ts`（1,771 行 → 2 个子文件）

**现有结构**：

| 功能区域 | 行范围 | 说明 |
|---------|--------|------|
| sendMessage（本地执行） | 100-820 | 本地 Agent 消息发送、会话创建、流式处理 |
| executeRemoteMessage（远程执行） | 821-1771 | 远程 Agent 消息发送、WebSocket 连接、远程流式转发 |

**拆分方案**：

| 新文件 | 职责 | 行数（估） |
|--------|------|-----------|
| `agent/send-message-local.ts` | 本地 Agent 消息发送（sendMessage 函数主体） | ~720 |
| `agent/send-message-remote.ts` | 远程 Agent 消息发送（executeRemoteMessage 函数） | ~950 |

**send-message.ts 变为薄聚合层**（~100 行）：
- re-export `sendMessage`（来自 send-message-local.ts）
- re-export `executeRemoteMessage`（来自 send-message-remote.ts）

##### 1.3 `agent/stream-processor.ts`（1,721 行 → 3 个子文件）

**现有结构**：

| 功能区域 | 行范围 | 说明 |
|---------|--------|------|
| Turn-Level Message Injection | 34-122 | 队列管理（queueInjection/getAndClearInjection 等） |
| Types（接口定义） | 124-203 | StreamCallbacks、StreamResult、ProcessStreamParams |
| SDK Subagent Tracking | 209-476 | 子代理状态追踪（findSubagentByToolUseId、processSubagentStreamEvent） |
| processStream（核心流处理） | 477-1721 | 流式事件处理主循环 |

**拆分方案**：

| 新文件 | 职责 | 行数（估） |
|--------|------|-----------|
| `agent/stream-injection.ts` | Turn-level 消息注入队列管理 | ~100 |
| `agent/subagent-tracker.ts` | SDK 子代理（Agent tool）状态追踪、子代理流事件处理 | ~300 |
| `agent/process-stream.ts` | 核心 processStream 函数（依赖上述两个模块） | ~1,300 |

**stream-processor.ts 变为薄聚合层**（~50 行）：
- re-export `processStream`、`queueInjection`、`getAndClearInjection`、`hasPendingInjection`、`clearInjectionsForConversation`、`clearAllInjections`、类型定义

##### 1.4 `agent/session-manager.ts`（1,098 行 → 2 个子文件）

**现有结构**：

| 功能区域 | 行范围 | 说明 |
|---------|--------|------|
| Session Maps | 29-49 | v2Sessions、activeSessions、pendingInvalidations |
| Session Cleanup Helper | 51-87 | cleanupSession |
| Health Check | 89-297 | 健康检查（markSessionRequestStart、markSessionActivity 等） |
| Process Exit Listener | 299-360 | 进程退出监听与清理 |
| Session Cleanup Timer | 362-431 | 闲置会话定期清理 |
| Session Migration | 433-545 | 会话文件迁移（旧目录 → 新目录） |
| Session Rebuild | 547-563 | needsSessionRebuild、closeV2SessionForRebuild |
| getOrCreateV2Session | 565-758 | 核心会话创建/复用逻辑 |
| Warm/Close/Invalidate | 759-990 | 会话预热、关闭、失效处理 |
| Session State Helpers | 992-1035 | createSessionState、registerActiveSession 等 |
| Compact Context | 1037-1098 | 上下文压缩 |

**拆分方案**：

| 新文件 | 职责 | 行数（估） |
|--------|------|-----------|
| `agent/session-health.ts` | 健康检查系统（配置、检查定时器、会话活动标记、进程退出监听） | ~350 |
| `agent/session-lifecycle.ts` | 会话创建/复用/迁移/清理/预热/关闭/失效/压缩（核心生命周期） | ~750 |

**session-manager.ts 变为薄聚合层**（~50 行）：
- re-export 所有公开函数和 session maps

---

#### 批次 2：ai-browser 模块（2 个文件，共 3,237 行）

##### 2.1 `ai-browser/context.ts`（1,634 行 → 4 个子文件）

**现有结构**：

| 功能区域 | 行范围 | 说明 |
|---------|--------|------|
| 基础设施（withTimeout、初始化） | 34-161 | 工具函数、BrowserContext 构造、视图管理 |
| Snapshot 管理 | 224-258 | 创建快照、获取快照、失效缓存 |
| 元素操作 | 261-390 | 元素查找、解析、交互元素计数 |
| 网络监控 | 446-567 | 请求/响应/错误处理、请求列表、清除 |
| 控制台监控 | 569-637 | 控制台消息处理、消息列表 |
| 对话框处理 | 638-694 | 对话框事件、accept/dismiss |
| 输入操作 | 675-990 | click、hover、fill、select、drag、pressKey、typeText |
| 截图 | 987-1139 | captureScreenshot |
| 导航与等待 | 1143-1286 | waitForText、waitForElement、waitForNavigation、ensurePageStable |
| 视口与性能 | 1298-1402 | setViewportSize、性能追踪 |
| 页面信息与 URL | 1389-1420 | getPageInfo、getPageUrl |
| 监控管理 | 1410-1460 | disableMonitoring |
| 视图跟踪与销毁 | 1462-1550 | trackView、destroy |

**拆分方案**：

| 新文件 | 职责 | 行数（估） |
|--------|------|-----------|
| `ai-browser/context-base.ts` | BrowserContext 类定义、构造函数、视图管理（init、getWebContents、setActiveViewId）、withTimeout 工具、快照管理、元素查找/解析 | ~400 |
| `ai-browser/context-interaction.ts` | 输入操作方法（click、hover、fill、select、drag、pressKey、typeText） | ~400 |
| `ai-browser/context-monitoring.ts` | 网络/控制台/对话框监控、截图、视口、性能追踪、导航等待 | ~500 |
| `ai-browser/context-lifecycle.ts` | 视图跟踪（trackView）、销毁（destroy）、disableMonitoring、getPageInfo/URL | ~300 |

**context.ts 变为薄聚合层**（~80 行）：
- re-export BrowserContext 类和 createScopedBrowserContext 函数

**注意**：BrowserContext 是一个 class，拆分方式为：将方法分到各子文件中作为独立函数（接受 BrowserContext 实例），然后在 context-base.ts 中组装到类定义中。替代方案：使用 mixin 模式。

##### 2.2 `ai-browser/sdk-mcp-server.ts`（1,603 行 → 4 个子文件）

**现有结构**（文件顶部已有 TODO 注释确认需拆分）：

| 功能区域 | 说明 |
|---------|------|
| Constants & Helpers | TOOL_TIMEOUT、NAV_TIMEOUT、withTimeout、textResult、imageResult、withRetry、fillFormElement |
| Navigation Tools (8 tools) | browser_list_pages、browser_select_page、browser_new_page、browser_close_page、browser_navigate |
| Input Tools (8 tools) | browser_click、browser_fill、browser_fill_form、browser_hover、browser_drag、browser_press_key、browser_upload_file、browser_handle_dialog |
| View Tools (4 tools) | browser_snapshot、browser_screenshot、browser_evaluate |
| Debug/Emulation Tools (8 tools) | browser_console、browser_network_requests、browser_emulate、browser_resize 等 |
| Server Creation | createSdkMcpServer、getGhSearchSdkToolNames |

**拆分方案**：

| 新文件 | 职责 | 行数（估） |
|--------|------|-----------|
| `ai-browser/tools/helpers.ts` | 公共工具函数（withTimeout、textResult、imageResult、withRetry、fillFormElement）和常量 | ~150 |
| `ai-browser/tools/navigation.ts` | 导航类工具定义（list_pages、select_page、new_page、close_page、navigate、wait_for） | ~350 |
| `ai-browser/tools/input.ts` | 输入类工具定义（click、fill、fill_form、hover、drag、press_key、upload_file、handle_dialog） | ~400 |
| `ai-browser/tools/view.ts` | 查看类工具定义（snapshot、screenshot、evaluate） + 调试/模拟类工具（console、network_requests、emulate、resize、list_pages） | ~450 |

**sdk-mcp-server.ts 变为薄聚合层**（~100 行）：
- import 各子文件的工具定义
- 组装 `buildAllTools()` 函数
- 保持 `createAIBrowserMcpServer` 和 `getAIBrowserSdkToolNames` 导出

---

#### 批次 3：remote-deploy 模块（1 个文件，4,915 行）

##### 3.1 `remote-deploy/remote-deploy.service.ts`（4,915 行 → 5 个子文件）

**现有结构**：

| 功能区域 | 行范围 | 说明 |
|---------|--------|------|
| 工具函数与常量 | 29-108 | escapeEnvValue、getRemoteAgentProxyPath、接口定义、常量 |
| Server CRUD | 110-717 | 添加/更新/删除/查询服务器、SSH 连接 |
| Deploy Operations | 719-1809 | 部署 Agent 代码（deployAgentCode、updateAgentCode） |
| Agent Start/Stop | 1812-2175 | startAgent、stopAgent、restartAgent、syncSystemPrompt |
| Remote File/Command | 2177-2709 | 执行远程命令、读写文件、WebSocket 客户端 |
| Health Monitor | 2720-2883 | 定期健康检查 |
| Integrity & Cleanup | 2883-3010 | 部署完整性检查、孤儿清理、部署删除 |
| Agent Install Check | 3012-3230 | 检测 Agent 是否已安装、版本检查 |
| SDK Deploy | 3231-3555 | deployAgentSDK |
| Remote Skills | 3557-4485 | 远程技能管理（list、install、sync、uninstall） |
| Offline Deployment | 4487-4915 | 离线部署包管理 |

**拆分方案**：

| 新文件 | 职责 | 行数（估） |
|--------|------|-----------|
| `remote-deploy/server-manager.ts` | 服务器 CRUD（add/update/remove/query）、SSH 连接管理、配置转换、操作状态跟踪 | ~650 |
| `remote-deploy/agent-deployer.ts` | Agent 代码部署（deployAgentCode、updateAgentCode、SDK 部署、依赖检查）、离线部署 | ~1,800 |
| `remote-deploy/agent-runner.ts` | Agent 启动/停止/重启、系统提示同步、日志获取、远程命令执行 | ~800 |
| `remote-deploy/remote-skill-manager.ts` | 远程技能管理（list、install、sync、uninstall、read/write） | ~900 |
| `remote-deploy/health-monitor.ts` | 健康检查定时器、部署完整性检查、孤儿清理 | ~350 |

**remote-deploy.service.ts 变为薄聚合层**（~150 行）：
- 定义 RemoteDeployService 类框架
- import 各子模块函数并挂载为类方法
- 保持 `remoteDeployService` 单例导出

**注意**：与 orchestrator 类似，需要将类方法提取为独立函数，接受 `this` 或 server map 作为参数。推荐使用组合模式：各子模块导出函数集，聚合层在类中组装调用。

---

#### 批次 4：remote-ws 模块（1 个文件，1,261 行）

##### 4.1 `remote-ws/remote-ws-client.ts`（1,261 行 → 3 个子文件）

**现有结构**：

| 功能区域 | 行范围 | 说明 |
|---------|--------|------|
| Types | 12-94 | RemoteWsClientConfig、ClientMessage、ServerMessage、ToolCallData、TerminalOutputData |
| RemoteWsClient Core | 95-530 | WebSocket 连接、认证、消息处理（handleMessage ~180 行） |
| Send Methods | 546-880 | sendClaudeMessage、sendChatWithStream、文件操作、工具审批、MCP 工具 |
| Connection Management | 886-930 | 重连、ping |
| Pool Management | 930-1261 | 连接池（acquireConnection、releaseConnection 等） |

**拆分方案**：

| 新文件 | 职责 | 行数（估） |
|--------|------|-----------|
| `remote-ws/ws-types.ts` | 类型定义（RemoteWsClientConfig、ClientMessage、ServerMessage 等） | ~90 |
| `remote-ws/ws-message-handler.ts` | handleMessage 内部逻辑（~180 行消息路由处理） | ~200 |
| `remote-ws/ws-connection-pool.ts` | 连接池管理（acquireConnection、releaseConnection、removePooledConnection、getPoolStats） | ~150 |

**remote-ws-client.ts 变为薄聚合层**（~300 行）：
- re-export 类型
- RemoteWsClient 类定义（精简，消息处理委托给子模块）
- 连接池函数仍从此文件导出（re-export from pool 模块）

**注意**：连接池是文件顶层的独立函数（非类方法），拆分较简单。handleMessage 是类的私有方法，需要提取为独立函数。

---

#### 批次 5：skill 模块（2 个文件，共 2,132 行）

##### 5.1 `skill/gitcode-skill-source.service.ts`（1,104 行 → 3 个子文件）

**现有结构**：

| 功能区域 | 行范围 | 说明 |
|---------|--------|------|
| API Infrastructure | 16-130 | Semaphore、RateLimiter、gitcodeFetch、GITHUB_API_BASE |
| Frontmatter Parsing | 239-280 | parseFrontmatter、formatSkillName |
| Skill Fetching | 300-590 | findSkillDirs、fetchSkillFileContent、fetchSkillDirectoryContents、findSkillDirectoryPath |
| Skill Listing | 583-700 | listRepoDirectories、listSkillsFromRepo、listSkillsFromRepoStreaming |
| Skill Detail & Validation | 700-860 | getSkillDetailFromRepo、validateRepo |
| Skill Push | 859-1104 | pushSkillAsMR |

**拆分方案**：

| 新文件 | 职责 | 行数（估） |
|--------|------|-----------|
| `skill/gitcode-api.ts` | API 基础设施（Semaphore、RateLimiter、gitcodeFetch、常量） | ~130 |
| `skill/gitcode-skill-fetch.ts` | 技能获取/搜索（findSkillDirs、fetchSkillFileContent、fetchSkillDirectoryContents、listSkillsFromRepo 等） | ~500 |
| `skill/gitcode-skill-push.ts` | 技能推送/安装（pushSkillAsMR、validateRepo、getSkillDetailFromRepo） | ~300 |

**gitcode-skill-source.service.ts 变为薄聚合层**（~100 行）：
- re-export 所有公开函数

##### 5.2 `skill/github-skill-source.service.ts`（1,028 行 → 3 个子文件）

**现有结构**：

| 功能区域 | 行范围 | 说明 |
|---------|--------|------|
| API Infrastructure | 18-80 | githubFetch、githubApiFetch、GITHUB_API_BASE |
| Frontmatter Parsing | 254-280 | parseFrontmatter、formatSkillName |
| Skill Fetching | 79-250 | listRepoDirectories、fetchSkillFileContent、fetchSkillDirectoryContents、findSkillDirectoryPath |
| Skill Listing | 242-670 | listSkillsFromRepo、listSkillsFromRepoStreaming、getSkillDetailFromRepo |
| Skill Validation & Push | 624-963 | validateRepo、pushSkillAsPR |
| Local Skill Reading | 963-1028 | readLocalSkillContent、readLocalSkillFiles |

**拆分方案**：

| 新文件 | 职责 | 行数（估） |
|--------|------|-----------|
| `skill/github-api.ts` | API 基础设施（githubFetch、githubApiFetch、常量） | ~80 |
| `skill/github-skill-fetch.ts` | 技能获取/搜索（fetchSkillFileContent、fetchSkillDirectoryContents、listSkillsFromRepo 等） | ~500 |
| `skill/github-skill-push.ts` | 技能推送/安装（pushSkillAsPR、validateRepo、getSkillDetailFromRepo）+ 本地读取 | ~350 |

**github-skill-source.service.ts 变为薄聚合层**（~100 行）：
- re-export 所有公开函数

**注意**：`gitcode-skill-source.service.ts` 第 1104 行有 `export { readLocalSkillContent, readLocalSkillFiles } from './github-skill-source.service'`，这需要在拆分后更新为指向 `github-skill-push.ts`。

---

#### 批次 6：gh-search 模块（1 个文件，1,082 行）

##### 6.1 `gh-search/sdk-mcp-server.ts`（1,082 行 → 4 个子文件）

**现有结构**：

| 功能区域 | 行范围 | 说明 |
|---------|--------|------|
| Constants & Helpers | 31-250 | GithubApiError、常量、textResult、execGh、buildSearchParams、parseViewArgs 等 |
| Result Formatters | 333-540 | formatRepoResults、formatIssueResults、formatPrResults、formatCodeResults、formatCommitResults、formatIssueView、formatPrView、formatRepoView |
| buildAllTools（工具定义） | 541-1057 | 8 个搜索/查看工具 |
| Server Creation | 1058-1082 | createGhSearchMcpServer、getGhSearchSdkToolNames |

**拆分方案**：

| 新文件 | 职责 | 行数（估） |
|--------|------|-----------|
| `gh-search/gh-api.ts` | API 基础设施（GithubApiError、execGh、ghApiDirect、常量、textResult） | ~250 |
| `gh-search/gh-formatters.ts` | 结果格式化函数（formatRepoResults、formatIssueResults 等 8 个格式化器） | ~210 |
| `gh-search/gh-tools.ts` | 8 个工具定义（buildAllTools 函数） | ~520 |
| `gh-search/gh-helpers.ts` | 辅助函数（buildSearchParams、parseViewArgs、parseRepoViewArgs、extractRepoQualifier） | ~100 |

**sdk-mcp-server.ts 变为薄聚合层**（~50 行）：
- import buildAllTools 并组装 MCP Server
- re-export createGhSearchMcpServer、getGhSearchSdkToolNames

---

### 拆分实施模式

#### 类方法拆分模式

对于 orchestrator.ts 和 remote-deploy.service.ts 这两个超大 class，采用**组合模式**而非 mixin：

```typescript
// 原始模式（在 class 内）
class RemoteDeployService {
  async deployAgentCode(id: string) { ... }
}

// 拆分后模式
// agent-deployer.ts
export async function deployAgentCode(service: RemoteDeployService, id: string) { ... }

// remote-deploy.service.ts（聚合层）
class RemoteDeployService {
  async deployAgentCode(id: string) {
    return deployAgentCodeFn(this, id);
  }
}
```

这保持了类的外部接口不变，同时将实现分散到子文件。

#### BrowserContext 拆分模式

context.ts 的 BrowserContext 类方法较多，采用**独立函数 + 类组装**模式：

```typescript
// context-interaction.ts
export async function clickElement(ctx: BrowserContext, uid: string) { ... }

// context.ts（聚合层）
class BrowserContext {
  async clickElement(uid: string) {
    return clickElementFn(this, uid);
  }
}
```

#### 函数拆分模式

对于纯函数文件（stream-processor.ts、skill 源文件、gh-search），直接提取函数到子文件，原文件 re-export：

```typescript
// stream-injection.ts
export function queueInjection(...) { ... }

// stream-processor.ts（聚合层）
export { queueInjection } from './stream-injection';
```

## 开发前必读

| 类别 | 文件路径 | 阅读目的 |
|------|---------|---------|
| 模块设计文档 | `.project/modules/agent/features/tool-orchestration/design.md` | 理解 orchestrator 的功能边界和内部协作 |
| 模块设计文档 | `.project/modules/agent/features/sdk-session/design.md` | 理解 session-manager 的会话生命周期 |
| 模块设计文档 | `.project/modules/agent/features/stream-processing/design.md` | 理解 stream-processor 的流处理核心 |
| 模块设计文档 | `.project/modules/ai-browser/ai-browser-v1.md` | 理解 ai-browser 模块的工具定义和上下文管理 |
| 前置 PRD | `.project/prd/module/services/services-refactor-v1.md` | 理解 v1 重构的目录结构和约定 |
| 编码规范 | `docs/Development-Standards-Guide.md` | 遵循 import 规范、命名规范 |
| 开发流程 | `CLAUDE.md` | 遵循编辑后 re-read 确认、提交规范 |
| 桶文件 | `src/main/services/agent/index.ts` | 理解 agent 模块的公开 API，拆分后需保持导出不变 |
| 桶文件 | `src/main/services/ai-browser/index.ts` | 理解 ai-browser 模块的公开 API |
| 桶文件 | `src/main/services/remote-deploy/index.ts` | 理解 remote-deploy 模块的公开 API |
| 桶文件 | `src/main/services/remote-ws/index.ts` | 理解 remote-ws 模块的公开 API |
| 桶文件 | `src/main/services/skill/index.ts` | 理解 skill 模块的公开 API |
| 桶文件 | `src/main/services/gh-search/index.ts` | 理解 gh-search 模块的公开 API |
| 源码文件 | 上述 11 个超大文件 | 分析内部结构，确认拆分边界 |

## 涉及文件

### 新建的文件（预估 38 个）

| 文件 | 批次 | 说明 |
|------|------|------|
| `agent/orchestrator/types.ts` | 1 | orchestrator 类型定义 |
| `agent/orchestrator/team-lifecycle.ts` | 1 | 团队生命周期管理 |
| `agent/orchestrator/task-execution.ts` | 1 | 任务分发与执行 |
| `agent/orchestrator/stall-detection.ts` | 1 | 停滞检测 |
| `agent/orchestrator/messaging.ts` | 1 | 代理间消息传递 |
| `agent/send-message-local.ts` | 1 | 本地消息发送 |
| `agent/send-message-remote.ts` | 1 | 远程消息发送 |
| `agent/stream-injection.ts` | 1 | 消息注入队列 |
| `agent/subagent-tracker.ts` | 1 | 子代理状态追踪 |
| `agent/process-stream.ts` | 1 | 核心 processStream |
| `agent/session-health.ts` | 1 | 会话健康检查 |
| `agent/session-lifecycle.ts` | 1 | 会话生命周期管理 |
| `ai-browser/context-base.ts` | 2 | BrowserContext 基础定义 |
| `ai-browser/context-interaction.ts` | 2 | 输入操作方法 |
| `ai-browser/context-monitoring.ts` | 2 | 监控与调试 |
| `ai-browser/context-lifecycle.ts` | 2 | 生命周期管理 |
| `ai-browser/tools/helpers.ts` | 2 | 工具公共函数 |
| `ai-browser/tools/navigation.ts` | 2 | 导航工具 |
| `ai-browser/tools/input.ts` | 2 | 输入工具 |
| `ai-browser/tools/view.ts` | 2 | 查看/调试工具 |
| `remote-deploy/server-manager.ts` | 3 | 服务器 CRUD |
| `remote-deploy/agent-deployer.ts` | 3 | Agent 部署 |
| `remote-deploy/agent-runner.ts` | 3 | Agent 运行管理 |
| `remote-deploy/remote-skill-manager.ts` | 3 | 远程技能管理 |
| `remote-deploy/health-monitor.ts` | 3 | 健康监控 |
| `remote-ws/ws-types.ts` | 4 | WebSocket 类型定义 |
| `remote-ws/ws-message-handler.ts` | 4 | 消息处理 |
| `remote-ws/ws-connection-pool.ts` | 4 | 连接池管理 |
| `skill/gitcode-api.ts` | 5 | GitCode API 基础设施 |
| `skill/gitcode-skill-fetch.ts` | 5 | GitCode 技能获取 |
| `skill/gitcode-skill-push.ts` | 5 | GitCode 技能推送 |
| `skill/github-api.ts` | 5 | GitHub API 基础设施 |
| `skill/github-skill-fetch.ts` | 5 | GitHub 技能获取 |
| `skill/github-skill-push.ts` | 5 | GitHub 技能推送 |
| `gh-search/gh-api.ts` | 6 | GitHub 搜索 API |
| `gh-search/gh-formatters.ts` | 6 | 结果格式化 |
| `gh-search/gh-tools.ts` | 6 | 搜索工具定义 |
| `gh-search/gh-helpers.ts` | 6 | 辅助函数 |

### 修改的文件（11 个，变为薄聚合层）

| 文件 | 批次 |
|------|------|
| `agent/orchestrator.ts` | 1 |
| `agent/send-message.ts` | 1 |
| `agent/stream-processor.ts` | 1 |
| `agent/session-manager.ts` | 1 |
| `ai-browser/context.ts` | 2 |
| `ai-browser/sdk-mcp-server.ts` | 2 |
| `remote-deploy/remote-deploy.service.ts` | 3 |
| `remote-ws/remote-ws-client.ts` | 4 |
| `skill/gitcode-skill-source.service.ts` | 5 |
| `skill/github-skill-source.service.ts` | 5 |
| `gh-search/sdk-mcp-server.ts` | 6 |

### 可能需要更新的桶文件（6 个）

| 文件 | 说明 |
|------|------|
| `agent/index.ts` | 如果 re-export 路径不变则无需更新 |
| `ai-browser/index.ts` | 同上 |
| `remote-deploy/index.ts` | 同上 |
| `remote-ws/index.ts` | 同上 |
| `skill/index.ts` | 同上 |
| `gh-search/index.ts` | 同上 |

## 验收标准

### 通用验收

- [x] 超大文件已拆分为子文件（9 个文件，跳过 2 个）
- [x] 每个原文件变为薄聚合层，仅包含 re-export
- [x] 所有子文件命名清晰，体现职责
- [x] `npm run typecheck` 通过
- [x] `npm run build` 通过
- [x] 无任何外部 API / IPC 接口变更

### 跳过的文件

- `ai-browser/context.ts`（1,634行）— 紧密耦合的大类，拆分风险过高，暂时保留
- `ai-browser/sdk-mcp-server.ts`（1,603行）— 依赖 context.ts，跳过
- `agent/orchestrator.ts`（3,673行）— 大单例类，拆分风险过高，暂时保留
- `conversation.service.ts`、`space.service.ts`、`config.service.ts` — 顶层基础服务，不在范围内

### 分批次验收

#### 批次 6：gh-search 模块

- [x] `sdk-mcp-server.ts` 拆分为 4 个子文件 + 薄聚合层（gh-api.ts、gh-formatters.ts、gh-helpers.ts、gh-tools.ts）
- [x] `gh-search/index.ts` 导出不变
- [x] 外部消费者（mcp-proxy-server.ts、aico-bot-mcp-bridge.ts）导入不变

#### 批次 5：skill 模块

- [x] `gitcode-skill-source.service.ts` 拆分为 3 个子文件 + 薄聚合层（gitcode-api.ts、gitcode-skill-fetch.ts、gitcode-skill-push.ts）
- [x] `github-skill-source.service.ts` 拆分为 3 个子文件 + 薄聚合层（github-api.ts、github-skill-fetch.ts、github-skill-push.ts）
- [x] `skill/index.ts` 导出不变
- [x] 外部消费者（skill.controller.ts、gitcode-auth.service.ts）导入不变

#### 批次 4：remote-ws 模块

- [x] `remote-ws-client.ts` 拆分为 2 个子文件 + 薄聚合层（ws-types.ts、ws-connection-pool.ts）
- [x] `remote-ws/index.ts` 导出不变

#### 批次 1：agent 模块（3 个文件拆分）

- [x] `send-message.ts` 拆分为 2 个子文件 + 薄聚合层（send-message-local.ts、send-message-remote.ts）
- [x] `stream-processor.ts` 拆分为 3 个子文件 + 薄聚合层（stream-injection.ts、subagent-tracker.ts、process-stream.ts）
- [x] `session-manager.ts` 拆分为 2 个子文件 + 薄聚合层（session-health.ts、session-lifecycle.ts）

#### 批次 3：remote-deploy 模块

- [x] `remote-deploy.service.ts` 拆分为 5 个子文件 + 薄聚合层（server-manager.ts、agent-deployer.ts、agent-runner.ts、remote-skill-manager.ts、health-monitor.ts）
- [x] `remote-deploy/index.ts` 导出不变
- [x] 外部消费者（skill.controller.ts、space.ts 等）导入不变

## 分批执行计划

| 批次 | 模块 | 文件数 | 行数 | 复杂度 | 风险 |
|------|------|--------|------|--------|------|
| 1 | agent | 4 → 16 | 8,265 | 高 | orchestrator 是单例 class，拆分需谨慎 |
| 2 | ai-browser | 2 → 10 | 3,237 | 中 | BrowserContext class 拆分 |
| 3 | remote-deploy | 1 → 6 | 4,915 | 高 | 最大单文件，功能密集 |
| 4 | remote-ws | 1 → 4 | 1,261 | 低 | 相对简单的 WebSocket 客户端 |
| 5 | skill | 2 → 8 | 2,132 | 低 | 纯函数，拆分最简单 |
| 6 | gh-search | 1 → 5 | 1,082 | 低 | 纯函数，拆分最简单 |

### 建议执行顺序

按复杂度从低到高，先练手再攻坚：

1. **批次 6**（gh-search，1,082 行，纯函数） — 最简单，验证模式
2. **批次 5**（skill，2,132 行，纯函数） — 与 gh-search 类似
3. **批次 4**（remote-ws，1,261 行，单 class） — 引入 class 拆分
4. **批次 2**（ai-browser，3,237 行，class + 工具） — 复杂度中等
5. **批次 1**（agent，8,265 行，核心模块） — 文件最多、依赖最复杂
6. **批次 3**（remote-deploy，4,915 行，最大单文件） — 最后处理

### 每批次开发步骤

1. 创建子文件，将对应功能区域的代码迁移过去
2. 更新原文件为薄聚合层（re-export）
3. 处理内部 import 路径更新
4. 运行 `npm run typecheck` 验证类型
5. 运行 `npm run build` 验证构建
6. 检查并更新桶文件（如需）
7. 提交 commit

## 变更记录

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-05-06 | 初始 PRD（draft） | @moonseeker |
| 2026-05-06 | 确认并执行。实际拆分 9 个文件（跳过 ai-browser 2个、agent orchestrator 1个），新建约 30 个子文件。纯重构，功能零变更 | @moonseeker |
