# PRD [Bug 修复级] — 打包后应用因 SDK Patch 启动卡死/反复重启

> 版本：bugfix-packaged-app-crash-on-sdk-patch-v1
> 日期：2026-04-17
> 指令人：@moonseeker1
> 反馈人：@moonseeker1
> 归属模块：modules/agent
> 严重程度：Critical

## 问题描述
- **期望行为**：打包后的应用（`npm run build:win` 等产物）正常启动，窗口正常显示
- **实际行为**：打包后应用启动卡死，进程反复重启，无法进入主界面
- **复现步骤**：
  1. 执行 `npm run build:win`（或 `build:mac` / `build:linux`）完成打包
  2. 安装并运行打包后的应用
  3. 应用启动后卡死，日志打印 `[Bootstrap] SDK patch script: ...app.asar/scripts/patch-sdk.mjs` 后无后续输出
  4. 进程崩溃后反复重启，始终无法进入正常界面

## 根因分析

### 背景

`src/main/bootstrap/essential.ts` 在阶段一（Essential）初始化时执行 SDK Patch 脚本 `scripts/patch-sdk.mjs`。该脚本用于修补 `@anthropic-ai/claude-agent-sdk` 的 `sdk.mjs`，使其支持选项转发（cwd、systemPrompt 等）。在开发模式下，`essential.ts` 通过 `execFileSync('node', [patchScript])` 执行该脚本，可以正常工作。

### 问题根因

在打包后环境中存在两个致命问题：

**问题一：`process.execPath` 指向 Electron 二进制（已修复）**

此前 `essential.ts` 使用 `execFileSync(process.execPath, [patchScript])` 执行 `.mjs` 脚本。打包后 `process.execPath` 指向 Electron 可执行文件（如 `AICO-Bot.exe`），Electron 会将 `.mjs` 文件作为 app 入口点加载，而非作为 Node.js 脚本执行，导致 Electron 尝试加载完整应用而卡死/崩溃。

**问题二：`app.asar` 内文件只读（需构建流程修复）**

即使使用正确的 `node` 执行器，打包后 `scripts/patch-sdk.mjs` 和 `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` 都位于 `app.asar` 内部。asar 是只读归档格式，运行时无法修改其中的文件。因此：
- Patch 脚本本身可以被执行（读取 asar 内文件是允许的）
- 但 `writeFileSync` 写入 `sdk.mjs` 会失败（asar 内文件不可写）
- 即使假设能写入，也只是写入了 asar 的内存映射，不影响实际文件

### 关键代码位置

| 文件 | 行号 | 说明 |
|------|------|------|
| `src/main/bootstrap/essential.ts` | 46-63 | SDK Patch 执行逻辑 |
| `scripts/patch-sdk.mjs` | 全文 | Patch 脚本，读写 `node_modules/.../sdk.mjs` |
| `package.json` | build scripts | `build` 命令为 `build:proxy && electron-vite build`，未包含 SDK patch 步骤 |

### 日志表现

```
[Bootstrap] SDK patch script: /path/to/resources/app.asar/scripts/patch-sdk.mjs
（进程卡死，无后续输出）
```

## 修复方案

### 第一部分：运行时执行器修复（已完成）

修改 `essential.ts` 中的 SDK Patch 逻辑：

1. **打包后跳过运行时 Patch**：`app.isPackaged` 为 `true` 时直接跳过，打印日志说明 patch 应在构建时完成
2. **开发模式使用 `node`**：将 `execFileSync(process.execPath, [patchScript])` 改为 `execFileSync('node', [patchScript])`，确保 `.mjs` 脚本由 Node.js 执行

修复后 `essential.ts` 代码：

```typescript
try {
  if (app.isPackaged) {
    console.log('[Bootstrap] Packaged build — skipping runtime SDK patch (must be pre-patched in build output)');
  } else {
    const projectRoot = path.join(__dirname, '..', '..');
    const patchScript = path.join(projectRoot, 'scripts', 'patch-sdk.mjs');
    console.log(`[Bootstrap] SDK patch script: ${patchScript}`);
    execFileSync('node', [patchScript], { stdio: 'pipe' });
    console.log('[Bootstrap] SDK patch applied');
  }
} catch (e) {
  console.error('[Bootstrap] SDK patch failed:', e);
}
```

### 第二部分：构建流程修复（待完成）

当前构建流程：
```
build:proxy → electron-vite build → electron-builder 打包
```

需要修改为：
```
build:proxy → node scripts/patch-sdk.mjs → electron-vite build → electron-builder 打包
```

在 `electron-vite build` **之前**执行 SDK patch，确保 `out/` 目录中编译出的 `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` 已是 patched 状态。`electron-builder` 打包时会将 `out/` 内容封装进 `app.asar`，从而保证打包后的应用使用的是 patched SDK。

**具体改动**：
1. `package.json` 的 `build` 脚本改为：`npm run build:proxy && node scripts/patch-sdk.mjs && electron-vite build`
2. 或者新建一个 `build:patch-sdk` 脚本步骤，在 `build` 中串行调用

### 设计原则

- **构建时 Patch**：SDK patch 只在构建时执行一次，运行时不再修改 SDK 文件
- **开发时 Patch**：开发模式（`npm run dev`）仍由 `essential.ts` 在启动时自动执行
- **防御性日志**：打包后跳过时打印明确日志，便于排查问题

## 影响范围
- [ ] 涉及 API 变更 → 无
- [ ] 涉及数据结构变更 → 无
- [x] 涉及功能设计变更 → `modules/agent/features/sdk-patch/design.md`（需补充构建时 patch 流程说明）
- [ ] 涉及模块文档变更 → `modules/agent/` 模块文档中的内部组件表可能需补充 `scripts/patch-sdk.mjs`

## 验证方式

1. **开发模式验证**：
   - `npm run dev` 正常启动
   - 控制台日志包含 `[Bootstrap] SDK patch applied`
   - 发送 Agent 消息，确认 SDK 功能正常（cwd、systemPrompt 等选项生效）

2. **打包验证**：
   - `npm run build:win`（或对应平台）构建成功
   - 安装打包产物，启动应用正常进入主界面
   - 控制台日志包含 `[Bootstrap] Packaged build — skipping runtime SDK patch`
   - 发送 Agent 消息，确认 SDK 功能正常
   - 不再出现卡死/反复重启

3. **回归验证**：
   - 远程 Agent 部署功能不受影响（远程环境使用独立 patch 流程）

## 变更
| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-17 | 初始 PRD | @moonseeker1 |
