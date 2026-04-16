# 变更记录 -- 工具编排与多代理团队

| 日期 | 内容 | 指令人 | 触发来源 |
|------|------|--------|---------|
| 2026-04-16 | 初始设计 | @moonseeker1 | 新功能 |
| 2026-04-16 | 重构：orchestrator 新增 updateTeamConfig() 深合并、getTeamMembers() 双源成员列表方法，IPC handler 改为薄代理；createHyperSpaceMcpServer 参数封装为 HyperSpaceMcpOptions；queueInjection、getOrCreateV2Session 调用方同步更新 | @moonseeker1 | 代码审计 |
