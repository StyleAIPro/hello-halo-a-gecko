面向 **TypeScript + React + Electron** 项目的编码规范。核心原则：**高内聚、低耦合**。面向 vibecoding 敏捷开发，保留保证可用性和可靠性的底线。

参考来源：electron-react-boilerplate、electron-vite、VS Code、GitHub Desktop 等主流开源项目。

------

# AICO-Bot 编码规范

## 1. 设计原则

### 1.1 高内聚

每个模块/文件/函数只做一件事，且相关的功能放在一起：

- 一个 service 只管一个业务域（`chat`、`space`、`config`）
- 一个组件只管一个 UI 单元（`MessageItem` 只渲染单条消息）
- 一个函数不超过 50 行，超过就拆

### 1.2 低耦合

模块之间通过明确的接口交互，不直接依赖内部实现：

- 渲染进程不直接 `import` 主进程代码（通过 `api/` 层 + IPC 通信）
- `shared/` 不依赖任何 Node/Electron 模块（纯类型和常量）
- 组件不直接调用 service，通过 store → api 隔离
- service 不依赖组件，通过 IPC 事件推送数据

### 1.3 依赖方向

```
pages → stores → api → (IPC) → ipc → services → platform
                                    ↓
                                shared/types + shared/constants
```

**单向依赖，禁止反向引用。** 渲染进程绝不导入主进程模块，services 不导入渲染进程模块。

------

## 2. 模块与文件设计

### 2.1 模块划分原则

```
src/
├── main/           # 主进程 — 每个目录/文件 = 一个职责边界
│   ├── ipc/        # IPC 传输层 — 只做参数校验和调用转发，不含业务逻辑
│   ├── services/   # 业务层 — 所有业务逻辑的唯一位置
│   ├── platform/   # 基础设施层 — 事件总线、存储、调度（与业务无关）
│   ├── controllers/# HTTP 控制器 — 适配 HTTP 协议，调用 services
│   ├── apps/       # 自动化平台 — 独立子系统
│   └── utils/      # 工具函数 — 无状态、纯函数
│
├── renderer/       # 渲染进程 — 每个目录 = 一个关注点
│   ├── pages/      # 页面 — 组合组件，不含 UI 细节
│   ├── components/ # 组件 — 只管渲染，不含业务逻辑
│   ├── stores/     # 状态 — 管理数据和状态流转
│   ├── hooks/      # Hooks — 抽离可复用的状态逻辑
│   └── api/        # 通信层 — 隔离 IPC/HTTP 实现细节
│
├── shared/         # 共享层 — 纯类型和常量，零副作用
└── preload/        # 桥接层 — 只做 IPC 通道映射
```

### 2.2 文件职责边界

| 层级 | 该做什么 | 不该做什么 |
|------|---------|-----------|
| `ipc/*.ts` | 接收参数 → 调用 service → 返回结果 | 不写业务逻辑 |
| `services/` | 业务逻辑、数据转换、外部 SDK 调用 | 不导入渲染进程代码 |
| `controllers/` | HTTP 请求 → 参数校验 → 调用 service | 不含业务逻辑 |
| `stores/` | 状态定义、状态更新方法 | 不直接调用 service（通过 api 层） |
| `components/` | UI 渲染、用户交互 | 不含业务逻辑、不直接调 IPC |
| `hooks/` | 可复用的有状态逻辑 | 不包含 JSX（UI 展示） |
| `api/` | IPC/HTTP 调用封装 | 不含状态管理 |

### 2.3 模块边界规则

```typescript
// ✓ 正确 — ipc 只做转发
ipcMain.handle('config:get', async () => {
  try {
    const data = await configService.getConfig()
    return { success: true, data }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
})

// ✗ 错误 — ipc 里写了业务逻辑
ipcMain.handle('config:get', async () => {
  const file = path.join(app.getPath('userData'), 'config.json')
  const raw = fs.readFileSync(file, 'utf-8')
  const config = JSON.parse(raw)  // ← 这应该放在 config.service.ts
  return config
})
```

------

## 3. 函数设计

### 3.1 单一职责

一个函数只做一件事。函数名应该准确描述它做什么：

```typescript
// ✓ 清晰 — 函数名即文档
function extractMentionedAgents(text: string): string[] { ... }
function formatTokenCount(tokens: number): string { ... }
function isConversationActive(session: SessionState): boolean { ... }

// ✗ 模糊 — 做了太多事
function processMessage(msg) { /* 解析、校验、存储、发送、更新 UI */ }
```

### 3.2 参数设计

- 参数不超过 4 个，超过就封装为对象
- 用类型定义参数结构，不用内联对象字面量

```typescript
// ✓ 参数对象 + 类型定义
interface SendMessageOptions {
  content: string
  conversationId: string
  attachments?: FileAttachment[]
  model?: string
}

async function sendMessage(options: SendMessageOptions): Promise<SendResult> { ... }

// ✗ 参数过多 + 无类型
async function sendMessage(content, convId, files, model, stream, timeout) { ... }
```

### 3.3 返回值设计

