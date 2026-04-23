# 变更记录 -- 用户输入区域

| 日期 | 内容 | 指令人 | 触发来源 |
|------|------|--------|---------|
| 2026-04-16 | 初始设计 | @moonseeker1 | 新功能 |
| 2026-04-16 | BUG-001 修复：MAX_IMAGES 未定义导致崩溃，添加 export 和 import | @moonseeker1 | BUG修复 |
| 2026-04-16 | 重构：提取 useMentionSystem hook（@mention 自动补全、键盘导航、targetAgentIds 同步）；提取 useImageAttachments hook（粘贴/拖拽/选择、压缩、验证） | @moonseeker1 | 代码审计 |
| 2026-04-18 | 新增斜杠命令框架集成：useSlashCommand hook、SlashCommandMenu 组件、命令注册表、执行器；支持 /skill 系列 5 个子命令（list/install/uninstall/info/search） | @MoonSeeker | feature/slash-command-framework-v1 |
| 2026-04-21 | 新增输入历史翻阅：useInputHistory hook，上/下键浏览当前对话用户消息，支持草稿暂存、边界处理、与 mention/slash 系统兼容 | @moonseeker1 | feature/chat/input-history-v1 |
