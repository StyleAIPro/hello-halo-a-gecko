# PRD [功能级] -- 部署前网络连通性预检

> 版本：feature-deploy-network-precheck-v1
> 日期：2026-04-22
> 指令人：StyleAIPro
> 归属模块：main/remote-deploy + renderer/settings
> 状态：done
> 优先级：P1
> 影响范围：前端 + 后端（remote-deploy）
> PRD 级别：feature

## 需求分析

### 背景

用户在内网环境中使用远程部署功能时，如果未配置镜像源，会出现以下体验问题：

1. SSH 连接正常建立（通常很快）
2. 部署流程继续执行 `npm install` / `curl` 下载 Node.js 等操作
3. 这些操作尝试访问外网 URL（npm registry、Node.js 下载镜像），在内网中无法连通
4. 经过数分钟的超时等待后操作失败

用户往往忘记自己处于内网环境，直到超时才发现问题。整个等待过程浪费了用户数分钟的时间。

### 现状分析

当前远程部署的 4 个入口方法在 SSH 连接建立后，直接进入部署阶段（npm install、下载 Node.js 等），没有任何网络连通性预检：

| # | 方法 | 调用时机 |
|---|------|---------|
| 1 | `autoDetectAndDeploy()` | Add Server 后自动检测并部署 |
| 2 | `updateAgent()` | 用户点击「Update Agent」 |
| 3 | `deployAgentCode()` | 首次部署或增量更新代码 |
| 4 | `deployToServer()` | 完整重新部署 |

部署进度事件流：
```
emitDeployProgress(id, stage, message, progress)
  → deployProgressCallbacks
    → IPC 'remote-server:deploy-progress'
      → renderer handleDeployProgress()
        → addProgress state + terminalEntries
```

### 问题

1. **浪费用户时间**：内网用户每次部署失败都要等数分钟超时
2. **错误信息不明确**：超时后的错误信息通常是 npm install 失败，用户难以判断是网络问题
3. **缺乏主动提醒**：系统知道将访问的 URL，但没有在部署前主动检查

### 目标

1. 在部署实际开始前（SSH 连接建立后），通过 SSH 在远程服务器上执行快速网络连通性检查
2. 根据检查结果和当前镜像源配置，向用户展示适当的提示
3. 用户可以选择配置镜像源、继续部署（接受超时风险）、或取消操作

### 使用场景

1. **内网 + 未配置镜像**：用户在内网，未配置镜像源。预检发现 npm registry 不可达 → 提示用户配置镜像源
2. **内网 + 已配置镜像**：用户在内网，已配置镜像源但镜像 URL 配错了。预检发现镜像不可达 → 提示用户检查配置
3. **外网 + 正常**：用户在外网，网络通畅。预检通过 → 静默跳过，正常部署
4. **外网 + 已配置镜像**：用户在外网，配置了自定义镜像。预检镜像不可达 → 提示用户检查配置

## 技术方案

### 架构概览

```
┌─────────────────────────────────────────────────────────────────────┐
│  部署入口方法                                                         │
│  autoDetectAndDeploy / updateAgent / deployAgentCode / deployToServer│
│       │                                                             │
│       ▼                                                             │
│  ┌─────────────────────────────────┐                                │
│  │ checkRemoteNetworkConnectivity  │  ← 新增方法                     │
│  │  1. 通过 SSH 在远程执行 curl     │                                │
│  │  2. 检查 npm registry 可达性     │                                │
│  │  3. 检查 Node.js 下载镜像可达性  │                                │
│  │  4. emit precheck 进度事件      │                                │
│  └──────────────┬──────────────────┘                                │
│                 │                                                    │
│                 ▼                                                    │
│  ┌─────────────────────────────────┐                                │
│  │ 结果处理                         │                                │
│  │  全部可达 → 继续部署             │                                │
│  │  不可达 → emit precheck-fail    │                                │
│  │         → 等待 UI 确认/取消     │                                │
│  └─────────────────────────────────┘                                │
│                                                                      │
│  ─── 前端 ───                                                        │
│  ┌─────────────────────────────────┐                                │
│  │ handleDeployProgress()          │                                │
│  │  stage === 'precheck-fail' →    │                                │
│  │    判断是否配置了镜像源           │                                │
│  │    显示对应的提示对话框           │                                │
│  │    "配置镜像源" → 滚动到配置区域  │                                │
│  │    "继续" → 调用 continueDeploy  │                                │
│  │    "取消" → 调用 cancelDeploy    │                                │
│  └─────────────────────────────────┘                                │
└─────────────────────────────────────────────────────────────────────┘
```

