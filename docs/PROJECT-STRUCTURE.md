# AICO-Bot 项目代码结构

## 顶层目录

```
AICO-Bot/
├── src/                    # 源代码（核心）
│   ├── main/               # Electron 主进程（后端）
│   ├── renderer/           # React 前端（UI）
│   ├── shared/             # 前后端共享类型和常量
│   ├── preload/            # IPC 预加载桥接
│   └── worker/             # 文件监听子进程
├── packages/               # 独立子包
│   └── remote-agent-proxy/ # 远程代理 Node.js 服务
├── scripts/                # 构建/部署/运维脚本
├── tests/                  # 单元测试 + E2E 测试
├── resources/              # 图标等静态资源
├── docs/                   # 文档
├── patches/                # 依赖补丁
└── 配置文件
    ├── electron.vite.config.ts  # Vite 构建配置
    ├── tsconfig.json           # TypeScript 配置
    ├── package.json            # 依赖和脚本
    ├── tailwind.config.cjs     # Tailwind 样式配置
    ├── product.json            # 构建和认证配置
    └── i18next-parser.config.mjs # 国际化提取配置
```

---

## `src/main/` — Electron 主进程（后端）

所有业务逻辑、系统交互、Agent 对接都在这里。

### 入口与启动

```
main/
├── index.ts                # 应用入口，启动主进程
└── bootstrap/              # 两阶段启动
    ├── index.ts            # 启动调度器
    ├── state.ts            # 启动状态管理
    ├── essential.ts        # 第一阶段：同步初始化（<500ms）
    └── extended.ts         # 第二阶段：延迟初始化（ready-to-show 后）
```

**启动顺序**：`index.ts` → `bootstrap/essential.ts`（配置、IPC、窗口）→ `bootstrap/extended.ts`（分析、健康检查、后台服务）

### `services/` — 核心业务服务

```
services/
├── agent/                  # ★★★ Claude SDK 对接（最核心）
│   ├── index.ts            # Agent 服务入口
│   ├── send-message.ts     # 发送消息到 Claude
│   ├── orchestrator.ts     # 工具调用编排
│   ├── stream-processor.ts # 流式响应处理
│   ├── session-manager.ts  # 会话管理（创建/恢复）
│   ├── sdk-config.ts       # SDK 配置
│   ├── system-prompt.ts    # 系统提示词
│   ├── helpers.ts          # 辅助函数
│   ├── control.ts          # 中断/取消控制
│   ├── mailbox.ts          # 消息队列
│   ├── taskboard.ts        # 任务看板
│   ├── permission-handler.ts   # 权限处理
│   ├── permission-forwarder.ts # 权限转发
│   ├── persistent-worker.ts    # 持久化 Worker
│   ├── mcp-manager.ts      # MCP 工具管理
│   ├── hyper-space-mcp.ts  # Hyper Space MCP
│   ├── message-utils.ts    # 消息工具函数
│   └── types.ts            # Agent 类型定义
│
├── remote-ws/              # ★★ 远程 WebSocket 连接
│   ├── index.ts            # 服务入口
│   ├── remote-ws-client.ts # WebSocket 客户端
│   └── aico-bot-mcp-bridge.ts # MCP 桥接
│
├── remote-ssh/             # ★★ SSH 隧道
│   ├── index.ts
│   ├── ssh-tunnel.service.ts  # SSH 隧道建立
│   └── ssh-manager.ts         # SSH 连接管理
│
├── remote-deploy/          # 远程代理部署
│   ├── index.ts
│   └── remote-deploy.service.ts
│
├── conversation.service.ts # 聊天记录持久化
├── space.service.ts        # 工作空间管理
├── config.service.ts       # 应用配置管理
├── remote.service.ts       # 远程服务总入口
│
├── ai-browser/             # AI 浏览器控制
│   ├── index.ts            # 浏览器服务入口
│   ├── context.ts          # 浏览器上下文
│   ├── snapshot.ts         # 页面快照
│   ├── sdk-mcp-server.ts   # MCP 服务器
│   └── types.ts
│
├── ai-sources/             # AI 数据源（多模型接入）
│   ├── index.ts            # 服务入口
│   ├── manager.ts          # 数据源管理
│   ├── auth-loader.ts      # 认证加载
│   └── providers/          # 各模型 Provider 实现
│
├── gh-search/              # GitHub 搜索
├── mcp-proxy/              # MCP 代理服务
├── stealth/                # 浏览器隐身注入
│
├── artifact.service.ts     # Artifact 产物服务
├── artifact-cache.service.ts # Artifact 缓存
├── browser-view.service.ts # 浏览器视图管理
├── notification.service.ts # 通知服务
├── notify-channels/        # 通知渠道（邮件/钉钉/飞书等）
├── search.service.ts       # 搜索服务
├── overlay.service.ts      # 悬浮窗服务
│
├── git-bash.service.ts     # Git Bash 集成
├── git-bash-installer.service.ts # Git Bash 安装
├── github-auth.service.ts  # GitHub 认证
├── gitcode-auth.service.ts # GitCode 认证
│
├── analytics/              # 使用分析（默认关闭）
├── health/                 # 健康检查
├── perf/                   # 性能监控
├── terminal/               # 终端网关
├── skill/                  # 技能系统
├── updater.service.ts      # 应用更新
├── watcher-host.service.ts # 文件监听宿主
├── window.service.ts       # 窗口管理
├── protocol.service.ts     # 协议注册（aico://）
├── secure-storage.service.ts # 安全存储（加密）
├── api-validator.service.ts   # API 验证
├── onboarding.service.ts   # 新手引导
├── tunnel.service.ts       # 隧道服务
├── mock-bash.service.ts    # Mock Bash（测试用）
├── win32-hwnd-cleanup.ts   # Win32 窗口句柄清理
└── agent.service.backup.ts # （备份文件，可删除）
```

