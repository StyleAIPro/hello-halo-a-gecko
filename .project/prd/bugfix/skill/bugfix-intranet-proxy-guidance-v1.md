---
时间: 2026-04-29
状态: done
指令人: misakamikoto
PRD 级别: bugfix
优先级: P0
影响范围: 仅前端 + 后端错误提示
---

# 内网环境网络代理未配置引导

## 需求背景

AICO-Bot 已有完整的网络代理基础设施（`proxy-fetch`、Settings > 网络代理 UI、代理测试），但存在严重的引导断层问题：

1. **错误提示指向环境变量而非应用内设置**：`error-classifier.ts` 中硬编码的网络错误提示消息仅告知用户"请在系统环境变量中设置 HTTP_PROXY / HTTPS_PROXY 后重启应用"，完全未提及应用内已有"设置 > 系统 > 网络代理"配置入口。
2. **技能市场网络错误横幅缺乏针对性引导**：`SkillMarket.tsx` 的 `classifySkillMarketError()` 能识别网络错误并显示横幅，但横幅内容只是复用后端返回的错误消息，未提供前往代理设置的具体引导。
3. **技能市场加载无主动网络检测**：用户在内网打开技能市场时，如果代理未配置，会看到"加载中"→超时→模糊错误，缺少在加载前或加载中主动检测网络可达性的能力。

**核心问题**：用户在内网环境下看到错误提示"设置环境变量"，但应用内已有更便捷的代理配置 UI，两者之间缺少引导桥梁。

## 问题分析

### 现状分析

| 场景 | 文件 | 当前行为 | 用户感知 |
|------|------|---------|---------|
| Agent 对话网络错误 | `error-classifier.ts:52` | 提示"设置 HTTP_PROXY 环境变量重启应用" | 不知道应用内有代理设置 |
| Agent 流式思考网络错误 | `error-classifier.ts:84` | 同上 | 同上 |
| 技能市场加载网络错误 | `SkillMarket.tsx:844-867` | 显示原始错误消息 + "前往设置"按钮 | 按钮未导航到代理设置页 |
| 技能市场加载网络错误 | `skill-market-service.ts` | `isNetworkError()` 抛出含"环境变量"的提示 | 同上 |
| 用户代理已配置 | 各处 | 仍提示"设置环境变量" | 误导信息 |

### 根因

`error-classifier.ts` 编写时（feature-error-guidance-v1 PRD），应用内的代理设置 UI 尚未实现（`network-proxy-v1` PRD），因此只能引导到环境变量。现在应用内已有完整的代理配置 UI，但错误消息未同步更新。

## 技术方案

### 方案：更新错误引导 + 增强技能市场网络横幅

核心思路：将所有网络错误引导从"设置环境变量"更新为"前往 设置 > 网络 配置代理"，并让技能市场的网络错误横幅直接导航到代理设置区域。

#### 1. 更新 `error-classifier.ts` 网络错误消息

将硬编码的双语消息从：

```
网络连接失败，请检查网络代理配置。请在系统环境变量中设置 HTTP_PROXY / HTTPS_PROXY 后重启应用。
Network connection failed. Please check your proxy settings. Set HTTP_PROXY / HTTPS_PROXY in system environment variables and restart the app.
```

更新为：

```
网络连接失败，请检查网络代理配置。请前往 设置 > 网络 配置代理，或在系统环境变量中设置 HTTP_PROXY / HTTPS_PROXY。
Network connection failed. Please check your network proxy settings. Go to Settings > Network to configure a proxy, or set HTTP_PROXY / HTTPS_PROXY in system environment variables.
```

**同步更新 `classifyError()` 和 `extractNetworkErrorHint()` 两处**。

#### 2. 技能市场网络错误横幅增强

在 `SkillMarket.tsx` 中，当 `classifySkillMarketError()` 返回 `'network'` 时：

- 横幅内容改为专用的网络引导文案（而非复用原始 loadError）
- "前往设置"按钮点击后导航到 Settings 页面的网络代理区域（而非仅设置页顶部）

