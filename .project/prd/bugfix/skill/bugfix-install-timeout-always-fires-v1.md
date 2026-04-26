# PRD [Bug 修复级] — 技能安装超时消息始终触发

> 版本：bugfix-install-timeout-always-fires-v1
> 日期：2026-04-24
> 指令人：用户
> 归属模块：modules/skill
> 严重程度：Minor（安装功能正常，但终端始终输出误导性错误消息，影响用户体验）
> 所属功能：features/skill-market
> 状态：draft

## 问题描述

- **期望行为**：技能安装成功完成后，终端只显示成功信息，不显示超时错误
- **实际行为**：无论安装成功还是失败，安装完成后终端始终会输出 "Installation timed out (60s). Please check your network and try again."，即使安装在 10s 内成功完成
- **复现步骤**：
  1. 打开技能市场，选择任意技能
  2. 点击「安装」按钮
  3. 等待安装成功完成（通常 < 10s）
  4. 观察终端：安装成功提示之后，60s 后仍会出现 "Installation timed out" 错误消息

## 根因分析

**文件**：`src/main/controllers/skill.controller.ts`，`installSkillFromMarket` 函数

当前实现使用 `Promise.race` 比赛安装逻辑和超时定时器：

```typescript
return Promise.race([
  doInstall(),
  new Promise<{ success: false; error: string }>((resolve) =>
    setTimeout(() => {
      const msg = 'Installation timed out (60s). Please check your network and try again.';
      onOutput?.({ type: 'error', content: msg });
      resolve({ success: false, error: msg });
    }, INSTALL_TIMEOUT),
  ),
]);
```

**问题**：`setTimeout` 创建的定时器在 `doInstall` 完成时没有被清除。即使 `doInstall` 先完成、`Promise.race` 已返回正确结果，60s 后定时器仍会触发，调用 `onOutput` 向前端发送超时错误消息。用户看到的是安装成功提示后紧接着又出现超时错误。

> 此 bug 是 `bugfix-skill-install-hang-v1`（添加 60s 整体安装超时）引入的回归缺陷。

## 技术方案

将 `Promise.race` + `setTimeout` 替换为 `new Promise` + `setTimeout`/`clearTimeout` 模式：

```typescript
return new Promise<{ success: boolean; error?: string }>((resolve) => {
  const timeoutId = setTimeout(() => {
    const msg = 'Installation timed out (60s). Please check your network and try again.';
    onOutput?.({ type: 'error', content: msg });
    resolve({ success: false, error: msg });
  }, INSTALL_TIMEOUT);

  doInstall().then((result) => {
    clearTimeout(timeoutId);
    resolve(result);
  });
});
```

当 `doInstall` 先完成时，`clearTimeout` 取消定时器，不会触发超时消息。

## 涉及文件

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/main/controllers/skill.controller.ts` | 修改 | `installSkillFromMarket` 中 `Promise.race` 改为 `clearTimeout` 模式 |
| `.project/modules/skill/features/skill-market/changelog.md` | 更新 | 追加变更记录 |
| `.project/modules/skill/features/skill-market/bugfix.md` | 更新 | 追加 bug 记录 |

## 开发前必读

| 分类 | 文档/文件 | 阅读目的 |
|------|----------|---------|
| 模块文档 | `.project/modules/skill/features/skill-market/changelog.md` | 了解 skill market 最近变更 |
| 模块文档 | `.project/modules/skill/features/skill-market/bugfix.md` | 了解 skill market 已知问题 |
| 源码文件 | `src/main/controllers/skill.controller.ts` | 理解 `installSkillFromMarket` 中 `Promise.race` 超时逻辑的实现 |
| 历史PRD | `.project/prd/bugfix/skill/bugfix-skill-install-hang-v1.md` | 了解 60s 整体超时的引入背景，避免修复此 bug 时引入回归 |

## 验收标准

- [ ] 安装成功时，不再出现 "Installation timed out" 消息
- [ ] 安装失败时，显示实际错误信息，不显示超时
- [ ] 安装真正超时（>60s）时，显示超时错误信息
- [ ] `npm run typecheck && npm run lint && npm run build` 通过

## 变更记录

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-24 | 初始 Bug 修复 PRD | 用户 |
