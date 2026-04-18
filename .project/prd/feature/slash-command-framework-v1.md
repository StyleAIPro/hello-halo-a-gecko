# PRD [功能级] -- 斜杠命令框架 + /skill 插件

> 版本：slash-command-framework-v1
> 日期：2026-04-18
> 指令人：@moonseeker1
> 归属模块：renderer/chat + shared
> 状态：done

## 需求分析

### 背景

AICO-Bot 聊天输入框（`InputArea`）目前仅支持纯文本输入和 `@` 提及（Hyper Space 场景）。用户在聊天中管理技能（Skill）需要切换到专门的 Skill 页面，操作路径较长。引入斜杠命令（`/` 前缀）是业界常见交互模式（Slack、Discord、Notion），可以显著提升操作效率和可发现性。

现有的 `useMentionSystem` hook（`@` 触发）已在项目中落地，证明弹出式交互模式可行。斜杠命令框架应参照该模式，实现独立的通用命令入口。

### 问题

1. **操作路径长**：用户在聊天场景下无法快速操作技能（查看、安装、卸载、搜索），必须切换到 Skill 页面
2. **缺乏命令入口**：输入框没有可扩展的命令入口，无法通过简短命令触发表层操作
3. **重复实现风险**：如果不建立通用框架，后续每个命令（/clear、/compact、/model 等）都需要单独实现触发逻辑

### 预期效果

- 用户在聊天输入框行首输入 `/` 时，弹出斜杠命令下拉菜单，列出所有可用命令
- 输入 `/skill` 后展开技能子命令（list、install、uninstall、info、search），支持模糊搜索
- 选中命令后，可通过 Tab 补全命令名称，按 Enter 执行
- 命令执行结果以内联系统消息形式反馈在聊天区域
- 框架可扩展，后续添加新命令只需注册，无需修改 InputArea 代码

## 技术方案

### 架构概览

```
┌──────────────────────────────────────────────────────────────────┐
│  InputArea.tsx (textarea)                                        │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ useSlashCommand() hook                                     │  │
│  │  - 检测行首 / 前缀输入                                      │  │
│  │  - 管理命令列表/子命令过滤                                    │  │
│  │  - 键盘导航拦截 (ArrowUp/Down/Tab/Enter/Esc)               │  │
│  │  - 命令补全文本替换                                          │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ SlashCommandMenu.tsx (下拉菜单组件)                          │  │
│  │  - 命令/子命令列表渲染                                       │  │
│  │  - 参数提示行                                               │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ slash-command-registry.ts (命令注册表，渲染进程单例)            │  │
│  │  - register() / unregister()                                │  │
│  │  - getAllCommands()                                         │  │
│  │  - parseInput(input, cursorPos) → SlashCommandMatch          │  │
│  │  - 初始化时注册内置 /skill 命令                                │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ slash-command-executor.ts (命令执行器)                        │  │
│  │  - parseFullCommand(text) → { command, subcommand, args }   │  │
│  │  - executeCommand(text) → SlashCommandExecutionResult        │  │
│  │  - ipc 类型命令通过 api 层调用（自动适配 Electron/HTTP）        │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### 与 @Mention 系统的关系

当前 `useMentionSystem` hook 专为 Hyper Space 的 `@agent` 提及设计，是领域特定的实现。斜杠命令框架是**独立的通用层**，与 `@mention` 系统并存：

- **不耦合**：两个 hook 独立工作，不互相 import
- **事件拦截优先级**：`handleKeyDown` 中先交给 `handleMentionKeyDown`，再交给 `handleSlashKeyDown`。因为 `@` 和 `/` 不会同时触发，不会冲突
- **共享模式**：键盘导航（上下/Tab/Enter/Esc）和弹出列表的交互模式参照 `useMentionSystem` 的设计，但代码各自独立

### 1. 类型定义

**文件**：`src/renderer/hooks/slash-command/types.ts`

```typescript
/**
 * 斜杠命令参数定义
 */
export interface SlashCommandArgument {
  /** 参数名，如 'skillId' */
  name: string;
  /** 参数类型 */
  type: 'string' | 'enum' | 'rest';
  /** 是否必需 */
  required: boolean;
  /** 国际化 key，如 'slash.skill.install.arg.skillId' */
  descriptionKey: string;
  /** 枚举值列表（type === 'enum' 时使用） */
  enumValues?: string[];
  /** 输入占位文本（国际化 key） */
  placeholderKey?: string;
}

/**
 * 斜杠命令定义
 */
export interface SlashCommand {
  /** 命令名，如 'skill'（不含 /） */
  name: string;
  /** 命令名称的国际化 key，如 'slash.skill.name' */
  labelKey: string;
  /** 命令描述的国际化 key，如 'slash.skill.description' */
  descriptionKey: string;
  /** 图标名称（lucide-react 图标组件名） */
  icon?: string;
  /** 子命令列表 */
  subcommands?: SlashCommandSubcommand[];
  /** 无子命令时的直接参数列表 */
  arguments?: SlashCommandArgument[];
  /** 命令执行位置：local = 前端处理，ipc = 调用 api 层 */
  execution: 'local' | 'ipc';
}