### 1. 后端：网络连通性检查方法

**文件**：`src/main/services/remote-deploy/remote-deploy.service.ts`（修改）

新增方法和接口：

```typescript
/** 网络连通性检查结果 */
interface NetworkCheckResult {
  npmReachable: boolean;
  nodeMirrorReachable: boolean;
  /** 是否配置了自定义镜像源 */
  mirrorConfigured: boolean;
}

/**
 * 在远程服务器上检查部署所需的网络连通性
 * 通过 SSH 执行 curl 命令，检查 npm registry 和 Node.js 下载镜像是否可达
 *
 * @param id - 服务器 ID
 * @returns 检查结果
 */
private async checkRemoteNetworkConnectivity(id: string): Promise<NetworkCheckResult> {
  const manager = this.getSSHManager(id);
  if (!manager || !manager.isConnected()) {
    // 无 SSH 连接则跳过检查
    return { npmReachable: true, nodeMirrorReachable: true, mirrorConfigured: false };
  }

  this.emitDeployProgress(id, 'precheck', '检查远程服务器网络连通性...', -1);

  const mirrorUrls = this.getActiveMirrorUrls();
  const mirrorConfigured = !!mirrorUrls;
  const npmRegistry = mirrorUrls?.npmRegistry || DEFAULT_MIRROR_URLS.npmRegistry;
  const nodeMirror = mirrorUrls?.nodeDownloadMirror || DEFAULT_MIRROR_URLS.nodeDownloadMirror;

  // 并行执行两个检查，每个最多 5 秒超时
  const [npmResult, nodeResult] = await Promise.all([
    this.curlCheck(manager, npmRegistry),
    this.curlCheck(manager, nodeMirror),
  ]);

  const npmReachable = this.isHttpSuccess(npmResult);
  const nodeMirrorReachable = this.isHttpSuccess(nodeResult);

  return { npmReachable, nodeMirrorReachable, mirrorConfigured };
}

/**
 * 通过 SSH 在远程服务器上执行 curl 检查 URL 可达性
 * @returns curl 输出的 HTTP 状态码
 */
private async curlCheck(manager: SSHManager, url: string): Promise<string> {
  try {
    const result = await manager.executeCommand(
      `curl -s --connect-timeout 5 -o /dev/null -w "%{http_code}" "${escapeEnvValue(url)}" 2>/dev/null || echo "000"`
    );
    return result.stdout.trim();
  } catch {
    return '000';
  }
}

/**
 * 判断 HTTP 状态码是否表示成功（2xx 或 3xx）
 */
private isHttpSuccess(statusCode: string): boolean {
  const code = statusCode.trim();
  return code.startsWith('2') || code.startsWith('3');
}
```

### 2. 后端：在部署入口中集成预检

在以下 4 个方法中，SSH 连接建立后、实际部署开始前插入预检逻辑：

#### 2.1 `autoDetectAndDeploy()`（行 ~525 之后）

在端口分配完成后、检测远程 Agent 之前插入：

```typescript
// 在 this.emitDeployProgress(id, 'detect', ...) 之前
const networkCheck = await this.checkRemoteNetworkConnectivity(id);
if (!networkCheck.npmReachable || !networkCheck.nodeMirrorReachable) {
  this.emitDeployProgress(id, 'precheck-fail', JSON.stringify(networkCheck));
  // 等待用户确认（通过 waitForPrecheckDecision）
  const decision = await this.waitForPrecheckDecision(id);
  if (decision === 'cancel') {
    this.emitDeployProgress(id, 'complete', '部署已取消', 100);
    return;
  }
  // decision === 'continue': 继续部署
}
```

#### 2.2 `updateAgent()`（行 ~2415 之后）

在停止 Agent 后、部署之前插入同样的预检逻辑。

#### 2.3 `deployAgentCode()`（行 ~1040 之后）

在 SSH 连接确认后、创建部署目录之前插入同样的预检逻辑。

#### 2.4 `deployToServer()`（行 ~1005 之后）

