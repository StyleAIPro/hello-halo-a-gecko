# Bugfix: SDK 版本和 Node.js 版本硬编码，升级时需多处手动同步

## 元信息

- **时间**: 2026-04-22
- **状态**: done
- **优先级**: P1
- **指令人**: StyleAIPro
- **影响范围**: 前端（RemoteServersSection） + 后端（remote-deploy）
- **PRD 级别**: bugfix

## 问题描述

项目中存在两处版本号硬编码问题，版本升级时容易遗漏同步，导致显示错误或部署失败：

### Bug 1: SDK 版本硬编码在 UI 徽标中

- **文件**: `src/renderer/components/settings/RemoteServersSection.tsx` 第 983 行
- **现象**: 版本不匹配警告中，所需版本号 `0.2.104` 硬编码在 JSX 中：

  ```tsx
  <span>{t('SDK')} {server.sdkVersion} (need 0.2.104)</span>
  ```

- **问题**: 项目已定义了共享常量 `CLAUDE_AGENT_SDK_VERSION`（`src/shared/constants/sdk.ts`），但 UI 未引用该常量。当 SDK 升级时，此处硬编码值容易被遗漏，导致提示的版本号与实际要求不一致。

### Bug 2: Node.js 版本硬编码在 Shell 脚本中

- **文件**: `src/main/services/remote-deploy/remote-deploy.service.ts` 第 1222-1223 行和第 3427-3428 行（共两处，逻辑相同）
- **现象**: npx 路径查找脚本中，Node.js 安装目录路径包含硬编码版本号 `v20.18.1`：

  ```bash
  elif [ -f "/usr/local/node-v20.18.1-linux-arm64/bin/npx" ]; then
    NPX_BIN="/usr/local/node-v20.18.1-linux-arm64/bin/npx"
  ```

- **问题**: `REQUIRED_NODE_VERSION` 常量（第 186 行）和 `$NODE_VER` Shell 变量（在第 224 行赋值）已经定义，但此处路径拼接时未使用变量，而是直接写死了版本字符串。当 Node.js 版本升级时，这两处容易遗漏修改，导致找不到 npx 二进制，部署失败。此外，该路径只覆盖了 `arm64` 架构，未考虑 `x64`。

## 根因分析

两处问题的根因相同：**在拼接版本相关的字符串时，开发者直接写了字面量而非引用已有的常量或变量**。这是典型的 copy-paste 疏忽，缺少 code review 中的版本引用一致性检查。

## 技术方案

### Bug 1 修复

1. 在 `RemoteServersSection.tsx` 顶部导入共享常量：
   ```typescript
   import { CLAUDE_AGENT_SDK_VERSION } from '@shared/constants/sdk';
   ```
2. 将第 983 行替换为使用常量引用：
   ```tsx
   <span>{t('SDK')} {server.sdkVersion} (need {CLAUDE_AGENT_SDK_VERSION})</span>
   ```

### Bug 2 修复

将两处硬编码的 Node.js 版本路径改为使用 `$NODE_VER` 变量动态拼接，同时补充 `x64` 架构支持：

```bash
# Try node installation directory (arm64)
elif [ -f "/usr/local/node-$NODE_VER-linux-arm64/bin/npx" ]; then
  NPX_BIN="/usr/local/node-$NODE_VER-linux-arm64/bin/npx"
# Try node installation directory (x64)
elif [ -f "/usr/local/node-$NODE_VER-linux-x64/bin/npx" ]; then
  NPX_BIN="/usr/local/node-$NODE_VER-linux-x64/bin/npx"
```

**注意**: 该 Shell 脚本片段通过模板字符串拼接到更大的部署脚本中。需确认 `$NODE_VER` 变量在此片段执行前已被赋值（当前 `$NODE_VER` 在第 224 行赋值，而此片段在约第 1216 行执行，需验证执行时序。若 `$NODE_VER` 可能未定义，则应在片段内补充 `NODE_VER="${NODE_VER:-v20.18.1}"` 的回退赋值）。

两处修改位于相同的方法逻辑中（约第 1216 行和第 3421 行的 `findAndLinkCmd`），需要同步修改。

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/renderer/components/settings/RemoteServersSection.tsx` | 修改 | 导入 `CLAUDE_AGENT_SDK_VERSION`，替换硬编码版本号 |
| `src/main/services/remote-deploy/remote-deploy.service.ts` | 修改 | 两处 `findAndLinkCmd` 中用 `$NODE_VER` 替换硬编码版本，补充 x64 架构支持 |

## 开发前必读

1. `src/shared/constants/sdk.ts` — `CLAUDE_AGENT_SDK_VERSION` 常量定义
2. `src/renderer/components/settings/RemoteServersSection.tsx` — UI 版本徽标逻辑（第 970-990 行）
3. `src/main/services/remote-deploy/remote-deploy.service.ts` — `REQUIRED_NODE_VERSION` 常量（第 186 行）、`$NODE_VER` 赋值（第 224 行）、`findAndLinkCmd` 片段（第 1216 行和第 3421 行）
4. `.project/modules/remote-agent/features/remote-deploy/changelog.md` — 了解远程部署最近变更
5. `.project/modules/remote-agent/features/remote-deploy/bugfix.md` — 了解已知问题

## 验收标准

- [ ] `RemoteServersSection.tsx` 中 SDK 版本警告使用 `CLAUDE_AGENT_SDK_VERSION` 常量，无硬编码版本号
- [ ] `remote-deploy.service.ts` 中两处 `findAndLinkCmd` 使用 `$NODE_VER` 变量拼接路径，无硬编码 `v20.18.1`
- [ ] npx 路径查找同时覆盖 `arm64` 和 `x64` 架构
- [ ] 若 `$NODE_VER` 可能为空，片段内有回退赋值逻辑
- [ ] `npm run typecheck && npm run lint && npm run build` 全部通过
- [ ] 手动验证：修改 `CLAUDE_AGENT_SDK_VERSION` / `REQUIRED_NODE_VERSION` 常量后，对应 UI 和 Shell 脚本中的版本号自动更新，无需额外修改
