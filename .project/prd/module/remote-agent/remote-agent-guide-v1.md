# PRD [功能级] — Remote Agent 详解文档

> 版本：remote-agent-guide-v1
> 日期：2026-04-16
> 指令人：@moonseeker1
> 归属模块：modules/remote-agent

## 需求

在 `docs/` 下创建一份独立的 Remote Agent 完整技术文档 `docs/remote-agent-guide.md`，覆盖：

1. **系统概述**：Remote Agent 的定位、能力和适用场景
2. **架构全景**：本地 AICO-Bot ↔ SSH 隧道 ↔ 远程代理的完整通信链路
3. **核心组件**：remote-ws（WebSocket 客户端）、remote-ssh（SSH 隧道）、remote-deploy（部署管理）、remote-agent-proxy（远程代理服务）各自的职责和关键接口
4. **通信协议**：WebSocket 消息类型、格式、生命周期
5. **部署架构**：单机部署、多 PC 隔离、端口分配策略
6. **消息流**：远程聊天、会话恢复、中断、MCP Bridge 的完整数据流
7. **配置说明**：服务器配置字段、Space 配置、AI 模型选择
8. **故障排查**：常见问题和诊断方法

文档语言：中文。

## 约束

- 不修改任何代码
- 不修改已有功能的设计文档
- 文档基于现有代码实际情况编写，不包含规划中的功能

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始 PRD | @moonseeker1 |
| 2026-04-16 | 完成：创建 docs/remote-agent-guide.md 完整技术详解文档 | @moonseeker1 |
