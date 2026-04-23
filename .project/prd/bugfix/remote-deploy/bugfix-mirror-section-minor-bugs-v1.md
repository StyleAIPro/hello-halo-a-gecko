# Bugfix: MirrorSourceSection 重复 return 语句 + 注释语法错误

## 元信息

- **时间**: 2026-04-22
- **状态**: done
- **优先级**: P0
- **指令人**: StyleAIPro
- **影响范围**: 仅前端 + 后端（两个独立小修复）
- **PRD 级别**: bugfix

## 问题描述

两个代码质量问题，均为编辑残留：

**Bug 1 — `extractDomain` 重复 return 语句**

文件 `src/renderer/components/settings/MirrorSourceSection.tsx` 第 159 行存在重复的 `return url;`。该语句是死代码，永远不会执行（第 158 行已经 return）。虽不影响功能，但违反代码规范，应清理。

```tsx
const extractDomain = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
    return url;  // ← 重复死代码，需删除
  }
};
```

**Bug 2 — 注释使用了无效的反斜杠前缀**

文件 `src/main/services/remote-deploy/remote-deploy.service.ts` 约第 2426 行，注释使用了 `\` 而非 `//` 作为前缀：

```typescript
\ Check remote environment: files, version freshness, and SDK independently
```

应修正为：

```typescript
// Check remote environment: files, version freshness, and SDK independently
```

`\` 不是合法的 TypeScript 注释前缀，会导致语法错误。

## 根因分析

两处均为人工编辑时的残留错误：

- Bug 1：复制粘贴或编辑时重复输入了 `return url;`，未清理。
- Bug 2：在注释行首误输入 `\`（可能是 `/` 的误触），TypeScript 不识别单反斜杠作为注释。

## 技术方案

两个修复均为单行删除/修改，无逻辑变更：

### Bug 1 修复

删除 `MirrorSourceSection.tsx` 第 159 行的重复 `return url;`。

### Bug 2 修复

将 `\ Check remote environment...` 修正为 `// Check remote environment...`。

## 涉及文件

| 文件 | 修改内容 |
|------|---------|
| `src/renderer/components/settings/MirrorSourceSection.tsx` | 删除第 159 行重复的 `return url;` |
| `src/main/services/remote-deploy/remote-deploy.service.ts` | 修正第 2426 行注释前缀 `\` → `//` |

## 开发前必读

- `src/renderer/components/settings/MirrorSourceSection.tsx` — 理解 `extractDomain` 上下文
- `src/main/services/remote-deploy/remote-deploy.service.ts` — 理解注释所在函数的上下文

## 验收标准

- [x] `MirrorSourceSection.tsx` 中 `extractDomain` 函数的 `catch` 块内只有一条 `return url;`
- [x] `remote-deploy.service.ts` 第 2426 行注释使用 `//` 前缀（已在 unstaged changes 中修复）
- [ ] `npm run typecheck` 通过
- [ ] `npm run lint` 通过
- [ ] `npm run build` 通过
