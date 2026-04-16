# 功能 — 页面无障碍快照（page-snapshot）

> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源 PRD：功能级文档生成
> 所属模块：modules/ai-browser/ai-browser-v1

## 描述

页面无障碍快照模块负责通过 CDP（Chrome DevTools Protocol）捕获页面的无障碍树（Accessibility Tree），并将其转换为结构化格式供 AI 消费。快照为每个页面元素分配唯一 UID，AI 可通过 UID 引用元素进行交互操作，无需理解 CSS 选择器或 DOM 结构。

核心能力：
- 通过 `Accessibility.getFullAXTree` CDP 命令获取完整无障碍树
- 将 CDP 节点转换为带 UID 的结构化树（`AccessibilityNode`）
- 格式化为文本供 AI 阅读（对齐 chrome-devtools-mcp 的 snapshotFormatter 格式）
- 带缓存的快照获取（500ms TTL + URL 匹配检测）
- 辅助操作：获取元素边界框、滚动到可见、聚焦元素

## 依赖

- `electron` — WebContents 及其 debugger API
- `./types` — AccessibilityNode、AccessibilitySnapshot 类型定义

## 实现逻辑

### 正常流程

1. **快照创建**：`createAccessibilitySnapshot(webContents, verbose, forceRefresh)`
   - 检查缓存（除非 `forceRefresh=true`），命中则直接返回
   - 附加 CDP debugger（v1.3），发送 `Accessibility.getFullAXTree` 命令
   - 构建 `cdpNodeMap`（nodeId -> CDPAXNode）用于快速查找
   - 从根节点（第一个非 ignored 且无 parentId 的节点）开始递归转换

2. **节点转换**：`convertNode(cdpNode)` 递归处理
   - **ignored 节点**：展开子节点，单子节点直接透传，多子节点包装为 `group`
   - **非 verbose 模式过滤**：仅保留交互角色（button、link、textbox 等 20 种）和结构角色（heading、img、table 等 25 种），以及有名称的节点；无名称的 generic 容器跳过
   - **属性提取**：从 CDP properties 数组提取 focused、checked、disabled、expanded、selected、required、level
   - **稳定 ID**：`generateStableId(role, name)` 生成跨快照匹配 ID（`role:name` 格式，截断 50 字符）
   - **UID 格式**：`{snapshotId}_{nodeIndex}`，如 `snap_1_42`

3. **快照对象**：`AccessibilitySnapshot` 包含
   - `root` — 根节点
   - `idToNode` — Map<uid, AccessibilityNode> 查找表
   - `url`、`title` — 页面信息
   - `format(verbose?)` — 格式化为文本

4. **文本格式化**：`formatSnapshot()` 对齐 chrome-devtools-mcp 的输出格式
   - 行格式：`uid=X role "name" [attributes]`
   - 属性映射：disabled -> disableable/disabled、expanded -> expandable/expanded 等
   - 缩进层级表示树结构

5. **缓存机制**：
   - 键：`{webContentsId}:{verbose}`
   - TTL：500ms
   - 失效条件：超时 或 URL 变化
   - 最大缓存：10 条（超过时 LRU 淘汰）
   - `invalidateSnapshotCache()` 在 DOM 修改操作后调用

6. **辅助操作**：
   - `getElementBoundingBox()` — CDP `DOM.getBoxModel` 获取元素四角坐标，计算 bounding box
   - `scrollIntoView()` — CDP `DOM.resolveNode` + `Runtime.callFunctionOn` 调用 `scrollIntoView({ block: 'center' })`
   - `focusElement()` — CDP `DOM.focus`

### 异常流程

1. **空无障碍树**：`Accessibility.getFullAXTree` 返回空数组时抛出 "Empty accessibility tree"
2. **Debugger 已附加**：`debugger.attach` 捕获异常静默处理
3. **元素边界框获取失败**：`DOM.getBoxModel` 返回空时返回 null，调用方需处理
4. **滚动/聚焦失败**：catch 后 console.error，不抛出异常
5. **缓存淘汰**：超过最大缓存时按时间排序保留最近 SNAPSHOT_CACHE_MAX_SIZE 条

## 涉及 API

无外部 API。通过 BrowserContext 的 `createSnapshot()` 方法被 SDK MCP 工具调用。

## 涉及数据

无持久化数据。运行时状态：
- `snapshotCache: Map<string, SnapshotCacheEntry>` — 全局快照缓存
- `snapshotCounter: number` — 快照 ID 计数器

## 变更
→ changelog.md
