# PRD [功能级] — 日志内容优化

| 字段 | 值 |
|------|------|
| 版本 | v1 |
| 日期 | 2026-04-30 |
| 作者 | 人 |
| 模块 | main |
| 状态 | done |
| 优先级 | P1 |
| 影响范围 | 仅主进程 |

## 需求分析

### 背景

AICO-Bot 日志系统基于 electron-log v5.4.3，已完成按日期分割（v2 PRD）和文件噪音过滤（bugfix-log-noise-v1 PRD）。经代码审计发现，日志的 **内容质量** 存在安全隐患和可用性问题：敏感数据泄露、噪音过多、错误日志丢失 stack trace、前缀混乱。

### 问题清单

#### P0 — 敏感数据泄露（安全）

| # | 文件 | 行号 | 问题 |
|---|------|------|------|
| 1 | `src/main/http/server.ts` | 295 | 明文记录 HTTP access token：`console.log('[HTTP] Access token: ${token}')` |
| 2 | `src/main/ipc/remote-server.ts` | 71 | 用 `JSON.stringify(input)` 序列化完整远程服务器配置，可能包含 SSH 密钥、密码等敏感字段 |
| 3 | `src/main/ipc/config.ts` | 32-36 | config:set 日志记录所有变更的 key 名称（keys 本身不敏感，但与值拼接时需注意） |

#### P1 — 日志噪音过多

| # | 位置 | 问题 |
|---|------|------|
| 1 | `src/main/ipc/` (17 个文件) | 共 125 个 `console.log` 调用，每个 IPC 调用都产生日志 |
| 2 | `src/main/services/agent/send-message.ts` | 大量 `========== FUNCTION START ==========`、`===== BEFORE GETSPACE =====` 等调试横幅 |
| 3 | `src/main/services/agent/control.ts` | 每步操作独立一行 log（15 处），如 `[Agent][control.ts] Session found: true/false` |
| 4 | 多处 IPC handler | 同一操作被双重记录：`console.log('[IPC] ...')` + `console.info('[event] ...')` |

#### P1 — 错误日志质量差

| # | 位置 | 问题 |
|---|------|------|
| 1 | `src/main/ipc/` (9 个文件) | 约 159 处 `err.message` 引用，其中 ~60% 的错误日志只记录 `err.message`，丢失 stack trace |
| 2 | 多处 catch 块 | 完全静默，无任何日志 |

#### P2 — 日志前缀不一致

| # | 问题 |
|---|------|
| 1 | `[Settings]` 被用于 `remote.ts`（31 处）、`health.ts`（17 处）、`onboarding.ts`（7 处）、`system.ts`（9 处）等非设置模块 |
| 2 | `[Agent][control.ts]` 嵌入文件名（整个代码库唯一一个，15 处） |
| 3 | IPC handler 注册日志有的用 `[Settings]` 有的用 `[IPC]` |

#### P2 — 缺少性能追踪

| # | 问题 |
|---|------|
| 1 | 无 IPC 操作耗时记录 |
| 2 | 无 API 延迟追踪 |
| 3 | 启动计时结构可优化 |

## 技术方案

### 核心策略

**不做全量 console.log -> createLogger 替换**。electron-log 已全局捕获所有 console 输出，本次优化聚焦于：
1. 安全修复：全局脱敏 hook + 清理敏感日志点
2. 噪音过滤：扩展文件传输 hook 过滤高频 IPC 日志
3. 错误质量：标准化错误日志，传递完整 error 对象
4. 前缀统一：将误用的 `[Settings]` 前缀修正为模块前缀
5. 性能日志：在关键路径添加耗时记录

### 方案 1: 日志脱敏 Hook（修改 `src/main/index.ts`）

在 `log.initialize()` 之后注册全局脱敏 hook，对所有传输（console + file）生效：

