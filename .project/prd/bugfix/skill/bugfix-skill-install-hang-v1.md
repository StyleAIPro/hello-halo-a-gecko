# PRD [Bug 修复级] — GitCode 技能市场安装长时间挂起

> 版本：bugfix-skill-install-hang-v1
> 日期：2026-04-24
> 指令人：用户
> 归属模块：modules/skill
> 严重程度：Major（安装流程完全无响应，用户无法安装任何技能）
> 所属功能：features/skill-market + features/skill-source
> 状态：in-progress

## 问题描述

- **期望行为**：从 GitCode 技能市场点击安装按钮后，技能在合理时间内（< 60s）完成安装，界面显示安装进度和结果
- **实际行为**：点击安装按钮后界面一直显示 "Installing..." 转圈，长时间无响应，无任何进度信息，用户只能强制关闭
- **复现步骤**：
  1. 配置 GitCode PAT Token
  2. 在技能市场浏览 GitCode 源的技能列表
  3. 点击任意技能的「安装」按钮
  4. 观察界面停留在 "Installing..." 状态，无进度反馈

## 根因分析

### 根因 1：`downloadSkill` 阶段无进度反馈

**文件**：`skill-market-service.ts` L588-639

`skill.controller.ts` L254 调用 `skillMarket.downloadSkill(skillId)` 时没有传递 `onOutput` 回调。`downloadSkill` 内部调用 `getSkillDetail`，可能触发 GitCode API 请求。如果 API 超时（30s）或网络慢，用户看不到任何进度信息，只会看到 "Installing..." 转圈。

```typescript
// skill.controller.ts:254 — 无进度回调
const downloadResult = await skillMarket.downloadSkill(skillId);
```

```typescript
// skill-market-service.ts:603 — getSkillDetail 可能耗时很长
const skill = await this.getSkillDetail(skillId);
```

### 根因 2：`getSkillDetail` 失败后路径大小写不匹配

**文件**：`skill-market-service.ts` L603-619

当 `getSkillDetail` 失败时（如 GitCode API 暂时不可用），代码从 skillId 解析 skillName：

```typescript
// L615 — 全小写，如 "inference/skill-name"
skillName: parts.slice(2).join(':'),
```

但 GitCode 上的实际目录可能是 `Inference/Skill-Name`（首字母大写），导致后续 `findSkillDirectoryPath` 的精确匹配（3 个变体）全部失败，回退到递归扫描。

### 根因 3：`findSkillDirectoryPath` 回退到递归扫描耗时数分钟

**文件**：`gitcode-skill-source.service.ts` L537-559

精确路径匹配（3 个变体）全部失败后，回退到 `findSkillDirs(repo, '/', token)` 递归扫描：

```typescript
// L539 — maxDepth 默认 5，可能发起数十个 API 请求
const allDirs = await findSkillDirs(repo, '/', token);
```

每个请求有 30s 超时 + 1s 速率限制间隔。在 2026-04-22 的 `bugfix-skill-scan-category-dir-v1` 修复后，`findSkillDirs` 已添加短路优化（发现首个含 SKILL.md 的子目录后批量提升同级目录），但该优化仅在分类目录结构下有效。对于其他目录结构，仍可能发起大量 API 请求，最坏情况下耗时数分钟。

此外，该 fallback 的 `try/catch`（L557-559）静默吞掉所有错误，用户得不到任何反馈。

### 根因 4：Token 可能未正确传递到安装流程

**文件**：`skill.controller.ts` L96

`installSkillFromSource` 通过 `adapter.getToken()` 获取 Token，而 `downloadSkill`（`skill-market-service.ts` L531）通过 `gitcodeSkillSource.getGitCodeToken()` 获取。如果配置读取时序或缓存问题导致 Token 为 `undefined`，API 请求会因认证失败返回 401，被 catch 块静默吞掉，触发递归扫描 fallback。

### 根因 5：无整体安装超时

`installSkillFromMarket`（`skill.controller.ts` L244-345）没有整体超时机制。GitHub npx 安装有 120s 超时（L298），但 GitCode 直接下载路径（`installSkillFromSource`）没有超时限制。如果递归扫描耗时过长，安装流程将永远挂起。

