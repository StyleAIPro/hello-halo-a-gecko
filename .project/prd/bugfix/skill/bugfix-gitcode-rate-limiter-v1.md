# PRD [Bug 修复级] — 固定 GitCode 速率限制器参数

> 版本：bugfix-gitcode-rate-limiter-v1
> 日期：2026-04-18
> 指令人：@MoonSeeker
> 反馈人：@MoonSeeker
> 归属模块：modules/skill
> 严重程度：Major

## 背景

GitCode API 限制：每个用户每分钟最多 50 次请求。当前应用使用单一 GitCode 用户（Personal Access Token），所有仓库共享这一配额。

之前在 `bugfix-gitcode-skill-fetch-v1` 中实现了令牌桶速率限制器（`gitcode-skill-source.service.ts` 的 `RateLimiter` 类），但参数经过多次调试调整，尚未形成正式文档。本次 PRD 目的是将最终确定的速率限制器参数固定下来，作为后续维护的基线。

## 最终参数

| 参数 | 值 | 说明 |
|------|----|------|
| 最小请求间隔 | 1000ms (1s) | 任意两个连续 GitCode API 请求之间至少间隔 1 秒 |
| 令牌桶上限 | 50 tokens | 对应 GitCode 50 req/min 的配额 |
| 令牌补充速率 | 每 1.2s 补充 1 token | 约 50 tokens/min，略低于上限留余量 |
| 并发限制 | max 3 | 已有 `Semaphore` 实现 |
| 实例作用域 | 全局共享 | 所有仓库的 GitCode API 调用共享同一个 `RateLimiter` 实例 |

## 请求流水线

```
GitCode API Request
  → RateLimiter.acquire()
    → 1. 检查距上次请求是否 >= 1s（不足则等待剩余时间）
    → 2. 补充令牌（refill）
    → 3. 令牌桶有 token 则消费，无 token 则等待 1.2s 后补充并消费
    → 4. 更新 lastAcquire 时间戳
    → Semaphore.acquire() (max 3 并发)
      → 实际 HTTP 请求
```

## 影响范围

- 仅 `src/main/services/skill/gitcode-skill-source.service.ts` 的 `RateLimiter` 类及相关常量
- 不涉及前端、IPC、其他模块

## 验收标准

1. 任意两个连续 GitCode API 请求之间间隔 >= 1s（观察遥测日志 `_rateLimitWaitMs`）
2. 一分钟内总请求不超过 50 次（观察遥测计数器 `_requestCount`）
3. 多个仓库加载共享同一配额（单一 `_rateLimiter` 实例）
4. 不会触发 GitCode 429 错误（正常使用场景下）

## 变更
| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-18 | 初始版本：固定速率限制器最终参数 | @MoonSeeker |
