# Bug 记录 — AI 源提供商

---

## 统计
| 严重程度 | 数量 |
|---------|------|
| Critical | 0 |
| Major | 1 |
| Minor | 0 |

---

## Major

### [bugfix-model-fetch-and-validate-v1] 获取模型和测试连接的成功/失败判定不可靠

- **状态**：已修复
- **日期**：2026-05-10
- **现象**：测试连接误报成功（API 报错时仍显示成功）、获取模型误报失败（非标准格式响应被拒绝）
- **根因**：SDK result 消息未检查错误字段；响应格式仅支持 OpenAI 标准；URL 规范化逻辑不一致
- **修复**：检查 `msg.is_error`/`msg.subtype` 判定 result 错误；支持 `{ models: [...] }` 等多种响应格式；提取 `normalizeModelsUrl()` 共享函数统一 URL 规范化；超时从 15s 增至 20s