在连接确认后、`deployAgentSDK()` 之前插入同样的预检逻辑。

### 3. 后端：用户决策等待机制

**文件**：`src/main/services/remote-deploy/remote-deploy.service.ts`（修改）

由于部署方法需要等待用户的 UI 决策（继续 / 取消），需要引入 Promise 等待机制：

```typescript
/** 存储等待用户决策的 resolve 函数 */
private precheckDecisionResolvers: Map<string, (decision: 'continue' | 'cancel') => void> = new Map();

/**
 * 等待用户对预检失败的处理决策
 * 前端通过 IPC 调用 continueDeploy / cancelDeploy 来 resolve
 */
private waitForPrecheckDecision(id: string): Promise<'continue' | 'cancel'> {
  return new Promise((resolve) => {
    this.precheckDecisionResolvers.set(id, resolve);
  });
}

/** 前端调用：继续部署 */
async continueDeploy(id: string): Promise<void> {
  const resolver = this.precheckDecisionResolvers.get(id);
  if (resolver) {
    this.precheckDecisionResolvers.delete(id);
    resolver('continue');
  }
}

/** 前端调用：取消部署 */
async cancelDeploy(id: string): Promise<void> {
  const resolver = this.precheckDecisionResolvers.get(id);
  if (resolver) {
    this.precheckDecisionResolvers.delete(id);
    resolver('cancel');
  }
}
```

### 4. IPC 通道

**文件**：`src/main/ipc/remote-server.ts`（修改）

新增 2 个 IPC handler：

| IPC 通道 | 方向 | 说明 |
|----------|------|------|
| `remote-server:continue-deploy` | renderer → main | 用户确认继续部署 |
| `remote-server:cancel-deploy` | renderer → main | 用户取消部署 |

```typescript
// 在 remote-server.ts 中新增
ipcMain.handle('remote-server:continue-deploy', async (_event, serverId: string) => {
  return deployService.continueDeploy(serverId);
});

ipcMain.handle('remote-server:cancel-deploy', async (_event, serverId: string) => {
  return deployService.cancelDeploy(serverId);
});
```

**文件**：`src/preload/index.ts`（修改）

暴露新方法到 `window.aicoBot`：

```typescript
remoteServerContinueDeploy: (serverId: string) =>
  ipcRenderer.invoke('remote-server:continue-deploy', serverId),
remoteServerCancelDeploy: (serverId: string) =>
  ipcRenderer.invoke('remote-server:cancel-deploy', serverId),
```

**文件**：`src/renderer/api/transport.ts`（修改）

在 `methodMap` 中注册新方法。

**文件**：`src/renderer/api/index.ts`（修改）

导出 `api.remoteServerContinueDeploy()` 和 `api.remoteServerCancelDeploy()`。

### 5. 前端：预检失败对话框

**文件**：`src/renderer/components/settings/RemoteServersSection.tsx`（修改）

在 `handleDeployProgress()` 中处理 `precheck-fail` 阶段：

```typescript
const handleDeployProgress = (data: {
  serverId: string;
  stage: string;
  message: string;
  progress?: number;
  timestamp: number;
}) => {
  // ... 现有逻辑 ...

  // 处理预检失败
  if (data.stage === 'precheck-fail') {
    const checkResult: NetworkCheckResult = JSON.parse(data.message);
    showPrecheckDialog(data.serverId, checkResult);
    return; // 不更新 addProgress，等待用户决策
  }

  // ... 其余现有逻辑 ...
};
```

#### 5.1 对话框逻辑

```typescript
const showPrecheckDialog = (serverId: string, checkResult: NetworkCheckResult) => {
  const config = useConfigStore.getState().config;
  const mirrorConfigured = !!config?.deployMirror?.activeProfileId;

  if (!mirrorConfigured) {
    // 场景 A：未配置镜像源 + registry 不可达
    showWarningDialog(
      '网络连通性检查失败',
      '无法连接到 npm registry，你可能在内网环境。建议配置镜像源。是否继续？（继续可能会超时）',
      [
        { label: t('配置镜像源'), action: () => {
          // 滚动到镜像源配置区域
          document.getElementById('mirror-source')?.scrollIntoView({ behavior: 'smooth' });
          api.remoteServerCancelDeploy(serverId);
        }},
        { label: t('继续'), action: () => {
          api.remoteServerContinueDeploy(serverId);
        }},
        { label: t('取消'), action: () => {
          api.remoteServerCancelDeploy(serverId);
        }},
      ]
    );
  } else {
    // 场景 B：已配置镜像源 + 镜像不可达
    showErrorDialog(
      '镜像源不可达',
      '已配置的镜像源不可达，请检查镜像配置。',
      [
        { label: t('检查配置'), action: () => {
          document.getElementById('mirror-source')?.scrollIntoView({ behavior: 'smooth' });
          api.remoteServerCancelDeploy(serverId);
        }},
        { label: t('取消'), action: () => {
          api.remoteServerCancelDeploy(serverId);
        }},
      ]
    );
  }
};
```

