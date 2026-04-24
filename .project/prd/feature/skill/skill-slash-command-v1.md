# PRD [功能级] -- /skill 斜杠命令增强：完整 CRUD + enable/disable

> 版本：skill-slash-command-v1
> 日期：2026-04-20
> 指令人：@moonseeker1
> 归属模块：skill-market + renderer/chat
> 状态：done
> 优先级：P0
> 影响范围：前端（slash-command executor + 命令定义）| 后端无新增（复用已有 IPC 通道）

## 需求分析

### 背景

斜杠命令框架已在 PRD `slash-command-framework-v1`（状态：done）中实现并落地。当前 `/skill` 命令支持 5 个子命令：`list`、`install`、`uninstall`、`info`、`search`。这些命令已全部通过现有 IPC 通道实现，无需后端变更。

但当前实现**缺失**以下关键能力：

1. **`enable` / `disable`**：后端 `SkillManager.toggleSkill()` 和 IPC 通道 `skill:toggle` 已支持启用/禁用技能，但斜杠命令层未暴露这两个子命令
2. **`create`**：后端 `skill:generate` IPC 通道已支持从对话或 prompt 生成技能，但斜杠命令层未暴露此能力
3. **`refresh`**：后端 `skill:refresh` IPC 通道已支持刷新技能列表，斜杠命令层未暴露

### 现有代码调研

#### 已有的斜杠命令框架（已落地）

| 文件 | 职责 |
|------|------|
| `src/renderer/hooks/slash-command/types.ts` | 类型定义（SlashCommand, SlashCommandSubcommand 等） |
| `src/renderer/hooks/slash-command/slash-command-registry.ts` | 命令注册表单例，parseInput 解析逻辑 |
| `src/renderer/hooks/slash-command/builtin-skill-commands.ts` | 内置 /skill 命令定义（当前 5 个子命令） |
| `src/renderer/hooks/slash-command/slash-command-executor.ts` | 命令执行器，路由到 api 层调用 |
| `src/renderer/hooks/slash-command/useSlashCommand.ts` | React hook，输入检测+键盘导航 |
| `src/renderer/components/chat/SlashCommandMenu.tsx` | 下拉菜单 UI 组件 |
| `src/renderer/components/chat/InputArea.tsx` | 已集成 useSlashCommand hook |

#### 已有的后端 IPC 通道（可复用）

| 子命令 | 现有 IPC 通道 | API 层方法 | 后端服务 |
|--------|-------------|-----------|---------|
| `list` | `skill:list` | `api.skillList()` | `SkillManager.getInstalledSkills()` |
| `install` | `skill:install` | `api.skillInstall({ mode, skillId })` | `SkillManager.installSkill()` |
| `uninstall` | `skill:uninstall` | `api.skillUninstall(skillId)` | `SkillManager.uninstallSkill()` |
| `info` | `skill:market:detail` | `api.skillMarketDetail(skillId)` | `SkillMarketService.getSkillDetail()` |
| `search` | `skill:market:search` | `api.skillMarketSearch(query)` | `SkillMarketService.searchSkills()` |
| **`enable`** (新增) | `skill:toggle` | `api.skillToggle(skillId, true)` | `SkillManager.toggleSkill()` |
| **`disable`** (新增) | `skill:toggle` | `api.skillToggle(skillId, false)` | `SkillManager.toggleSkill()` |
| **`refresh`** (新增) | `skill:refresh` | `api.skillRefresh()` | `SkillManager.refresh()` |
| **`create`** (新增) | `skill:generate` | 需新增封装 | `skillController.generateSkillFromPrompt()` |

### 问题

1. **技能 enable/disable 操作入口缺失**：用户在聊天中无法快速启用/禁用技能，必须切换到技能页面操作
2. **技能列表刷新不便**：安装/卸载技能后，用户需要手动刷新才能看到最新状态
3. **技能创建入口单一**：创建新技能只能在 Skill Editor 页面完成，聊天中无法快速发起

### 预期效果

- `/skill enable <skill-id>` 在聊天中启用指定技能
- `/skill disable <skill-id>` 在聊天中禁用指定技能
- `/skill refresh` 刷新本地已安装技能列表
- `/skill create <name> <description>` 快速创建新技能草稿
- 所有现有命令（list、install、uninstall、info、search）保持不变
- 命令结果以内联系统消息反馈到聊天区域（与现有逻辑一致）

## 技术方案

### 改动范围

本 PRD **仅涉及前端**（斜杠命令定义和执行器），不需要后端、IPC、preload 的变更。所有新增子命令都复用已有的 IPC 通道。

### 1. 扩展 builtin-skill-commands.ts 命令定义

**文件**：`src/renderer/hooks/slash-command/builtin-skill-commands.ts`

在现有 `skillCommand.subcommands` 数组中新增 4 个子命令定义：

