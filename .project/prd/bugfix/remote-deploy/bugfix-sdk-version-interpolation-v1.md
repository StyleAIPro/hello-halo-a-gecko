# PRD [Bug 修复级] — SDK 安装命令模板字符串未插值导致安装错误版本

> 版本：bugfix-sdk-version-interpolation-v1
> 日期：2026-04-17
> 指令人：@zhaoyinqi
> 反馈人：@zhaoyinqi
> 归属模块：modules/remote-agent
> 严重程度：Critical

## 问题描述

- **期望行为**：远程部署 Agent 时，应安装项目指定的 SDK 版本（如 `0.2.104`），确保远程环境与本地版本一致。
- **实际行为**：远程部署时 npm 安装了最新版本（如 `0.2.111`）而非项目要求的 `0.2.104`，导致远程 Agent 运行时行为与预期不符。
- **复现步骤**：
  1. 配置一个远程服务器并连接
  2. 创建远程空间，触发 Agent 部署
  3. 观察远程服务器上安装的 SDK 版本
  4. 发现安装的是 npm registry 最新版本（如 0.2.111），而非 `REQUIRED_SDK_VERSION` 指定的版本（如 0.2.104）

## 根因分析

在 `src/main/services/remote-deploy/remote-deploy.service.ts` 中，有 3 处执行 npm install 命令的代码使用了 JavaScript 单引号字符串（`'...'`）而非反引号模板字符串（`` `...` ``）。

由于单引号字符串不会进行模板插值，`${REQUIRED_SDK_VERSION}` 被当作普通文本传给远程 shell，shell 将其解析为空字符串，最终 npm install 命令没有指定版本号，默认安装了最新版本。

**涉及代码位置**：
- 第 1163 行：npm install 命令（单引号字符串）
- 第 1168 行：npm install 命令（单引号字符串）
- 第 3250 行：npm install 命令（单引号字符串）

## 修复方案

将上述 3 处 npm install 命令的字符串从单引号（`'...'`）改为反引号模板字符串（`` `...` ``），确保 `${REQUIRED_SDK_VERSION}` 被正确插值为项目指定的 SDK 版本号。

**具体改动**：
- 文件：`src/main/services/remote-deploy/remote-deploy.service.ts`
- 位置：第 1163、1168、3250 行
- 改动：`'npm install ...${REQUIRED_SDK_VERSION}...'` → `` `npm install ...${REQUIRED_SDK_VERSION}...` ``

## 影响范围

- [ ] 涉及 API 变更 → 无
- [ ] 涉及数据结构变更 → 无
- [ ] 涉及功能设计变更 → 无

## 验证方式

1. 配置远程服务器并触发部署
2. 部署完成后，检查远程服务器上 `node_modules/@anthropic-ai/claude-agent-sdk/package.json` 中的版本号
3. 确认版本号与 `REQUIRED_SDK_VERSION` 常量定义的值一致（如 0.2.104）
4. 确认不是 npm registry 上的最新版本

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-17 | 初始 Bug 修复 PRD | @zhaoyinqi |
