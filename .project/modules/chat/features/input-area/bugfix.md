# Bug 记录 -- 用户输入区域

## BUG-001: MAX_IMAGES 未定义导致 InputArea 崩溃
- **日期**：2026-04-16
- **严重程度**：Critical
- **发现人**：@moonseeker1
- **问题**：打开聊天页面即崩溃，报 `ReferenceError: MAX_IMAGES is not defined`
- **根因**：`useImageAttachments.ts` 中 `MAX_IMAGES` 未 export，`InputArea.tsx` 未 import
- **修复**：export `MAX_IMAGES` 并在 InputArea 中导入
- **PRD**：`prd/bugfix/chat/bugfix-max-images-not-defined-v1.md`
- **影响文档**：
  - [ ] design.md

---

## 统计

| 严重程度 | 数量 |
|---------|------|
| Critical | 1 |
| Major | 0 |
| Minor | 0 |
