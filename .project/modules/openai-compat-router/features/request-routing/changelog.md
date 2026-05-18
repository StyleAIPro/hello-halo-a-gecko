# 变更记录 — 请求路由

> 所属模块：modules/openai-compat-router

## 变更

| 日期 | 类型 | 说明 | PRD |
|------|------|------|-----|
| 2026-05-18 | 修复 | 代理 CONNECT 失败时返回 HTTP 400（不可重试）替代 HTTP 500，防止 SDK 重试循环导致 250 秒延迟；`sendError()` 对 4xx 不设置 `retry-after` | [bugfix-proxy-connect-failed-v1](../../../prd/bugfix/chat/bugfix-proxy-connect-failed-v1.md) |
| 2026-05-10 | 修复 | `fetchUpstream` 和 `fetchAnthropicUpstream` 改用 `proxyFetch`，LLM 推理请求走用户配置的网络代理 | [proxy-llm-inference-v1](../../../prd/bugfix/proxy-llm-inference-v1.md) |
| 2026-04-17 | 新功能 | 初始设计 | 无（从现有代码逆向生成） |
