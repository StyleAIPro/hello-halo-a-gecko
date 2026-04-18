# Bug 记录 — AI 源管理器

---

## 统计
| 严重程度 | 数量 |
|---------|------|
| Critical | 0 |
| Major | 1 |
| Minor | 0 |

---

## [Major] useAISources 以函数回调调用 setConfig 导致主题重置

> PRD：`prd/bugfix/ai-sources/bugfix-theme-reset-on-config-update-v1.md`

**现象**：更新 AI 源配置后深色主题背景变白，需手动切换主题才能恢复。

**根因**：`useAISources` 中 `setConfig((prev) => ...)` 使用函数式更新器模式，但 `app.store.ts` 的 `setConfig` 不支持该模式，导致整个 config 被替换为函数对象，`config.appearance.theme` 丢失。

**修复**：改用 `updateConfig` 方法进行部分合并更新。