```typescript
log.hooks.push((message, transport) => {
  // 对所有传输（console + file）脱敏
  let text = message.data?.map(d => typeof d === 'string' ? d : JSON.stringify(d)).join(' ') ?? '';

  // API Keys
  text = text.replace(/sk-ant-[a-zA-Z0-9\-_]{20,}/g, 'sk-ant-***');
  text = text.replace(/sk-[a-zA-Z0-9]{20,}/g, 'sk-***');
  // Bearer tokens
  text = text.replace(/Bearer\s+[a-zA-Z0-9\-._~+/]+=*/g, 'Bearer ***');
  // JSON fields
  text = text.replace(/"apiKey"\s*:\s*"[^"]+"/g, '"apiKey": "***"');
  text = text.replace(/"token"\s*:\s*"[^"]+"/g, '"token": "***"');
  text = text.replace(/"password"\s*:\s*"[^"]+"/g, '"password": "***"');
  text = text.replace(/"accessToken"\s*:\s*"[^"]+"/g, '"accessToken": "***"');
  text = text.replace(/"secretKey"\s*:\s*"[^"]+"/g, '"secretKey": "***"');
  text = text.replace(/"privateKey"\s*:\s*"[^"]{10,}"/g, '"privateKey": "***"');

  // 将脱敏后的文本写回（仅替换第一个 data 元素，保持日志结构）
  if (message.data?.[0] !== undefined) {
    message.data[0] = text;
  }
  return message;
});
```

要点：
- 脱敏 hook 对所有传输（console + file）生效，确保敏感数据不会在任何输出中出现
- 使用正则覆盖常见 API key 格式（Anthropic、OpenAI）和 JSON 字段
- 放在 `log.initialize()` 之后、`log.errorHandler.startCatching()` 之前注册

### 方案 2: 文件传输噪音过滤 Hook 扩展（修改 `src/main/index.ts`）

在 bugfix-log-noise-v1 的噪音过滤 hook 基础上，增加 IPC 高频调用过滤：

```typescript
log.hooks.push((message, transport) => {
  if (transport !== log.transports.file) return message;
  if (message.level === 'debug') return false;

  const text = String(message.data?.[0] ?? '');

  // 高频只读 IPC — 不记录到文件
  const noisePrefixes = [
    '[IPC] agent:',
    '[IPC] remote-server:get',
    '[IPC] remote-server:list',
    '[Settings] config:get',
    '[Settings] system:get-auto-launch',
    '[Settings] health:get-status',
    '[Settings] health:get-state',
  ];
  for (const prefix of noisePrefixes) {
    if (text.startsWith(prefix)) return false;
  }

  return message;
});
```

要点：
- 只在 `transportName === 'file'` 时过滤，控制台输出不受影响（开发调试不受限）
- 保留 `[event]` 前缀的用户操作日志（与 bugfix-log-noise-v1 策略一致）
- 保留所有 error/warn 级别日志

### 方案 3: 清理敏感日志点（逐文件修改）

| # | 文件 | 行号 | 当前代码 | 修改 |
|---|------|------|---------|------|
| 1 | `src/main/http/server.ts` | 295 | `console.log('[HTTP] Access token: ${token}')` | 删除该行（token 已通过脱敏 hook 保护，但明文打印毫无必要） |
| 2 | `src/main/ipc/remote-server.ts` | 71 | `console.log('[IPC] remote-server:add - Full input:', JSON.stringify(input))` | 删除整行（可能包含 SSH 密钥、密码等敏感字段） |
| 3 | `src/main/services/agent/send-message.ts` | 118-125 | `========== FUNCTION START ==========`、`===== BEFORE/AFTER GETSPACE =====` 等 | 删除这些调试横幅 |
| 4 | `src/main/services/agent/control.ts` | 27-130 | 15 处 `[Agent][control.ts]` 详细步骤日志 | 保留入口/出口/错误日志，删除中间步骤日志 |
| 5 | `src/main/services/agent/control.ts` | 114 | 注释掉的 `console.log` 残留 | 删除注释 |

