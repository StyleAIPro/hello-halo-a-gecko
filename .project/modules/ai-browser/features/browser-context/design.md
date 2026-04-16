# 功能 — 浏览器上下文管理（browser-context）

> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源 PRD：功能级文档生成
> 所属模块：modules/ai-browser/ai-browser-v1

## 描述

BrowserContext 是 AI Browser 模块的核心上下文管理器。它封装了 Electron BrowserView 的 WebContents 访问、CDP（Chrome DevTools Protocol）命令执行、无障碍快照管理、网络/控制台监控、元素交互操作以及性能追踪等能力。所有 AI Browser 工具都通过此上下文进行操作。

支持两种上下文模式：
- **全局单例**：用于交互式用户浏览，复用主窗口的 BrowserView
- **作用域上下文**：用于自动化运行（Digital Humans），使用离屏宿主窗口隔离视图生命周期，避免与用户可见视图冲突

## 依赖

- `electron` — BrowserWindow、WebContents
- `../browser-view.service` — BrowserView 管理器（创建、销毁、导航）
- `./snapshot` — 无障碍快照模块（createAccessibilitySnapshot、getElementBoundingBox、scrollIntoView、focusElement）
- `./types` — 类型定义（BrowserContextInterface、AccessibilitySnapshot、NetworkRequest、ConsoleMessage、DialogInfo）

## 实现逻辑

### 正常流程

1. **初始化**：`initialize(mainWindow)` 保存主窗口引用
2. **视图激活**：`setActiveViewId(viewId)` 切换活跃视图，自动启用网络和控制台监控，通知渲染进程
3. **CDP 命令**：`sendCDPCommand(method, params, timeout)` 通过 WebContents debugger 发送 CDP 命令，内置 15s 默认超时保护
4. **元素操作**：
   - `clickElement(uid)` — 通过快照查找元素 -> 获取 bounding box -> CDP Input.dispatchMouseEvent 模拟点击
   - `fillElement(uid, value)` — 聚焦元素 -> 全选（平台感知 Cmd/Ctrl） -> 删除 -> Input.insertText 插入文本
   - `selectOption(uid, value)` — 遍历 combobox 子节点匹配 option -> DOM.resolveNode -> Runtime.callFunctionOn 设置值
   - `dragElement(fromUid, toUid)` — 获取两个元素坐标 -> 10 步插值模拟平滑拖拽
   - `hoverElement(uid)` — 滚动至可见 -> 获取坐标 -> mouseMoved
   - `pressKey(key)` — 解析组合键（Ctrl+Shift+R 等） -> keyDown/keyUp 事件
5. **等待机制**：
   - `waitForText(text, timeout)` — 轮询快照检查文本，500ms 间隔
   - `waitForNavigation(timeout)` — 事件驱动，200ms 检查 isLoading 状态，30s 默认超时
   - `ensurePageStable(timeout)` — 三阶段：等待导航完成 -> 等待网络空闲 500ms -> 检查待处理对话框
6. **快照管理**：`createSnapshot()` / `getElementByUid()` / `resolveElement()` 支持多级回退（精确匹配 -> 刷新快照 -> 部分匹配 -> 稳定 ID 匹配）
7. **监控**：启用 CDP Network.enable + Runtime.enable，通过 debugger message 事件捕获请求/响应/控制台消息
8. **截图**：`captureScreenshot()` 支持 png/jpeg/webp 格式，元素级别/视口/全页面三种模式
9. **脚本执行**：`evaluateScript()` 通过 CDP Runtime.evaluate 执行 JS，支持传参
10. **作用域清理**：`destroy()` 禁用监控 -> 销毁所有拥有的 BrowserView -> 重置状态

### 异常流程

1. **无活跃视图**：所有操作前置检查 `getActiveViewId()`，返回明确错误信息
2. **元素未找到**：`resolveElement()` 四级回退机制，最终抛出包含页面 URL、可用元素数量的详细错误
3. **CDP 超时**：`withTimeout` 包装器确保所有 CDP 操作不会无限挂起
4. **调试器已附加**：`ensureDebuggerAttached` 捕获 "already attached" 异常，静默处理
5. **媒体抑制**（仅作用域上下文）：`trackView()` 注入启动脚本覆盖 visibilityState、禁用 autoplay、静音音频，两层防护（文档层 + 音频层）
6. **监控禁用**：切换视图时自动禁用旧视图的监控，防止资源泄漏

## 涉及 API

无外部 API，为内部模块。通过 SDK MCP Server 对外暴露工具。

## 涉及数据

无持久化数据。运行时状态包括：
- `networkRequests: Map<string, NetworkRequest>` — 网络请求记录（内存）
- `consoleMessages: ConsoleMessage[]` — 控制台消息（最多保留 1000 条）
- `ownedViewIds: Set<string>` — 作用域上下文拥有的视图 ID
- `lastSnapshot: AccessibilitySnapshot | null` — 最近一次快照缓存

## 变更
→ changelog.md