## 技术方案

### 修复 1：为 `downloadSkill` 添加进度回调

**文件**：`skill-market-service.ts` + `skill.controller.ts`

修改 `downloadSkill` 接受可选的 `onOutput` 参数，在关键步骤发送进度信息：

```typescript
async downloadSkill(
  skillId: string,
  onOutput?: (data: { type: 'stdout' | 'stderr'; content: string }) => void,
): Promise<{ ... }> {
  onOutput?.({ type: 'stdout', content: '  Resolving skill metadata...\n' });
  const skill = await this.getSkillDetail(skillId);
  // ...
}
```

在 `installSkillFromMarket`（`skill.controller.ts:254`）调用时传入 `onOutput`：

```typescript
const downloadResult = await skillMarket.downloadSkill(skillId, (data) => {
  onOutput?.({ type: 'stdout', content: data.content });
});
```

### 修复 2：`getSkillDetail` 失败时优先使用缓存路径

**文件**：`skill-market-service.ts` L603-619

当 `getSkillDetail` 返回 `null` 时，先查缓存 `findSkillInCache(skillId)` 获取原始大小写 `remotePath`，而非直接从 ID 解析小写路径：

```typescript
if (!skill) {
  // 优先使用缓存中的原始路径（保留大小写）
  const cachedItem = this.findSkillInCache(skillId);
  if (cachedItem?.remotePath && cachedItem?.remoteRepo) {
    return {
      success: true,
      remoteRepo: cachedItem.remoteRepo,
      skillName: cachedItem.remotePath,
      sourceType,
    };
  }
  // fallback：从 ID 解析（保留原始分隔符 ':'）
  if ((skillId.startsWith('gitcode:') || skillId.startsWith('github:')) && skillId.split(':').length >= 3) {
    // ... 现有逻辑
  }
}
```

> 注意：`getSkillDetail` 内部（L521-534）在 `getSkillDetailFromRepo` 之前已有 `findSkillInCache` 逻辑并会用缓存路径覆盖 `skillPath`。但如果 `getSkillDetailFromRepo` 本身抛异常被外层 catch，整个 `getSkillDetail` 返回 `null`，缓存路径丢失。此修复确保缓存路径在 `downloadSkill` 层面被兜底使用。

### 修复 3：限制 `findSkillDirs` 递归深度和超时

**文件**：`gitcode-skill-source.service.ts` L537-559

将 `findSkillDirectoryPath` 中 fallback 的 `findSkillDirs` 调用：
- `maxDepth` 从默认 5 降到 **2**
- 添加整体超时 **15s**，超时后返回 `null` 并打印警告日志

```typescript
// Case-insensitive fallback with depth limit and timeout
try {
  const timeoutPromise = new Promise<null>((resolve) =>
    setTimeout(() => {
      console.warn('[GitCodeSkillSource] findSkillDirs fallback timed out (15s) for', repo, skillName);
      resolve(null);
    }, 15000),
  );
  const dirsPromise = findSkillDirs(repo, '/', token, 2);
  const allDirs = await Promise.race([dirsPromise, timeoutPromise]);
  if (!allDirs) {
    console.warn('[GitCodeSkillSource] Fallback scan timed out, tried paths:', triedPaths.join(', '));
    return null;
  }
  // ... 大小写不敏感匹配逻辑
} catch (error) {
  console.error('[GitCodeSkillSource] Fallback scan failed for', repo, skillName, error);
}
```

### 修复 4：添加整体安装超时

**文件**：`skill.controller.ts`

在 `installSkillFromMarket` 中添加 60s 整体超时：

```typescript
export async function installSkillFromMarket(
  skillId: string,
  onOutput?: ...,
): Promise<{ success: boolean; error?: string }> {
  const INSTALL_TIMEOUT = 60_000; // 60 秒
  return Promise.race([
    doInstall(skillId, onOutput),
    new Promise<{ success: boolean; error: string }>((resolve) =>
      setTimeout(() => {
        onOutput?.({ type: 'error', content: 'Installation timed out after 60 seconds. Please check your network and try again.\n' });
        resolve({ success: false, error: 'Installation timed out (60s)' });
      }, INSTALL_TIMEOUT),
    ),
  ]);
}
```