### 方案 4: 统一 IPC handler 日志策略

**规则：只保留一种日志，去除重复**

| 场景 | 保留 | 删除/降级 |
|------|------|----------|
| 有 `[event]` 事件的 IPC handler | 保留 `console.info('[event] ...')` | 删除同操作的 `console.log('[IPC]/[Settings] ...')` 调用日志 |
| 只读 IPC handler（config:get, space:list, health:get-status 等） | 降级为 `console.debug()` 或直接删除 | - |
| IPC handler 注册日志（`console.log('[xxx] handlers registered')`） | 删除 | - |
| 错误日志 | 统一改为 `console.error('[scope] action failed', error)` 传完整 error 对象 | - |

涉及的重复日志清理：

| 文件 | 操作 |
|------|------|
| `src/main/ipc/config.ts` | config:set 删除 `[Settings] config:set - Saving/Saved` 日志，保留 `[event] updateConfig` |
| `src/main/ipc/remote-server.ts` | remote-server:add 删除 `[IPC]` 调用日志，保留 `[event] remoteServer` |
| `src/main/ipc/agent.ts` | agent:send-message/stop 删除重复 `[IPC]` 日志，保留 `[event]` |
| `src/main/ipc/space.ts` | space CRUD 删除重复 `[IPC]` 日志，保留 `[event]` |
| `src/main/ipc/skill.ts` | skill install/uninstall 删除重复 `[IPC]` 日志，保留 `[event]` |

### 方案 5: 错误日志标准化

将所有 `err.message` 模式改为传完整 error 对象：

```typescript
// 修改前（丢失 stack trace）
console.error('[IPC] remote-server:add - Failed:', err.message);

// 修改后（electron-log 自动序列化 stack）
console.error('[IPC] remote-server:add failed', error);
```

涉及文件（按 err.message 出现次数排序）：

| # | 文件 | err.message 出现次数 |
|---|------|---------------------|
| 1 | `src/main/ipc/remote-server.ts` | 62 |
| 2 | `src/main/ipc/config.ts` | 18 |
| 3 | `src/main/ipc/conversation.ts` | 12 |
| 4 | `src/main/ipc/remote.ts` | 16 |
| 5 | `src/main/ipc/space.ts` | 17 |
| 6 | `src/main/ipc/system.ts` | 14 |
| 7 | `src/main/ipc/artifact.ts` | 7 |
| 8 | `src/main/ipc/agent.ts` | 9 |
| 9 | `src/main/ipc/health.ts` | 11 |
| 10 | `src/main/ipc/auth.ts` | 7 |
| 11 | `src/main/ipc/onboarding.ts` | 4 |

修改策略：
- 将 `err.message` 替换为完整的 `error` 对象
- 对于已经是 `(error as Error).message` 的场景，改为直接传 `error`
- 对于已经是完整 `error` 对象引用的场景，无需修改

### 方案 6: 前缀统一 + 性能日志

#### 6.1 前缀统一

| # | 文件 | 当前前缀 | 修改为 |
|---|------|---------|--------|
| 1 | `src/main/ipc/remote.ts` (31 处) | `[Settings]` | `[Remote]` |
| 2 | `src/main/ipc/health.ts` (17 处) | `[Settings]` | `[Health]` |
| 3 | `src/main/ipc/onboarding.ts` (7 处) | `[Settings]` | `[Onboarding]` |
| 4 | `src/main/ipc/system.ts` (9 处) | `[Settings]` | `[System]` |
| 5 | `src/main/services/agent/control.ts` (15 处) | `[Agent][control.ts]` | `[Agent]` |

#### 6.2 性能日志

在 `src/main/bootstrap/essential.ts` 和 `src/main/bootstrap/extended.ts` 中优化启动计时：

