# 功能 — 技能市场

> 日期：2026-04-16（初始）→ 2026-04-18（全面重写）
> 指令人：@moonseeker1
> 所属模块：modules/skill/skill-system-v1

## 描述

提供技能市场的浏览、搜索、安装功能。用户可从内置源（skills.sh）、GitHub 仓库、GitCode 仓库浏览和安装技能，也可将本地技能推送至 GitHub/GitCode 远程仓库。

## 依赖

- `skill-market-service` — 市场服务后端（编排层、缓存、配置）
- `github-skill-source` — GitHub API 调用层
- `gitcode-skill-source` — GitCode API 调用层（含速率限制、代理）
- `skill.controller.ts` — IPC handler（桥接层）
- `skill.store.ts` — 前端 Zustand 状态
- `SkillMarket.tsx` — 市场页面 UI

---

## 架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                        渲染进程 (Renderer)                       │
│                                                                  │
│  SkillMarket.tsx ──► skill.store.ts ──► api/index.ts             │
│  (UI 组件)          (Zustand 状态)      (双模式 IPC/HTTP)         │
│                                                  │               │
└──────────────────────────────────────────────────┼───────────────┘
                                                   │ IPC invoke
                                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  preload/index.ts ──► window.aicoBot.xxx()                      │
│  (IPC Bridge + 事件监听)                                           │
└──────────────────────────────────────────────────────────────────┘
                                                   │ ipcMain.handle
                                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  skill.controller.ts ──► SkillMarketService                      │
