# 变更记录 — 请求路由

> 所属模块：modules/openai-compat-router

## 变更

| 日期 | 类型 | 说明 | PRD |
|------|------|------|-----|
| 2026-05-10 | 修复 | `fetchUpstream` 和 `fetchAnthropicUpstream` 改用 `proxyFetch`，LLM 推理请求走用户配置的网络代理 | [proxy-llm-inference-v1](../../../prd/bugfix/proxy-llm-inference-v1.md) |
| 2026-04-17 | 新功能 | 初始设计 | 无（从现有代码逆向生成） |
