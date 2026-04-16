# 功能 — 终端网关

> 日期：2026-04-16
> 指令人：@moonseeker1
> 所属模块：modules/terminal/terminal-service-v1

## 描述
管理终端子进程的生命周期，提供终端创建、输出流管理和进程终止能力。支持本地和远程终端会话。

## 依赖
- 无（底层模块）

## 实现逻辑
### 正常流程
1. 接收终端创建请求
2. spawn 子进程（bash/cmd/ssh）
3. 通过 WebSocket 或 IPC 转发终端输出
4. 进程退出时通知前端

### 异常流程
1. 子进程异常退出 → 记录日志，通知前端
2. 远程连接断开 → 标记会话为断开状态

## 涉及文件
- `services/terminal/terminal.service.ts` — 终端服务主入口
- `services/terminal/terminal-gateway.ts` — 终端进程网关
- `services/terminal/terminal-tools.ts` — SDK 终端工具
- `services/terminal/terminal-output-store.ts` — 输出缓存
- `services/terminal/terminal-history-store.ts` — 历史记录
- `services/terminal/shared-terminal-service.ts` — 共享终端服务

## 变更
→ changelog.md