│  (IPC Handler)            (编排 / 缓存 / 配置)                    │
│                                │                                 │
│                    ┌───────────┼───────────┐                     │
│                    ▼           ▼           ▼                     │
│           GitHubSkill   GitCodeSkill  skills.sh                  │
│           Source        Source        (HTML 抓取)                 │
│           Service       Service                                 │
└──────────────────────────────────────────────────────────────────┘
```

---

## 数据模型

### 核心类型 (`src/shared/skill/skill-types.ts`)

| 类型 | 用途 | 关键字段 |
|------|------|---------|
| `RemoteSkillItem` | 远程技能项 | `id`, `name`, `description`, `version`, `author`, `tags`, `sourceId`, `githubRepo`, `githubPath` |
| `SkillMarketSource` | 市场源配置 | `id`, `name`, `type`(builtin/github/gitcode/custom), `url`, `enabled`, `repos?` |
| `SkillMarketConfig` | 顶层配置 | `sources[]`, `activeSourceId` |

### Skill ID 格式

| 源类型 | ID 格式 | 示例 |
|--------|---------|------|
| skills.sh | `skills.sh:<owner>/<repo>/<skillName>` | `skills.sh:anthropic/claude-code/commit` |
| GitHub | `github:<owner>/<repo>:<fullPath>` | `github:user/skills:/commit/SKILL.md` |
| GitCode | `gitcode:<owner>/<repo>:<fullPath>` | `gitcode:user/skills:/commit/SKILL.md` |

> **注意**：`RemoteSkillItem.githubRepo` 和 `RemoteSkillItem.githubPath` 字段名对 GitCode 源也使用，这是历史命名遗留。

### 内置源

```typescript
const BUILTIN_SOURCES = [
  { id: 'skills.sh', name: 'Skills.sh', type: 'builtin', url: 'https://skills.sh', enabled: true }
];
```

### 配置持久化

- 路径：`<agentsSkillsDir>/../skill-market-config.json`
- 启动时从磁盘加载，与内置源合并
- 源增删改后立即保存

---

## IPC 通道清单

### Invoke 通道（渲染 → 主）

| 通道 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `skill:market:list` | `page?, pageSize?` | `{ success, data: { skills, total, hasMore } }` | 获取市场技能列表 |
| `skill:market:search` | `query, page?, pageSize?` | `{ success, data: { skills, total, hasMore } }` | 搜索技能 |
| `skill:market:detail` | `skillId` | `{ success, data: RemoteSkillItem }` | 获取技能详情 |
| `skill:market:sources` | 无 | `{ success, data: sources[], activeSourceId }` | 获取所有源 + 当前活跃源 |
| `skill:market:add-source` | source 对象 | `{ success, data: SkillMarketSource }` | 添加源 |
| `skill:market:remove-source` | `sourceId` | `{ success }` | 删除源 |
| `skill:market:toggle-source` | `{ sourceId, enabled }` | `{ success }` | 启用/禁用源 |
| `skill:market:set-active` | `sourceId` | `{ success }` | 设置活跃源 |
| `skill:market:push-to-github` | `skillId, targetRepo, targetPath?` | `{ success, prUrl?, error? }` | 推送技能到 GitHub |
| `skill:market:push-to-gitcode` | `skillId, targetRepo, targetPath?` | `{ success, mrUrl?, error? }` | 推送技能到 GitCode |
| `skill:market:validate-repo` | `repo` | `{ success, data: { valid, hasSkillsDir, skillCount } }` | 验证 GitHub 仓库 |
| `skill:market:validate-gitcode-repo` | `repo` | `{ success, data: { valid, hasSkillsDir?, skillCount? } }` | 验证 GitCode 仓库 |
| `skill:market:list-repo-dirs` | `repo` | `{ success, data: string[] }` | 列出 GitHub 仓库目录 |
| `skill:market:list-gitcode-repo-dirs` | `repo` | `{ success, data: string[] }` | 列出 GitCode 仓库目录 |
| `skill:market:set-gitcode-token` | `token` | `{ success }` | 设置 GitCode Token |

### Event 通道（主 → 渲染）

| 通道 | 数据 | 说明 |
|------|------|------|
| `skill:market:fetch-progress` | `{ phase, current, total }` | 获取进度 |

> **废弃/死代码**：`skill:market:skill-found`、`skill:market:fetch-complete`、`skill:market:fetch-error` 三个通道在 preload 和 transport 层注册了监听，但主进程从未发送过这些事件。这是流式加载方案回退后的遗留。

---

## 实现逻辑

### 1. 技能列表获取（核心流程）

```
用户切换源 → setActiveMarketSource(sourceId)
    │
    ├── 后端: skill:market:set-active → 保存 activeSourceId
    │
    └── 前端: loadSkills(1, true)
         │
         ├── skills.sh 源 → fetchFromSkillsShWithInfiniteScroll()
         │    └── 抓取 https://skills.sh 首页 HTML
         │        └── 正则解析 <a class="grid grid-cols-[auto_1fr_auto]"> 提取技能
         │
         ├── GitHub 源 → fetchFromGitHubRepo(source, page, pageSize)
         │    ├── 首次调用（无缓存）：
         │    │   └── 遍历 source.repos[]
         │    │       └── githubSkillSource.listSkillsFromRepo(repo, token, sendProgress)
         │    │           ├── Phase 1: findSkillDirs(repo, path, token, maxDepth=5)
         │    │           │   └── 递归扫描目录，查找含 SKILL.md 的文件夹
         │    │           │       → onProgress(phase='scanning', current, total)
         │    │           └── Phase 2: 并行获取每个目录的 SKILL.md 元数据
         │    │               → onProgress(phase='fetching-metadata', current, total)
         │    └── 后续调用：从内存缓存分页
         │
         └── GitCode 源 → fetchFromGitCodeRepo(source, page, pageSize)
              ├── 首次调用（无缓存）：
              │   ├── resetProxyDispatcher() // 刷新代理
              │   └── 遍历 source.repos[]
              │       └── gitcodeSkillSource.listSkillsFromRepo(repo, token, sendProgress)
              │           ├── 路径为 skills/ → listSkillsDir() (单层列表，不递归)
              │           ├── 路径为根 / → findSkillDirs(repo, path, token, maxDepth=3)
              │           │   └── 递归扫描，onProgress 仅顶层报告
              │           └── Phase 2: 批量获取元数据（经 RateLimiter + Semaphore）
              └── 后续调用：从内存缓存分页
```

### 2. 速率限制（GitCode 专用）

```
API 请求
    │
    ▼
withConcurrency(fn)
    │
    ├── RateLimiter.acquire()   ← 令牌桶限速
    │   ├── 检查最小间隔 (1s)
    │   ├── 等待令牌 (50 上限)
    │   └── 令牌补充速率: 1 token / 1.2s
    │
    └── Semaphore.acquire()     ← 并发控制 (max 3)
        │
        └── 执行 API 调用
```

| 参数 | 值 | 说明 |
|------|-----|------|
| `RATE_LIMIT_MAX_TOKENS` | 50 | 令牌桶上限 |
| `RATE_LIMIT_MIN_INTERVAL_MS` | 1000 | 任意两次请求最小间隔 |
| `RATE_LIMIT_REFILL_INTERVAL_MS` | 1200 | 令牌补充间隔 (≈ 50/min) |
| 初始令牌数 | 1 | 防止启动时突发 |
| `MAX_CONCURRENCY` | 3 | 并发信号量上限 |

**429 重试**：GitCode 返回 HTTP 429（或 400 + error_code 429）时，指数退避重试 3 次（2s → 4s → 8s）。

**遥测**：每 10 次请求打印一次统计（总请求数、限速等待次数、总等待时间）。

### 3. 进度报告

```
主进程                          渲染进程
────────                      ────────
listSkillsFromRepo()
  ├── onProgress(scanning, 1/20)
  ├── onProgress(scanning, 5/20)
  ├── ...
  ├── onProgress(fetching-metadata, 1/20)
  │       │
  │       ▼ webContents.send('skill:market:fetch-progress', data)
  │                     │
  │                     ▼ preload listener → transport.onEvent()
  │                                  │
  │                                  ▼ SkillMarket.tsx: setFetchProgress()
  │                                        │
  ├── onProgress(fetching-metadata, 10/20)  ▼ 显示进度 UI
  │       ...
  └── onProgress(fetching-metadata, 20/20)
          │
          ▼ fetch 完成 → store.marketSkills 更新 → UI 渲染列表