### `apps/` — Digital Humans 自动化平台

```
apps/
├── spec/                   # App 规范定义（Schema、类型）
├── manager/                # App 生命周期管理（安装/卸载/更新）
├── runtime/                # App 运行时引擎（执行/调度）
└── conversation-mcp/       # 对话式 MCP 集成
```

### `ipc/` — IPC 通道（前端调用后端的 API）

```
ipc/
├── index.ts                # IPC 注册入口
├── agent.ts                # Agent 操作
├── config.ts               # 配置读写
├── space.ts                # 工作空间操作
├── conversation.ts         # 对话管理
├── auth.ts                 # 认证
├── git-bash.ts             # Git Bash
├── github.ts               # GitHub
├── gitcode.ts              # GitCode
├── health.ts               # 健康检查
├── search.ts               # 搜索
├── skill.ts                # 技能
├── store.ts                # 存储
├── system.ts               # 系统操作
├── remote.ts               # 远程服务
├── remote-server.ts        # 远程服务器
├── browser.ts              # 浏览器
├── ai-browser.ts           # AI 浏览器
├── artifact.ts             # Artifact
├── overlay.ts              # 悬浮窗
├── onboarding.ts           # 新手引导
├── perf.ts                 # 性能
├── notification-channels.ts # 通知渠道
└── hyper-space.ts          # Hyper Space
```

### `platform/` — 底层基础设施

```
platform/
├── event-bus/              # 事件总线（进程间通信）
├── memory/                 # 记忆系统
├── scheduler/              # 定时任务调度
├── store/                  # 持久化存储
└── background/             # 后台守护进程
```

### `controllers/` — HTTP 控制器（远程访问时使用）

```
controllers/
├── index.ts                # 控制器注册
├── agent.controller.ts     # Agent HTTP API
├── app.controller.ts       # App HTTP API
├── config.controller.ts    # 配置 HTTP API
├── conversation.controller.ts # 对话 HTTP API
├── space.controller.ts     # 工作空间 HTTP API
├── skill.controller.ts     # 技能 HTTP API
└── store.controller.ts     # 存储 HTTP API
```

### `http/` — 远程访问 HTTP 服务

```
http/
├── server.ts               # HTTP 服务器
├── auth.ts                 # HTTP 认证
├── websocket.ts            # WebSocket 支持
└── routes/                 # 路由定义
```

### 其他

```
main/
├── openai-compat-router/   # OpenAI 兼容 API 路由
├── utils/
│   └── logger.ts           # 日志工具
└── store/                  # 主进程本地存储
```

---

## `src/renderer/` — React 前端（UI）

### 入口与页面

