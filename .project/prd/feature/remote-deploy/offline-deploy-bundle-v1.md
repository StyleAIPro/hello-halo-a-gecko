# PRD [功能级] -- 离线部署包（Offline Deploy Bundle）

> 版本：offline-deploy-bundle-v1
> 日期：2026-04-23
> 指令人：@MoonSeeker
> 归属模块：modules/remote-agent/remote-deploy
> 状态：in-progress
> 级别：feature
> 优先级：P0
> 影响范围：全栈（构建流水线 + 后端部署服务 + 前端 UI）

---

## 需求分析

### 背景

当前远程部署流程（`src/main/services/remote-deploy/remote-deploy.service.ts`）依赖远端服务器的网络来完成以下步骤：

1. **下载 Node.js 二进制**：`deployAgentCode()` 在检测到远端未安装 Node.js 时，通过 `curl` 从 `nodejs.org` 或 `npmmirror.com` 下载 Node.js（参见第 978 行 `installNodeCmd`）
2. **`npm install` 安装项目依赖**：上传 `package.json` + `dist/` 后，远端执行 `npm install --legacy-peer-deps`，从 `registry.npmmirror.com` 下载 `node_modules`（参见第 1141 行）
3. **`npm install -g` 安装 SDK**：远端执行 `npm install -g @anthropic-ai/claude-agent-sdk@{VERSION}` 安装全局 SDK（参见第 1469 行）
4. **`postinstall` 补丁**：`npm install` 触发 `postinstall` 钩子执行 `node scripts/patch-sdk.mjs`，对 SDK 进行运行时 patch

唯一无法避免的网络依赖是 **Claude API 调用**（运行时通过 SDK 访问 API），这是业务需求而非部署流程。

### 问题

国内/企业环境中远端服务器经常遇到网络问题：

| 场景 | 具体表现 |
|------|---------|
| DNS 污染/劫持 | `nodejs.org`、`registry.npmjs.org` 域名无法解析 |
| 证书校验失败 | 企业内网代理的 SSL 证书不受信任，`curl`/`npm` 报错 |
| 内网隔离 | 远端服务器完全无外网访问（需通过跳板机中转） |
| 带宽不足 | `node_modules` 体积大（~50MB+），npm install 耗时过长甚至超时 |
| npm 镜像不可用 | 即使配置了 npmmirror，镜像同步延迟或临时不可用 |
| 代理配置复杂 | 每台服务器需要单独配置 HTTP_PROXY/HTTPS_PROXY |

现有 `deployAgentCode()` 和 `deployAgentSDK()` 方法虽然做了多层容错（NodeSource 失败降级 npmmirror、npx 修复等），但这些都**依赖远端有网络**。在完全离线的环境下，部署会直接失败。

### 目标

用户安装 AICO-Bot EXE 后，**开箱即用**：选择远程服务器 → 点击「离线部署」→ 离线包自动上传部署完成。整个过程中远端服务器**零网络依赖**（除 Claude API 运行时调用）。

用户不需要：
- 手动构建离线包
- 手动下载离线包
- 在远端执行任何网络操作

### 核心设计决策

**离线包在 AICO-Bot 构建时预打包，嵌入 EXE 发行包内。**

理由：
- 用户只需安装 EXE 即可获得离线部署能力，无需额外操作
- CI/CD 构建环境网络稳定可靠，能保证离线包构建成功
- 避免用户本地环境差异导致离线包构建失败

### 体积影响

| 组件 | 大小 |
|------|------|
| 当前 EXE 安装包 | 141MB |
| 离线部署包（优化后，`--production` 安装 + 清理） | ~40-50MB |
| 嵌入后 EXE 预估 | ~180-190MB |

体积增加约 30-35%，可接受。

---

## 技术方案

### 整体架构

