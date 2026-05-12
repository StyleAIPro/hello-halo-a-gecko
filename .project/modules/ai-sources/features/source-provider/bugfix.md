# Bug 记录 — AI 源提供商

---

## 统计
| 严重程度 | 数量 |
|---------|------|
| Critical | 0 |
| Major | 4 |
| Minor | 0 |

---

## Major

### [bugfix-model-fetch-and-validate-v1] 获取模型和测试连接的成功/失败判定不可靠

- **状态**：已修复
- **日期**：2026-05-10
- **现象**：测试连接误报成功（API 报错时仍显示成功）、获取模型误报失败（非标准格式响应被拒绝）
- **根因**：SDK result 消息未检查错误字段；响应格式仅支持 OpenAI 标准；URL 规范化逻辑不一致
- **修复**：检查 `msg.is_error`/`msg.subtype` 判定 result 错误；支持 `{ models: [...] }` 等多种响应格式；提取 `normalizeModelsUrl()` 共享函数统一 URL 规范化；超时从 15s 增至 20s

### [bugfix-model-name-stale-v1] 编辑模型显示名称后模型选择框出现新旧名称并存

- **状态**：已修复
- **日期**：2026-05-11
- **现象**：用户编辑模型显示名称后，模型选择框下拉列表中新旧两个名称同时存在
- **根因**：ProviderSelector 无模型名称编辑能力，用户通过 Custom Model ID 添加新名称时 handleSave 仅按 id 去重导致新旧并存；syncBuiltinModels 重启时用默认名称覆盖用户自定义名称
- **修复**：为模型列表项添加内联编辑名称功能（Pencil 图标）；handleSave 中对 availableModels 按 id 去重；syncBuiltinModels 保留用户自定义的模型名称

### [bugfix-model-add-rename-ux-v1] "Use custom model ID" 与内联改名操作混淆导致意外新增模型

- **状态**：已修复
- **日期**：2026-05-11
- **现象**：用户用铅笔编辑模型名称后，保存时系统将修改后的名称作为新模型新增，而非更新已有模型
- **根因**："Use custom model ID" 同时承担「选择模型」和「新增模型」语义，与铅笔编辑状态无联动，`handleSave` 中 `finalModel` 双路径逻辑无法区分用户意图
- **修复**：移除 "Use custom model ID" checkbox + 独立输入框；改为模型下拉列表底部 "+ Add custom model" 按钮；简化 `handleSave` 使 `source.model` 始终取 `selectedModel`；两个操作彻底分离

### [bugfix-fetch-models-format-v1] 智谱 AI 等 Anthropic 兼容端点获取模型列表失败

- **状态**：已修复
- **日期**：2026-05-11
- **现象**：使用智谱 AI Anthropic 兼容端点获取模型时报 `Invalid API response format`
- **根因**：`fetchModelsFromApi` 仅支持 3 种响应格式，不覆盖智谱 AI 的响应结构
- **修复**：新增 Format 1b（嵌套 `data.data` 提取）和 Format 4（遍历顶层数组字段回退）；改进 name 提取优先级为 `m.name || m.owned_by || m.id`；格式匹配失败时记录原始响应前 200 字符；补全 7 个语言文件的 "Add Model" i18n key