```
renderer/
├── main.tsx                # React 入口
├── App.tsx                 # 路由配置
├── index.html              # HTML 模板
├── overlay.html            # 悬浮窗 HTML
├── overlay-main.tsx        # 悬浮窗 React 入口
│
└── pages/                  # 页面组件（每个文件 = 一个路由页面）
    ├── HomePage.tsx            # 首页
    ├── HomePage-dialog-part.tsx # 首页对话框部分
    ├── SpacePage.tsx           # ★★★ 聊天主页面
    ├── AppsPage.tsx            # 自动化 App 管理页
    ├── SettingsPage.tsx        # 设置页面
    ├── RemoteAgentChatPage.tsx # 远程 Agent 聊天页
    ├── RemoteServersPage.tsx   # 远程服务器管理页
    └── skill/
        └── SkillPage.tsx       # 技能页面
```

### `stores/` — Zustand 状态管理（全局状态）

```
stores/
├── chat.store.ts           # ★★★ 聊天状态（最核心）
├── space.store.ts          # 工作空间状态
├── app.store.ts            # App 运行状态
├── apps.store.ts           # App 列表状态
├── apps-page.store.ts      # App 页面 UI 状态
├── ai-browser.store.ts     # AI 浏览器状态
├── canvas.store.ts         # 画布状态
├── terminal.store.ts       # 终端状态
├── user-terminal.store.ts  # 用户终端状态
├── agent-command.store.ts  # Agent 命令状态
├── notification.store.ts   # 通知状态
├── onboarding.store.ts     # 新手引导状态
├── perf.store.ts           # 性能状态
├── search.store.ts         # 搜索状态
└── skill/
    └── skill.store.ts      # 技能状态
```

### `api/` — 前后端通信层

```
api/
├── index.ts                # api.xxx() 方法汇总
└── transport.ts            # 传输层（自动选择 IPC 或 HTTP）
```

**工作原理**：`transport.ts` 检测运行环境（Electron 或 Web），Electron 下走 IPC，Web 下走 HTTP+WebSocket。

### `components/` — UI 组件

```
components/
├── chat/                   # ★★★ 聊天相关组件
│   ├── ChatView.tsx            # 聊天主视图
│   ├── MessageList.tsx         # 消息列表
│   ├── MessageItem.tsx         # 单条消息
│   ├── InputArea.tsx           # 输入区域
│   ├── ConversationList.tsx    # 对话列表
│   ├── MarkdownRenderer.tsx    # Markdown 渲染
│   ├── ThinkingBlock.tsx       # 思考过程展示
│   ├── ThoughtProcess.tsx      # 思维链展示
│   ├── WorkerPanel.tsx         # Worker 面板
│   ├── PermissionRequestDialog.tsx # 权限请求弹窗
│   ├── AskUserQuestionCard.tsx # 用户问题卡片
│   └── tool-result/            # 工具调用结果展示
│
├── apps/                   # 自动化 App 组件
│   ├── AppList.tsx             # App 列表
│   ├── AppInstallDialog.tsx    # 安装弹窗
│   ├── AppChatView.tsx         # App 聊天视图
│   ├── AppConfigPanel.tsx      # App 配置面板
│   ├── ActivityThread.tsx      # 活动记录
│   └── SessionDetailView.tsx   # 会话详情
│
├── ui/                     # 通用基础组件（按钮/输入框/弹窗等）
├── layout/                 # 布局组件（侧边栏/顶栏/面板）
├── icons/                  # 图标组件
├── brand/                  # 品牌组件（Logo 等）
├── settings/               # 设置页组件
├── space/                  # 工作空间组件
├── skill/                  # 技能组件
├── artifact/               # Artifact 展示组件
├── canvas/                 # 画布组件
├── diff/                   # 代码 Diff 组件
├── search/                 # 搜索组件
├── notification/           # 通知组件
├── onboarding/             # 新手引导组件
├── splash/                 # 启动画面
├── setup/                  # 安装向导
├── pulse/                  # 脉冲动画
├── store/                  # 商店组件
├── tool/                   # 工具组件
├── updater/                # 更新组件
├── ErrorBoundary.tsx       # 错误边界
├── TerminalOutput.tsx      # 终端输出
├── ToolCallDisplay.tsx     # 工具调用展示
├── remote-agent-chat.tsx   # 远程 Agent 聊天
├── remote-agent-terminal.tsx # 远程 Agent 终端
├── remote-file-browser.tsx # 远程文件浏览器
└── remote-task-panel.tsx   # 远程任务面板
```

