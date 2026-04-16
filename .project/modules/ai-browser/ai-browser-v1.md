# 模块 — AI Browser ai-browser-v1

> 版本：ai-browser-v1
> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源架构：无（初始版本）

## 职责

提供 AI 控制浏览器的完整能力，包括页面导航、元素交互（点击/填写/拖拽）、无障碍树快照、截图、网络请求监控、控制台消息查看、JavaScript 执行、设备/网络模拟和性能追踪。通过 SDK MCP Server 集成到 Agent 工具链。

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                      AI Browser Module                           │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  index.ts — 模块入口                                      │   │
│  │  - initializeAIBrowser() 初始化                           │   │
│  │  - createAIBrowserMcpServer() 创建 SDK MCP 服务器         │   │
│  │  - AI_BROWSER_SYSTEM_PROMPT 系统提示词                    │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  context.ts — 浏览器上下文管理                             │   │
│  │  - BrowserContext 单例                                     │   │
│  │  - CDP 命令执行（超时保护）                                │   │
│  │  - 导航等待、元素等待                                      │   │
│  │  - 网络/控制台/对话框监控                                  │   │
│  │  - 性能追踪                                                │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  snapshot.ts — 无障碍树快照                                │   │
│  │  - CDP Accessibility.getFullAXNodeChain 调用              │   │
│  │  - 结构化转换 + 唯一 UID 生成                              │   │
│  │  - 缓存（TTL 500ms）+ 导航自动失效                        │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  sdk-mcp-server.ts — SDK MCP 服务器                       │   │
│  │  26 个浏览器工具定义 (Zod + SDK tool())                   │   │
│  │  ┌─────────┐  ┌─────────┐  ┌──────────┐  ┌───────────┐ │   │
│  │  │ 导航类   │  │ 输入类   │  │ 查看类    │  │ 调试/模拟 │ │   │
│  │  │6 tools  │  │8 tools  │  │4 tools   │  │8 tools    │ │   │
│  │  └─────────┘  └─────────┘  └──────────┘  └───────────┘ │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  依赖:                                                           │
│  → browser-view.service (BrowserView 管理)                      │
│  → Electron WebContents (CDP 协议)                              │
│  → @anthropic-ai/claude-agent-sdk (SDK MCP Server)              │
└─────────────────────────────────────────────────────────────────┘
```

## 对外接口

### SDK MCP 工具（AI Agent 调用）

所有工具通过 `createSdkMcpServer()` 注册，MCP 服务器名为 `ai-browser`，调用前缀为 `mcp__ai-browser__`。

#### 导航类工具

| 工具名 | 输入 | 输出 | 说明 |
|--------|------|------|------|
| `browser_new_page` | `{ url }` | 页面信息 | 创建新页面并导航到 URL |
| `browser_navigate` | `{ type: url/back/forward/reload, url? }` | 导航结果 | 导航操作 |
| `browser_list_pages` | 无 | 页面列表 | 列出所有打开的页面 |
| `browser_select_page` | `{ pageIdx }` | 页面信息 | 选择活跃页面 |
| `browser_close_page` | `{ pageIdx }` | 操作结果 | 关闭页面 |
| `browser_wait_for` | `{ text, timeout? }` | 等待结果 | 等待文本出现 |

#### 输入类工具

| 工具名 | 输入 | 输出 | 说明 |
|--------|------|------|------|
| `browser_click` | `{ uid, dblClick? }` | 操作结果 | 点击元素 |
| `browser_fill` | `{ uid, value }` | 操作结果 | 填写输入框/选择下拉框 |
| `browser_fill_form` | `{ elements: [{ uid, value }] }` | 操作结果 | 批量填写表单 |
| `browser_hover` | `{ uid }` | 操作结果 | 悬停在元素上 |
| `browser_drag` | `{ from_uid, to_uid }` | 操作结果 | 拖拽元素 |
| `browser_press_key` | `{ key }` | 操作结果 | 按键/组合键 |
| `browser_upload_file` | `{ uid, filePath }` | 操作结果 | 上传文件 |
| `browser_handle_dialog` | `{ action: accept/dismiss, promptText? }` | 操作结果 | 处理浏览器对话框 |

#### 查看类工具

| 工具名 | 输入 | 输出 | 说明 |
|--------|------|------|------|
| `browser_snapshot` | `{ verbose? }` | 无障碍树文本 | 获取页面快照（最重要的工具） |
| `browser_screenshot` | `{ format?, quality?, uid?, fullPage? }` | 截图数据 | 截取页面截图 |
| `browser_evaluate` | `{ function, args? }` | JS 执行结果 | 执行 JavaScript |

#### 调试与模拟类工具

| 工具名 | 输入 | 输出 | 说明 |
|--------|------|------|------|
| `browser_console` | `{ types?, pageSize? }` | 控制台消息 | 查看控制台消息 |
| `browser_network_requests` | `{ resourceTypes? }` | 网络请求列表 | 查看网络请求 |
| `browser_emulate` | `{ networkConditions?, cpuThrottlingRate?, geolocation? }` | 操作结果 | 设备/网络模拟 |
| `browser_resize` | `{ width, height }` | 操作结果 | 调整视口大小 |

### 模块导出函数

| 函数 | 输入 | 输出 | 说明 |
|------|------|------|------|
| `initializeAIBrowser` | `mainWindow: BrowserWindow` | `void` | 初始化 AI Browser 模块 |
| `createAIBrowserMcpServer` | 无 | SDK MCP Server | 创建 SDK MCP 服务器实例 |
| `getAIBrowserToolNames` | 无 | `string[]` | 获取所有工具名称列表 |
| `isAIBrowserTool` | `toolName` | `boolean` | 判断是否为 AI Browser 工具 |
| `getBrowserContext` | 无 | `BrowserContext` | 获取浏览器上下文 |
| `setActiveBrowserView` | `viewId` | `void` | 设置活跃浏览器视图 |
| `cleanupAIBrowser` | 无 | `void` | 清理资源 |

## 内部组件

| 组件 | 职责 | 文件 |
|------|------|------|
| index.ts | 模块入口（初始化、MCP 服务器创建、系统提示词、工具名称查询） | `services/ai-browser/index.ts` |
| context.ts | 浏览器上下文管理器（CDP 命令、导航等待、元素交互、网络/控制台监控、性能追踪） | `services/ai-browser/context.ts` |
| snapshot.ts | 无障碍树快照（CDP 调用、结构化转换、UID 生成、缓存管理） | `services/ai-browser/snapshot.ts` |
| sdk-mcp-server.ts | SDK MCP 服务器（26 个工具定义，使用 Zod schema + SDK tool()，含超时保护） | `services/ai-browser/sdk-mcp-server.ts` |
| types.ts | 类型定义（AccessibilityNode, AccessibilitySnapshot, BrowserContextInterface 等） | `services/ai-browser/types.ts` |
| browser-view.service | Electron BrowserView 管理（创建/销毁/定位、CDP 桥接） | `services/browser-view.service.ts` |
| browser-menu.service | 浏览器上下文菜单构建（右键菜单、Tab 菜单） | `services/browser-menu.service.ts` |
| stealth | 浏览器指纹隐匿（WebGL/Canvas/字体/AudioContext 指纹随机化） | `services/stealth/` |
| ai-browser.store | AI Browser 前端状态管理 | `renderer/stores/ai-browser.store.ts` |

### 归属 IPC Handler

| Handler | 文件 |
|---------|------|
| browser | `ipc/browser.ts` |
| ai-browser | `ipc/ai-browser.ts` |

## 功能列表

| 功能 | 状态 | 文档 |
|------|------|------|
| browser-context | 已完成 | features/browser-context/design.md |
| browser-stealth | 已完成 | features/browser-stealth/design.md |
| browser-tools | 已完成 | features/browser-tools/design.md |
| page-snapshot | 已完成 | features/page-snapshot/design.md |
| electron-browser-view | 已完成 | features/electron-browser-view/design.md |

## 绑定的 API

- 无（通过 SDK MCP Server 暴露给 Agent，不通过 HTTP API）

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始模块文档 | @moonseeker1 |
