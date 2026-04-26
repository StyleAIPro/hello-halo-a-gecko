# Bug 记录 — 技能市场

---

## BUG-001: GitCode 技能获取全面失败
- **日期**：2026-04-18
- **严重程度**：Critical
- **发现人**：@MoonSeeker
- **问题**：选择 GitCode 源后技能列表为空或加载失败
- **根因**：7 个问题叠加 — ①速率限制器 clearInterval(undefined) 导致限速失效；②无请求超时；③getSkills()/searchSkills() catch 吞没所有错误；④fetchFromGitCodeRepo 缓存空结果；⑤UI 层无错误展示；⑥代理配置不刷新；⑦Promise.all 并发打爆 API
- **修复**：①重写 rate limiter 为递归 setTimeout；②添加 30s AbortController 超时；③移除 getSkills()/searchSkills() 的 try/catch 让错误传播到 controller；④失败时不缓存空结果，抛出错误；⑤UI 添加 loadError 状态 + 错误提示 + 重试按钮；⑥添加 resetProxyDispatcher 支持代理刷新；⑦添加 asyncPool 通用并发控制，findSkillDirs/listSkillsFromRepo/fetchSkillDirectoryContents 并发上限 3
- **影响文档**：
  - [ ] design.md
  - [ ] api/<resource>.md
  - [ ] db/schema.md

---

---

## BUG-002: 技能市场综合问题修复
- **日期**：2026-04-18
- **严重程度**：Major
- **发现人**：@MoonSeeker
- **问题**：7 项问题叠加 — ①进度不准确（递归扫描不报告进度）；②死代码事件通道（3 个从未发送的 IPC 事件）；③preload 重复定义（skillAnalyzeConversations 等 4 个方法）；④skills.sh 详情只尝试 main 分支；⑤GitCode validateRepo 缺少 hasSkillsDir；⑥loadMarketSkills 参数透传 bug；⑦快速切换源竞态条件
- **修复**：①GitHub findSkillDirs 添加 onProgress 跟踪器；②移除 skill:market:skill-found/fetch-complete/fetch-error 三个死代码通道；③移除 preload 重复的方法定义和实现；④fetchSkillContent 添加 master 分支回退；⑤GitCode validateRepo 添加 skills/ 目录检测和 hasSkillsDir 字段；⑥移除 store loadMarketSkills 的无用 sourceId 参数；⑦添加 fetchGenerationRef 丢弃过期结果
- **PRD**：prd/bugfix/skill/bugfix-skill-market-cleanup-v1.md
- **影响文档**：
  - [x] design.md

---

---

## BUG-003: 技能市场 UX 精修与请求优化
- **日期**：2026-04-18
- **严重程度**：Major
- **发现人**：@MoonSeeker
- **问题**：3 项问题 — ①GitCode 元数据获取进度不均匀（Promise.all 一次性完成导致进度条从 0 跳到 100%）；②前端初始源选择与后端不一致（前端 fallback 到第一个 enabled 源，后端使用 config 中的 activeSourceId）；③GitHub 元数据获取被误改为顺序化导致不必要的减速
- **修复**：①GitCode `listSkillsFromRepo` 元数据获取从 `Promise.all` 改为顺序 `for...of` 循环，每个 skill 完成后报告进度；②Store 添加 `_activeSourceId` 状态从后端响应同步，组件 init 使用后端的 `activeSourceId`；③GitHub `listSkillsFromRepo` 恢复 `Promise.all` 并行获取（GitHub 无速率限制），进度在所有完成后一次性报告
- **PRD**：prd/bugfix/skill/bugfix-skill-market-ux-v1.md
- **影响文档**：
  - [x] design.md

---

---

