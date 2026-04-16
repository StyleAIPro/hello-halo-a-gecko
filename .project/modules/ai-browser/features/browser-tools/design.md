# 功能 — MCP 浏览器自动化工具（browser-tools）

> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源 PRD：功能级文档生成
> 所属模块：modules/ai-browser/ai-browser-v1

## 描述

通过 Claude Agent SDK 的 `tool()` + `createSdkMcpServer()` 构建 MCP 服务器，将 AI Browser 的全部 26 个工具以 MCP 协议暴露给 AI Agent。所有工具使用 Zod schema 定义参数，每个工具内置 60s 超时保护，输入类工具额外包含 `withRetry` 元素重解析机制。

工具按功能分为 6 类：
- **导航**（8 个）：new_page、navigate、list_pages、select_page、close_page、wait_for、resize、handle_dialog
- **输入**（7 个）：click、hover、fill、fill_form、drag、press_key、upload_file
- **快照**（3 个）：snapshot、screenshot、evaluate
- **网络**（2 个）：network_requests、network_request
- **控制台**（2 个）：console、console_message
- **模拟**（1 个）：emulate（含网络节流、CPU 降速、地理位置）
- **性能**（3 个）：perf_start、perf_stop、perf_insight

MCP 服务器支持两种上下文模式：
- 全局单例（交互式用户浏览，共享 browserContext）
- 作用域上下文（自动化运行，通过 `scopedContext` 参数隔离）

## 依赖

- `zod` — 参数 schema 验证
- `@anthropic-ai/claude-agent-sdk` — `tool()`、`createSdkMcpServer()` SDK 函数
- `./context` — BrowserContext（CDP 命令、元素操作、快照、监控）
- `../browser-view.service` — BrowserView 管理器（创建、销毁、导航、状态查询）

## 实现逻辑

### 正常流程

1. **MCP 服务器创建**：`createAIBrowserMcpServer(scopedContext?)`
   - 选择上下文（传入的作用域上下文 或 全局 browserContext 单例）
   - 调用 `buildAllTools(ctx)` 构建 26 个工具
   - `createSdkMcpServer({ name: 'ai-browser', version: '1.0.0', tools })` 创建 MCP 服务器

2. **通用包装机制**：
   - **`withTimeout(promise, ms, label)`**：每个工具调用外包 60s 超时
   - **`withRetry(operationFn, label, ctx, uid)`**：输入类工具的元素重解析包装，失败时自动刷新快照并通过 `resolveElement` 重试
   - **`fillFormElement(ctx, uid, value)`**：combobox 智能填充 — 有 option 子元素时调用 selectOption，否则降级为文本填充
   - **`ensurePageStable()`**：输入操作前确保页面加载完毕、网络空闲、无待处理对话框

3. **导航工具流程**：
   - `browser_new_page`：创建 BrowserView（作用域上下文用 offscreen 模式）-> trackView -> setActiveViewId -> waitForNavigation
   - `browser_navigate`：支持 url/back/forward/reload 四种类型 -> waitForNavigation
   - `browser_list_pages/select_page/close_page`：通过 browserViewManager 管理多标签页

4. **输入工具流程**：
   - `browser_click`：ensurePageStable -> withRetry(clickElement) -> withTimeout
   - `browser_fill`：ensurePageStable -> withRetry(fillFormElement) -> withTimeout；combobox 自动检测并使用 selectOption
   - `browser_fill_form`：批量填充，逐个元素执行，收集错误后统一报告
   - `browser_drag`：ensurePageStable -> withRetry(dragElement)
   - `browser_upload_file`：ensurePageStable -> resolveElement -> CDP `DOM.setFileInputFiles`
   - `browser_press_key`：直接调用 ctx.pressKey，支持组合键（Control+Shift+R 等）

5. **快照工具流程**：
   - `browser_snapshot`：createSnapshot -> format -> 返回文本（可选保存到文件）
   - `browser_screenshot`：captureScreenshot（支持 png/jpeg/webp、元素/视口/全页）-> 返回 base64 图片或保存到文件
   - `browser_evaluate`：evaluateScript（支持传入元素参数）-> JSON 格式化结果

6. **网络/控制台工具**：分页 + 资源类型过滤 + 详情查看，对齐 chrome-devtools-mcp 的参数命名

7. **模拟工具**：`browser_emulate` 支持：
   - 网络节流：Slow 3G / Fast 3G / Regular 4G / DSL / WiFi / Offline / No emulation
   - CPU 降速：1x-20x 减速因子
   - 地理位置：经纬度覆盖（设为 null 清除）

8. **性能工具**：
   - `browser_perf_start`：可选 reload + autoStop，开始 CDP Tracing（17 个标准追踪类别）
   - `browser_perf_stop`：停止追踪，获取 Performance.getMetrics
   - `browser_perf_insight`：分析 DocumentLatency / LCPBreakdown / RenderBlocking 等洞察

### 异常流程

1. **无活跃页面**：所有工具前置检查 `ctx.getActiveViewId()`，返回 `isError: true` 的文本结果
2. **元素未找到**：`withRetry` 自动重试一次（刷新快照 + resolveElement 回退），二次失败抛出详细错误提示用户重新获取快照
3. **超时**：`withTimeout` 确保工具不会无限挂起，超时后返回明确错误信息
4. **combobox 无匹配 option**：`fillFormElement` 捕获 "Could not find option" 异常，降级为文本填充
5. **批量填充部分失败**：`browser_fill_form` 收集所有错误，部分失败返回部分成功信息，全部失败标记为 error
6. **screenshot uid+fullPage 冲突**：前置校验参数互斥，返回错误
7. **性能追踪重复**：已追踪时返回错误提示先停止

## 涉及 API

无外部 HTTP API。通过 MCP 协议（`mcp__ai-browser__` 前缀）暴露给 AI Agent。

## 涉及数据

无持久化数据。所有状态由 BrowserContext 管理。

## 变更
→ changelog.md
