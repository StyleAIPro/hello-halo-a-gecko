# PRD: AI Source Per-Source Proxy Toggle

## 元信息

- **时间**: 2026-05-10
- **状态**: done
- **优先级**: P2
- **指令人**: moonseeker
- **影响范围**: 前端（设置 UI）+ 后端（代理请求路由）

## 需求分析

当前所有 AI 模型 API 请求统一使用全局代理设置（设置 > 系统 > 网络代理）。用户需要针对不同 AI 源（如 Anthropic、DeepSeek、SiliconFlow）独立控制是否走网络代理。

例如：用户全局代理用于访问国外 API，但国内 AI 源（DeepSeek、通义千问等）不需要代理，甚至走代理反而连接失败。

## 技术方案

在 `AISource` 接口上添加 `useProxy?: boolean` 字段：
- `undefined / false`（默认）：不走代理，即使全局代理已开启
- `true`：使用全局代理配置的地址进行请求

通过 `BackendRequestConfig` 将该标志传播到 OpenAI 兼容路由器，在 `fetchUpstream` / `fetchAnthropicUpstream` 中据此决定是否调用 `getEffectiveProxyUrl()`。

## 开发前必读

| 类别 | 文件 | 阅读目的 |
|------|------|---------|
| 模块设计 | `.project/modules/ai-sources/ai-sources-v1.md` | 模块整体架构 |
| 功能设计 | `.project/modules/ai-sources/features/source-manager/design.md` | AI 源管理逻辑 |
| 共享类型 | `src/shared/types/ai-sources.ts` | AISource / BackendRequestConfig 类型定义 |
| UI 组件 | `src/renderer/components/settings/ProviderSelector.tsx` | AI 源配置表单 |
| 请求路由 | `src/main/openai-compat-router/server/request-handler.ts` | 上游请求代理逻辑 |
| 代理工具 | `src/main/services/proxy/proxy-fetch.ts` | proxyFetch 实现 |
| 代理配置 | `src/main/services/proxy/proxy-agent.ts` | getEffectiveProxyUrl |
| AI 源管理 | `src/main/services/ai-sources/manager.ts` | getBackendConfig 构建 |
| 路由分发 | `src/main/openai-compat-router/server/router.ts` | 解码 BackendConfig 传参 |

## 涉及文件

| 文件 | 变更类型 |
|------|---------|
| `src/shared/types/ai-sources.ts` | 修改：AISource、BackendRequestConfig 增加 useProxy |
| `src/renderer/components/settings/ProviderSelector.tsx` | 修改：添加「使用网络代理」checkbox |
| `src/main/services/ai-sources/manager.ts` | 修改：getBackendConfig / getBackendConfigForSource 传递 useProxy |
| `src/main/openai-compat-router/server/request-handler.ts` | 修改：fetchUpstream/fetchAnthropicUpstream 支持 useProxy |
| `src/main/services/proxy/proxy-fetch.ts` | 修改：proxyFetch 支持 forceNoProxy 参数 |
| `src/renderer/i18n/locales/zh-CN.json` | 修改：添加中文翻译 |

## 验收标准

- [x] 新建 AI 源时，代理开关默认关闭（false）
- [x] 编辑已有 AI 源时，代理开关状态正确回显
- [x] 代理开关关闭时：AI 请求不走代理（日志显示 direct）
- [x] 代理开关打开 + 全局代理已配置：AI 请求走代理（日志显示 proxy）
- [x] 代理开关打开 + 全局代理未配置：等同于直连
- [x] TypeScript 类型检查通过（无新增错误）
- [x] 构建通过