/**
 * 斜杠子命令定义
 */
export interface SlashCommandSubcommand {
  /** 子命令名，如 'install' */
  name: string;
  /** 子命令名称的国际化 key */
  labelKey: string;
  /** 子命令描述的国际化 key */
  descriptionKey: string;
  /** 子命令参数 */
  arguments: SlashCommandArgument[];
  /** 执行位置 */
  execution: 'local' | 'ipc';
}

/**
 * 斜杠命令匹配结果（parseInput 返回值）
 */
export interface SlashCommandMatch {
  /** 匹配类型 */
  type: 'command' | 'subcommand' | 'argument' | 'none';
  /** 匹配到的命令（type 为 subcommand/argument 时有值） */
  command?: SlashCommand;
  /** 匹配到的子命令（type 为 argument 时有值） */
  subcommand?: SlashCommandSubcommand;
  /** 当前输入的查询文本（用于过滤） */
  query?: string;
  /** 已匹配的命令文本（用于补全替换） */
  matchedText?: string;
  /** 命令起始位置（文本替换的起始索引） */
  commandStart?: number;
  /** 当前填充的参数索引 */
  argumentIndex?: number;
}

/**
 * 菜单项（用于 SlashCommandMenu 渲染）
 */
export interface SlashCommandMenuItem {
  type: 'command' | 'subcommand';
  label: string;
  description: string;
  icon?: string;
  command: SlashCommand;
  subcommand?: SlashCommandSubcommand;
  /** 选中后要插入/替换的文本 */
  insertText: string;
}

/**
 * 命令执行结果
 */
export interface SlashCommandExecutionResult {
  success: boolean;
  /** 结果消息（显示在聊天中的文本） */
  message: string;
  /** 结构化数据（可选，用于富文本渲染） */
  data?: unknown;
  /** 错误信息 */
  error?: string;
}
```

### 2. 命令注册表

**文件**：`src/renderer/hooks/slash-command/slash-command-registry.ts`

```typescript
/**
 * 斜杠命令注册表（渲染进程单例）
 *
 * 职责：
 * - 管理所有已注册的斜杠命令
 * - 根据用户输入和光标位置查询匹配的命令/子命令
 * - 提供命令解析能力（parseInput）
 */
import type { SlashCommand, SlashCommandMatch } from './types';

class SlashCommandRegistry {
  private commands: Map<string, SlashCommand> = new Map();

  /** 注册单个命令 */
  register(command: SlashCommand): void {
    this.commands.set(command.name, command);
  }

  /** 批量注册 */
  registerAll(commands: SlashCommand[]): void {
    for (const cmd of commands) {
      this.register(cmd);
    }
  }

  /** 注销命令 */
  unregister(commandName: string): void {
    this.commands.delete(commandName);
  }

