# 功能 — offline-deploy

> 日期：2026-04-23
> 指令人：@MoonSeeker
> 来源 PRD：`.project/prd/feature/remote-deploy/offline-deploy-bundle-v1.md`
> 所属模块：modules/remote-agent/remote-agent-v1

## 描述
离线部署包功能，将远程 Agent 部署所需的全部运行时文件（Node.js 二进制、node_modules、编译产物、SDK 补丁）在构建时打包为自包含的 tar.gz 归档，嵌入 AICO-Bot EXE 安装包。用户在 EXE 中选择「离线部署」即可一键上传到远端服务器，全程远端零网络依赖（除 Claude API 运行时调用）。

## 依赖
- `packages/remote-agent-proxy/scripts/build-offline-bundle.mjs` — 构建脚本
- `packages/remote-agent-proxy/scripts/deploy-env.sh` — 远端环境初始化
- `src/main/services/remote-deploy/remote-deploy.service.ts` — 部署服务（离线方法）
- `src/main/ipc/remote-server.ts` — IPC 通道（deploy-offline, check-offline-bundle）
- `src/preload/index.ts` — preload 暴露
- `src/renderer/api/index.ts` — 前端 API 层
- `src/renderer/components/settings/RemoteServersSection.tsx` — 前端 UI

## 实现逻辑

### 正常流程

**构建阶段（`npm run build` 自动执行）**
1. `build-offline-bundle.mjs` 在 `electron-vite build` 之前执行
2. 安装生产依赖（`npm install --production`），清理 devDependencies 残留
3. 编译 TypeScript + 执行 SDK 补丁
4. 下载 linux-x64 和 linux-arm64 的 Node.js v20.18.1 二进制（缓存到 `.cache/`）
5. 清理 node_modules（删除 .ts, .map, test/, README 等）
6. 组装 staging 目录：dist/ + node_modules/ + scripts/ + package.json + Node.js 二进制 + deploy-env.sh
7. 打包为 `aico-bot-offline-linux-{x64,arm64}.tar.xz`，输出到 `resources/offline-bundles/`
8. electron-builder 通过 `extraResources` 将离线包打入 EXE

**离线部署流程（`deployAgentCodeOffline()`）**
1. 从 `process.resourcesPath/offline-bundles/` 读取内置离线包
2. SFTP 上传到远端服务器
3. 远端 `tar -xJf` 解压
4. 验证 bundled Node.js 可用
5. 创建 SDK 全局 symlink（`/usr/local/lib/node_modules/@anthropic-ai` → 部署目录）
6. 同步系统提示词
7. 使用 bundled Node.js 启动 Agent Proxy

**增量更新流程（`updateAgentCodeOffline()`）**
1. 检测远端 `deploy-env.sh` 存在 → 已有离线部署
2. 对比 `version.json` 时间戳，一致则跳过
3. 仅上传 `dist/` 变更文件（md5 对比，跳过未变文件）
4. 重启 Agent

### 异常流程
1. **离线包不存在** — 提示用户执行 `npm run build:offline-bundle`，按钮置灰
2. **离线部署失败** — 自动回退到在线部署 `deployAgentCode()`
3. **Node.js 二进制缺失** — 抛出异常
4. **SDK 全局 symlink 失败** — 降级到用户本地全局目录

## 涉及 API

- `RemoteDeployService.getOfflineBundlePath(platform)` — 获取离线包路径
- `RemoteDeployService.isOfflineBundleAvailable(platform)` — 检查离线包是否可用
- `RemoteDeployService.deployAgentCodeOffline(id, platform)` — 执行离线部署
- `RemoteDeployService.updateAgentCodeOffline(id, platform)` — 增量离线更新
- `RemoteDeployService.startAgentOffline(id, deployPath)` — 使用 bundled Node.js 启动

## 涉及数据

- `resources/offline-bundles/aico-bot-offline-linux-{x64,arm64}.tar.xz` — 离线部署包（嵌入 EXE）
- `.cache/node-binaries/` — Node.js 二进制下载缓存

## 变更
-> changelog.md
