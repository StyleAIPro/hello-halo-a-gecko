# Bug 记录 -- 流式响应处理

## BUG-001: 停止生成按钮导致无限加载
- **日期**：2026-04-16
- **严重程度**：Critical
- **发现人**：@zhaoyinqi
- **问题**：用户点击停止按钮后 UI 进入无限加载状态（isStopping: true），Agent 卡住无法停止，必须重启应用
- **根因**：control.ts 中 stopGeneration 的 drain 循环（for await on stream）与 stream-processor.ts 的 for await 循环竞争同一个 SDK stream 迭代器，drain 循环消费了 result 消息导致 stream processor 永远挂起，agent:complete 事件永远不到达前端
- **修复**：移除 control.ts 中的 drain 循环，仅保留 interrupt() 调用；前端 chat.store.ts 增加 10 秒安全超时强制清除 isStopping 状态
- **影响文档**：
  - [ ] design.md
  - [ ] api/
  - [ ] db/schema.md

---

## BUG-002: 第二条消息卡死在思考状态
- **日期**：2026-04-17
- **严重程度**：Critical
- **发现人**：@zhaoyinqi
- **问题**：本地空间对话只能成功一次，第二次对话永远卡在 "set model to xxx" 的思考状态，Claude 不会返回回复
- **根因**：`sdk-turn-injection-patch.ts` 中 patched `send()` 的守卫条件使用 `firstResultReceived`（SDK 内部状态，跨对话保留为 true），导致第二次 `send()` 时消息被错误地推入 `_pendingUserMessages` 队列而未发送到 SDK inputStream，`stream()` 的 `for await` 循环因 inputStream 为空而永久阻塞
- **修复**：将守卫条件从 `this.query?.firstResultReceived` 改为 `this.query?._continueAfterResult`，仅在活跃注入流程中队列消息，流结束后允许正常发送
- **PRD**：`prd/bugfix/agent/bugfix-second-message-stuck-v1.md`
- **影响文档**：
  - [x] design.md
  - [ ] api/
  - [ ] db/schema.md

---

## 统计

| 严重程度 | 数量 |
|---------|------|
| Critical | 2 |
| Major | 0 |
| Minor | 0 |
