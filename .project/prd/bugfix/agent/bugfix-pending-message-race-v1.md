# Bugfix: handleAgentComplete 竞态条件导致排队消息丢失

## 元信息

- **时间**：2026-05-10
- **状态**：done
- **指令人**：用户
- **PRD 级别**：bugfix

## 问题描述

AI 完成回答后，用户快速发送新消息，UI 只显示空白思考框，消息永不发送。

### 根因

`handleAgentComplete`（`chat.store.ts`）在 `await api.getConversation()` 之前（第 1833 行）拍 `pendingMessages` 快照。在 await 期间 `isGenerating` 仍为 `true`，用户新发的消息会被排入 `pendingMessages` 队列并显示在 UI 上。但 await 结束后，第 1985 行的发送判断用的是旧快照（空数组），导致消息永不发送，session 卡死。

### 次要问题

`api.getConversation()` 失败时（第 2059 行），`pendingMessages` 被静默清空，已显示的用户消息被丢弃。

## 技术方案

1. **删除第 1833 行的预拍快照**，在 `set()` 回调内（第 1929 行）读取 `pendingMessages` 的最新值
2. **将 pending 消息发送逻辑移入 `set()` 回调之后**，使用 `set()` 返回的最新 state 中的 `pendingMessages`
3. **错误处理分支**：reload 失败时不清空 `pendingMessages`，改为重试发送或保留队列让用户可以重发

## 开发前必读

| 类别 | 文件 | 阅读目的 |
|------|------|---------|
| 源码 | `src/renderer/stores/chat.store.ts` (1827-2065, 1220-1294) | 理解 handleAgentComplete 和 sendMessage 的完整逻辑 |
| 源码 | `src/renderer/stores/chat.store.ts` (1594-1680) | 理解 handleAgentMessage 的事件过滤 |
| 功能设计 | `.project/modules/agent/features/message-send/design.md` | 理解消息发送流程设计 |
| Bug记录 | `.project/modules/agent/features/message-send/bugfix.md` | 避免回归 |

## 涉及文件

- `src/renderer/stores/chat.store.ts` — 修复 handleAgentComplete 中的竞态条件（删除第 1831-1833 行预拍快照；set() 内通过闭包变量传出 nextPendingMessage；错误分支保留 pendingMessages）
- `.project/modules/agent/features/message-send/bugfix.md` — 新增 BUG-003 记录
- `.project/modules/agent/features/message-send/changelog.md` — 新增变更行

## 验收标准

- [x] AI 完成后快速发消息，消息正常发送并收到回复
- [x] AI 完成后正常发消息，行为不变
- [x] reload 失败时，排队消息不会被静默丢弃
- [x] `npm run typecheck` 通过（chat.store.ts 无新增错误）