- 函数要么返回值，要么抛异常，不要两者混用
- 异步函数统一返回 `Promise<T>`，不要返回 `Promise<T | undefined>`

```typescript
// ✓ 明确的返回类型
async function getConfig(): Promise<SpaceConfig> { ... }

// ✗ 含糊 — 调用方不知道什么时候返回 undefined
async function getConfig(): Promise<SpaceConfig | undefined> { ... }
```

### 3.4 纯函数优先

不依赖外部状态的纯函数更容易测试和复用：

```typescript
// ✓ 纯函数 — 输入决定输出，无副作用
function truncateText(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) + '...' : text
}

// ✗ 依赖外部状态
function getTruncatedMessage(): string {
  return truncateText(currentMessage, MAX_LENGTH)  // currentMessage 是外部变量
}
```

------

## 4. 类型设计

### 4.1 严格模式

```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitReturns": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "forceConsistentCasingInFileNames": true
  }
}
```

### 4.2 类型使用规范

| 场景 | 规则 |
|------|------|
| 对象结构 | 用 `interface` |
| 联合类型 / 工具类型 | 用 `type` |
| 不确定的类型 | 用 `unknown` + 类型守卫，禁止 `any` |
| 纯类型导入 | 用 `import type { Foo }` |
| 函数参数 | 用 interface 定义参数对象 |

```typescript
// ✓ 类型守卫收窄 unknown
function parseResponse(data: unknown): Message {
  if (typeof data !== 'object' || data === null) throw new Error('Invalid response')
  if (!('content' in data)) throw new Error('Missing content')
  return data as Message
}

// ✗ 直接用 any
function parseResponse(data: any): Message { return data }
```

### 4.3 类型组织

```typescript
// ✓ 按业务域组织类型文件
// shared/types/space.ts
export interface Space { ... }
export interface SpaceConfig { ... }
export type SpaceStatus = 'active' | 'archived'

// shared/types/conversation.ts
export interface Conversation { ... }
export interface Message { ... }

// shared/types/index.ts — 统一导出
export type { Space, SpaceConfig } from './space'
export type { Conversation, Message } from './conversation'
```

每个业务域一个类型文件，`index.ts` 统一导出。不要把所有类型堆在一个巨型文件里。

------

## 5. 组件设计

### 5.1 组件分层

```
pages/          → 页面级组件，组合子组件，处理路由参数
  ↓
components/     → 功能组件（chat/、settings/ 等），可复用
  ├── ui/       → 基础 UI 原子组件（Button、Input、Modal）
  ├── chat/     → 聊天域组件（ChatView、MessageList）
  └── layout/   → 布局组件（Sidebar、Header）
```

上层依赖下层，下层不知道上层的存在。

### 5.2 组件职责分离

```typescript
// ✓ 正确 — 组件只管渲染，逻辑在 Hook 里
function MessageList({ conversationId }: Props) {
  const { messages, isLoading } = useMessages(conversationId)

  if (isLoading) return <Spinner />
  return <div>{messages.map(msg => <MessageItem key={msg.id} message={msg} />)}</div>
}

// ✗ 错误 — 组件里直接调 API、写业务逻辑
function MessageList({ conversationId }: Props) {
  const [messages, setMessages] = useState([])
  useEffect(() => {
    api.getMessages(conversationId).then(setMessages)  // ← 应该抽到 Hook
  }, [conversationId])
  // ...
}
```

### 5.3 Props 设计

```typescript
// ✓ 用 interface 定义 Props，命名用 `XxxProps`
interface MessageItemProps {
  message: Message
  isStreaming?: boolean
  onRetry?: () => void
}

export function MessageItem({ message, isStreaming, onRetry }: MessageItemProps) { ... }
```

------

## 6. 状态管理设计（Zustand）

### 6.1 按功能域拆分

```typescript
// stores/chat.store.ts — 只管聊天相关状态
export const useChatStore = create<ChatState>((set, get) => ({
  messages: new Map<string, Message[]>(),
  streamingMessages: new Map<string, Message>(),

  addMessage: (convId, msg) => set(state => ({
    messages: new Map(state.messages).set(convId, [...(state.messages.get(convId) ?? []), msg]),
  })),
}))

// stores/space.store.ts — 只管空间相关状态
export const useSpaceStore = create<SpaceState>((set) => ({
  spaces: [],
  currentSpaceId: null,
  // ...
}))
```

**禁止创建全局 God Store**。每个 store 只管自己的域。

### 6.2 Store 与组件的关系

```
组件 → 读取 store → 渲染 UI
组件 → 用户交互 → 调用 api → api 调 IPC → IPC 调 service → service 返回 → api 更新 store → 组件重渲染
```

组件不直接更新 store 的业务数据（如发送消息），而是调用 `api` 层，由后端处理完后再通过 store 更新。

------

## 7. IPC 通信设计

### 7.1 通信架构

```
渲染进程                        桥接                        主进程
┌──────────┐  api.xxx()  ┌──────────┐  ipcRenderer.invoke  ┌──────────┐
│ 组件     │ ──────────► │ preload  │ ──────────────────► │ ipc/     │ ───► services/
│ stores   │ ◄────────── │          │ ◄────────────────── │ handler  │ ◄───
└──────────┘   on event   └──────────┘   ipcRenderer.on     └──────────┘
```