```
AICO-Bot 构建阶段（CI/CD，有网络）
┌─────────────────────────────────────────────────────────┐
│  npm run build                                          │
│  ├─ electron-vite build（主进程/渲染进程/preload）        │
│  └─ build:offline-bundle（新增，并行执行）                │
│      ├─ npm install --production（仅生产依赖）            │
│      ├─ npm run build（编译 TypeScript → dist/）          │
│      ├─ node scripts/patch-sdk.mjs（执行 SDK 补丁）       │
│      ├─ 下载 linux-x64 + linux-arm64 Node.js 二进制      │
│      ├─ 清理 node_modules（删除 devDependencies 残留）    │
│      └─ 打包 → resources/offline-bundles/                │
│          ├─ aico-bot-offline-linux-x64.tar.gz            │
│          └─ aico-bot-offline-linux-arm64.tar.gz          │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
electron-builder 打包（offline-bundles/ 随 asar 或 extraResources 打入 EXE）
                          │
                          ▼
用户运行 EXE → 远程部署面板 → 点击「离线部署」
┌─────────────────────────────────────────────────────────┐
│  选择平台（x64/arm64）→ 使用内置离线包                     │
│  ├─ 从 app 资源目录读取内置的 tar.gz                      │
│  ├─ SFTP 上传到远端服务器                                │
│  ├─ SSH: 解压 + 配置环境变量 + 启动                      │
│  └─ 远端 Agent Proxy 运行（仅需访问 Claude API）          │
└─────────────────────────────────────────────────────────┘
```

### 1. 构建流水线集成

**核心原则**：离线包构建集成到 `npm run build` 中，用户无感知。

**修改文件**：根目录 `package.json`

```jsonc
// 新增 scripts
{
  "build:offline-bundle": "node packages/remote-agent-proxy/scripts/build-offline-bundle.mjs",
  "build": "npm run build:proxy && npm run build:offline-bundle && electron-vite build"
}
```

`build:offline-bundle` 在 `electron-vite build` 之前执行，确保离线包就绪。

**构建流程** (`build-offline-bundle.mjs`)：

```
步骤 1: 安装生产依赖
  cd packages/remote-agent-proxy
  rm -rf node_modules
  npm install --production --legacy-peer-deps

步骤 2: 编译 TypeScript
  npm run build（执行 build-with-timestamp.js → tsc + version.json + patch-sdk）

步骤 3: 执行 SDK 补丁
  node scripts/patch-sdk.mjs（确保 node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs 已 patch）

步骤 4: 下载 Node.js 二进制
  linux-x64:  node-v20.18.1-linux-x64.tar.xz（~25MB）
  linux-arm64: node-v20.18.1-linux-arm64.tar.xz（~25MB）
  下载源: https://nodejs.org/dist/ → 备 https://npmmirror.com/mirrors/node/
  缓存: 构建缓存目录，避免重复下载

步骤 5: 组装 staging 目录
  staging/
  ├── dist/                    # 编译产物
  ├── node_modules/            # 仅生产依赖（已 patch SDK）
  ├── scripts/                 # patch-sdk.mjs 等脚本
  ├── package.json             # 依赖声明
  ├── node-v20.18.1-linux-x64/ # Node.js 运行时
  │   └── bin/node
  ├── deploy-env.sh            # 环境初始化脚本
  └── version.json             # 构建信息

步骤 6: 清理 node_modules 减小体积
  删除: *.ts, *.map, test/, tests/, __tests__/
        .github/, .eslint*, .prettier*, README*, CHANGELOG*, LICENSE*
        node_modules/.cache/
  保留: @anthropic-ai/ 完整（SDK 核心，54MB）

步骤 7: 打包为 tar.gz
  输出到 resources/offline-bundles/:
    ├─ aico-bot-offline-linux-x64.tar.gz     (~50MB)
    └─ aico-bot-offline-linux-arm64.tar.gz    (~50MB)
```

### 2. 离线包嵌入 EXE

**方案**：通过 electron-builder 的 `extraResources` 将离线包打入安装包。

**修改文件**：根目录 `package.json` 的 `build` 配置

```jsonc
{
  "build": {
    "extraResources": [
      {
        "from": "resources/offline-bundles",
        "to": "offline-bundles"
      }
    ]
  }
}
```

**运行时读取**：