```

**进度 UI 行为**：
- scanning 阶段：显示 `(N)` — 已扫描目录数
- fetching-metadata 阶段：显示 `(N/M)` + 进度条 — 已获取/总计

> **注意**：GitHub 不受速率限制（认证后 5000 req/h），可并行获取，进度条可能快速前进；GitCode 受 50 req/min 限制，进度条匀速推进。

### 4. 技能搜索

| 源类型 | 搜索方式 | 说明 |
|--------|---------|------|
| skills.sh | 服务端搜索 | `GET https://skills.sh/api/search?q=<query>&limit=50` |
| GitHub | 客户端过滤 | 先触发全量获取，再按 name/description/author/tags 过滤 |
| GitCode | 客户端过滤 | 同 GitHub |

**缓存键**：`search:<query>` / `github-search:<sourceId>:<query>` / `gitcode-search:<sourceId>:<query>`

### 5. 技能安装

```
handleInstallToTarget(skillId, targets[])
    │
    ▼ api.skillInstallMulti({ skillId, targets })
        │
        ▼ 主进程: skill.controller.installSkillMulti
            │
            ├── skillMarket.downloadSkill(skillId)
            │   └── getSkillDetail(skillId) → { githubRepo, skillName, sourceType }
            │
            ├── GitCode 源:
            │   └── installSkillFromSource(repo, skillName, GITCODE_ADAPTER)
            │       ├── adapter.findSkillDirectoryPath()
            │       ├── adapter.fetchSkillDirectoryContents()
            │       └── 写入本地 + 生成 META.json
            │
            └── GitHub / skills.sh 源:
                ├── 优先: npx --yes skills add <repo> --skill <name> -y --global
                └── 降级: installSkillFromSource(repo, skillName, GITHUB_ADAPTER)
```

### 6. 技能推送（Push）

**GitHub 推送** (`pushSkillAsPR`)：
1. 获取当前用户 (`gh api user --jq .login`)
2. 检查是否 fork → 是则设 `prTargetRepo = parent`
3. 非 fork 且非协作者 → fork 仓库
4. 获取基础分支 SHA（尝试 `main`，回退 `master`）
5. 创建新分支
6. 逐文件提交（GitHub Contents API，PUT）
7. 创建 PR（`POST /repos/{prTargetRepo}/pulls`）
8. PR 创建失败时返回分支 URL（非致命）

**GitCode 推送** (`pushSkillAsMR`)：
1. 获取当前用户
2. 检查文件是否存在（决定 POST/PUT）
3. 检查是否 fork → 是则设 `mrTargetRepo = parent`
4. 非 fork → fork 仓库
5. 创建新分支
6. 逐文件提交（GitCode API，POST/PUT）
7. 创建 MR（`POST /repos/{mrTargetRepo}/pulls`）

### 7. 技能详情获取

| 源类型 | 详情获取方式 |
|--------|-------------|
| GitHub | `githubSkillSource.getSkillDetailFromRepo(repo, path)` |
| GitCode | `gitcodeSkillSource.getSkillDetailFromRepo(repo, path)` |
| skills.sh | 构造基础项，从 `raw.githubusercontent.com/<repo>/<branch>/<path>/SKILL.md` 或 `README.md` 获取内容（先 `main` 后 `master`） |

### 8. 缓存策略

- **内存缓存**：`Map<sourceId, RemoteSkillItem[]>`
- **搜索缓存**：`Map<cacheKey, RemoteSkillItem[]>`
- **不持久化**：每次应用重启重新获取
- **清除时机**：`resetCache(sourceId?)` 可清除特定或全部缓存

### 9. 前端状态管理

