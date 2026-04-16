# 功能 — 进程守护

> 日期：2026-04-16
> 指令人：@moonseeker1
> 所属模块：modules/health/health-monitor-v1

## 描述
监控 Agent 进程的存活状态，进程异常退出时触发自动恢复流程。

## 依赖
- health-checker（健康状态）

## 实现逻辑
### 正常流程
1. 监控 Agent 进程 PID
2. 检测进程存活状态
3. 异常退出时触发恢复

## 涉及文件
- `services/health/process-guardian/` — 进程守护
- `services/health/recovery-manager/` — 恢复管理

## 变更
→ changelog.md
