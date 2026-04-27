# PRD [重构级] — GitCode 技能安装流程优化

> 版本：refactor-gitcode-install-optimization-v1
> 日期：2026-04-26
> 状态：done
> 指令人：@MoonSeeker
> 归属模块：modules/skill
> 优先级：P1

## 背景

在尝试从 `https://gitcode.com/AICO-Ascend/Ascend-Skills.git` 安装 `ais-bench` 技能时，发现整个安装流程无法完成。实际调试发现的问题远超原始预判：不只是冗余 API 调用，而是 **3 个根本性缺陷** 导致流程完全不可用。

## 问题分析

### 问题 1（Critical）：GitCode tree API 不返回 blob 条目

**严重度**：Critical — 技能列表完全为空

`findSkillDirsViaTree` 使用 `GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1` 查找技能目录。通过实际 API 测试发现，GitCode 的 tree API **只返回 `tree` 类型条目（目录），不返回 `blob` 类型条目（文件）**。SKILL.md 是文件，永远不会出现在结果中。

```
实际返回（20 条，全部 type=tree）：
  tree AISystem
  tree AISystem/ontology-extractor
  tree Inference
  tree Inference/ais-bench
  tree Inference/ais-bench/assets
  ...
```

`filtered by entry.type === 'blob'` 永远为空 → 技能列表为空 → 无法安装。

### 问题 2（Critical）：GitCode branches API 不返回 tree.sha

**严重度**：Critical — 回退路径也失败

branches API 响应结构为 `branch.commit.commit.author`（双层 commit！），没有 `branch.commit.tree.sha`：

```json
{
  "commit": { "commit": { "author": {...}, "committer": {...}, "message": "..." } },
  "sha": "07ddc2c..."
}
```

代码检查 `branchData?.commit?.tree?.sha` 永远为 `undefined` → 无法获取 tree SHA。

### 问题 3（High）：GitCode 400/404 未被当作 not found 处理

**严重度**：High — 分支探测报错

GitCode 返回 "Branch Not Found" 时使用 HTTP 400 + `error_code:404`（非标准 HTTP 404）。旧代码只处理了 HTTP 404，导致分支探测被当成通用错误抛出和日志。

### 问题 4（High）：`fetchSkillDirectoryContents` 未支持 AbortSignal

**严重度**：High — 超时后下载仍在后台进行

安装超时触发 `abortController.abort()` 后，`fetchSkillDirectoryContents` 和 `fetchSkillFileContent` 内部的请求不会被取消，继续消耗 API 配额。

### 问题 5（Medium）：安装流程冗余 tree API 调用

**严重度**：Medium（浪费 2-4 次 API 调用）

`downloadSkill` 已获取 `remotePath`，但 `installSkillFromSource` 又调用 `findSkillDirectoryPath` 重新发现路径。

### 问题 6（Medium）：`installSkillMultiTarget` 超时仅 60s

**严重度**：Medium

单目标安装 120s 超时，多目标安装仅 60s，不一致且偏短。

### 问题 7（High）：GitCode contents API 大小写敏感，cache miss 时路径 404

**严重度**：High — 应用重启后安装失败

skillId 中的路径是小写（如 `inference/ais-bench`），但 GitCode contents API 区分大小写（实际路径为 `Inference/ais-bench`）。当 `getSkillDetail` 在 cache miss 时直接用小写路径调用 API，返回 404。

## 技术方案

### 改动 1：用 contents API 替代 tree API（解决问题 1）

**文件**：`src/main/services/skill/gitcode-skill-source.service.ts`

删除 `findSkillDirsViaTree`，替换为 `findSkillDirsViaContents`，使用 contents API 两轮扫描自动适配两种仓库布局：

```
步骤 1：GET /repos/{repo}/contents → 获取根目录列表
步骤 2：对每个根目录并行 GET /contents/{dir}：
  - 若包含 SKILL.md → 扁平布局，该目录是技能
  - 若只有子目录 → 分类布局，探测第一个子目录确认有 SKILL.md 后提升所有子目录
```

对于 `AICO-Ascend/Ascend-Skills`：
- 步骤 1：1 次 API 调用 → [AISystem, Inference, Operation, Train]
- 步骤 2：4 次并行 + 1 次探测 = 6 次 API 调用
- 总计：7 次 API 调用发现全部 32 个技能

### 改动 2：修复 GitCode 400/404 处理（解决问题 3）

**文件**：`src/main/services/skill/gitcode-skill-source.service.ts`

在 `gitcodeApiFetch` 中，检测 HTTP 400 + `error_code:404`，返回 `null`（与 HTTP 404 一致），而非抛出异常。分支探测链 `main → master → default_branch` 可正常回退。

### 改动 3：安装时跳过冗余 `findSkillDirectoryPath`（解决问题 5）

**文件**：`src/main/controllers/skill.controller.ts`

为 `installSkillFromSource` 新增 `knownDirPath` 参数。GitCode 安装时直接传递 `skillName`（即 `remotePath`），跳过路径发现。

### 改动 4：`fetchSkillFileContent` 和 `fetchSkillDirectoryContents` 添加 AbortSignal（解决问题 4）

**文件**：`src/main/services/skill/gitcode-skill-source.service.ts`

- `fetchSkillFileContent(repo, filePath, token, signal)` — signal 传入 `gitcodeFetch`
- `fetchSkillDirectoryContents(repo, dirPath, token, signal)` — signal 透传到递归调用，并在文件下载后、子目录遍历前检查 `signal.aborted` 提前退出

### 改动 5：`installSkillMultiTarget` 超时 60s → 120s（解决问题 6）

**文件**：`src/main/controllers/skill.controller.ts`

### 改动 6：`getSkillDetail` cache miss 时纠正路径大小写（解决问题 7）

**文件**：`src/main/services/skill/skill-market-service.ts`

导出 `findSkillDirsViaContents`，在 `getSkillDetail` 的 GitCode 分支中，当 cache miss 时调用该函数获取全量目录列表，用 `toLowerCase()` 匹配纠正路径大小写。

**文件**：`src/main/controllers/skill.controller.ts`

## 涉及文件

| 文件 | 改动 |
|------|------|
| `src/main/services/skill/gitcode-skill-source.service.ts` | 用 contents API 替代 tree API；修复 400/404 处理；删除 `findSkillDirsViaTree`；`fetchSkillFileContent` + `fetchSkillDirectoryContents` 添加 signal |
| `src/main/services/skill/skill-market-service.ts` | `getSkillDetail` cache miss 时用 `findSkillDirsViaContents` 纠正路径大小写 |
| `src/main/controllers/skill.controller.ts` | `installSkillFromSource` 新增 `knownDirPath`；GitCode 安装跳过路径发现；多目标超时 120s |

## 验收标准

- [x] GitCode 技能列表能正确显示 `AICO-Ascend/Ascend-Skills` 仓库的全部 32 个技能
- [x] 从列表安装 `ais-bench` 技能成功完成（`Inference/ais-bench/`，含 assets/references/scripts 子目录）
- [x] 安装超时触发后，pending 的文件下载请求被取消
- [x] GitCode 400/404 错误不再以 error 级别日志输出，分支探测正常回退
- [x] GitHub 技能源功能不受影响
- [x] `npm run typecheck && npm run lint && npm run build` 全部通过

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-26 | 初始版本 | @MoonSeeker |
| 2026-04-26 | 实际实施：发现 3 个额外根因（tree API 不返回 blob、branches API 无 tree.sha、400/404 未处理），扩展 PRD 范围 | @MoonSeeker |
