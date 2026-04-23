# PRD [Bug 修复级] — GitCode 技能获取全面失败

> 版本：bugfix-gitcode-skill-fetch-v1
> 日期：2026-04-18
> 指令人：@MoonSeeker
> 反馈人：@MoonSeeker
> 归属模块：modules/skill
> 严重程度：Critical

## 问题描述
- **期望行为**：用户在技能市场选择 GitCode 源后，应能正常加载并浏览仓库中的技能列表
- **实际行为**：GitCode 源的技能列表始终为空或加载失败，用户无法获取任何技能
- **复现步骤**：
  1. 打开技能市场
  2. 选择或添加 GitCode 源
  3. 观察技能列表加载 — 结果为空或报错

## 根因分析

经过代码审查，发现 6 个相互叠加的问题导致 GitCode 技能获取全面失败：

### BUG-001：速率限制器完全失效（Critical）
**文件**：`src/main/services/skill/gitcode-skill-source.service.ts:26-41`

`enqueueApiCall` 函数中 `clearInterval(undefined as any)` 传入了 `undefined` 而非 `setInterval` 的返回值。导致：
- `setInterval` 创建的定时器永远不会被清除
- 多次调用产生多个并发定时器，API 调用无节流
- 递归目录遍历 + 逐 skill 请求 SKILL.md 可轻易触发 50+ 并发请求
- GitCode API 返回 429 后，简单的 5s 等待 + 单次重试不足以恢复

### BUG-002：无请求超时（Major）
**文件**：`src/main/services/skill/gitcode-skill-source.service.ts:78-82`

`gitcodeFetch` 和 `gitcodeApiFetch` 均未设置请求超时。当网络不通或 gitcode.com 无响应时，请求会挂起直到 OS 级 TCP 超时（30-120s），用户体验极差。

### BUG-003：`getSkills()` / `searchSkills()` 错误被静默吞掉（Critical）
**文件**：`src/main/services/skill/skill-market-service.ts:210-234`

`getSkills()` 和 `searchSkills()` 方法的 catch 块将所有异常转为 `{ skills: [], total: 0, hasMore: false }` 返回。即使 `fetchFromGitCodeRepo()` 正确抛出错误，也会被此处拦截，导致 controller 层始终收到 `success: true` + 空列表。这是最关键的问题所在 — **整条链路的错误传播被此层彻底阻断**。

### BUG-004：`fetchFromGitCodeRepo` 缓存空结果（Major）
**文件**：`src/main/services/skill/skill-market-service.ts:785-797`

`fetchFromGitCodeRepo` 在 catch 中仅 console.error，并将空结果 `[]` 缓存到 `skillsCache`。后续请求直接返回缓存的空列表，用户看到的是"仓库无技能"而非"加载失败"。

### BUG-005：UI 层无错误展示（Major）
**文件**：`src/renderer/components/skill/SkillMarket.tsx:352-385`

`loadSkills` 回调在 `result.success === false` 时无 else 分支，catch 块仅 `console.error`，用户看不到任何错误提示。

### BUG-006：代理配置仅缓存一次（Minor）
**文件**：`src/main/services/skill/gitcode-skill-source.service.ts:50-73`

`_proxyDispatcher` 在首次加载后永久缓存。用户运行时切换代理/VPN 后不生效。

## 修复方案

### 修复 BUG-001：重写速率限制器
- 将 `setInterval` 返回值保存到变量，在队列为空时正确 `clearInterval`
- 改用 `setTimeout` 递归调度替代 `setInterval`，彻底避免并发问题
- 确保同一时刻只有一个调度器在运行

### 修复 BUG-002：添加请求超时
- `gitcodeFetch` 使用 `AbortController` 添加 30s 超时
- 超时时抛出明确错误信息

### 修复 BUG-003：移除 `getSkills()` / `searchSkills()` 的 catch 吞没
- 移除 try/catch 包装，让错误自然传播到 controller 层
- controller 的 `listMarketSkills()` / `searchMarketSkills()` 已有正确的 error handling

### 修复 BUG-004：指数退避重试 + 不缓存空结果
- `gitcodeApiFetch` 429 响应改为指数退避重试（2s → 4s → 8s，最多 3 次）
- `fetchFromGitCodeRepo` 不再缓存空结果，失败时抛出错误

### 修复 BUG-005：UI 层展示错误信息
- 添加 `loadError` 状态
- `loadSkills` 在 `result.success === false` 或 catch 时设置错误信息
- 空列表区域增加错误展示 + 重试按钮

### 修复 BUG-006：代理配置支持刷新
- 添加 `resetProxyDispatcher()` 方法
- 在每次 `fetchFromGitCodeRepo` 调用前重置代理缓存

### 修复 BUG-007：Promise.all 并发打爆 API，改为批次加载（Critical）

**问题**：`findSkillDirs` 和 `listSkillsFromRepo` 中使用 `Promise.all` 对所有子目录和所有 skill 并发发请求，导致队列积压过大，首屏等待时间极长，大量 429 错误。

**修复方案**：
1. 添加通用并发控制工具 `asyncPool(concurrency, items, fn)`，维护固定大小的 Promise 池
2. `findSkillDirs`：目录遍历并发上限 3
3. `listSkillsFromRepo`：SKILL.md 元数据获取并发上限 3
4. `fetchSkillDirectoryContents`：文件下载并发上限 3

## 影响范围
- [ ] 涉及 API 变更 → 无（内部实现修改，对外接口不变）
- [ ] 涉及数据结构变更 → 无
- [ ] 涉及功能设计变更 → 无（bug 修复，设计不变）

## 验证方式
1. 选择 GitCode 源，确认技能列表能正常加载
2. 配置无效 Token，确认显示错误提示而非空列表
3. 断网后重试，确认 30s 内超时并显示错误
4. 连续快速切换源，确认不出现请求堆积
5. 验证日志中不再出现无限增长的 interval 计时器

## 变更
| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-18 | 初始版本 | @MoonSeeker |
| 2026-04-18 | 追加 BUG-007：Promise.all 并发打爆 API，改为 asyncPool 批次加载 | @MoonSeeker |
