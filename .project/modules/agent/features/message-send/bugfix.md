# Bug 记录 -- 消息发送流程

## 统计

| 严重程度 | 数量 |
|---------|------|
| Critical | 0 |
| Major | 1 |
| Minor | 0 |

## BUG-003: handleAgentComplete 竞态条件导致排队消息丢失

- **严重程度**：Major
- **发现时间**：2026-05-10
- **状态**：已修复
- **触发条件**：AI 完成回答后，在 `await api.getConversation()` 期间用户快速发送新消息
- **现象**：UI 显示用户消息 + 空白思考框，消息永不发送，session 卡死在 `isGenerating: true`
- **根因**：`handleAgentComplete` 在 `await` 之前预拍 `pendingMessages` 快照（空数组），`await` 期间新排入的消息不在快照中，导致发送判断跳过
- **修复**：删除预拍快照，改在 `set()` 回调内读取最新 `pendingMessages` 并通过闭包变量传出；错误分支不再清空 `pendingMessages`
- **PRD**：`bugfix-pending-message-race-v1`