```typescript
// 已有: list, install, uninstall, info, search

// 新增：
{
  name: 'enable',
  labelKey: 'Enable Skill',
  descriptionKey: 'Enable a disabled skill',
  arguments: [
    {
      name: 'skillId',
      type: 'string',
      required: true,
      descriptionKey: 'Skill ID',
      placeholderKey: 'Enter skill ID',
    },
  ],
  execution: 'ipc',
},
{
  name: 'disable',
  labelKey: 'Disable Skill',
  descriptionKey: 'Disable an enabled skill',
  arguments: [
    {
      name: 'skillId',
      type: 'string',
      required: true,
      descriptionKey: 'Skill ID',
      placeholderKey: 'Enter skill ID',
    },
  ],
  execution: 'ipc',
},
{
  name: 'refresh',
  labelKey: 'Refresh Skills',
  descriptionKey: 'Reload installed skills list',
  arguments: [],
  execution: 'ipc',
},
{
  name: 'create',
  labelKey: 'Create Skill',
  descriptionKey: 'Create a new skill from a prompt',
  arguments: [
    {
      name: 'name',
      type: 'string',
      required: true,
      descriptionKey: 'Skill name',
      placeholderKey: 'Enter skill name',
    },
    {
      name: 'description',
      type: 'rest',
      required: true,
      descriptionKey: 'Skill description',
      placeholderKey: 'Enter skill description',
    },
  ],
  execution: 'ipc',
},
```

### 2. 扩展 slash-command-executor.ts 执行器

**文件**：`src/renderer/hooks/slash-command/slash-command-executor.ts`

在 `executeSkillCommand` 函数的 `switch` 语句中新增 4 个 case：

#### `/skill enable <skill-id>`

```typescript
case 'enable': {
  const skillId = parsed.args[0];
  if (!skillId) {
    return { success: false, message: t('Missing required argument: {{arg}}', { arg: 'skillId' }) };
  }
  try {
    const result = await api.skillToggle(skillId, true);
    if (result.success) {
      return { success: true, message: t('Skill "{{name}}" enabled', { name: skillId }) };
    }
    return { success: false, message: t('Failed to enable: {{error}}', { error: result.error ?? 'Unknown error' }) };
  } catch (error) {
    return { success: false, message: t('Failed to enable: {{error}}', { error: error instanceof Error ? error.message : String(error) }) };
  }
}
```

#### `/skill disable <skill-id>`

```typescript
case 'disable': {
  const skillId = parsed.args[0];
  if (!skillId) {
    return { success: false, message: t('Missing required argument: {{arg}}', { arg: 'skillId' }) };
  }
  try {
    const result = await api.skillToggle(skillId, false);
    if (result.success) {
      return { success: true, message: t('Skill "{{name}}" disabled', { name: skillId }) };
    }
    return { success: false, message: t('Failed to disable: {{error}}', { error: result.error ?? 'Unknown error' }) };
  } catch (error) {
    return { success: false, message: t('Failed to disable: {{error}}', { error: error instanceof Error ? error.message : String(error) }) };
  }
}
```

#### `/skill refresh`

```typescript
case 'refresh': {
  try {
    const result = await api.skillRefresh();
    if (result.success) {
      return { success: true, message: t('Skills list refreshed successfully') };
    }
    return { success: false, message: t('Failed to refresh: {{error}}', { error: result.error ?? 'Unknown error' }) };
  } catch (error) {
    return { success: false, message: t('Failed to refresh: {{error}}', { error: error instanceof Error ? error.message : String(error) }) };
  }
}
```

#### `/skill create <name> <description>`

```typescript
case 'create': {
  const name = parsed.args[0];
  const description = parsed.args.slice(1).join(' ');
  if (!name) {
    return { success: false, message: t('Missing required argument: {{arg}}', { arg: 'name' }) };
  }
  if (!description) {
    return { success: false, message: t('Missing required argument: {{arg}}', { arg: 'description' }) };
  }
  try {
    // 使用 skill:generate IPC（mode: 'prompt'）
    const result = await api.skillGenerateFromPrompt({
      spaceId: '',  // 不关联具体 space
      name,
      description,
      triggerCommand: `/${name.toLowerCase().replace(/\s+/g, '-')}`,
    });
    if (result.success) {
      return { success: true, message: t('Skill "{{name}}" created successfully', { name }) };
    }
    return { success: false, message: t('Failed to create: {{error}}', { error: result.error ?? 'Unknown error' }) };
  } catch (error) {
    return { success: false, message: t('Failed to create: {{error}}', { error: error instanceof Error ? error.message : String(error) }) };
  }
}
```

### 3. 新增 api.skillGenerateFromPrompt 封装

**文件**：`src/renderer/api/index.ts`