  /** 获取所有已注册命令（按名称排序） */
  getAllCommands(): SlashCommand[] {
    return Array.from(this.commands.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 获取指定命令 */
  getCommand(name: string): SlashCommand | undefined {
    return this.commands.get(name);
  }

  /**
   * 解析用户输入，返回匹配结果
   *
   * 解析规则：
   * 1. 光标所在行的文本以 "/" 开头
   * 2. "/" 前面只能是空行（允许前导空格/空行）
   * 3. 从 "/" 到当前光标位置的文本为解析对象
   *
   * 输入示例和对应输出：
   *   "/sk" cursor=3        → type:'command', query:'sk'
   *   "/skill " cursor=7    → type:'subcommand', command:skill, query:''
   *   "/skill in" cursor=9  → type:'subcommand', command:skill, query:'in'
   *   "/skill install " cursor=16 → type:'argument', subcommand:install, argumentIndex:0
   */
  parseInput(input: string, cursorPosition: number): SlashCommandMatch {
    // 找到光标所在行
    const lineStart = input.lastIndexOf('\n', cursorPosition - 1) + 1;
    const lineText = input.substring(lineStart, cursorPosition);

    // 检查行首是否有 /（忽略前导空格）
    const match = lineText.match(/^(\s*)\/(\S*)\s*(.*)?$/);
    if (!match) {
      return { type: 'none' };
    }

    const [, leadingSpace, commandName, rest] = match;

    // 确保光标在命令区域内（在命令名或后续部分）
    const slashIndex = lineStart + leadingSpace.length;
    if (cursorPosition <= slashIndex) {
      return { type: 'none' };
    }

    const command = this.getCommand(commandName);

    if (!command) {
      // 命令名未完全匹配，返回命令级过滤
      return {
        type: 'command',
        query: commandName,
        matchedText: `/${commandName}`,
        commandStart: slashIndex,
      };
    }

    // 命令已匹配，检查是否有子命令
    if (command.subcommands && command.subcommands.length > 0) {
      // 检查光标是否在命令名之后
      const fullCommandEnd = slashIndex + 1 + commandName.length;
      if (cursorPosition <= fullCommandEnd) {
        // 光标还在命令名上，返回命令级匹配
        return {
          type: 'command',
          query: commandName,
          matchedText: `/${commandName}`,
          commandStart: slashIndex,
        };
      }

      // 解析子命令
      const restParts = rest?.trimStart().split(/\s+/) ?? [];
      const subcommandName = restParts[0] ?? '';
      const subcommand = command.subcommands.find(
        (sc) => sc.name === subcommandName,
      );

      if (!subcommand) {
        // 子命令名未完全匹配，返回子命令级过滤
        return {
          type: 'subcommand',
          command,
          query: subcommandName,
          matchedText: `/${commandName} ${subcommandName}`,
          commandStart: slashIndex,
        };
      }

      // 子命令已匹配，检查参数
      const argsAfterSubcommand = restParts.slice(1);
      if (argsAfterSubcommand.length === 0 || (argsAfterSubcommand.length === 1 && argsAfterSubcommand[0] === '')) {
        return {
          type: 'argument',
          command,
          subcommand,
          argumentIndex: 0,
          matchedText: `/${commandName} ${subcommandName}`,
          commandStart: slashIndex,
        };
      }

      // 有参数内容，判断是正在输入第几个参数
      // rest 的光标相对位置
      const restStartInLine = fullCommandEnd + (rest?.length > 0 && rest[0] === ' ' ? 1 : 0);
      const argText = rest?.trimStart() ?? '';
      const nonEmptyArgs = argText.split(/\s+/).filter(Boolean);
      return {
        type: 'argument',
        command,
        subcommand,
        argumentIndex: Math.max(0, nonEmptyArgs.length - 1),
        matchedText: `/${commandName} ${subcommandName} ${argText}`,
        commandStart: slashIndex,
      };
    }

    // 无子命令的命令，直接处理参数
    return {
      type: 'command',
      command,
      matchedText: `/${commandName}`,
      commandStart: slashIndex,
    };
  }
}

export const slashCommandRegistry = new SlashCommandRegistry();
```

### 3. 内置 /skill 命令

**文件**：`src/renderer/hooks/slash-command/builtin-skill-commands.ts`

```typescript
import type { SlashCommand } from './types';

/**
 * 内置 /skill 命令定义
 *
 * 提供 5 个子命令，覆盖已安装技能管理和市场操作。
 * 所有子命令的 execution 为 'ipc'，通过 api 层调用已有通道。
 */
export const skillCommand: SlashCommand = {
  name: 'skill',
  labelKey: 'slash.skill.name',
  descriptionKey: 'slash.skill.description',
  icon: 'Wrench',
  execution: 'ipc',
  subcommands: [
    {
      name: 'list',
      labelKey: 'slash.skill.list.name',
      descriptionKey: 'slash.skill.list.description',
      arguments: [],
      execution: 'ipc',
    },
    {
      name: 'install',
      labelKey: 'slash.skill.install.name',
      descriptionKey: 'slash.skill.install.description',
      arguments: [
        {
          name: 'skillId',
          type: 'string',
          required: true,
          descriptionKey: 'slash.skill.install.arg.skillId',
          placeholderKey: 'slash.skill.install.arg.placeholder',
        },
      ],
      execution: 'ipc',
    },
    {
      name: 'uninstall',
      labelKey: 'slash.skill.uninstall.name',
      descriptionKey: 'slash.skill.uninstall.description',
      arguments: [
        {
          name: 'skillId',
          type: 'string',
          required: true,
          descriptionKey: 'slash.skill.uninstall.arg.skillId',
          placeholderKey: 'slash.skill.uninstall.arg.placeholder',
        },
      ],
      execution: 'ipc',
    },
    {
      name: 'info',
      labelKey: 'slash.skill.info.name',
      descriptionKey: 'slash.skill.info.description',
      arguments: [
        {
          name: 'skillId',
          type: 'string',
          required: true,
          descriptionKey: 'slash.skill.info.arg.skillId',
          placeholderKey: 'slash.skill.info.arg.placeholder',
        },
      ],
      execution: 'ipc',
    },
    {
      name: 'search',
      labelKey: 'slash.skill.search.name',
      descriptionKey: 'slash.skill.search.description',
      arguments: [
        {
          name: 'query',
          type: 'rest',
          required: true,
          descriptionKey: 'slash.skill.search.arg.query',
          placeholderKey: 'slash.skill.search.arg.placeholder',
        },
      ],
      execution: 'ipc',
    },
  ],
};
```

**初始化注册**（在 `index.ts` 中）：

```typescript
import { slashCommandRegistry } from './slash-command-registry';
import { skillCommand } from './builtin-skill-commands';

// 应用启动时注册内置命令
slashCommandRegistry.register(skillCommand);
```

### 4. useSlashCommand Hook

**文件**：`src/renderer/hooks/slash-command/useSlashCommand.ts`

```typescript
/**
 * useSlashCommand - 斜杠命令交互 hook
 *
 * 参照 useMentionSystem 的设计模式，实现：
 * - 输入检测（行首 / 前缀）
 * - 弹出列表过滤
 * - 键盘导航（ArrowUp/Down 移动、Tab 补全、Enter 执行、Esc 关闭）
 * - 文本替换和光标定位
 */

interface UseSlashCommandOptions {
  content: string;
  setContent: React.Dispatch<React.SetStateAction<string>>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onExecuteCommand?: (result: SlashCommandExecutionResult) => void;
}

interface UseSlashCommandResult {
  /** 是否显示命令菜单 */
  showCommandMenu: boolean;
  /** 菜单容器 ref（用于点击外部关闭） */
  commandMenuRef: React.RefObject<HTMLDivElement | null>;
  /** 当前过滤后的菜单项列表 */
  matchedCommands: SlashCommandMenuItem[];
  /** 当前选中的菜单项索引 */
  selectedIndex: number;
  /** 是否正在执行命令（用于禁用输入） */
  isExecuting: boolean;
  /** 文本变更处理函数 */
  handleTextChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  /** 键盘事件处理函数（返回 true 表示已消费） */
  handleSlashKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** 选中菜单项 */
  selectMenuItem: (item: SlashCommandMenuItem) => void;
}
```

**核心逻辑**：

1. **输入检测**：
   - 在 `handleTextChange` 中调用 `slashCommandRegistry.parseInput(content, cursorPosition)` 获取 `SlashCommandMatch`
   - 根据 `match.type` 计算 `matchedCommands` 菜单项列表
   - `type === 'command'`：从 `getAllCommands()` 中按 `query` 过滤
   - `type === 'subcommand'`：从 `match.command.subcommands` 中按 `query` 过滤
   - `type === 'argument'`：关闭菜单（参数由用户自由输入）
   - `type === 'none'`：关闭菜单

2. **过滤和菜单项生成**：
   - 命令数量有限（预计 < 50 条），不需要防抖，直接同步过滤
   - 过滤逻辑：命令名/子命令名的 `toLowerCase().includes(query.toLowerCase())`
   - 空查询时返回全部可用项

3. **键盘导航**（与 `useMentionSystem` 一致的拦截模式）：
   - `e.nativeEvent.isComposing` 时返回 `false`（不拦截输入法）
   - `ArrowDown`：`selectedIndex` 下移（循环）
   - `ArrowUp`：`selectedIndex` 上移（循环）
   - `Tab`：补全当前选中项的 `insertText`，调用 `selectMenuItem`
   - `Enter`：菜单可见时，如果 `type === 'argument'` 或参数已完整，执行命令；否则补全
   - `Escape`：关闭菜单
   - 返回 `boolean` 表示是否消费了按键事件

4. **补全逻辑**：
   - 使用 `textareaRef` 的 `setSelectionRange` 定位光标
   - `selectMenuItem` 中：计算 `content.substring(0, commandStart) + insertText + afterText`
   - 用 `setTimeout(() => textarea.focus())` 确保 React 状态更新后光标正确

5. **命令执行**：
   - Enter 在参数阶段（`type === 'argument'` 且参数已完整）时触发执行
   - 调用 `executeSlashCommand(trimmedInput)` 获取结果
   - 通过 `onExecuteCommand` 回调通知父组件
   - 执行期间 `isExecuting = true`，禁用输入

6. **点击外部关闭**：
   - `useEffect` 监听 `mousedown`，点击不在 `commandMenuRef` 内则关闭菜单
   - 与 `useMentionSystem` 的关闭逻辑模式一致

### 5. SlashCommandMenu 组件

**文件**：`src/renderer/components/chat/SlashCommandMenu.tsx`

```typescript
interface SlashCommandMenuProps {
  items: SlashCommandMenuItem[];
  selectedIndex: number;
  onSelect: (item: SlashCommandMenuItem) => void;
}
```

**样式规范**（与 MentionPopup 保持一致）：

- **定位**：`absolute bottom-full left-0 mb-2`（textarea 上方弹出）
- **容器**：`py-1 bg-popover border border-border rounded-lg shadow-lg min-w-[240px] max-h-[300px] overflow-y-auto z-50`
- **菜单项**：`px-3 py-2 flex items-center gap-2 text-sm transition-colors`
- **选中态**：`bg-primary/10 text-primary`
- **默认态**：`text-foreground hover:bg-secondary`
- **图标**：lucide-react 图标，`w-4 h-4 flex-shrink-0 text-muted-foreground`
- **名称**：`flex-1 text-left font-medium`
- **描述**：`text-xs text-muted-foreground truncate max-w-[160px]`
- **空状态**：居中显示 `t('slash.menu.noResults')`

**渲染内容**：
- 每个菜单项：图标 + 命令名（如 "skill"） + 描述文本
- 子命令项：缩进显示子命令名（如 "list"） + 描述文本
- 空列表：显示 "没有匹配的命令"

### 6. 命令执行器

**文件**：`src/renderer/hooks/slash-command/slash-command-executor.ts`

```typescript
/**
 * 斜杠命令执行器
 *
 * 职责：
 * - 解析完整的命令文本（如 "/skill list"）
 * - 路由到对应的处理函数
 * - local 命令在前端处理
 * - ipc 命令通过 api 层调用（自动适配 Electron/HTTP 双模式）
 * - 返回结构化执行结果
 */
import { api } from '../../api';
import { slashCommandRegistry } from './slash-command-registry';
import type { SlashCommandExecutionResult, SlashCommandMatch } from './types';
import { t } from '../../i18n';

interface ParsedCommand {
  commandName: string;
  subcommandName?: string;
  args: string[];
}

/**
 * 解析完整命令文本
 * 输入: "/skill install my-skill" → { commandName: 'skill', subcommandName: 'install', args: ['my-skill'] }
 */
function parseFullCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;

  const parts = trimmed.substring(1).split(/\s+/);
  const commandName = parts[0];
  if (!commandName) return null;

  const command = slashCommandRegistry.getCommand(commandName);
  if (!command) return null;

  if (command.subcommands && command.subcommands.length > 0) {
    const subcommandName = parts[1];
    if (!subcommandName) {
      return { commandName, args: [] };
    }
    const subcommand = command.subcommands.find((sc) => sc.name === subcommandName);
    if (!subcommand) {
      return { commandName, args: parts.slice(1) };
    }
    return {
      commandName,
      subcommandName,
      args: parts.slice(2),
    };
  }

  return { commandName, args: parts.slice(1) };
}

/**
 * 执行斜杠命令
 */
export async function executeSlashCommand(
  fullText: string,
): Promise<SlashCommandExecutionResult> {
  const parsed = parseFullCommand(fullText);
  if (!parsed) {
    return {
      success: false,
      message: t('slash.error.unknownCommand', { command: fullText }),
    };
  }

  const command = slashCommandRegistry.getCommand(parsed.commandName);
  if (!command) {
    return {
      success: false,
      message: t('slash.error.unknownCommand', { command: `/${parsed.commandName}` }),
    };
  }

  // 路由到 /skill 子命令执行器
  if (parsed.commandName === 'skill') {
    return executeSkillCommand(parsed);
  }

  // 未知命令
  return {
    success: false,
    message: t('slash.error.unknownCommand', { command: `/${parsed.commandName}` }),
  };
}

/**
 * 执行 /skill 子命令
 */
async function executeSkillCommand(parsed: ParsedCommand): Promise<SlashCommandExecutionResult> {
  const subcommand = parsed.subcommandName;

  switch (subcommand) {
    case 'list': {
      const result = await api.skillList();
      if (result.success && result.data) {
        const skills = result.data as ImportedSkill[];
        if (skills.length === 0) {
          return { success: true, message: t('slash.skill.list.empty') };
        }
        const list = skills.map((s) => `- ${s.spec.name} (${s.appId})`).join('\n');
        return {
          success: true,
          message: t('slash.skill.list.success', { count: skills.length, list }),
          data: skills,
        };
      }
      return { success: false, message: result.error ?? t('slash.error.executionFailed') };
    }

    case 'install': {
      const skillId = parsed.args[0];
      if (!skillId) {
        return {
          success: false,
          message: t('slash.error.missingArgument', { arg: 'skillId' }),
        };
      }
      const result = await api.skillInstall({ mode: 'market', skillId });
      if (result.success) {
        return { success: true, message: t('slash.skill.install.success', { name: skillId }) };
      }
      return { success: false, message: t('slash.skill.install.error', { error: result.error ?? 'Unknown' }) };
    }

    case 'uninstall': {
      const skillId = parsed.args[0];
      if (!skillId) {
        return {
          success: false,
          message: t('slash.error.missingArgument', { arg: 'skillId' }),
        };
      }
      const result = await api.skillUninstall(skillId);
      if (result.success) {
        return { success: true, message: t('slash.skill.uninstall.success', { name: skillId }) };
      }
      return { success: false, message: t('slash.skill.uninstall.error', { error: result.error ?? 'Unknown' }) };
    }

    case 'info': {
      const skillId = parsed.args[0];
      if (!skillId) {
        return {
          success: false,
          message: t('slash.error.missingArgument', { arg: 'skillId' }),
        };
      }
      // 优先尝试本地已安装技能详情，回退到市场详情
      const result = await api.skillMarketDetail(skillId);
      if (result.success && result.data) {
        const skill = result.data as any;
        const info = [
          `**${skill.name}** v${skill.version}`,
          skill.description ?? '',
          `Author: ${skill.author ?? 'Unknown'}`,
          skill.tags?.length ? `Tags: ${skill.tags.join(', ')}` : '',
        ].filter(Boolean).join('\n');
        return { success: true, message: info, data: skill };
      }
      return { success: false, message: result.error ?? t('slash.error.executionFailed') };
    }

    case 'search': {
      const query = parsed.args.join(' ');
      if (!query) {
        return {
          success: false,
          message: t('slash.error.missingArgument', { arg: 'query' }),
        };
      }
      const result = await api.skillMarketSearch(query);
      if (result.success && result.data) {
        const data = result.data as { skills: any[]; total: number };
        if (data.skills.length === 0) {
          return { success: true, message: t('slash.skill.search.noResults') };
        }
        const list = data.skills
          .slice(0, 10)
          .map((s) => `- **${s.name}**: ${s.description}`)
          .join('\n');
        return {
          success: true,
          message: t('slash.skill.search.results', { count: data.total, list }),
          data: data.skills,
        };
      }
      return { success: false, message: result.error ?? t('slash.error.executionFailed') };
    }

    default:
      return {
        success: false,
        message: t('slash.error.unknownSubcommand', { subcommand: subcommand ?? '' }),
      };
  }
}
```

**命令执行 → API 映射表**：

| 子命令 | API 调用 | 参数 | 说明 |
|--------|---------|------|------|
| `/skill list` | `api.skillList()` | 无 | 列出已安装技能 |
| `/skill install <id>` | `api.skillInstall({ mode: 'market', skillId })` | `skillId` | 从市场安装技能 |
| `/skill uninstall <id>` | `api.skillUninstall(skillId)` | `skillId` | 卸载技能 |
| `/skill info <id>` | `api.skillMarketDetail(skillId)` | `skillId` | 查看技能详情 |
| `/skill search <query>` | `api.skillMarketSearch(query)` | `query` | 搜索市场技能 |

### 7. 集成到 InputArea

**文件**：`src/renderer/components/chat/InputArea.tsx`

修改内容：

1. **新增 import**：
```typescript
import { useSlashCommand } from '../../hooks/slash-command/useSlashCommand';
import { SlashCommandMenu } from './SlashCommandMenu';
import type { SlashCommandExecutionResult } from '../../hooks/slash-command/types';
```

2. **在 InputAreaInternal 中使用 hook**（位于 `useMentionSystem` 下方）：
```typescript
const {
  showCommandMenu,
  commandMenuRef,
  matchedCommands,
  selectedIndex,
  isExecuting,
  handleTextChange: handleSlashTextChange,
  handleSlashKeyDown,
  selectMenuItem,
} = useSlashCommand({
  content,
  setContent,
  textareaRef,
  onExecuteCommand: handleCommandResult,
});
```

3. **修改 textarea 事件绑定**：

`onChange` -- 两个 hook 都需要处理文本变更，但只有行首 `/` 时才走斜杠命令逻辑。策略是两者都调用（互不干扰），因为内部各自检测自己的触发条件：

```typescript
const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
  handleMentionTextChange(e);
  handleSlashTextChange(e);
};
```

`onKeyDown` -- 按优先级拦截：

```typescript
const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
  // 1. Mention 系统优先（Hyper Space @agent）
  if (handleMentionKeyDown(e)) return;
  // 2. 斜杠命令系统
  if (handleSlashKeyDown(e)) return;
  // 3. 原有逻辑（Enter 发送、Esc 停止生成）
  if (e.key === 'Enter' && !e.shiftKey && !isMobile()) {
    e.preventDefault();
    handleSend();
  }
  if (e.key === 'Escape' && isGenerating) {
    e.preventDefault();
    onStop();
  }
};
```

4. **命令结果处理**：
```typescript
const handleCommandResult = (result: SlashCommandExecutionResult) => {
  // 清空输入框
  setContent('');
  // 将结果作为系统消息插入聊天
  // 通过 chat store 或 onSend 回调注入（具体方案见讨论）
};
```

5. **添加 SlashCommandMenu 组件**（紧邻 MentionPopup，在同一 `relative` 容器内）：

```tsx
{/* Slash Command Menu */}
{showCommandMenu && (
  <SlashCommandMenu
    ref={commandMenuRef}
    items={matchedCommands}
    selectedIndex={selectedIndex}
    onSelect={selectMenuItem}
  />
)}
```

6. **textarea 禁用状态**：命令执行中追加禁用：
```typescript
disabled={isOnboardingSendStep || isExecuting}
```

### 8. IPC 通道

本 PRD **不需要新增 IPC 通道**。`/skill` 的所有子命令复用已有的 skill IPC 通道：

| 子命令 | 复用的 IPC 通道 | 对应 preload 方法 |
|--------|---------------|-----------------|
| `/skill list` | `skill:list` | `window.aicoBot.skillList()` |
| `/skill install` | `skill:install` | `window.aicoBot.skillInstall(input)` |
| `/skill uninstall` | `skill:uninstall` | `window.aicoBot.skillUninstall(skillId)` |
| `/skill info` | `skill:market:detail` | `window.aicoBot.skillMarketDetail(skillId)` |
| `/skill search` | `skill:market:search` | `window.aicoBot.skillMarketSearch(query)` |

命令执行完全在渲染进程的 `slash-command-executor.ts` 中完成，通过现有的 `api.skillList()` 等方法调用，自动适配 Electron IPC 和远程 HTTP 双模式。

### 9. 模块导出入口

**文件**：`src/renderer/hooks/slash-command/index.ts`

```typescript
export type { SlashCommand, SlashCommandSubcommand, SlashCommandArgument, SlashCommandMatch, SlashCommandMenuItem, SlashCommandExecutionResult } from './types';
export { slashCommandRegistry } from './slash-command-registry';
export { executeSlashCommand } from './slash-command-executor';
export { useSlashCommand } from './useSlashCommand';
```

### 10. 国际化

**新增 i18n keys**（运行 `npm run i18n` 提取后翻译）：

```json
{
  "slash.menu.title": "斜杠命令",
  "slash.menu.noResults": "没有匹配的命令",

  "slash.skill.name": "技能管理",
  "slash.skill.description": "查看和管理已安装的技能",

  "slash.skill.list.name": "列出技能",
  "slash.skill.list.description": "显示所有已安装的技能",
  "slash.skill.list.empty": "当前没有已安装的技能",
  "slash.skill.list.success": "已安装 {{count}} 个技能：\n{{list}}",

  "slash.skill.install.name": "安装技能",
  "slash.skill.install.description": "从技能市场安装技能",
  "slash.skill.install.arg.skillId": "技能 ID",
  "slash.skill.install.arg.placeholder": "输入技能 ID",
  "slash.skill.install.success": "技能 \"{{name}}\" 安装成功",
  "slash.skill.install.error": "安装失败：{{error}}",

  "slash.skill.uninstall.name": "卸载技能",
  "slash.skill.uninstall.description": "卸载指定技能",
  "slash.skill.uninstall.arg.skillId": "技能 ID",
  "slash.skill.uninstall.arg.placeholder": "输入技能 ID",
  "slash.skill.uninstall.success": "技能 \"{{name}}\" 已卸载",
  "slash.skill.uninstall.error": "卸载失败：{{error}}",

  "slash.skill.info.name": "技能详情",
  "slash.skill.info.description": "查看技能详细信息",
  "slash.skill.info.arg.skillId": "技能 ID",
  "slash.skill.info.arg.placeholder": "输入技能 ID",

  "slash.skill.search.name": "搜索技能",
  "slash.skill.search.description": "在技能市场搜索技能",
  "slash.skill.search.arg.query": "搜索关键词",
  "slash.skill.search.arg.placeholder": "输入搜索关键词",
  "slash.skill.search.noResults": "未找到匹配的技能",
  "slash.skill.search.results": "找到 {{count}} 个技能：\n{{list}}",

  "slash.error.unknownCommand": "未知命令：{{command}}",
  "slash.error.unknownSubcommand": "未知子命令：{{subcommand}}",
  "slash.error.invalidSyntax": "命令格式不正确。用法：{{usage}}",
  "slash.error.missingArgument": "缺少必需参数：{{arg}}",
  "slash.error.executionFailed": "命令执行失败"
}
```

### 11. 边界条件与错误处理

| 场景 | 处理方式 |
|------|---------|
| 非行首的 `/` | `parseInput` 检查行首，不匹配则返回 `type: 'none'`，不弹出菜单 |
| 命令菜单打开时按 Enter | `handleSlashKeyDown` 拦截，执行补全而非发送消息 |
| 命令菜单打开时按 Esc | `handleSlashKeyDown` 拦截，关闭菜单而非停止生成 |
| 命令执行中 | `isExecuting = true`，textarea 禁用，防止重复执行 |
| IPC 调用失败 | `try/catch` 捕获，返回 `{ success: false, message: errorText }` |
| 参数缺失 | 执行前校验必需参数，缺失时返回提示消息 |
| 输入法组合输入（IME） | 检查 `e.nativeEvent.isComposing`，组合输入期间不拦截键盘事件 |
| 远程 Web 模式 | 命令执行器通过 `api` 层调用，自动适配 HTTP 模式 |
| `/` 后无内容 | `parseInput` 返回 `type: 'command', query: ''`，显示全部命令列表 |
| 已有 `@mention` 弹出时输入 `/` | 两个系统独立，`@` 弹出不受 `/` 影响（反之亦然） |

## 涉及文件

| # | 文件 | 改动类型 | 说明 |
|---|------|---------|------|
| 1 | `src/renderer/hooks/slash-command/types.ts` | 新增 | 斜杠命令类型定义 |
| 2 | `src/renderer/hooks/slash-command/slash-command-registry.ts` | 新增 | 命令注册表（注册、查询、解析输入） |
| 3 | `src/renderer/hooks/slash-command/slash-command-executor.ts` | 新增 | 命令执行器（解析完整命令文本、路由到 API 调用） |
| 4 | `src/renderer/hooks/slash-command/useSlashCommand.ts` | 新增 | 斜杠命令交互 hook（输入检测、键盘导航、补全） |
| 5 | `src/renderer/hooks/slash-command/builtin-skill-commands.ts` | 新增 | 内置 /skill 命令定义 |
| 6 | `src/renderer/hooks/slash-command/index.ts` | 新增 | 模块导出入口 |
| 7 | `src/renderer/components/chat/SlashCommandMenu.tsx` | 新增 | 斜杠命令下拉菜单 UI 组件 |
| 8 | `src/renderer/components/chat/InputArea.tsx` | 修改 | 集成 useSlashCommand hook + SlashCommandMenu 组件 |
| 9 | `src/renderer/i18n/locales/*.json` | 修改 | 新增斜杠命令相关的国际化文本 |
| 10 | `.project/modules/chat/chat-ui-v1.md` | 修改 | 模块变更记录追加 |
| 11 | `.project/modules/chat/features/input-area/changelog.md` | 修改 | 追加变更记录 |

## 开发前必读

### 模块设计文档

| # | 文档/文件 | 阅读目的 |
|---|---------|---------|
| 1 | `.project/modules/chat/features/input-area/design.md` | 理解输入框组件设计、现有 hook 集成方式、正常/异常流程 |
| 2 | `.project/modules/chat/features/input-area/changelog.md` | 了解输入框最近变更（useMentionSystem 提取等），避免回归 |
| 3 | `.project/modules/chat/features/input-area/bugfix.md` | 了解已知问题（MAX_IMAGES 等），避免踩坑 |
| 4 | `.project/modules/chat/chat-ui-v1.md` | 理解聊天模块整体架构、组件树、chat.store 职责 |
| 5 | `.project/modules/skill/skill-system-v1.md` | 理解技能模块概述、IPC 通道列表、内部组件关系 |
| 6 | `.project/modules/skill/features/skill-market/changelog.md` | 了解技能市场最近变更，确认 API 可用性 |

### 源码文件

| # | 文档/文件 | 阅读目的 |
|---|---------|---------|
| 7 | `src/renderer/hooks/useMentionSystem.ts` | 理解现有的弹出式交互 hook 设计模式（parseMentionPosition、键盘拦截、文本替换、关闭逻辑），作为 useSlashCommand 的参考 |
| 8 | `src/renderer/components/chat/InputArea.tsx` | 理解输入框组件结构、textarea 事件绑定、handleKeyDown 优先级、onSend 回调、MentionPopup 渲染位置 |
| 9 | `src/shared/skill/skill-types.ts` | 理解 InstalledSkill、SkillSpec、RemoteSkillItem 等类型定义，用于执行结果的格式化 |
| 10 | `src/main/ipc/skill.ts` | 理解已有的 skill IPC 通道签名（skill:list、skill:install 等），确认参数格式 |
| 11 | `src/preload/index.ts` | 确认 skill 相关的 preload API 暴露方式（Skill Management 区域） |
| 12 | `src/renderer/api/index.ts` | 确认渲染进程的 skill API 调用签名（api.skillList()、api.skillInstall() 等） |

### 编码规范

| # | 文档/文件 | 阅读目的 |
|---|---------|---------|
| 13 | `docs/Development-Standards-Guide.md` | 编码规范（TypeScript strict、禁止 any、纯类型导入、命名规范、i18n t() 使用） |
| 14 | `docs/vibecoding-doc-standard.md` | 文档管理规范（PRD 状态流转、changelog 更新规则） |

## 验收标准

- [x] 输入 `/` 时弹出斜杠命令下拉菜单，列出所有已注册命令（当前仅 skill）
- [x] 输入 `/sk` 时菜单过滤显示 `skill` 命令
- [x] 输入 `/skill `（带空格）时菜单展示子命令列表（list、install、uninstall、info、search）
- [x] 输入 `/skill in` 时菜单过滤显示 `install`、`info` 子命令
- [x] ArrowUp/ArrowDown 键可在候选列表中移动选中项（循环滚动）
- [x] Tab 键补全命令名/子命令名，并在末尾追加空格
- [x] Enter 键在菜单可见且选中项为命令/子命令时执行补全（不触发发送消息）
- [x] Enter 键在参数阶段时执行命令（`/skill list` 回车执行）
- [x] Esc 键在菜单可见时关闭菜单（不触发停止生成）
- [x] `/skill list` 执行后在聊天中显示已安装技能列表（格式化文本）
- [x] `/skill list` 无已安装技能时显示空提示
- [x] `/skill install <id>` 执行后触发安装流程，成功/失败结果反馈到聊天
- [x] `/skill uninstall <id>` 执行后卸载技能，结果反馈到聊天
- [x] `/skill info <id>` 执行后显示技能详情信息
- [x] `/skill search <query>` 执行后显示市场搜索结果（最多 10 条）
- [x] `/skill search` 无结果时显示空提示
- [x] 命令执行失败时显示友好的错误消息（非弹窗），不崩溃
- [x] 所有用户可见文本使用 `t()` 国际化
- [x] 行中间输入 `/` 不触发命令菜单（如 "hello /world"）
- [x] 命令菜单打开时原有 Enter 发送、Esc 停止的行为被正确拦截
- [x] 输入法组合输入期间不拦截键盘事件
- [x] 命令执行中输入框被禁用，防止重复执行
- [ ] 远程 Web 模式下斜杠命令功能正常（通过 HTTP API）（需人工验证）
- [x] 命令注册表支持通过 `register()` 动态添加新命令
- [x] 命令菜单的样式与 @Mention 弹窗保持一致（颜色、圆角、阴影、字体大小）
- [x] `npm run typecheck` 通过
- [x] `npm run lint` 通过
- [x] `npm run build` 通过
- [x] `npm run i18n` 无新增未翻译 key（已通过 i18n:extract 提取）

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-18 | 初始 PRD | @moonseeker1 |
