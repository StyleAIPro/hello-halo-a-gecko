# 功能 — App 规范定义与校验

> 日期：2026-04-16
> 指令人：@moonseeker1
> 所属模块：modules/automation

## 描述

定义 Digital Human（自动化 App）的声明式规范格式（App Spec），提供基于 Zod 的结构校验、YAML 解析与字段归一化。App Spec 是整个自动化平台的数据模型基础，所有 App 的安装、运行时、调度均以规范为输入。

## 依赖

- `zod` — Schema 定义与校验
- `yaml` — YAML 文本解析

## 实现逻辑

### 正常流程

1. `parseYamlString()` 将 YAML 文本解析为原始 JS 对象；遇到语法错误抛出 `AppSpecParseError`
2. `normalizeRawSpec()` 对原始对象执行字段别名归一化：
   - `inputs` -> `config_schema`
   - `required_mcps` / `required_skills` -> `requires.mcps` / `requires.skills`
   - 订阅简写形式展开（`type` 字段从顶层移入 `source` 嵌套结构）
   - MCP 依赖字符串数组自动转为 `[{ id }]` 对象数组
3. `validateAppSpec()` 将归一化后的对象传入 `AppSpecSchema`（Zod schema）进行校验
4. Zod schema 中通过 `superRefine` 实现跨字段约束：
   - `type=automation` 必须有 `system_prompt` 和 `subscriptions`
   - `type=mcp` 必须有 `mcp_server`
   - `subscriptions` 只允许出现在 `type=automation`
   - 订阅 ID 唯一性校验
   - `config_key` 引用必须在 `config_schema` 中存在
5. 校验失败时抛出 `AppSpecValidationError`，携带结构化的 `ValidationIssue[]` 列表

### 异常流程

1. YAML 语法错误 -> `AppSpecParseError`
2. Schema 结构不匹配 -> `AppSpecValidationError`（含路径化错误列表）
3. `validateAppSpecSafe()` 提供不抛异常的 `{ success, data/error }` 返回模式

## 涉及数据

App Spec 核心数据结构：

| 字段 | 类型 | 说明 |
|------|------|------|
| name | string | App 显示名（必填） |
| type | `'mcp'\|'skill'\|'automation'\|'extension'` | App 类型 |
| system_prompt | string | AI 行为指令（automation/skill 必填） |
| subscriptions | SubscriptionDef[] | 订阅定义（仅 automation） |
| config_schema | InputDef[] | 用户配置表单定义 |
| output | OutputConfig | 通知配置 |
| filters | FilterRule[] | 规则过滤器 |
| memory_schema | Record | 持久化记忆字段 |
| permissions | string[] | 权限声明 |
| store | StoreMetadata | 商店/注册表元数据 |
| i18n | Record | 多语言覆盖 |

## 变更
-> changelog.md
