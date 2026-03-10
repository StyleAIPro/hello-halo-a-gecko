# 共享终端重构实现总结

## 已完成的功能

### 1. 核心服务层

#### `shared-terminal-service.ts` - 共享终端核心服务
**文件**: `src/main/services/terminal/shared-terminal-service.ts`

功能：
- `SharedTerminalSession` 类：管理单个终端会话
  - 支持本地 PTY (`node-pty`) 和远程 SSH 终端
  - 输出缓冲区管理（最近 500 行）
  - 命令历史记录
  - 实时数据流发射

- `SharedTerminalService` 类：管理所有终端会话
  - 多会话并发支持
  - 按 `spaceId:conversationId` 标识会话
  - 统一的事件接口

关键方法：
```typescript
// 获取或创建会话
getOrCreateSession(sessionId, config): Promise<SharedTerminalSession>

// 执行命令（Agent 命令在真实终端执行）
executeCommand(command: string)

// 获取最近输出（供 Agent 查询）
getRecentOutput(lines: number): TerminalOutputLine[]

// 写入数据到终端
write(data: string)
```

---

### 2. 前端 Store

#### `agent-command.store.ts` - Agent 命令显示区 Store
**文件**: `src/renderer/stores/agent-command.store.ts`

功能：
- 只读显示 Agent 执行的命令
- 命令状态管理（pending/running/completed/error）
- 流式输出聚合
- 按 conversationId 隔离

状态结构：
```typescript
interface AgentCommandEntry {
  id: string
  command: string
  output: string
  exitCode: number | null
  status: 'pending' | 'running' | 'completed' | 'error'
  timestamp: string
  conversationId: string
}
```

---

### 3. 前端组件

#### `SharedTerminalPanel.tsx` - 共享终端面板
**文件**: `src/renderer/components/layout/SharedTerminalPanel.tsx`

布局：左右分栏
```
┌────────────────────────┬─────────────────────────┐
│  Agent Commands        │  Your Terminal          │
│  (只读，xterm.js)       │  (真实 PTY，可输入)      │
│                        │                         │
│  - 拦截 SDK 命令显示      │  - node-pty / SSH       │
│  - 真实 Terminal 样式     │  - 输出存储             │
│  - 滑动查看历史          │  - 可发送输出到对话     │
└────────────────────────┴─────────────────────────┘
```

功能：
- 左侧：Agent 命令只读显示
  - 使用 xterm.js 渲染
  - 真实 Terminal 样式（Dracula 主题）
  - 支持滑动查看历史命令

- 右侧：用户 Terminal
  - 真实 PTY 执行
  - 支持命令输入
  - 输出实时显示

- 工具栏：
  - Generate Skill
  - Send Output to Chat（发送到对话输入框）
  - Clear Agent Commands

---

### 4. MCP 工具

#### `terminal-tools.ts` - Agent 查询工具
**文件**: `src/main/services/terminal/terminal-tools.ts`

提供 3 个 MCP 工具供 Agent 调用：

1. **`get_terminal_output`**
   - 获取最近 N 行 Terminal 输出
   - 区分用户命令和 Agent 命令
   - 示例：
     ```
     Agent: "让我看看你刚才执行了什么命令"
     Tool: get_terminal_output(lines=50)
     ```

2. **`get_command_history`**
   - 获取命令历史列表
   - 可按 source（user/agent）过滤
   - 显示执行状态

3. **`clear_terminal`**
   - 清空输出缓冲区

---

### 5. IPC 接口

#### 新增接口

**Preload** (`src/preload/index.ts`):
```typescript
sendTerminalCommand: (spaceId, conversationId, command) => Promise<IpcResponse>
getTerminalOutput: (spaceId, conversationId, lines?) => Promise<IpcResponse>
```

**Main Process** (`src/main/ipc/system.ts`):
```typescript
ipcMain.handle('terminal:send-command', ...)
ipcMain.handle('terminal:get-output', ...)
```

**Renderer API** (`src/renderer/api/index.ts`):
```typescript
sendTerminalCommand: async (spaceId, conversationId, command)
getTerminalOutput: async (spaceId, conversationId, lines?)
```

---

### 6. 页面集成

#### `SpacePage.tsx`
- 导入 `SharedTerminalPanel`
- 替换旧的 `TerminalPanel`
- 保持 `showTerminal` 状态管理

---

## 架构设计

### 数据流

#### Agent 命令 → 用户显示
```
Agent 决定执行命令
    ↓
SDK 返回 tool_use (Bash)
    ↓
stream-processor.ts / send-message.ts 拦截
    ↓
terminalGateway.onAgentCommand() → 发送事件到前端
sharedTerminalService.executeCommand() → 在真实 PTY 执行
    ↓
┌───────────────────────────────────────┐
│ 前端 SharedTerminalPanel              │
│ 左侧：Agent Command Viewer (只读)      │
│ 右侧：User Terminal (真实执行)         │
└───────────────────────────────────────┘
```