在 `api` 对象中新增 `skillGenerateFromPrompt` 方法，封装 `skill:generate` IPC 通道的 `mode: 'prompt'` 调用：

```typescript
skillGenerateFromPrompt: async (input: {
  spaceId: string;
  name: string;
  description: string;
  triggerCommand?: string;
}): Promise<ApiResponse> => {
  if (isElectron()) {
    return window.aicoBot.skillGenerate({
      mode: 'prompt',
      ...input,
    });
  }
  return httpRequest('POST', '/api/skills/generate', { mode: 'prompt', ...input });
},
```

> **注意**：需要确认 `window.aicoBot.skillGenerate` 和 preload 中是否已有 `skillGenerate` 方法。经调研，preload 已有 `skillGenerate`（`skill:generate` IPC），但 `api/index.ts` 中缺少对应的 `skillGenerateFromPrompt` 封装方法。如果已有则直接复用，否则需要新增。

### 4. IPC 通道（无需新增）

所有新增子命令复用已有 IPC 通道，无需修改后端代码：

| 新增子命令 | 复用的 IPC 通道 | API 层方法 |
|-----------|---------------|-----------|
| `/skill enable` | `skill:toggle` | `api.skillToggle(skillId, true)` |
| `/skill disable` | `skill:toggle` | `api.skillToggle(skillId, false)` |
| `/skill refresh` | `skill:refresh` | `api.skillRefresh()` |
| `/skill create` | `skill:generate` | `api.skillGenerateFromPrompt(...)` |

### 5. 国际化新增 keys

**文件**：`src/renderer/i18n/locales/zh-CN.json` 等语言文件

新增以下 i18n keys（运行 `npm run i18n` 提取后翻译）：

```json
{
  "Enable Skill": "启用技能",
  "Disable Skill": "禁用技能",
  "Enable a disabled skill": "启用一个已禁用的技能",
  "Disable an enabled skill": "禁用一个已启用的技能",
  "Refresh Skills": "刷新技能",
  "Reload installed skills list": "重新加载已安装技能列表",
  "Create Skill": "创建技能",
  "Create a new skill from a prompt": "通过描述快速创建新技能",
  "Skill \"{{name}}\" enabled": "技能 \"{{name}}\" 已启用",
  "Skill \"{{name}}\" disabled": "技能 \"{{name}}\" 已禁用",
  "Failed to enable: {{error}}": "启用失败：{{error}}",
  "Failed to disable: {{error}}": "禁用失败：{{error}}",
  "Skills list refreshed successfully": "技能列表已刷新",
  "Failed to refresh: {{error}}": "刷新失败：{{error}}",
  "Skill \"{{name}}\" created successfully": "技能 \"{{name}}\" 创建成功",
  "Failed to create: {{error}}": "创建失败：{{error}}",
  "Skill name": "技能名称",
  "Skill description": "技能描述",
  "Enter skill name": "输入技能名称",
  "Enter skill description": "输入技能描述"
}
```

### 6. /skill create 的 spaceId 问题

`/skill create` 需要一个 `spaceId` 参数（`skill:generate` IPC 要求）。在聊天场景下，可以：

**方案 A**（推荐）：使用当前空间的 spaceId
- 从 `useSpaceStore` 获取 `currentSpaceId`
- 但 `slash-command-executor.ts` 是纯函数，不直接访问 store
- 解决：在 `executeSlashCommand` 中增加可选的 context 参数（如 `{ spaceId }`），由调用方传入

**方案 B**：后端允许 spaceId 为空
- 修改 `skill:generate` handler，当 `mode === 'prompt'` 且 `spaceId` 为空时使用默认 space
- 需要修改后端代码

**推荐方案 A**，因为它不要求后端变更。具体做法：

1. 在 `SlashCommandExecutionResult` 类型中新增可选的 `context?: { spaceId?: string; conversationId?: string }` 字段
2. 在 `InputArea.tsx` 中调用 `executeSlashCommand` 时传入 context
3. 执行器从 context 中获取 spaceId 用于 `skill:generate` 调用

但考虑到改动最小化，可以先使用**方案 B**：让 `skill:generate` handler 对 `prompt` 模式下空 `spaceId` 的容错。如果后端已经处理了这种情况（当前 controller 中 `generateSkillFromPrompt` 是否检查 spaceId），则直接传空即可。

**最终决定**：调研 `skill.controller.ts` 的 `generateSkillFromPrompt` 方法，确认是否允许空 spaceId。如果允许，直接传空。如果不允许，则在 executor 中增加 context 传递机制。

### 7. 数据流总结