```typescript
// 主进程中读取内置离线包路径
import { app } from 'electron';
import path from 'path';

function getOfflineBundlePath(platform: 'x64' | 'arm64'): string {
  if (app.isPackaged) {
    // 打包后: resources/offline-bundles/aico-bot-offline-linux-x64.tar.gz
    return path.join(process.resourcesPath, 'offline-bundles', `aico-bot-offline-linux-${platform}.tar.gz`);
  }
  // 开发环境: resources/offline-bundles/...
  return path.join(app.getAppPath(), 'resources', 'offline-bundles', `aico-bot-offline-linux-${platform}.tar.gz`);
}
```

### 3. 远端离线部署流程

**修改文件**：`src/main/services/remote-deploy/remote-deploy.service.ts`

新增方法 `deployAgentCodeOffline(id: string, platform: 'x64' | 'arm64'): Promise<void>`：

```
deployAgentCodeOffline(serverId, platform)
  │
  ├─ 1. 定位离线包
  │    getOfflineBundlePath(platform)
  │    校验 tar.gz 文件存在且完整
  │
  ├─ 2. 上传离线包
  │    SFTP upload tar.gz → deployPath/aico-bot-offline.tar.gz
  │    进度回调: emitDeployProgress(id, 'upload', '正在上传离线部署包...', 20)
  │
  ├─ 3. 解压离线包
  │    SSH: cd deployPath && tar -xzf aico-bot-offline.tar.gz && rm aico-bot-offline.tar.gz
  │    进度回调: emitDeployProgress(id, 'extract', '正在解压离线部署包...', 35)
  │
  ├─ 4. 配置环境 & 创建 symlink
  │    SSH: source deployPath/deploy-env.sh
  │    验证 bundled node --version 可用
  │    创建 SDK 全局 symlink:
  │      ln -s deployPath/node_modules/@anthropic-ai /usr/local/lib/node_modules/@anthropic-ai
  │    进度回调: emitDeployProgress(id, 'env', '正在配置运行环境...', 50)
  │
  ├─ 5. 生成 .env 配置
  │    复用现有 .env 生成逻辑（端口、API Key、工作目录等）
  │    进度回调: emitDeployProgress(id, 'config', '正在生成配置...', 60)
  │
  ├─ 6. 创建必要目录
  │    mkdir -p logs/ data/ config/
  │    mkdir -p ~/.agents/skills ~/.agents/claude-config
  │    进度回调: emitDeployProgress(id, 'prepare', '正在创建目录...', 70)
  │
  └─ 7. 启动 Agent
       使用 bundled Node.js: deployPath/node-v20.18.1-linux-x64/bin/node dist/index.js
       进度回调: emitDeployProgress(id, 'start', '正在启动 Agent...', 80)
```

**关键设计**：

- **SDK 全局安装**：`@anthropic-ai/claude-agent-sdk` 的 `ProcessTransport` 需要全局查找 CLI。离线包通过 symlink 将 SDK 挂载到全局 `node_modules`，无需 `npm install -g`
- **Node.js 完全自包含**：使用 bundled 的 `node-v20.18.1/bin/node` 启动，不依赖系统 Node.js
- **postinstall 跳过**：离线包中的 SDK 已在构建时 patch 过，部署时跳过所有 `npm install`

### 4. 增量更新

远端已有离线部署时，后续更新仅上传 `dist/` 变更（~1MB），不上传整个离线包：

```
updateAgentCodeOffline(serverId)
  │
  ├─ 1. 检测远端已有离线部署
  │    test -f deployPath/deploy-env.sh → 已有
  │
  ├─ 2. 只上传 dist/ + version.json（~1-2MB）
  │
  ├─ 3. 对比 version.json 版本号
  │    版本不一致 → 更新 dist/
  │    版本一致 → 跳过，已是最新
  │
  └─ 4. 重启 Agent（使用 bundled Node.js）
```

### 5. 回退机制

离线部署失败时自动降级到在线部署：

```typescript
async deployAgentCodeOffline(id: string, platform: 'x64' | 'arm64'): Promise<void> {
  try {
    // ... 离线部署流程
  } catch (error) {
    this.emitCommandOutput(id, 'output',
      `离线部署失败: ${error.message}，回退到在线部署...`);
    return this.deployAgentCode(id);
  }
}
```

