# PRD [Bug 修复级] — 第二条消息卡死在思考状态

> 版本：bugfix-second-message-stuck-v1
> 日期：2026-04-17
> 指令人：@zhaoyinqi
> 反馈人：@zhaoyinqi
> 归属模块：modules/agent
> 严重程度：Critical

## 问题描述

- **期望行为**：用户在本地空间中发送多条消息，每条消息都应正常获得 Claude 的回复
- **实际行为**：第一次对话正常完成，第二次发送消息后 UI 永远卡在 "set model to xxx" 的思考状态，Claude 不会返回任何回复
- **复现步骤**：
  1. 创建或打开一个本地空间
  2. 发送第一条消息 → Agent 正常响应
  3. 等待第一条消息完成后，发送第二条消息
  4. UI 显示 "set model to xxx" 的思考状态，但永远不会收到回复
  5. 只能重启应用恢复

## 根因分析

**文件**：`src/main/services/agent/sdk-turn-injection-patch.ts`（第 63-76 行）

该 patch 修改了 SDK 的 `send()` 方法，添加了 turn-level message injection 逻辑。问题出在 `send()` 的守卫条件判断错误。

### Patched send() 的关键逻辑

```javascript
async send(message) {
    // [PATCHED] Turn-level message injection
    if (this.query?.firstResultReceived && !this.closed) {
      if (!this.query._continueAfterResult && !this.query._pendingUserMessages?.length) {
        this.query._pendingUserMessages.push(message);
        this.query._continueAfterResult = true;
        console.log('[SDK] Queued message for turn-level injection');
        return;  // <--- 消息被队列，未发送到 SDK inputStream
      } else if (this.query._pendingUserMessages) {
        this.query._pendingUserMessages.push(message);
        console.log('[SDK] Queued additional message for injection');
        return;
      }
    }
    // ... 正常发送逻辑
```

### 第一次对话（正常流程）

1. `send()` 调用时 `firstResultReceived` 为 false → 跳过 patched 分支
2. 消息正常发送到 SDK inputStream
3. `stream()` 正常迭代，处理响应
4. SDK 内部设置 `firstResultReceived = true`
5. 流正常结束

### 第二次对话（卡死流程）

1. `send()` 调用时 `firstResultReceived` 已经为 true（来自第一次对话，SDK 内部状态保留）
2. `_continueAfterResult` 为 false（上次流结束后被重置）
3. `_pendingUserMessages` 为空或未定义
4. 命中第一个分支（Branch A）：消息被推入 `_pendingUserMessages`，`send()` 直接 return
5. **消息从未被发送到 SDK 的 inputStream**
6. `stream()` 被调用 → SDK 的 inputStream 为空 → `for await` 循环永远阻塞
7. UI 显示 Claude 一直在思考

### 关键发现

- SDK patch 的 helper methods（`enableContinueConversation()`, `hasPendingMessages()`, `getPendingMessageCount()`）从未被应用层代码调用
- 应用层使用自己的 `pendingInjectionQueues` 机制（在 `stream-processor.ts` 中），不依赖 SDK patch 的队列
- SDK patch 的 within-stream injection 机制实际上从未被使用

## 修复方案

**文件**：`src/main/services/agent/sdk-turn-injection-patch.ts`

修复包含两部分：

### Part 1：修复 patch 模板（新安装生效）

将 patched `send()` 的判断条件从 `this.query?.firstResultReceived` 改为 `this.query?._continueAfterResult`。

**修改前**（第 65 行）：
```javascript
if (this.query?.firstResultReceived && !this.closed) {
```

**修改后**：
```javascript
if (this.query?._continueAfterResult && !this.closed) {
```

### Part 2：添加迁移步骤（已安装生效）

SDK 文件（`node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`）已经被旧 patch 修改过，仅修改模板不会生效。需要在 patch 函数开头新增迁移步骤，检测并修复已应用旧 patch 的 SDK 文件。

新增 Step 0 迁移逻辑：
```javascript
// 0. MIGRATION: Fix already-patched send() that uses firstResultReceived
const oldSendGuard = 'this.query?.firstResultReceived&&!this.closed';
if (content.includes(oldSendGuard)) {
  content = content.replace(oldSendGuard, 'this.query?._continueAfterResult&&!this.closed');
  changes++;
}
```

**为什么需要迁移**：
- patch 函数通过字符串匹配定位原始代码，但旧 patch 已修改了 `send()` 的代码结构
- 旧的 `sendPattern`（`async send(message) {\n    if (this.closed) {`）无法匹配已被修改的代码
- 因此仅修改模板，已安装的 SDK 文件不会自动更新

### 修复逻辑分析

| 场景 | `_continueAfterResult` | `firstResultReceived` | 修改前行为 | 修改后行为 |
|------|----------------------|----------------------|-----------|-----------|
| 首次消息 | false | false | 正常发送 | 正常发送 |
| 活跃注入中 | true | true | 队列（正确） | 队列（正确） |
| 上次流已结束的新消息 | false | true | **队列（BUG）** | 正常发送 |
| 流已关闭 | false | true | 队列（无影响） | 正常发送（无影响） |

修复后：
- 当 `_continueAfterResult` 为 true（活跃的注入流程中）：消息被队列
- 当 `_continueAfterResult` 为 false（流已结束或首次发送）：消息正常发送
- `_continueAfterResult` 仅在 patch 自身设置为 true 时才为 true，流结束后 SDK 内部会重置它

### 远程空间影响

**不需要修改远程空间的代码。** 远程空间（`packages/remote-agent-proxy`）不使用此 SDK patch，且每次对话都创建全新 session，不存在 session 复用场景。

## 影响范围

- [x] 涉及 API 变更 -> 无
- [ ] 涉及数据结构变更 -> 无
- [ ] 涉及功能设计变更 -> 无

## 涉及文件

| 文件 | 改动类型 |
|------|---------|
| `src/main/services/agent/sdk-turn-injection-patch.ts` | 修改 — 守卫条件改为 `_continueAfterResult`；新增 Step 0 迁移逻辑 |

## 验证方式

1. **基础二轮对话**：本地空间发送第一条消息 → 等待完成 → 发送第二条消息 → 应正常获得回复
2. **多轮对话**：连续发送 5+ 条消息 → 每条都应正常获得回复
3. **远程空间**：远程空间执行同样的多轮对话测试 → 确保修复不影响远程会话
4. **中途发消息**：Agent 响应过程中发送新消息 → 消息应排队并在当前响应完成后自动发送
5. **停止后继续**：停止当前生成 → 发送新消息 → 应正常工作
6. **npm install 后验证**：删除 `node_modules` 重新安装 → 确认迁移步骤正确修复 SDK 文件

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-17 | 初始 Bug 修复 PRD | @zhaoyinqi |
| 2026-04-17 | 补充迁移步骤（Part 2），说明已安装 SDK 的修复机制 | @zhaoyinqi |