### 其他前端目录

```
renderer/
├── hooks/                  # React 自定义 Hooks
│   ├── useAsyncHighlight.ts    # 异步高亮
│   ├── useCanvasLifecycle.ts   # 画布生命周期
│   ├── useIsMobile.ts          # 移动端检测
│   ├── useLayoutPreferences.ts # 布局偏好
│   ├── useLazyVisible.ts       # 懒加载可见性
│   ├── useSearchShortcuts.ts   # 搜索快捷键
│   └── useSmartScroll.ts       # 智能滚动
│
├── i18n/                   # 国际化（7 种语言）
├── services/               # 前端服务层
├── utils/                  # 前端工具函数
├── constants/              # 前端常量
├── lib/                    # 第三方库封装
├── types/                  # 前端类型定义
├── assets/                 # 静态资源（CSS/图片）
└── overlay/                # 悬浮窗组件
```

---

## `src/shared/` — 前后端共享

```
shared/
├── types/                  # ★ TypeScript 类型定义
│   ├── index.ts
│   └── ...                 # 所有数据结构接口（Space, Conversation, App 等）
├── constants/              # 共享常量
├── interfaces/             # 共享接口
├── protocol/               # 通信协议定义
├── skill/                  # 技能相关共享类型
├── apps/                   # App 相关共享类型
├── store/                  # 存储相关共享类型
└── file-changes.ts         # 文件变更类型
```

---

## `packages/` — 独立子包

```
packages/
└── remote-agent-proxy/     # 远程代理服务器（独立 Node.js 应用）
    └── ...                 # 可单独部署，提供远程 Agent 访问能力
```

---

## 数据流向

```
用户操作
  │
  ▼
renderer/pages/          (页面组件)
  │
  ▼
renderer/stores/         (Zustand 状态更新)
  │
  ▼
renderer/api/            (调用 api.xxx() 方法)
  │
  ├─ Electron 模式 ──► preload/ ──► main/ipc/   (IPC 通道)
  │
  └─ 远程 Web 模式 ─► HTTP + WebSocket ──► main/http/ ──► main/controllers/
  │
  ▼
main/services/           (执行业务逻辑)
  │
  ▼
main/platform/           (基础设施：存储/事件/调度)
  │
  ▼
返回结果 ──► sendToRenderer() ──► stores 更新 ──► 页面重新渲染
```

---

## 添加新功能的标准路径

### 添加新页面
1. `src/renderer/pages/XxxPage.tsx` — 创建页面
2. `src/renderer/App.tsx` — 添加路由
3. `src/renderer/stores/xxx.store.ts` — 状态管理（如需要）

### 添加新 IPC API
1. `src/main/ipc/xxx.ts` — 定义 IPC handler
2. `src/main/services/xxx.service.ts` — 实现业务逻辑
3. `src/preload/index.ts` — 暴露给前端
4. `src/renderer/api/transport.ts` — 添加到 methodMap
5. `src/renderer/api/index.ts` — 导出为 api.xxx()

### 添加新后端服务
1. `src/main/services/xxx/` — 服务目录
2. `src/main/bootstrap/extended.ts` — 注册初始化（如需要）

---

## 关键文件速查

| 你想... | 看这个文件 |
|---------|-----------|
| 理解聊天怎么工作 | `src/renderer/stores/chat.store.ts` |
| 理解 Agent 怎么对接 | `src/main/services/agent/index.ts` |
| 理解前后端怎么通信 | `src/renderer/api/transport.ts` |
| 理解应用怎么启动 | `src/main/bootstrap/index.ts` |
| 理解消息发送流程 | `src/main/services/agent/send-message.ts` |
| 理解远程连接 | `src/main/services/remote-ws/remote-ws-client.ts` |
| 理解工作空间 | `src/main/services/space.service.ts` |
| 理解自动化 App | `src/main/apps/runtime/` |
| 添加新 IPC 通道 | `src/main/ipc/xxx.ts` |
| 添加新页面 | `src/renderer/pages/XxxPage.tsx` |
| 添加共享类型 | `src/shared/types/` |