### 6. 前端 UI 变更

**修改文件**：`src/renderer/components/settings/RemoteServersSection.tsx`

在现有服务器操作栏中，将部署按钮调整为在线/离线两种模式：

```
服务器详情面板
├── [Connect] [Disconnect] [Delete]        ← 现有按钮
├── 部署方式: (●) 离线部署  ( ) 在线部署    ← 新增：单选切换
├── 平台:     (●) linux-x64  ( ) linux-arm64  ← 仅离线模式显示
├── [Deploy Agent]                          ← 统一按钮，根据模式走不同流程
└── 部署进度面板                            ← 现有，复用
```

**交互说明**：
- 默认选中「离线部署」+ 「linux-x64」（最常用组合）
- 离线部署使用内置离线包，无需用户选择文件
- 在线部署走现有 `deployAgentCode()` 流程
- 部署进度面板复用现有 UI，进度步骤文案根据模式调整

**新增 IPC 通道**：

| 通道名 | 方法 | 说明 |
|--------|------|------|
| `remote-server:deploy-offline` | IPC handle | 使用内置离线包部署（参数：platform） |

### 7. 与现有代码的兼容性

| 现有方法 | 影响 | 说明 |
|---------|------|------|
| `deployAgentCode()` | 不变 | 现有在线部署流程完全保留 |
| `updateAgentCode()` | 不变 | 现有增量更新流程完全保留 |
| `deployAgentSDK()` | 不变 | 现有 SDK 安装流程完全保留 |
| `startAgent()` | 小幅调整 | 新增 `useBundledNode` 参数，离线部署时使用 bundled Node.js |
| `createDeployPackage()` | 不变 | 离线包使用独立构建脚本 |
| `checkDeployFilesIntegrity()` | 扩展 | 增加 `deploy-env.sh` 和 `node-v*/` 到检查清单 |

### 8. 开发环境支持

开发时（`npm run dev`）也需要离线包，否则无法测试。策略：

- `npm run build:offline-bundle` 可独立执行，生成的包放在 `resources/offline-bundles/`
- 开发环境下 `getOfflineBundlePath()` 优先从 `resources/offline-bundles/` 读取
- 如果离线包不存在，前端「离线部署」按钮置灰并提示「请先执行 `npm run build:offline-bundle`」
- `npm run prepare` 可选集成 `build:offline-bundle`，让开发者一键就绪

---

## 开发前必读

### 模块设计文档

| 文档路径 | 阅读目的 |
|---------|---------|
| `.project/modules/remote-agent/remote-agent-v1.md` | 理解 Remote Agent 模块整体架构、各子模块职责和对外接口 |
| `.project/modules/remote-agent/features/remote-deploy/design.md` | 理解现有部署流程（deployAgentCode/updateAgentCode）、SDK Patch 机制、Node.js 安装逻辑 |
| `.project/modules/remote-agent/features/remote-deploy/changelog.md` | 了解近期变更，避免回归 |
| `.project/modules/remote-agent/features/remote-deploy/bugfix.md` | 了解已知问题和历史 bug |

### 源码文件

| 文件路径 | 阅读目的 |
|---------|---------|
| `src/main/services/remote-deploy/remote-deploy.service.ts` | **核心文件**：理解 `deployAgentCode()`、`updateAgentCode()`、`deployAgentSDK()`、`startAgent()` 的完整实现 |
| `packages/remote-agent-proxy/package.json` | 理解依赖声明、`postinstall` 钩子、构建脚本 |
| `packages/remote-agent-proxy/scripts/build-with-timestamp.js` | 理解构建流程（tsc → version.json → patch-sdk） |
| `packages/remote-agent-proxy/scripts/patch-sdk.mjs` | 理解 SDK 补丁机制，确保离线包构建时正确执行 |
| `src/shared/constants/sdk.ts` | 理解 `CLAUDE_AGENT_SDK_VERSION` 常量定义 |
| `src/shared/types/index.ts` | 理解 `RemoteServer` 接口（可能需要新增字段） |
| `src/renderer/components/settings/RemoteServersSection.tsx` | 理解前端服务器管理 UI 现有交互 |
| `src/renderer/api/index.ts` | 理解 API 层现有 remote-server 相关接口 |
| `src/preload/index.ts` | 理解 preload 暴露的 IPC 接口 |
| `package.json`（根目录） | 理解 `build` 配置（extraResources）、构建脚本（build:offline-bundle） |

