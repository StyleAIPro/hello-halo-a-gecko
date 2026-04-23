# PRD [Bug 修复级] — checkAgentInstalled 未做版本精确匹配导致 UI 状态错误

> 版本：bugfix-sdk-version-check-v1
> 日期：2026-04-17
> 指令人：@zhaoyinqi
> 反馈人：@zhaoyinqi
> 归属模块：modules/remote-agent
> 严重程度：Critical

## 问题描述

- **期望行为**：远程部署 SDK 后，`checkAgentInstalled` 应检查已安装的 SDK 版本是否与项目要求的版本一致，不一致时 UI 应提示版本不匹配。
- **实际行为**：即使远程安装了错误版本的 SDK（如 0.2.111 而非要求的 0.2.104），`checkAgentInstalled` 仍返回 `sdkInstalled: true`，UI 显示绿色状态（SDK 已安装），误导用户认为环境正常。
- **复现步骤**：
  1. 远程服务器上安装了错误版本的 SDK（或因 BUG-003 安装了最新版）
  2. 触发 `checkAgentInstalled` 检查
  3. 观察 UI 状态，显示为绿色「SDK 已安装」
  4. 实际 SDK 版本与 `REQUIRED_SDK_VERSION` 不匹配，但未给出任何警告

## 根因分析

在 `src/main/services/remote-deploy/remote-deploy.service.ts` 中，`checkAgentInstalled` 方法（约第 2940 行）在检测 SDK 安装状态时，只检查 SDK 是否已安装（即 `node_modules/@anthropic-ai/claude-agent-sdk` 目录是否存在或能否读取 package.json），但未将检测到的版本号与 `REQUIRED_SDK_VERSION` 进行精确比较。

这意味着即使安装了错误版本，`sdkInstalled` 仍被设为 `true`，UI 无法感知版本不匹配问题。

**涉及代码位置**：
- `checkAgentInstalled` 方法（约第 2940 行）

## 修复方案

在 `checkAgentInstalled` 方法中增加版本精确匹配校验：

1. 读取远程已安装 SDK 的 `package.json` 获取实际版本号
2. 将实际版本号与 `REQUIRED_SDK_VERSION` 进行比较
3. 如果版本不匹配，设置 `sdkVersionMismatch: true`，同时保留 `sdkInstalled: true`（SDK 确实已安装，只是版本不对）
4. UI 根据 `sdkVersionMismatch` 状态显示黄色警告（版本不匹配）而非绿色（正常）

**具体改动**：
- 文件：`src/main/services/remote-deploy/remote-deploy.service.ts`
- 位置：`checkAgentInstalled` 方法（约第 2940 行）
- 改动：增加 `version === REQUIRED_SDK_VERSION` 精确匹配判断，不匹配时设置 `sdkVersionMismatch: true`

## 影响范围

- [ ] 涉及 API 变更 → 无
- [ ] 涉及数据结构变更 → 无（`sdkVersionMismatch` 为新增状态字段，向后兼容）
- [x] 涉及功能设计变更 → 需更新 `checkAgentInstalled` 逻辑描述

## 验证方式

1. 在远程服务器上手动安装一个不同版本的 SDK（如 0.2.111）
2. 触发 `checkAgentInstalled` 检查
3. 确认返回结果中 `sdkVersionMismatch` 为 `true`
4. 确认 UI 显示版本不匹配警告（非绿色正常状态）
5. 安装正确版本后重新检查，确认 `sdkVersionMismatch` 为 `false`，UI 恢复绿色正常状态

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-17 | 初始 Bug 修复 PRD | @zhaoyinqi |
