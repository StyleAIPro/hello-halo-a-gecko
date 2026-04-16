# PRD [模块级] — 清理 observability 和 notification 代码

> 版本：cleanup-observability-notification-v1
> 日期：2026-04-16
> 指令人：@moonseeker1
> 归属模块：codebase（跨模块代码清理）
> 关联 PRD：doc-module-merge-v1（文档删除已完成）

## 背景

PRD doc-module-merge-v1 已完成 observability 和 notification 两个模块的文档删除，但代码未同步清理。模块删除必须同时清理文档和代码，否则代码残留会增加维护负担并误导开发者。

## 需求

### 1. 删除 analytics 代码（6 文件）

删除 `src/main/services/analytics/` 整个目录。

**受影响上游引用：**
- `src/main/index.ts`：移除 `initAnalytics` 导入和调用
- `src/main/services/config.service.ts`：移除 `AnalyticsConfig` 类型导入（保留 config 中 analytics 字段作为纯数据，不主动使用）
- `src/preload/index.ts`：移除 `analytics:track` IPC 监听器
- `src/renderer/index.html`：移除 Baidu Tongji SDK 脚本

### 2. 删除 perf 代码（7 文件）

删除以下文件：
- `src/main/services/perf/` 整个目录（4 文件）
- `src/main/ipc/perf.ts`
- `src/renderer/stores/perf.store.ts`
- `src/renderer/lib/perf-collector.ts`

**受影响上游引用：**
- `src/main/bootstrap/extended.ts`：移除 `registerPerfHandlers` 导入和调用
- `src/preload/index.ts`：移除 perf 相关 10 个 API（perfStart/perfStop/perfGetState/perfGetHistory/perfClearHistory/perfSetConfig/perfExport/perfReportRendererMetrics/onPerfSnapshot/onPerfWarning）
- `src/renderer/api/transport.ts`：移除 `perf:snapshot` 和 `perf:warning` 事件映射
- `src/renderer/api/index.ts`：移除整个 Performance Monitoring API 段（~70 行）
- `src/renderer/App.tsx`：移除 `initPerfStoreListeners` 导入和调用

### 3. 删除外部通知渠道代码（8 文件）

**删除文件：**
- `src/main/services/notify-channels/` 整个目录（7 文件：index/email/wecom/dingtalk/feishu/webhook/token-manager）
- `src/main/ipc/notification-channels.ts`
- `src/main/apps/runtime/notify-tool.ts`
- `src/renderer/components/settings/NotificationChannelsSection.tsx`
- `src/shared/types/notification-channels.ts`

**保留并精简 `notification.service.ts`：**
- 保留：`notifyTaskComplete()`（系统级 OS 通知）、`notifyAppEvent()` 系统通知部分、`sendInAppToast()`（应用内 toast）
- 删除：`notifyExternalChannels()` 函数、`sendToChannels` 导入、`NotificationChannelType` 导入、`AppNotificationOptions.channels` 字段

**受影响上游引用：**
- `src/main/apps/runtime/execute.ts`：移除 `createNotifyToolServer` 导入和使用
- `src/main/apps/runtime/report-tool.ts`：移除 `NotificationChannelType` 导入，`notifyAppEvent` 调用移除 channels 参数
- `src/main/apps/runtime/service.ts`：`notifyAppEvent` 调用移除 channels 参数
- `src/main/apps/runtime/prompt.ts`：移除 `NOTIFICATION_INSTRUCTIONS` 段和引用
- `src/main/bootstrap/extended.ts`：移除 `registerNotificationChannelHandlers` 导入和调用
- `src/main/ipc/index.ts`：移除 `notification-channels` 导出
- `src/main/http/routes/index.ts`：移除 `testChannel/clearAllTokenCaches` 导入和两个 `/api/notify-channels/*` 端点
- `src/preload/index.ts`：移除 `testNotificationChannel` 和 `clearNotificationChannelCache` API
- `src/renderer/api/index.ts`：移除 `testNotificationChannel` 和 `clearNotificationChannelCache` API
- `src/renderer/components/settings/nav-config.ts`：移除 `notification-channels` 导航项
- `src/shared/types/index.ts`：移除 `notification-channels` 导出
- `src/shared/apps/spec-types.ts`：移除 `NotificationChannelType` 类型，`OutputNotifyConfig` 移除 `channels` 字段
- `src/renderer/types/index.ts`：移除 `NotificationChannelsConfig` 导入和使用

## 约束

- 保留系统通知功能（`notifyTaskComplete`、in-app toast）
- 保留 `notification:toast` IPC 事件（用于应用内 toast 通知）
- config 中 `analytics` 和 `notificationChannels` 字段保留为纯数据（不做迁移），仅移除代码层面的读取逻辑

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始 PRD | @moonseeker1 |
| 2026-04-16 | 完成：删除 analytics/perf/notify-channels 代码（~21 文件删除，~20 文件修改），更新 vibecoding 规范和 CLAUDE.md 新增模块删除同步清理规则 | @moonseeker1 |
