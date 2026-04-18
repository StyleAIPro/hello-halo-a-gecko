# 功能 -- 请求拦截器

> 日期：2026-04-17
> 指令人：@StyleAIPro
> 来源 PRD：无（从现有代码逆向生成）
> 所属模块：modules/openai-compat-router

## 描述

请求拦截器子系统，在协议格式转换之前对 Anthropic 格式请求进行拦截和短路处理。包含两个内置拦截器：预热拦截器（warmup）和预检拦截器（preflight），分别拦截 Claude Code CLI 的连接预热请求和 SDK 内部 LLM 调用（如 bash_extract_prefix 安全分析），返回 mock 响应以消除不必要的网络延迟（30-60 秒/次）。

拦截器通过指纹检测机制识别目标请求，避免实际发送到后端 LLM 提供商，显著提升用户体验。

## 依赖

- `types/anthropic.ts` -- Anthropic 请求类型（用于指纹匹配）
- `interceptors/types.ts` -- RequestInterceptor 接口定义

## 实现逻辑

### 正常流程

1. **拦截器链执行**：
   a. 请求到达后，按注册顺序依次执行拦截器
   b. 每个拦截器检查请求是否匹配其拦截条件
   c. 匹配则返回 InterceptorResult（含 mock 响应），终止后续处理
   d. 不匹配则返回 null，继续下一个拦截器

2. **预热拦截器**（`warmup.ts`）：
   a. 检测 Claude Code CLI 的 "Warmup" 请求
   b. 特征：特定的请求内容或 header 标识
   c. 匹配后返回 mock Anthropic Messages 响应（包含简单文本内容）
   d. 消除 CLI 启动时的预热延迟

3. **预检拦截器**（`preflight.ts`）：
   a. 检测 CC SDK 内部 LLM 调用（如 bash_extract_prefix 安全分析）
   b. 指纹检测机制：
      - tools 数量为 0（无工具调用的纯文本请求）
      - system prompt 包含特定子串匹配（标识为内部安全分析调用）
   c. 匹配后返回 mock 响应（合理的默认分析结果）
   d. 消除每条 bash 命令触发的 30-60 秒安全分析延迟（在慢速模型上尤为明显）

### 异常流程

1. **指纹误判**：合法用户请求被错误拦截，返回 mock 响应而非真实 LLM 输出
2. **拦截器执行错误**：单个拦截器抛出异常，跳过该拦截器继续执行后续拦截器和正常请求处理流程

## 涉及 API

- `RequestInterceptor` -- 拦截器接口（intercept 方法）
- `InterceptorContext` -- 拦截器上下文（请求体、header 等）
- `InterceptorResult` -- 拦截结果（mock 响应或 null）
- `runInterceptors(context)` -- 执行拦截器链

## 涉及数据

- `InterceptorContext` -- `{ requestBody, headers, path }` 拦截器执行上下文
- `InterceptorResult` -- `{ response: AnthropicMessageResponse } | null` 拦截结果

## 变更

-> changelog.md
