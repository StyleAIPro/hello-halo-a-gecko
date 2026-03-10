# Shared Terminal Feature Design

## 概述

实现一个人机共用的 Terminal 界面，用于远程空间对话场景：
- **实时显示** Agent 执行的所有命令和输出
- **允许用户** 在 Terminal 中手动执行命令帮助 Agent
- **双向感知** Agent 可以看到用户的操作，用户可以看到 Agent 的操作
- **Skill 生成** 任务完成后自动生成可复用的 Skill

## 架构设计

```
┌──────────────────────────────────────────────────────────────┐
│  Frontend (React)                                            │
│  ┌────────────────┐    ┌────────────────────────────────┐   │
│  │  Chat Panel    │    │  Terminal Panel (新增)          │   │
│  │                │    │  ┌──────────────────────────┐  │   │
│  │  - 对话流       │    │  │  Terminal Output        │  │   │
│  │  - 思考过程     │◄──►│  │  $ agent_command        │  │   │
│  │                │    │  │  output...              │  │   │
│  │                │    │  │  $ user_command (可输入) │  │   │
│  └────────────────┘    │  └──────────────────────────┘  │   │
│                        └────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
                            │
                            │ WebSocket (remote-ws-client)
                            │  - terminal:stream (Agent → UI)
                            │  - terminal:input (User → Agent)
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  Remote Server (remote-agent-proxy)                          │
│  ┌────────────────┐    ┌────────────────────────────────┐   │
│  │ claude-manager │    │  PTY Service (新增)            │   │
│  │                │    │  - node-pty                    │   │
│  │  - 拦截 Bash   │    │  - shell session               │   │
│  │    tool_use    │───►│  - 命令输出流                   │   │
│  └────────────────┘    └────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

## 数据流

### 1. Agent 命令 → Terminal 显示

```
Agent 决定执行命令
    │
    ▼
SDK 返回 tool_use (Bash)
    │
    ▼
claude-manager.ts 拦截
    │
    ▼
发送 terminal:stream 事件 (通过 WebSocket)
    │
    ▼
前端 Terminal Panel 显示命令和执行结果
```

### 2. 用户输入 → Agent 感知

```
用户在 Terminal 输入命令
    │
    ▼
前端发送 terminal:input 事件
    │
    ▼
WebSocket 传输到远程服务器
    │
    ▼
claude-manager 将命令注入上下文
    │
    ▼
Agent 在下一轮对话中感知用户操作
```

### 3. Skill 生成

```
任务完成
    │
    ▼
用户点击"生成 Skill"
    │
    ▼
分析 Terminal 历史和人机协作过程
    │
    ▼
生成可复用的 Skill (Markdown/JSON)
    │
    ▼
保存到 Skill 库
```

## 技术实现

### 前端组件

1. **TerminalPanel.tsx** - Terminal 界面组件
   - 使用 xterm.js 作为 Terminal 渲染引擎
   - 支持命令输出（只读）和用户输入（可编辑）
   - 区分 Agent 命令和用户命令的样式

2. **Terminal Store** - 状态管理
   - terminal.store.ts
   - 管理命令历史、输出缓冲区、连接状态

3. **IPC/API** - 通信接口
   - `terminal:stream` - Agent 命令流
   - `terminal:input` - 用户输入
   - `terminal:history` - 获取历史记录

### 后端服务

1. **PTY Service** (remote-agent-proxy)
   - 使用 `node-pty` 创建伪终端
   - 管理 shell session
   - 流式输出命令结果

2. **Claude Manager 扩展**
   - 拦截 Bash tool_use
   - 转发命令到 PTY
   - 收集输出并流式返回

3. **WebSocket 协议扩展**
   ```typescript
   // 新消息类型
   type TerminalMessage =
     | { type: 'terminal:stream', data: { command: string, output: string, source: 'agent' } }
     | { type: 'terminal:input', data: { command: string, source: 'user' } }
     | { type: 'terminal:history', data: { commands: CommandHistory[] } }
   ```

### 数据库设计

**Terminal History 表**
```sql
CREATE TABLE terminal_history (
  id TEXT PRIMARY KEY,
  space_id TEXT,
  conversation_id TEXT,
  command TEXT,
  output TEXT,
  source TEXT,  -- 'agent' | 'user'
  timestamp TEXT,
  exit_code INTEGER
)
```

## 实现步骤

1. [ ] 添加 xterm.js 依赖
2. [ ] 创建 TerminalPanel 组件
3. [ ] 实现 terminal.store.ts
4. [ ] 扩展 WebSocket 协议
5. [ ] 实现 PTY Service
6. [ ] 修改 Claude Manager 拦截 Bash 命令
7. [ ] 实现用户命令注入上下文
8. [ ] 实现 Terminal History 持久化
9. [ ] 实现 Skill 生成功能

## UI 设计

```
┌──────────────────────────────────────────────────┐
│  Terminal                              [_][□][×] │
├──────────────────────────────────────────────────┤
│  Last login: Tue Mar  4 12:00:00 on ttys000     │
│  Welcome to Ubuntu 22.04 LTS                    │
│                                                  │
│  [AGENT] cd /home/project                       │
│  [AGENT] npm install                            │
│           ⠧ Installing...                       │
│           ✓ 125 packages installed              │
│  [USER]  ls -la                                 │
│          total 1234                             │
│          drwxr-xr-x ...                         │
│  [AGENT] Great! Now let me check the config...  │
│                                                  │
│  $ _                                            │
└──────────────────────────────────────────────────┘
```

## 注意事项

1. **安全性**: 用户命令执行需要权限控制
2. **性能**: 大量输出需要节流和虚拟滚动
3. **同步**: Agent 和用户命令的时序需要正确管理
4. **上下文**: 用户命令需要被 Agent 感知并用于后续决策