#### 5.2 UI 反馈规则

| 场景 | 对话框类型 | 按钮配置 | 说明 |
|------|-----------|---------|------|
| 未配置镜像源 + npm registry 不可达 | Warning | 「配置镜像源」/「继续」/「取消」 | 引导用户配置镜像源 |
| 未配置镜像源 + Node.js 镜像不可达 | Warning | 「配置镜像源」/「继续」/「取消」 | 同上 |
| 已配置镜像源 + 镜像不可达 | Error | 「检查配置」/「取消」 | 配置有误，不允许继续 |
| 已配置镜像源 + 默认源不可达（不可能，默认源等于 npmmirror） | — | — | 不会出现此场景 |
| 全部可达 | — | — | 静默通过 |

**注意**：当 `mirrorConfigured` 为 true 时，只显示「检查配置」和「取消」，不显示「继续」按钮。因为用户已经配置了镜像但镜像本身不可达，继续部署必然失败。

### 6. 边界情况处理

| 情况 | 处理方式 |
|------|---------|
| SSH 未连接 | 跳过预检（不应发生，因为预检在 SSH 连接后） |
| curl 命令不存在 | 捕获异常，返回不可达 |
| 预检超时（单个 curl > 5s） | curl 自身的 `--connect-timeout 5` 会保证超时 |
| 用户切换标签页后回来 | `precheckDecisionResolvers` 保留 resolve，对话框通过 state 持久化 |
| 快速连续触发部署 | 同一 serverId 只保留最新的 resolver |
| 远程服务器无外网但有代理 | 用户配置的镜像源如果通过代理可达，预检会通过（正确行为） |

## 涉及文件

| # | 文件 | 变更类型 | 说明 |
|---|------|---------|------|
| 1 | `src/main/services/remote-deploy/remote-deploy.service.ts` | 修改 | 新增 `checkRemoteNetworkConnectivity()`、`curlCheck()`、`isHttpSuccess()`、`waitForPrecheckDecision()`、`continueDeploy()`、`cancelDeploy()`；在 4 个部署入口方法中插入预检逻辑 |
| 2 | `src/main/ipc/remote-server.ts` | 修改 | 新增 `remote-server:continue-deploy` 和 `remote-server:cancel-deploy` IPC handler |
| 3 | `src/preload/index.ts` | 修改 | 暴露 `remoteServerContinueDeploy()` 和 `remoteServerCancelDeploy()` |
| 4 | `src/renderer/api/transport.ts` | 修改 | 在 `methodMap` 中注册新方法 |
| 5 | `src/renderer/api/index.ts` | 修改 | 导出 `api.remoteServerContinueDeploy()` 和 `api.remoteServerCancelDeploy()` |
| 6 | `src/renderer/components/settings/RemoteServersSection.tsx` | 修改 | `handleDeployProgress()` 中处理 `precheck-fail` 阶段，显示预检对话框 |
| 7 | `src/renderer/i18n/locales/zh-CN.json` | 修改 | 新增预检相关中文翻译 |
| 8 | `src/renderer/i18n/locales/en.json` | 修改 | 新增预检相关英文翻译 |
| 9 | `src/renderer/i18n/locales/zh-TW.json` | 修改 | 新增预检相关繁体中文翻译 |
| 10 | `src/renderer/i18n/locales/ja.json` | 修改 | 新增预检相关日文翻译 |
| 11 | `src/renderer/i18n/locales/de.json` | 修改 | 新增预检相关德文翻译 |
| 12 | `src/renderer/i18n/locales/es.json` | 修改 | 新增预检相关西班牙文翻译 |
| 13 | `src/renderer/i18n/locales/fr.json` | 修改 | 新增预检相关法文翻译 |

