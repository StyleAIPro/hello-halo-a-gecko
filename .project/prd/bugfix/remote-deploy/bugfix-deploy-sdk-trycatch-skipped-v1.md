# Bugfix: deployAgentSDK 环境检查 try/catch 永不触发导致安装逻辑跳过

## 元信息

- **时间**: 2026-04-21
- **状态**: confirmed
- **优先级**: P0
- **指令人**: StyleAIPro
- **影响范围**: 仅后端（remote-deploy）
- **PRD 级别**: bugfix

## 问题描述

在全新的远程服务器上执行 Add Server（触发 `deployAgentSDK()`）时，Node.js 未安装但自动安装逻辑被跳过，导致后续所有 `npm` 命令报 `command not found`（exit code 127），部署失败。

## 根因分析

`SSHManager` 有两个执行命令的方法：

| 方法 | 非零退出码行为 |
|------|---------------|
| `executeCommand()` | **throw Error** |
| `executeCommandFull()` | **resolve，返回 { exitCode }** |

`deployAgentSDK()` 中检查 Node.js/npm/npx/claude 时，使用了 `executeCommandFull()` + `try/catch` 的模式：

```typescript
// 第 3173 行（修复前）
try {
  const nodeVersion = await manager.executeCommandFull('node --version');
  // ... 成功处理
} catch {
  // Node.js 安装逻辑 ← 永远不会执行！
}
```

因为 `executeCommandFull` 在非零退出码时 **不会 throw**，所以 catch 块永远不会进入，Node.js 自动安装逻辑被完全跳过。

对比 `deployAgentCode()` 中使用了正确的写法：
```typescript
const nodeCheck = await manager.executeCommandFull('node --version');
if (nodeCheck.exitCode !== 0 || !nodeCheck.stdout.trim()) {
  // 安装 Node.js ← 正确触发
}
```

## 涉及的 4 个 bug 点

### Bug 1: Node.js 检查（第 3173 行）
- `executeCommandFull('node --version')` + try/catch → catch 永不触发
- **影响**: Node.js 未安装时跳过自动安装

### Bug 2: npm 检查（第 3214 行）
- 同上模式，npm 不存在时 catch 不触发
- **影响**: npm 不存在时不报错（静默通过），后续 npm 命令全部失败

### Bug 3: npx 检查（第 3228 行）
- 同上模式，npx 不存在时安装/修复逻辑被跳过
- **影响**: npx 损坏时不修复

### Bug 4: Claude CLI 安装缺少 npm registry 配置（第 3337 行）
- 当 Node.js 已安装（try 块成功）但 Claude CLI 未安装时
- 直接执行 `npm install -g @anthropic-ai/claude-code` 未先 `npm config set registry`
- **影响**: 内网环境下 Claude CLI 安装可能因无法访问 npm 默认 registry 而超时

## 技术方案

将 `deployAgentSDK()` 中所有 `executeCommandFull()` + `try/catch` 改为 `executeCommandFull()` + 手动 `exitCode` 检查，与 `deployAgentCode()` 对齐。

### 修改清单

1. **Node.js 检查**: try/catch → `if (exitCode !== 0 || !stdout.trim())`
2. **npm 检查**: try/catch → `if (exitCode !== 0 || !stdout.trim())`
3. **npx 检查**: try/catch → `if (exitCode !== 0 || !stdout.trim())`
4. **Claude CLI 安装**: try/catch → `if (exitCode !== 0 || !stdout.trim())`，并在安装前添加 `npm config set registry`

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/services/remote-deploy/remote-deploy.service.ts` | 修改 | deployAgentSDK() 4 处 try/catch 改为 exitCode 检查 + Claude CLI 安装前加 registry 配置 |

## 开发前必读

- `src/main/services/remote-ssh/ssh-manager.ts` — 理解 executeCommand vs executeCommandFull 的行为差异
- `src/main/services/remote-deploy/remote-deploy.service.ts` — deployAgentCode() 中的正确写法参考

## 验收标准

- [ ] 在全新远程服务器上 Add Server，Node.js 自动安装正常触发
- [ ] npm/npx 检查正确识别不存在的情况
- [ ] Claude CLI 安装前正确配置 npm registry
- [ ] 内网环境下使用华为镜像源，完整部署流程（Add Server + Update Agent）不卡住
- [ ] `npm run typecheck && npm run lint && npm run build` 通过