#### 3. 技能市场加载失败时的代理状态检测

当技能市场加载失败且被分类为网络错误时，自动检测当前代理配置状态：
- 如果代理未启用 → 横幅提示"未配置代理，可能无法访问外部仓库"
- 如果代理已启用但仍然失败 → 横幅提示"代理连接失败，请检查代理地址是否正确"

新增 IPC 通道 `skill:network:proxy-status`，返回 `{ enabled: boolean; proxyUrl: string }`。

#### 4. i18n 键

新增：
- `skill.network.proxyNotConfigured` — 代理未配置提示
- `skill.network.proxyFailed` — 代理已配置但连接失败提示
- `skill.network.goToNetworkSettings` — "前往 网络设置"按钮文案

## 开发前必读

| 类别 | 文件 | 阅读目的 |
|------|------|---------|
| 源码 | `src/main/services/agent/error-classifier.ts` | 了解现有网络错误分类逻辑和消息格式 |
| 源码 | `src/renderer/components/skill/SkillMarket.tsx` | 了解错误横幅渲染逻辑和导航机制 |
| 源码 | `src/main/services/skill/skill-market-service.ts` | 了解 `isNetworkError()` 和现有网络错误消息 |
| 源码 | `src/renderer/components/settings/SystemSection.tsx` | 了解代理设置 UI 结构和 `setView` 导航 |
| 源码 | `src/main/services/config.service.ts` | 了解 `getConfig()` 中 network 字段结构 |
| 源码 | `src/main/ipc/skill.ts` | IPC 通道注册模式 |
| 源码 | `src/preload/index.ts` | preload 暴露模式 |
| 源码 | `src/renderer/api/index.ts` | renderer API 方法注册模式 |
| 模块文档 | `.project/prd/feature/settings/feature-error-guidance-v1.md` | 了解 v1 错误引导实现范围 |
| 模块文档 | `.project/prd/feature/network-proxy/network-proxy-v1.md` | 了解代理基础设施实现范围 |

## 涉及文件

> 预估修改清单

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `src/main/services/agent/error-classifier.ts` | 修改 | 更新 `classifyError()` 和 `extractNetworkErrorHint()` 网络错误消息，改为引导到应用内设置 |
| `src/renderer/components/skill/SkillMarket.tsx` | 修改 | 网络错误横幅使用专用引导文案 + 代理状态检测 + 导航到网络设置 |
| `src/main/ipc/skill.ts` | 修改 | 新增 `skill:network:proxy-status` IPC handler |
| `src/preload/index.ts` | 修改 | 新增 `skillNetworkProxyStatus` API 暴露 |
| `src/renderer/api/index.ts` | 修改 | 新增 `skillNetworkProxyStatus()` renderer API 方法 |
| `src/renderer/i18n/locales/en.json` | 修改 | 新增网络代理引导 i18n key |
| `src/renderer/i18n/locales/zh-CN.json` | 修改 | 新增网络代理引导 i18n key |

## 验收标准

- [x] **1.1** Agent 对话中出现网络错误时，提示消息包含"前往 设置 > 网络"引导（而非仅"设置环境变量"）
- [x] **1.2** Agent 流式思考中出现网络错误时，提示消息包含"前往 设置 > 网络"引导
- [x] **2.1** 技能市场加载失败且为网络错误时，横幅显示专用引导文案（非原始错误消息）
- [x] **2.2** 代理未配置时，横幅提示"未配置代理，内网环境可能无法访问外部仓库"
- [x] **2.3** 代理已配置但仍然失败时，横幅提示"代理连接失败，请检查代理地址"
- [x] **2.4** 横幅"前往设置"按钮点击后导航到 Settings 页面网络代理区域
- [x] **3.1** 所有新增用户可见文本均有中英文 i18n 翻译
- [x] **3.2** `npm run typecheck && npm run lint && npm run build` 全部通过
- [x] **3.3** IPC handler 有 try/catch + `{ success, data/error }` 返回格式
- [x] **3.4** 编辑后运行 `npx eslint --fix <file>` 并 re-read 确认逻辑未被覆盖