## 开发前必读

### 模块设计文档

| # | 文档/文件 | 阅读目的 |
|---|---------|---------|
| 1 | `docs/Development-Standards-Guide.md` | 编码规范（TypeScript strict、禁止 any、纯类型导入、命名规范、i18n t() 使用） |
| 2 | `docs/vibecoding-doc-standard.md` | 文档管理规范（PRD 状态流转、changelog 更新规则） |

### 源码文件

| # | 文档/文件 | 阅读目的 |
|---|---------|---------|
| 3 | `src/main/services/remote-deploy/remote-deploy.service.ts`（L307-317） | 理解 `emitDeployProgress()` 事件机制 |
| 4 | `src/main/services/remote-deploy/remote-deploy.service.ts`（L140-166） | 理解 `getActiveMirrorUrls()` 和镜像配置读取逻辑 |
| 5 | `src/main/services/remote-deploy/remote-deploy.service.ts`（L525-644） | 理解 `autoDetectAndDeploy()` 流程，确认预检插入点 |
| 6 | `src/main/services/remote-deploy/remote-deploy.service.ts`（L1040-1060） | 理解 `deployAgentCode()` 入口和 SSH 连接检查逻辑 |
| 7 | `src/main/services/remote-deploy/remote-deploy.service.ts`（L1005-1034） | 理解 `deployToServer()` 流程 |
| 8 | `src/main/services/remote-deploy/remote-deploy.service.ts`（L2415-2475） | 理解 `updateAgent()` 流程 |
| 9 | `src/main/ipc/remote-server.ts`（L43-46） | 理解 deploy-progress 事件的 IPC 转发方式 |
| 10 | `src/renderer/components/settings/RemoteServersSection.tsx`（L282-340） | 理解 `handleDeployProgress()` 前端事件处理逻辑 |
| 11 | `src/renderer/components/settings/RemoteServersSection.tsx`（L512-590） | 理解 `handleAddServer()` 流程 |
| 12 | `src/renderer/api/transport.ts`（L320-325） | 理解 `methodMap` 注册方式 |
| 13 | `src/preload/index.ts` | 理解 `window.aicoBot` 暴露方式 |
| 14 | `src/shared/types/mirror-source.ts` | 理解 `DEFAULT_MIRROR_URLS` 和镜像源类型定义 |
| 15 | `.project/prd/feature/mirror-source-config-v1.md` | 理解镜像源配置功能的完整设计 |

## 验收标准

- [ ] `checkRemoteNetworkConnectivity()` 方法通过 SSH 在远程服务器上执行 curl 检查 npm registry 和 Node.js 镜像可达性
- [ ] 每个检查使用 5 秒 `--connect-timeout` 超时
- [ ] 两个检查并行执行（Promise.all）
- [ ] 4 个部署入口方法（`autoDetectAndDeploy`、`updateAgent`、`deployAgentCode`、`deployToServer`）在 SSH 连接后、部署前插入预检
- [ ] 预检通过时（全部可达）静默继续部署，不弹出任何提示
- [ ] 预检失败时 emit `precheck-fail` 阶段事件，携带 `NetworkCheckResult` JSON
- [ ] 未配置镜像源 + 不可达时，前端显示 Warning 对话框：「配置镜像源」/「继续」/「取消」
- [ ] 已配置镜像源 + 不可达时，前端显示 Error 对话框：「检查配置」/「取消」（无「继续」按钮）
- [ ] 点击「配置镜像源」/「检查配置」按钮，页面滚动到镜像源配置区域并取消部署
- [ ] 点击「继续」按钮，部署流程恢复继续
- [ ] 点击「取消」按钮，部署流程终止，进度显示「部署已取消」
- [ ] 新增 2 个 IPC 通道（`remote-server:continue-deploy`、`remote-server:cancel-deploy`）正确注册
- [ ] preload、transport、api 三层正确暴露新方法
- [ ] 所有用户可见文本使用 `t()` 国际化，`npm run i18n` 无新增未翻译 key
- [ ] `npm run typecheck` 通过
- [ ] `npm run lint` 通过
- [ ] `npm run build` 通过

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-22 | 初稿 | StyleAIPro |