## BUG-004: GitHub/GitCode 平台隔离不足
- **日期**：2026-04-18
- **严重程度**：Major
- **发现人**：@MoonSeeker
- **问题**：4 项架构级问题 — ①`RemoteSkillItem` 使用 `githubRepo`/`githubPath` 字段名存储所有平台数据（30+ 处引用混淆）；②Push 流程不校验目标平台（`loadRepoDirectories` 始终调用 GitHub API，GitCode 目录列表无法加载）；③前端硬编码英文未走 i18n（7 处硬编码字符串）；④Controller 返回值不一致（GitHub 返回 `prUrl`，GitCode 返回 `mrUrl`）
- **修复**：①`RemoteSkillItem` 字段重命名为 `remoteRepo`/`remotePath`（10+ 文件，`replace_all`）；②renderer API 层暴露 `skillMarketListGitCodeRepoDirs`，SkillLibrary 根据 source type 路由到正确的目录列表 API，按钮文案动态显示 PR/MR；③SkillMarket 硬编码字符串包裹 `t()`，"View on GitHub" 改为根据 sourceId 条件显示；④`pushSkillToGitCode` controller 返回值 `mrUrl` → `prUrl` 统一
- **PRD**：prd/refactor/skill/refactor-skill-market-platform-isolation-v1.md
- **影响文档**：
  - [x] design.md

---

## BUG-005: Push 按钮文案 + 同名仓库路由错误
- **日期**：2026-04-18
- **严重程度**：Major
- **发现人**：@MoonSeeker
- **问题**：3 项问题 — ①Push 触发按钮始终显示 "Push to GitHub" 不区分平台；②同名 GitHub/GitCode 仓库 `<select>` value 重复导致 MR 路由错误；③`SkillDetail` 子组件直接引用父组件 `githubSources` 变量导致运行时 ReferenceError
- **修复**：①按钮根据源数量和类型动态显示 "Push to GitHub" / "Push to GitCode" / "Push to Remote"；②`<select>` 改用 `source.id` 作为 value 确保唯一性，新增 `pushTargetSourceId` 状态和 `isGitCodePush` 派生变量；③`SkillDetail` 新增 `githubSourcesList` prop 并从父组件传递
- **PRD**：prd/bugfix/skill/bugfix-skill-push-ui-and-repo-routing-v1.md

---

## 统计
| 严重程度 | 数量 |
|---------|------|
| Critical | 1 |
| Major | 5 |
| Minor | 1 |

---

## BUG-007: 安装完成后误报超时错误

- **日期**：2026-04-24
- **严重程度**：Minor
- **问题**：技能安装完成后（无论成功或失败），终端始终输出 "Installation timed out (60s)"，即使安装在数秒内完成
- **根因**：`installSkillFromMarket` 使用 `Promise.race` + `setTimeout` 实现超时，但 `doInstall` 完成后未调用 `clearTimeout` 清除定时器，60s 后定时器仍触发 `onOutput` 发送超时消息
- **修复**：`Promise.race` 替换为 `new Promise` + `clearTimeout` 模式，`doInstall` 完成时清除定时器
- **PRD**：`.project/prd/bugfix/skill/bugfix-install-timeout-always-fires-v1.md`
- **回归来源**：`bugfix-skill-install-hang-v1`（添加 60s 整体超时）引入
| Minor | 0 |

---

## BUG-006: GitCode 技能安装长时间挂起

- **日期**：2026-04-24
- **严重程度**：Major
- **问题**：从 GitCode 技能市场安装任意技能时，点击安装后界面一直显示 "Installing..." 转圈，长时间无响应
- **根因**：4 个问题叠加 — ①`downloadSkill` 阶段无进度反馈（无 `onOutput` 回调）；②`getSkillDetail` 失败后路径大小写不匹配触发递归扫描；③`findSkillDirectoryPath` fallback 的 `findSkillDirs` 递归深度默认 5，可能耗时数分钟；④`installSkillFromMarket` 无整体超时
- **修复**：①`downloadSkill` 添加可选 `onOutput` 参数，安装流程传入回调；②`getSkillDetail` 失败时优先使用 `findSkillInCache` 缓存的原始大小写路径；③`findSkillDirectoryPath` fallback 的 `findSkillDirs` maxDepth 降至 2 + 15s 超时 + 诊断日志；④`installSkillFromMarket` 添加 60s 整体超时
- **PRD**：`.project/prd/bugfix/skill/bugfix-skill-install-hang-v1.md`