```
SkillMarket.tsx
    │
    ├── state
    │   ├── fetchProgress: { phase, current, total } | null  — 获取进度
    │   ├── activeSourceId: string  — 当前活跃源
    │   ├── skills / page / hasMore  — 分页状态
    │   ├── searchQuery / debouncedQuery  — 搜索状态
    │   └── selectedSkill  — 选中的技能
    │
    ├── useEffect (mount)
    │   ├── loadInstalledSkills()
    │   ├── loadServers()
    │   └── loadMarketSources().then(syncActiveSourceId)
    │
    ├── useEffect (query 变化)
    │   └── 重置 skills/page/hasMore → loadSkills(1, true)
    │
    └── handleScroll (无限滚动)
        └── 接近底部 → loadSkills(page + 1)
```

### 10. 源同步机制

```
组件挂载
    │
    ▼ loadMarketSources()
        │
        ▼ api.skillMarketSources()
            │
            ▼ 主进程: getMarketSources()
                │
                └── 返回 { sources[], activeSourceId }
                    │
                    ▼ store.marketSources = sources
                        │
                        ▼ find(enabled) || sources[0] → setActiveSourceId()
```

---

## 代理支持（GitCode 专用）

- 检查 `HTTPS_PROXY` / `HTTP_PROXY` / `https_proxy` / `http_proxy` 环境变量
- 使用 `undici.ProxyAgent` 建立代理
- `resetProxyDispatcher()` — 清除缓存代理（VPN 切换时使用）
- 每请求 30s 超时（`AbortController`）

---

## 涉及文件

| 文件 | 职责 |
|------|------|
| `services/skill/skill-market-service.ts` | 市场编排层：源管理、缓存、fetch 分发 |
| `services/skill/github-skill-source.service.ts` | GitHub API：目录扫描、元数据解析、PR 创建 |
| `services/skill/gitcode-skill-source.service.ts` | GitCode API：速率限制、代理、MR 创建 |
| `controllers/skill.controller.ts` | IPC handler：参数校验、调用 service、返回结果 |
| `renderer/components/skill/SkillMarket.tsx` | 市场 UI：源切换、技能列表、进度显示、安装 |
| `renderer/stores/skill/skill.store.ts` | Zustand store：状态管理、API 调用封装 |
| `renderer/api/index.ts` | 前端 API 层：双模式（IPC/HTTP）适配 |
| `renderer/api/transport.ts` | 事件路由：IPC 通道 → preload 方法映射 |
| `preload/index.ts` | IPC Bridge：暴露方法 + 注册事件监听 |
| `shared/skill/skill-types.ts` | 共享类型定义 |

---

## 已知问题

| # | 问题 | 严重程度 | 说明 |
|---|------|---------|------|
| 1 | ~~进度不准确 — 递归扫描进度卡顿~~ | Major | **已修复**：GitHub `findSkillDirs` 添加 `onProgress` 和 `scanned` 跟踪器 |
| 2 | ~~死代码事件通道~~ | Minor | **已修复**：移除 `skill:market:skill-found` / `fetch-complete` / `fetch-error` |
| 3 | ~~preload 重复定义~~ | Minor | **已修复**：移除重复的 `skillAnalyzeConversations` 等方法 |
| 4 | `githubPath` 命名误导 | Minor | GitCode 技能也使用 `githubRepo` / `githubPath` 字段名 |
| 5 | 无取消机制 | Minor | 长时间获取无法被用户中断 |
| 6 | 缓存不持久化 | Minor | 每次重启重新获取，GitCode 有速率限制会导致首次加载慢 |
| 7 | skills.sh HTML 抓取脆弱 | Major | 依赖特定 CSS 类名，网站改版会静默返回空结果 |
| 8 | ~~skills.sh 详情只尝试 main 分支~~ | Minor | **已修复**：`fetchSkillContent` 添加 `master` 分支回退 |
| 9 | ~~GitCode validateRepo 缺少 hasSkillsDir~~ | Minor | **已修复**：添加 `hasSkillsDir` 字段和 `skills/` 目录检测 |
| 10 | ~~`loadMarketSkills(sourceId)` 参数透传 bug~~ | Major | **已修复**：移除无用 `sourceId` 参数 |
| 11 | ~~快速切换源的竞态条件~~ | Minor | **已修复**：添加 `fetchGenerationRef` 丢弃过期结果 |
| 12 | ~~GitCode 进度不均匀（Promise.all 一次性完成）~~ | Major | **已修复**：改为顺序 `for...of` 循环，每个 skill 完成后报告进度 |
| 13 | ~~前端初始源选择与后端不一致~~ | Major | **已修复**：Store 同步后端 `activeSourceId`，组件 init 使用后端值 |
| 14 | ~~GitHub 元数据获取被误改为顺序化~~ | Minor | **已修复**：恢复 `Promise.all` 并行获取，减少请求延迟 |

## 变更
→ changelog.md