将现有安装逻辑提取到内部 `doInstall` 函数。

### 修复 5：在递归扫描前添加诊断日志

**文件**：`gitcode-skill-source.service.ts` L537

在 `findSkillDirectoryPath` 进入 fallback 前打印日志，包含已尝试的路径和仓库信息：

```typescript
console.warn(
  '[GitCodeSkillSource] Exact match failed, falling back to recursive scan for',
  { repo, skillName, lastSegment, triedPaths },
);
```

## 涉及文件（实际）

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/main/services/skill/skill-market-service.ts` | 修改 | `downloadSkill` 添加 `onOutput` 回调参数 + 缓存路径兜底 |
| `src/main/services/skill/gitcode-skill-source.service.ts` | 修改 | `findSkillDirectoryPath` fallback 限制 maxDepth=2 + 15s 超时 + 诊断日志 |
| `src/main/controllers/skill.controller.ts` | 修改 | 传递 `onOutput` 到 `downloadSkill` + 添加 60s 整体安装超时 |
| `.project/modules/skill/features/skill-market/changelog.md` | 更新 | 追加变更记录 |
| `.project/modules/skill/features/skill-market/bugfix.md` | 更新 | 追加 BUG-006 记录 |
| `.project/modules/skill/features/skill-source/changelog.md` | 更新 | 追加变更记录 |
| `.project/changelog/CHANGELOG.md` | 更新 | 追加全局变更记录 |
| `.project/prd/bugfix/skill/bugfix-skill-install-hang-v1.md` | 新增 | 本 PRD |

## 开发前必读

| 分类 | 文档/文件 | 阅读目的 |
|------|----------|---------|
| 模块文档 | `.project/modules/skill/features/skill-source/changelog.md` | 了解 GitCode skill source 最近变更（尤其是 findSkillDirs 短路优化） |
| 模块文档 | `.project/modules/skill/features/skill-source/bugfix.md` | 了解已知问题（分类目录扫描超时已修复的背景） |
| 模块文档 | `.project/modules/skill/features/skill-market/changelog.md` | 了解 skill market 最近变更 |
| 模块文档 | `.project/modules/skill/features/skill-market/bugfix.md` | 了解 skill market 已知问题（5 个历史 bug 的修复上下文） |
| 源码文件 | `src/main/services/skill/skill-market-service.ts` | 理解 `downloadSkill`（L588-639）和 `getSkillDetail`（L520-583）的实现逻辑 |
| 源码文件 | `src/main/services/skill/gitcode-skill-source.service.ts` | 理解 `findSkillDirectoryPath`（L490-562）和 `findSkillDirs` 的实现逻辑 |
| 源码文件 | `src/main/controllers/skill.controller.ts` | 理解 `installSkillFromMarket`（L244-345）和 `installSkillFromSource`（L70-200）的安装流程 |
| 历史PRD | `.project/prd/bugfix/skill/bugfix-skill-scan-category-dir-v1.md` | 了解 findSkillDirs 短路优化的技术细节，避免回归 |

## 验收标准

- [ ] 从 GitCode 技能市场安装技能时，安装界面显示进度信息（如 "Resolving skill metadata..."、"Locating skill directory..."、"Downloading skill files..." 等）
- [ ] `getSkillDetail` 失败时优先使用缓存中的原始大小写路径，不再回退到小写 ID 解析
- [ ] `findSkillDirectoryPath` fallback 递归扫描 `maxDepth` 限制为 2，整体超时 15s
- [ ] 递归扫描超时后返回明确的错误信息（不再静默失败）
- [ ] 安装过程总超时 60s，超时后前端显示明确的错误提示
- [ ] 递归扫描 fallback 触发时，控制台打印诊断日志（包含已尝试路径和仓库信息）
- [ ] 正常安装流程不受影响（安装成功，技能可正常加载和使用）
- [ ] `npm run typecheck && npm run lint && npm run build` 通过
- [ ] 新增/修改的用户可见文本已执行 `npm run i18n`（如无新增文本则跳过）

## 变更记录

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-24 | 初始 Bug 修复 PRD | 用户 |