#### 用户命令 → Agent 感知
```
用户在 Terminal 输入命令
    ↓
SharedTerminalPanel 发送 IPC → sendTerminalCommand
    ↓
terminalGateway.onUserCommand()
    ↓
写入真实 PTY 会话
    ↓
输出存储到 Session Buffer
    ↓
Agent 可通过 MCP 工具查询：
- get_terminal_output()
- get_command_history()
```

---

## SSH 远程终端支持

### 实现位置
`shared-terminal-service.ts` 中的 `startSSH()` 方法

### 工作流程
```typescript
1. 检测 space.remoteServerId
2. 获取 SSH 配置（需要从 remote-server 服务获取）
3. SSHManager.connect(sshConfig)
4. SSHManager.executeShell() 获取交互式 shell
5. 绑定 stdout/stderr 到事件发射器
```

### 注意事项
- 当前实现中 SSH 配置获取是 TODO
- 需要与 remote-server 服务集成
- 建议优先测试本地 PTY 功能

---

## 使用示例

### 1. 显示 Agent 命令
```typescript
// stream-processor.ts:440-451
if (blockState.toolName === 'Bash' && toolInput.command) {
  terminalGateway.onAgentCommand(
    spaceId,
    conversationId,
    command,
    '',  // Output will come via tool_result
    'running'
  )
}
```

### 2. 用户发送命令到 Terminal
```typescript
// Frontend
await api.sendTerminalCommand(spaceId, conversationId, 'ls -la')

// Main Process
terminalGateway.onUserCommand(spaceId, conversationId, 'ls -la')
```

### 3. Agent 查询 Terminal 输出
```typescript
// Agent 调用 MCP 工具
const result = await mcp.callTool('get_terminal_output', { lines: 50 })
// 返回最近 50 行 Terminal 输出
```

---

## 待完成的工作

### P0 - 核心功能
1. **Terminal Gateway 与 SharedTerminalService 集成**
   - 当前 `terminal-gateway.ts` 使用的是旧的 `terminalService`
   - 需要迁移到 `sharedTerminalService`
   - 确保 Agent 命令同时在左侧显示区和右侧真实终端执行

2. **SSH 配置获取**
   - 实现从 remote-server 服务获取 SSH 配置
   - 支持远程 Space 的 Terminal 连接

### P1 - 用户体验
3. **发送输出到对话的完整实现**
   - 当前 `handleSendOutputToChat` 是简化版本
   - 需要正确获取 xterm buffer 内容
   - 支持选择输出范围

4. **SpacePage 完整集成**
   - 测试 `SharedTerminalPanel` 替换 `TerminalPanel`
   - 确保状态管理正确
   - 处理 conversation 切换时的终端会话管理

### P2 - 增强功能
5. **命令历史持久化**
   - 当前存储在内存中
   - 建议存储到 SQLite
   - 支持跨会话查询

6. **Terminal 样式优化**
   - 优化左右分栏的宽度比例
   - 支持拖动分隔条
   - 支持独立最大化

---

## 文件清单

### 新增文件
- `src/main/services/terminal/shared-terminal-service.ts`
- `src/renderer/stores/agent-command.store.ts`
- `src/renderer/components/layout/SharedTerminalPanel.tsx`
- `src/renderer/components/layout/SharedTerminalPanel.css`
- `src/main/services/terminal/terminal-tools.ts`

### 修改文件
- `src/renderer/api/index.ts` - 添加 terminal API
- `src/preload/index.ts` - 添加 IPC 接口
- `src/main/ipc/system.ts` - 添加 IPC handler
- `src/renderer/pages/SpacePage.tsx` - 集成新组件

---

## 测试建议

### 单元测试
1. `SharedTerminalSession` - 测试 PTY 启动/写入/输出
2. `AgentCommandViewerStore` - 测试命令状态管理
3. `TerminalTools` - 测试 MCP 工具查询

### 集成测试
1. Agent 命令拦截 → 左侧显示 + 右侧执行
2. 用户输入 → PTY 执行 → Agent 查询
3. 多 conversation 切换 → 会话隔离

### 手动测试
1. 打开 Terminal Panel
2. 观察 Agent 执行命令
3. 手动输入命令
4. 点击"Send Output to Chat"
5. 测试 Agent 调用 `get_terminal_output`

---

## 技术栈
- **PTY**: `node-pty` (本地终端)
- **SSH**: `ssh2` (远程终端)
- **Terminal 渲染**: `@xterm/xterm` + `@xterm/addon-fit`
- **状态管理**: Zustand
- **IPC**: Electron IPC
- **MCP Tools**: `@modelcontextprotocol/sdk`

---

## 下一步行动

1. **立即修复**: 将 `terminal-gateway.ts` 迁移到使用 `sharedTerminalService`
2. **测试验证**: 运行应用，测试 Agent 命令显示和用户 Terminal
3. **SSH 集成**: 与 remote-server 服务对接，获取 SSH 配置
4. **完善功能**: 实现完整的"发送输出到对话"功能