### 7.2 IPC 通道常量化

```typescript
// shared/constants/ipc-channels.ts
export const IPC_CHANNELS = {
  AGENT_SEND: 'agent:send-message',
  AGENT_STOP: 'agent:stop',
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]
```

禁止硬编码字符串。新增通道必须先加到常量文件。

### 7.3 IPC Handler 统一结构

所有 handler 必须遵循相同模式：

```typescript
ipcMain.handle(IPC_CHANNELS.CONFIG_GET, async () => {
  try {
    const data = await configService.getConfig()
    return { success: true, data }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[Config IPC] ${IPC_CHANNELS.CONFIG_GET} failed:`, message)
    return { success: false, error: message }
  }
})
```

**三点不可缺**：try/catch、`{ success, data/error }` 结构、错误日志。

### 7.4 Preload 最小暴露

```typescript
// ✓ 只暴露具体方法
contextBridge.exposeInMainWorld('aicoBot', {
  getConfig: () => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_GET),
})

// ✗ 禁止暴露原始 ipcRenderer
contextBridge.exposeInMainWorld('electron', { ipcRenderer })  // ❌
```

------

## 8. 错误处理设计

### 8.1 分层错误处理

| 层级 | 策略 |
|------|------|
| IPC handler | try/catch → 返回 `{ success: false, error: message }` |
| 渲染进程 api 层 | 检查 `result.success`，失败时展示提示 |
| Service 层 | 抛出有意义的 Error（带上下文信息） |
| 进程级兜底 | `uncaughtException` + `unhandledRejection` |
| 渲染进程 | ErrorBoundary 包裹关键组件 |

### 8.2 错误信息规范

```typescript
// ✓ 有上下文的错误信息
throw new Error(`Failed to load space ${spaceId}: config file not found`)

// ✗ 无意义的错误
throw new Error('Error')
throw new Error('Something went wrong')
```

### 8.3 不要吞掉错误

```typescript
// ✗ 错误被吞掉
try {
  await saveConfig(config)
} catch (e) {
  // 什么都不做
}

// ✓ 至少记录日志
try {
  await saveConfig(config)
} catch (error) {
  logger.error('Failed to save config:', error)
  throw error  // 或者展示用户提示
}
```

------

## 9. 命名规范

| 类别 | 规则 | 示例 |
|------|------|------|
| 文件夹 | kebab-case | `remote-ws/`、`ai-browser/` |
| React 组件 | PascalCase | `ChatView.tsx`、`MessageItem.tsx` |
| Service | kebab-case + `.service.ts` | `config.service.ts` |
| Store | kebab-case + `.store.ts` | `chat.store.ts` |
| Hook | camelCase + `use` 前缀 | `useMessages.ts` |
| 接口/类型 | PascalCase，不加 `I` 前缀 | `interface SpaceConfig` |
| 函数/变量 | camelCase，动词开头 | `sendMessage`、`isLoading` |
| 常量 | UPPER_SNAKE_CASE | `MAX_RETRY_COUNT` |
| 布尔值 | `is`/`has`/`should` 前缀 | `isLoading`、`hasPermission` |

------

## 10. 代码风格

### 10.1 工具链

代码质量由 TypeScript strict 模式和 electron-vite 构建保证，无需额外 lint/format 工具。

```bash
npm run typecheck    # 类型检查
```

### 10.2 格式规范（团队约定，无工具强制执行）

```json
{
  "semi": true,
  "trailingComma": "all",
  "singleQuote": true,
  "printWidth": 100,
  "tabWidth": 2
}
```

### 10.3 UI 国际化

所有用户可见文本必须使用 `t()`，英文是源语言：

```tsx
<Button>{t('Save')}</Button>   // ✓
<Button>Save</Button>          // ✗ 硬编码破坏国际化
```

### 10.4 Tailwind 样式

使用 CSS 变量主题色，禁止硬编码色值：

```tsx
<div className="bg-background text-foreground">   // ✓
<div className="bg-white text-black">             // ✗
```

------

## 11. Git 提交规范

Conventional Commits（中文描述）：`<type>(<scope>): <中文简述>`

| 前缀 | 用途 | 示例 |
|------|------|------|
| `feat:` | 新功能 | `feat(ipc): 添加 IPC 通道常量定义` |
| `fix:` | 修 bug | `fix(chat): 修复重连后消息不显示的问题` |
| `docs:` | 文档 | `docs: 更新项目结构说明` |
| `style:` | 格式 | `style: 统一代码格式` |
| `refactor:` | 重构 | `refactor(agent): 拆分发送消息逻辑为独立模块` |
| `perf:` | 性能 | `perf(chat): 聊天列表改为虚拟滚动` |
| `chore:` | 构建/工具 | `chore: 升级 electron-vite 到 2.0` |

------

## 附录：快速参考

```bash
npm run typecheck    # 类型检查
npm run lint         # ESLint 检查
npm run format       # Prettier 格式化
npm run build        # 完整构建
```
