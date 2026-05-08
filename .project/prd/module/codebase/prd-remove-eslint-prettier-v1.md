# PRD [模块级] — 移除 ESLint 和 Prettier

> 版本：prd-remove-eslint-prettier-v1
> 日期：2026-05-04
> 状态：in-progress
> 指令人：@moonseeker
> 归属模块：codebase（工程基础设施）

## 需求分析

### 现状

- ESLint 当前报告 **3330 个问题**（1083 errors + 2247 warnings），几乎全部为噪音
  - ~960 个 CRLF 行尾错误（Windows 开发环境）
  - 大量 `no-console` 警告
  - 大量 `any` 类型警告（但实际被配置为 warn 而非 error）
- Prettier 配置 `endOfLine: "lf"` 与 Windows 开发环境冲突，每次保存都产生行尾差异
- CI 流水线（`.github/workflows/ci-test.yml`）**不运行 lint**，无门禁拦截
- 团队实际依赖 `npx eslint --fix <file>` 逐文件修复，但规则宽松（`any`/`no-console` 是 warn 不是 error），形同虚设
- `simple-git-hooks` + `lint-staged` 配置了 pre-commit 钩子，但因规则问题反而阻碍正常提交

### 结论

ESLint 和 Prettier 在本项目中的投入产出比为负：
1. **不生效**：CI 不跑、规则宽松、大量噪音掩盖真实问题
2. **反效果**：CRLF 警告在 Windows 上无意义、Prettier 的 `lf` 行尾强制导致 git diff 污染
3. **可替代**：代码质量保障由 TypeScript strict 模式（`npm run typecheck`）和构建检查（`npm run build`）提供

### 决策

**完全移除 ESLint 和 Prettier**，包括配置文件、devDependencies、scripts、pre-commit 钩子、以及源码中的 eslint-disable/prettier-ignore 注释。

代码风格统一改由以下方式保障：
- **TypeScript strict** — 类型安全
- **electron-vite 构建** — 语法错误拦截
- **团队共识** — 编码规范文档保留格式约定（缩进、引号等），但不强制工具执行

## 技术方案

### 步骤 1：删除配置文件

| 文件 | 说明 |
|------|------|
| `eslint.config.js` | 已在 pzm-dev 分支删除，确认无残留 |
| `.prettierrc` | 已在 pzm-dev 分支删除，确认无残留 |
| `.prettierignore` | 根目录忽略规则 |

### 步骤 2：清理 package.json

**删除 scripts（4 个）：**
- `lint`: `"eslint src/ --max-warnings 0"`
- `lint:fix`: `"eslint src/ --fix"`
- `format`: `"prettier --write \"src/**/*.{ts,tsx,json,md}\""`
- `format:check`: `"prettier --check \"src/**/*.{ts,tsx,json,md}\""`

**删除 devDependencies（10 个）：**
- `@eslint/js`
- `eslint`
- `eslint-config-prettier`
- `eslint-plugin-prettier`
- `eslint-plugin-react-hooks`
- `eslint-plugin-react-refresh`
- `typescript-eslint`
- `prettier`
- `lint-staged`
- `simple-git-hooks`

**删除 config 块（2 个）：**
- `simple-git-hooks` 配置块
- `lint-staged` 配置块

### 步骤 3：清理源码中的 lint 注释（18 个文件）

**eslint-disable 注释（16 个文件）：**

| 文件 | 注释类型 |
|------|---------|
| `src/preload/index.ts` | `/* eslint-disable */` |
| `src/renderer/api/index.ts` | eslint-disable |
| `src/renderer/components/skill/SkillMarket.tsx` | eslint-disable |
| `src/renderer/components/settings/RemoteServersSection.tsx` | eslint-disable |
| `src/renderer/pages/skill/SkillPage.tsx` | eslint-disable |
| `src/renderer/hooks/useSmartScroll.ts` | eslint-disable |
| `src/renderer/components/diff/FileChangesFooter.tsx` | eslint-disable |
| `src/renderer/components/chat/MessageList.tsx` | eslint-disable |
| `src/renderer/components/canvas/viewers/CodeMirrorEditor.tsx` | eslint-disable |
| `src/renderer/components/apps/SessionDetailView.tsx` | eslint-disable |
| `src/main/services/remote-deploy/remote-deploy.service.ts` | eslint-disable |
| `src/main/ipc/remote-server.ts` | eslint-disable |
| `src/main/services/remote-ssh/ssh-manager.ts` | eslint-disable |
| `src/main/services/overlay.service.ts` | eslint-disable |
| `src/main/services/browser-view.service.ts` | eslint-disable |
| `src/main/openai-compat-router/stream/base-stream-handler.ts` | eslint-disable |

**prettier-ignore 注释（2 个文件）：**

| 文件 |
|------|
| `src/renderer/components/chat/thought-utils.ts` |
| `src/renderer/components/chat/ThoughtProcess.tsx` |

清理方式：
- 文件顶部的 `/* eslint-disable */` — 直接删除整行
- 行内 `// eslint-disable-next-line xxx` — 删除注释行
- 行尾 `// eslint-disable-line xxx` — 删除注释部分
- `// prettier-ignore` — 删除注释行

### 步骤 4：更新文档