### API 文档

| 文档路径 | 阅读目的 |
|---------|---------|
| `src/main/ipc/` 中 remote-server 相关 IPC 处理器 | 理解 IPC 通道注册模式 |

### 编码规范

| 文档路径 | 阅读目的 |
|---------|---------|
| `docs/Development-Standards-Guide.md` | TypeScript 严格模式、命名规范、IPC 通道常量化等编码规范 |
| `docs/vibecoding-doc-standard.md` | 文档管理规范 |

---

## 涉及文件

### 新增文件

| 文件路径 | 说明 |
|---------|------|
| `packages/remote-agent-proxy/scripts/build-offline-bundle.mjs` | 离线部署包构建脚本（下载 Node.js、组装 staging、打包 tar.gz） |
| `packages/remote-agent-proxy/scripts/deploy-env.sh` | 远端环境初始化脚本（设置 PATH、创建 symlink） |
| `resources/offline-bundles/` | 离线包输出目录（.gitignore） |
| `.project/modules/remote-agent/features/offline-deploy/design.md` | 离线部署功能设计文档 |
| `.project/modules/remote-agent/features/offline-deploy/changelog.md` | 离线部署变更记录 |

### 修改文件

| 文件路径 | 修改内容 |
|---------|---------|
| `package.json`（根目录） | 新增 `build:offline-bundle` script；`build` 配置新增 `extraResources` 指向 `resources/offline-bundles/` |
| `src/main/services/remote-deploy/remote-deploy.service.ts` | 新增 `deployAgentCodeOffline()`、`updateAgentCodeOffline()`、`getOfflineBundlePath()`；调整 `startAgent()` 支持 bundled Node.js |
| `src/shared/constants/` | 新增离线部署相关 IPC 通道常量 |
| `src/preload/index.ts` | 新增 `deployOffline` 方法暴露 |
| `src/renderer/api/index.ts` | 新增 `remoteServerDeployOffline` API 方法 |
| `src/renderer/api/transport.ts` | `methodMap` 新增离线部署相关方法映射 |
| `src/renderer/components/settings/RemoteServersSection.tsx` | 部署按钮改为在线/离线模式切换；离线模式下显示平台选择 |

---

## 验收标准

- [ ] **B1**: `npm run build:offline-bundle` 能成功构建离线包，输出到 `resources/offline-bundles/`
- [ ] **B2**: `npm run build` 能成功完成（含离线包构建 + electron-vite build）
- [ ] **B3**: `npm run build:win` 生成的 EXE 安装包内包含 `resources/offline-bundles/aico-bot-offline-linux-x64.tar.gz`
- [ ] **B4**: 离线包内容完整：dist/、node_modules/（已 patch SDK）、scripts/、package.json、deploy-env.sh、Node.js 二进制
- [ ] **B5**: 离线包体积单平台 ≤ 55MB（清理 devDependencies 后）
- [ ] **B6**: 远端服务器断网状态下，上传内置离线包后部署，Agent Proxy 正常启动（使用 bundled Node.js + bundled SDK）
- [ ] **B7**: 离线部署的 Agent Proxy 能正常创建会话并访问 Claude API（运行时网络正常即可）
- [ ] **B8**: 增量更新正常（后续更新仅上传 dist/，~1-2MB）
- [ ] **B9**: 离线部署失败自动回退到在线部署
- [ ] **B10**: 现有在线部署流程完全不受影响
- [ ] **B11**: 前端 UI 有在线/离线模式切换，离线模式下可选择平台
- [ ] **B12**: 开发环境下离线包不存在时，离线部署按钮置灰并提示
- [ ] **B13**: `npm run typecheck && npm run lint && npm run build` 全部通过
- [ ] **B14**: 新增用户可见文本已提取 i18n key 并翻译
