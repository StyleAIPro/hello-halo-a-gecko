# 变更记录 -- 工具编排与多代理团队

| 日期 | 内容 | 指令人 | 触发来源 |
|------|------|--------|---------|
| 2026-04-16 | 初始设计 | @moonseeker1 | 新功能 |
| 2026-04-16 | 重构：orchestrator 新增 updateTeamConfig() 深合并、getTeamMembers() 双源成员列表方法，IPC handler 改为薄代理；createHyperSpaceMcpServer 参数封装为 HyperSpaceMcpOptions；queueInjection、getOrCreateV2Session 调用方同步更新 | @moonseeker1 | 代码审计 |
| 2026-04-22 | bugfix: Leader 禁用 SDK 内置 Agent/Task 工具（additionalDisallowedTools）；Leader 系统提示改为完全禁止 Agent 工具；基础系统提示弱化 Task 工具鼓励措辞 | @misakamikoto | bugfix-excessive-subagents-v1 |
| 2026-04-22 | bugfix: Worker 内部 SDK 子 agent 的 worker:started/completed 事件被前端过滤（stream-processor.ts 增加 workerTag 判断），消除多余 Worker Tab | @misakamikoto | bugfix-excessive-subagents-v2 |
| 2026-04-23 | bugfix: 系统提示词新增编译/测试/lint 子 Agent 禁令（NEVER spawn sub-agent for build/test/lint），防止模型为编译测试创建多余子 Agent | @misakamikoto | bugfix-excessive-subagents-v3 |
| 2026-04-27 | bugfix: 普通对话全面禁用 Agent/Task 工具（send-message.ts 添加 additionalDisallowedTools）；系统提示词移除所有 Task/Agent 鼓励语句，禁令扩展为全面覆盖；远程 App Runtime 补齐 disallowedTools；删除 prompt.ts SUB_AGENT_INSTRUCTIONS | @misakamikoto | bugfix-excessive-subagents-v4 |