**CLAUDE.md：**
- 步骤 4 第 3 点（~行 69）：删除 `npx eslint --fix <file>` 要求，改为仅 re-read 确认
- 编码规范（~行 141）：删除 eslint --fix 要求
- 构建/测试命令（~行 168-172）：删除 `lint`、`lint:fix`、`format` 命令

**docs/ai-development-workflow.md：**
- 步骤 4 第 3 点（~行 38）：删除 eslint --fix 引用
- 步骤 5 自测（~行 43）：删除 `npm run lint`，保留 typecheck 和 build

**docs/development-standards-guide.md：**
- 10.1 工具链（行 440-451）：删除 ESLint/Prettier/Pre-commit hooks 行，删除对应命令示例
- 10.2 格式规范（行 455-462）：保留为参考性约定，标注为团队共识而非工具强制

**docs/vibecoding-doc-standard.md（如有引用）：**
- 检查并移除对 lint/format 的引用

### 步骤 5：处理关联 PRD 中的引用

`.project/prd/feature/remote-deploy/offline-deploy-bundle-v1.md` 行 155 提到 `.eslint*`/`.prettier*` 排除项。移除后该行无需更新（这些文件已不存在，排除规则自然失效），但应在 PRD 状态记录中注明。

## 开发前必读

| 类别 | 文件路径 | 阅读目的 |
|------|---------|---------|
| 模块设计文档 | `.project/modules/codebase/overview.md` | 理解 codebase 模块边界 |
| 编码规范 | `docs/development-standards-guide.md` 行 436-462 | 了解当前 10.1/10.2 节的完整内容以便准确编辑 |
| 开发流程 | `CLAUDE.md` 行 65-72、137-142、168-172 | 了解 ESLint 在编码流程中的所有引用点 |
| 开发流程 | `docs/ai-development-workflow.md` 行 33-46 | 了解 ESLint 在简化开发流程中的引用点 |
| 关联 PRD | `.project/prd/feature/remote-deploy/offline-deploy-bundle-v1.md` 行 155 | 确认离线打包 PRD 中的 eslint/prettier 引用 |
| 源码文件 | 上述 18 个含 lint 注释的文件 | 了解注释上下文，避免误删有用内容 |
| 配置文件 | `package.json` scripts 和 devDependencies 段 | 确认要删除的项目准确无误 |

## 涉及文件

### 配置文件（删除）
- `eslint.config.js` — ESLint 配置（已在 pzm-dev 删除）
- `.prettierrc` — Prettier 配置（已在 pzm-dev 删除）
- `.prettierignore` — Prettier 忽略规则

### 构建配置（修改）
- `package.json` — 删除 scripts/devDependencies/config 块

### 文档（修改）
- `CLAUDE.md` — 移除 eslint/prettier 引用
- `docs/ai-development-workflow.md` — 移除 eslint 引用
- `docs/development-standards-guide.md` — 重写 10.1/10.2 节

### 源码清理（18 个文件，删除 lint 注释）
- `src/preload/index.ts`
- `src/renderer/api/index.ts`
- `src/renderer/components/skill/SkillMarket.tsx`
- `src/renderer/components/settings/RemoteServersSection.tsx`
- `src/renderer/pages/skill/SkillPage.tsx`
- `src/renderer/hooks/useSmartScroll.ts`
- `src/renderer/components/diff/FileChangesFooter.tsx`
- `src/renderer/components/chat/MessageList.tsx`
- `src/renderer/components/chat/thought-utils.ts`
- `src/renderer/components/chat/ThoughtProcess.tsx`
- `src/renderer/components/canvas/viewers/CodeMirrorEditor.tsx`
- `src/renderer/components/apps/SessionDetailView.tsx`
- `src/main/services/remote-deploy/remote-deploy.service.ts`
- `src/main/ipc/remote-server.ts`
- `src/main/services/remote-ssh/ssh-manager.ts`
- `src/main/services/overlay.service.ts`
- `src/main/services/browser-view.service.ts`
- `src/main/openai-compat-router/stream/base-stream-handler.ts`

### 关联 PRD（备注）
- `.project/prd/feature/remote-deploy/offline-deploy-bundle-v1.md` — 行 155 引用 `.eslint*`/`.prettier*`，删除后自然失效，无需修改

## 验收标准

- [ ] `eslint.config.js` 已删除（或在 pzm-dev 分支已确认删除）
- [ ] `.prettierrc` 已删除（或在 pzm-dev 分支已确认删除）
- [ ] `.prettierignore` 已删除
- [ ] `package.json` 中 4 个 scripts（lint/lint:fix/format/format:check）已删除
- [ ] `package.json` 中 10 个 devDependencies 已删除
- [ ] `package.json` 中 `simple-git-hooks` 和 `lint-staged` 配置块已删除
- [ ] 18 个源码文件中的 eslint-disable/prettier-ignore 注释已清理
- [ ] `CLAUDE.md` 中 3 处 eslint/prettier 引用已移除
- [ ] `docs/ai-development-workflow.md` 中 2 处 eslint 引用已移除
- [ ] `docs/development-standards-guide.md` 10.1/10.2 节已更新
- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过
- [ ] `npx eslint` 命令不再可用（命令不存在）
- [ ] `npx prettier` 命令不再可用（命令不存在）

## 变更记录

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-05-04 | 初始 PRD（draft） | @moonseeker |