```typescript
// essential.ts — 已有基础计时，优化格式
console.info(`[bootstrap] essential completed: ${duration}ms`);

// extended.ts — 添加各服务初始化耗时
for (const [name, duration] of serviceDurations) {
  console.info(`[bootstrap] service ${name}: ${duration}ms`);
}
console.info(`[bootstrap] extended completed: ${totalDuration}ms (total: ${elapsedSinceStart}ms)`);
```

## 开发前必读

### 模块设计文档

| # | 文件 | 阅读目的 |
|---|------|---------|
| 1 | `.project/prd/feature/logging/logging-enhancement-v2.md` | 了解日志日期分割和用户操作日志方案，确保兼容 |
| 2 | `.project/prd/bugfix/main/bugfix-log-noise-v1.md` | 了解现有噪音过滤 hook 实现，确保扩展不冲突 |

### 源码文件

| # | 文件路径 | 阅读目的 |
|---|---------|---------|
| 1 | `src/main/index.ts` (lines 16-80) | 了解当前日志初始化配置，确定脱敏 hook 和噪音过滤 hook 注册位置 |
| 2 | `src/main/http/server.ts` (lines 285-300) | 确认 access token 日志位置 |
| 3 | `src/main/ipc/remote-server.ts` (lines 60-80) | 确认敏感 JSON.stringify 日志位置 |
| 4 | `src/main/ipc/config.ts` (全文) | 确认 [Settings] 前缀使用和重复日志 |
| 5 | `src/main/ipc/remote.ts` (全文) | 确认 31 处 [Settings] 前缀误用 |
| 6 | `src/main/ipc/health.ts` (全文) | 确认 17 处 [Settings] 前缀误用 |
| 7 | `src/main/ipc/onboarding.ts` (全文) | 确认 7 处 [Settings] 前缀误用 |
| 8 | `src/main/ipc/system.ts` (全文) | 确认 9 处 [Settings] 前缀误用 |
| 9 | `src/main/ipc/agent.ts` (全文) | 确认重复日志和 err.message |
| 10 | `src/main/ipc/space.ts` (全文) | 确认重复日志和 err.message |
| 11 | `src/main/ipc/skill.ts` (全文) | 确认重复日志 |
| 12 | `src/main/ipc/conversation.ts` (全文) | 确认 err.message |
| 13 | `src/main/ipc/artifact.ts` (全文) | 确认 err.message |
| 14 | `src/main/ipc/auth.ts` (全文) | 确认 err.message |
| 15 | `src/main/services/agent/send-message.ts` (lines 110-135) | 确认调试横幅位置 |
| 16 | `src/main/services/agent/control.ts` (全文) | 确认 [Agent][control.ts] 日志和注释残留 |
| 17 | `src/main/bootstrap/essential.ts` | 了解启动计时实现 |
| 18 | `src/main/bootstrap/extended.ts` | 了解扩展启动流程，确定性能日志添加位置 |

### 编码规范

| # | 文档 | 阅读目的 |
|---|------|---------|
| 1 | `docs/Development-Standards-Guide.md` | 了解 TypeScript strict、IPC handler try/catch 规范 |

## 涉及文件