```
用户输入 "/skill enable my-skill"
    ↓
useSlashCommand.parseInput() → SlashCommandMatch { type: 'argument', subcommand: 'enable' }
    ↓
Enter 键触发 → executeSlashCommand("/skill enable my-skill")
    ↓
parseFullCommand() → { commandName: 'skill', subcommandName: 'enable', args: ['my-skill'] }
    ↓
executeSkillCommand(parsed) → switch case 'enable'
    ↓
api.skillToggle('my-skill', true) → IPC: 'skill:toggle'
    ↓
SkillManager.toggleSkill('my-skill', true) → 更新 META.json
    ↓
返回 SlashCommandExecutionResult { success: true, message: '...' }
    ↓
InputArea.handleCommandResult() → 插入系统消息到聊天 UI
```

## 涉及文件

| # | 文件 | 改动类型 | 说明 |
|---|------|---------|------|
| 1 | `src/renderer/hooks/slash-command/builtin-skill-commands.ts` | 修改 | 新增 enable、disable、refresh、create 4 个子命令定义 |
| 2 | `src/renderer/hooks/slash-command/slash-command-executor.ts` | 修改 | 新增 4 个 switch case 对应的执行逻辑 |
| 3 | `src/renderer/api/index.ts` | 修改 | 新增 `skillGenerateFromPrompt` 封装方法 |
| 4 | `.project/modules/chat/features/input-area/changelog.md` | 修改 | 追加变更记录 |

## 开发前必读

### 模块设计文档

| # | 文档/文件 | 阅读目的 |
|---|---------|---------|
| 1 | `.project/prd/feature/slash-command-framework-v1.md` | 理解斜杠命令框架完整设计（已 done），确认扩展方式 |
| 2 | `.project/modules/skill/skill-system-v1.md` | 理解技能模块架构、IPC 通道列表 |
| 3 | `.project/modules/skill/features/skill-market/changelog.md` | 了解技能市场最近变更 |

### 源码文件

| # | 文档/文件 | 阅读目的 |
|---|---------|---------|
| 4 | `src/renderer/hooks/slash-command/builtin-skill-commands.ts` | 理解现有子命令定义格式，新增子命令时保持一致 |
| 5 | `src/renderer/hooks/slash-command/slash-command-executor.ts` | 理解现有执行逻辑，新增 case 时保持错误处理模式一致 |
| 6 | `src/renderer/hooks/slash-command/types.ts` | 确认 SlashCommandArgument 类型中 rest 类型的行为 |
| 7 | `src/main/controllers/skill.controller.ts` | 确认 `generateSkillFromPrompt` 方法对空 spaceId 的处理 |
| 8 | `src/renderer/api/index.ts` | 确认 `skillGenerateFromPrompt` 是否已存在，以及 `api.skillRefresh()` 签名 |
| 9 | `src/main/ipc/skill.ts` | 确认 `skill:toggle`、`skill:refresh`、`skill:generate` 的 handler 签名 |

### 编码规范

| # | 文档/文件 | 阅读目的 |
|---|---------|---------|
| 10 | `docs/Development-Standards-Guide.md` | TypeScript strict、禁止 any、纯类型导入、i18n t() 使用 |
| 11 | `docs/vibecoding-doc-standard.md` | 文档管理规范 |

## 验收标准

### 基础功能

- [ ] `/skill enable <skill-id>` 执行后启用指定技能，聊天中显示成功/失败反馈
- [ ] `/skill disable <skill-id>` 执行后禁用指定技能，聊天中显示成功/失败反馈
- [ ] `/skill enable` 不带参数时提示缺少必需参数
- [ ] `/skill disable` 不带参数时提示缺少必需参数
- [ ] `/skill refresh` 执行后刷新本地技能列表，显示刷新结果
- [ ] `/skill create <name> <description>` 执行后创建新技能，显示成功/失败反馈
- [ ] `/skill create` 不带参数时提示缺少必需参数
- [ ] `/skill create <name>` 不带 description 时提示缺少必需参数

### 菜单交互

- [ ] 输入 `/skill ` 后菜单中展示新增的 enable、disable、refresh、create 子命令
- [ ] 输入 `/skill en` 时菜单过滤显示 enable 子命令
- [ ] Tab 键可补全新增的子命令名称
- [ ] Enter 键在参数阶段正确执行新增命令

### 兼容性

- [ ] 现有的 `/skill list`、`/skill install`、`/skill uninstall`、`/skill info`、`/skill search` 功能不受影响
- [ ] `/skill list` 输出中显示技能的启用/禁用状态（当前已实现：`[disabled]` 标记）
- [ ] 所有用户可见文本使用 `t()` 国际化
- [ ] 远程 Web 模式下命令正常（通过 HTTP API）

### 代码质量

- [ ] `npm run typecheck` 通过
- [ ] `npm run lint` 通过
- [ ] `npm run build` 通过
- [ ] `npm run i18n` 无新增未翻译 key

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-20 | 初始 PRD | @moonseeker1 |
