# 功能 — 隐身脚本注入（browser-stealth）

> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源 PRD：功能级文档生成
> 所属模块：modules/ai-browser/ai-browser-v1

## 描述

隐身模块提供浏览器指纹规避（anti-fingerprinting）能力，使 Electron 内嵌浏览器在外观上表现为常规 Chrome 浏览器。移植自 puppeteer-extra-plugin-stealth（MIT License）。

模块由三个层次组成：
1. **工具层**（`utils.ts`）：提供 Proxy 包装、toString 伪装、属性替换等底层工具函数
2. **规避层**（`evasions/`）：14 个独立规避脚本，每个针对一种指纹检测维度
3. **注入层**（`index.ts`）：组合所有规避脚本为单一 IIFE，通过 CDP `Page.addScriptToEvaluateOnNewDocument` 在页面脚本执行前注入

### 14 个规避脚本

| 规避脚本 | 目标文件 | 防御维度 |
|---------|---------|---------|
| navigator.webdriver | `navigator.webdriver.ts` | 删除 `navigator.webdriver` 属性（Chrome 88 以下） |
| navigator.vendor | `navigator.vendor.ts` | 设置 `navigator.vendor` 为 "Google Inc." |
| navigator.languages | `navigator.languages.ts` | 覆盖语言列表为常见值 |
| navigator.hardwareConcurrency | `navigator.hardwareConcurrency.ts` | 设置合理的 CPU 核心数 |
| navigator.plugins | `navigator.plugins.ts` | 用 JSON 数据模拟完整的 PluginArray / MimeTypeArray |
| navigator.permissions | `navigator.permissions.ts` | 修复 Notification.permission 在 headless 下的异常行为 |
| chrome.app | `chrome.app.ts` | 模拟 `window.chrome.app` 对象 |
| chrome.csi | `chrome.csi.ts` | 模拟 `window.chrome.csi()` 函数 |
| chrome.loadTimes | `chrome.loadTimes.ts` | 模拟 `window.chrome.loadTimes()` 函数 |
| chrome.runtime | `chrome.runtime.ts` | 模拟 `window.chrome.runtime`（含 sendMessage/connect 错误处理） |
| webgl.vendor | `webgl.vendor.ts` | 修改 WebGL getParameter 返回 Intel 显卡信息（UNMASKED_VENDOR/RENDERER） |
| media.codecs | `media.codecs.ts` | 修复 canPlayType 对 mp4/aac 编解码器的返回值 |
| iframe.contentWindow | `iframe.contentWindow.ts` | 修复 HEADCHR_IFRAME 检测，代理 iframe.contentWindow |
| window.outerDimensions | `window.outerdimensions.ts` | 修复 outerWidth/outerHeight 在 headless 下为 0 的问题 |

## 依赖

- `electron` — WebContents 及其 debugger CDP API
- `../data/plugins.json` — 预置的浏览器插件/MIME 类型模拟数据
- `../data/chrome-runtime.json` — 预置的 chrome.runtime 静态数据

## 实现逻辑

### 正常流程

1. **脚本构建**：`buildStealthScript()`（仅执行一次，结果缓存）
   - 将 `stealthUtils` 工具函数注入
   - 调用 `utils.init()` 预加载缓存
   - 按依赖顺序组合 14 个规避脚本：
     1. navigator.webdriver（最简单，直接删除属性）
     2. window.outerDimensions
     3. chrome.app / chrome.csi / chrome.loadTimes / chrome.runtime（必须在 plugins 之前）
     4. navigator.vendor / languages / hardwareConcurrency / permissions
     5. navigator.plugins（复杂，依赖 MimeType/Plugin 原型链）
     6. webgl.vendor
     7. media.codecs
     8. iframe.contentWindow（最后执行，因为它 hook 了 document.createElement）

2. **脚本注入**：`injectStealthScripts(webContents)`
   - **首选方式**：CDP `Page.addScriptToEvaluateOnNewDocument`
     - 附加 debugger（v1.3）
     - 发送 `Page.addScriptToEvaluateOnNewDocument` 命令
     - 注册 debugger detach 事件处理
   - **降级方式**（CDP 失败时）：`setupFallbackInjection()`
     - 监听 `did-start-navigation` 事件
     - 在 `dom-ready` 时通过 `executeJavaScript` 注入
     - 对已加载页面立即注入

3. **工具层核心机制**：
   - **Proxy 包装**：`replaceWithProxy()`、`replaceGetterWithProxy()`、`mockWithProxy()`
   - **toString 伪装**：`patchToString()` 使被代理的函数的 `toString()` 返回原生代码字符串
   - **错误栈清洗**：`stripProxyFromErrors()` 从错误堆栈中移除 Proxy 相关帧
   - **缓存**：`preloadCache()` 缓存 Reflect 方法和原生 toString 字符串，防止被页面脚本嗅探

4. **单次注入**：`injectStealthScriptsOnce()` — 不注册自动重注入，仅执行一次

### 异常流程

1. **CDP 注入失败**：捕获异常，降级到事件驱动的 `executeJavaScript` 方式
2. **Debugger detach**：非 "target closed" 原因时打印日志
3. **单个规避脚本失败**：每个脚本独立 try/catch，一个失败不影响其他脚本
4. **headless 检测已通过**：navigator.webdriver 已为 false/undefined 时跳过；plugins 已有内容时跳过
5. **非 HTTPS 页面**：chrome.runtime 跳过注入（安全上下文限制）；permissions 规避使用不同逻辑

## 涉及 API

无外部 API。通过 `injectStealthScripts(webContents)` 在 BrowserView 创建时被调用。

## 涉及数据

- `data/plugins.json` — 浏览器插件模拟数据（Plugin + MimeType）
- `data/chrome-runtime.json` — chrome.runtime 静态数据
- 运行时：`cachedStealthScript: string | null` — 缓存的完整隐身脚本

## 变更
→ changelog.md