| # | 文件路径 | 变更类型 | 说明 |
|---|---------|---------|------|
| 1 | `src/main/index.ts` | 修改 | 添加脱敏 hook、扩展噪音过滤 hook |
| 2 | `src/main/http/server.ts` | 修改 | 删除 access token 明文日志 |
| 3 | `src/main/ipc/remote-server.ts` | 修改 | 删除敏感 JSON.stringify 日志、清理重复日志、修复 err.message |
| 4 | `src/main/ipc/config.ts` | 修改 | 清理重复日志、[Settings] 保持（属设置模块）、修复 err.message |
| 5 | `src/main/ipc/remote.ts` | 修改 | [Settings] -> [Remote]、修复 err.message |
| 6 | `src/main/ipc/health.ts` | 修改 | [Settings] -> [Health]、修复 err.message |
| 7 | `src/main/ipc/onboarding.ts` | 修改 | [Settings] -> [Onboarding]、修复 err.message |
| 8 | `src/main/ipc/system.ts` | 修改 | [Settings] -> [System]、修复 err.message |
| 9 | `src/main/ipc/agent.ts` | 修改 | 清理重复日志、修复 err.message |
| 10 | `src/main/ipc/space.ts` | 修改 | 清理重复日志、修复 err.message |
| 11 | `src/main/ipc/skill.ts` | 修改 | 清理重复日志、修复 err.message |
| 12 | `src/main/ipc/conversation.ts` | 修改 | 修复 err.message |
| 13 | `src/main/ipc/artifact.ts` | 修改 | 修复 err.message |
| 14 | `src/main/ipc/auth.ts` | 修改 | 修复 err.message |
| 15 | `src/main/ipc/ai-browser.ts` | 修改 | 修复 err.message |
| 16 | `src/main/ipc/hyper-space.ts` | 修改 | 修复 err.message |
| 17 | `src/main/services/agent/send-message.ts` | 修改 | 删除调试横幅 |
| 18 | `src/main/services/agent/control.ts` | 修改 | [Agent][control.ts] -> [Agent]、删除中间步骤日志、删除注释残留 |
| 19 | `src/main/bootstrap/essential.ts` | 修改 | 优化启动计时日志格式 |
| 20 | `src/main/bootstrap/extended.ts` | 修改 | 添加各服务初始化耗时日志 |

## 验收标准

### 安全修复（P0）

- [ ] `server.ts` 中不再明文打印 access token
- [ ] `remote-server.ts` 中不再序列化完整远程服务器配置
- [ ] 脱敏 hook 对 API key、Bearer token、密码等敏感字段生效（console + file 均生效）
- [ ] 脱敏后日志中不出现任何明文密钥或 token

### 噪音控制（P1）

- [ ] `send-message.ts` 中无 `==========` 调试横幅
- [ ] `control.ts` 中无 `[Agent][control.ts]` 文件名前缀
- [ ] `control.ts` 中中间步骤日志已删除（仅保留入口/出口/错误）
- [ ] 有 `[event]` 事件的 IPC handler 不再有重复的 `[IPC]`/`[Settings]` 调用日志
- [ ] 只读 IPC handler（config:get 等）日志已降级或删除
- [ ] IPC handler 注册日志（`xxx handlers registered`）已删除
- [ ] 文件传输噪音过滤 hook 正确过滤高频只读 IPC 日志
- [ ] 控制台输出不受影响（开发环境仍可看到完整日志）

### 错误质量（P1）

- [ ] 所有 IPC handler 的 catch 块传递完整 error 对象（非仅 err.message）
- [ ] 错误日志中包含 stack trace

### 前缀统一（P2）

- [ ] `remote.ts` 中 `[Settings]` 全部改为 `[Remote]`
- [ ] `health.ts` 中 `[Settings]` 全部改为 `[Health]`
- [ ] `onboarding.ts` 中 `[Settings]` 全部改为 `[Onboarding]`
- [ ] `system.ts` 中非设置相关的 `[Settings]` 改为 `[System]`
- [ ] `config.ts` 保留 `[Settings]` 前缀（属设置模块）

### 性能日志（P2）

- [ ] 启动计时日志格式统一
- [ ] extended services 各服务初始化有独立耗时记录

### 通用

- [ ] 与 logging-enhancement-v2 的日期分割方案兼容
- [ ] 与 bugfix-log-noise-v1 的噪音过滤 hook 兼容
- [ ] `npm run typecheck && npm run lint && npm run build` 通过
- [ ] 应用正常启动，无崩溃或白屏

## 变更记录

| 日期 | 内容 | 作者 |
|------|------|------|
| 2026-04-30 | 初始版本：基于代码审计确定 5 类问题，提出 6 个子方案 | 人 |
