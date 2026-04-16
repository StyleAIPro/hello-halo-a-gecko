# PRD [项目级] — AICO-Bot 可视化 AI Agent 桌面平台

> 版本：aico-bot-v1
> 日期：2026-04-16
> 指令人：@moonseeker1
> 上一版本：无

## 背景

AICO-Bot 是一个开源 Electron 桌面应用，将 Claude Code 的 AI Agent 能力封装为可视化跨平台界面。目标用户是不熟悉终端操作的开发者和非技术用户，使他们通过图形界面即可与 AI Agent 交互，完成代码编写、文件操作、自动化任务等工作。2.x 版本新增 Digital Humans 自动化平台，支持用户创建和管理定时运行的自动化 App。

核心问题：
- Claude Code 仅提供 CLI 交互方式，学习门槛高
- 缺乏可视化的对话管理和空间（工作区）管理
- 无法方便地在远程服务器上部署和运行 Agent
- 缺少可编排的自动化能力

## 需求列表

| # | 需求 | 指令人 | 状态 | 功能设计 |
|---|------|--------|------|---------|
| 1 | 核心 Chat Agent 功能：用户通过可视化界面与 AI Agent 对话，Agent 执行代码编写、文件操作等任务 | @moonseeker1 | 已完成 | modules/chat/features/{features} |
| 2 | 多工作空间（Space）管理：用户可创建多个独立工作区，每个空间绑定不同目录和配置 | @moonseeker1 | 已完成 | modules/space/features/{features} |
| 3 | 远程 Agent 支持：通过 SSH 隧道和 WebSocket 连接远程服务器上的 Agent，支持远程代码执行 | @moonseeker1 | 已完成 | modules/remote-agent/features/{features} |
| 4 | 多模型/多 AI 源支持：支持不同 AI Provider 和模型配置，用户可选择不同模型运行 Agent | @moonseeker1 | 已完成 | modules/agent/features/{features} |
| 5 | Digital Humans 自动化平台：用户可创建定时运行的自动化 App，支持事件触发、调度执行、通知推送 | @moonseeker1 | 已完成 | modules/automation/features/{features} |
| 6 | AI 浏览器自动化：Agent 可控制浏览器执行网页操作（点击、填表、截图等） | @moonseeker1 | 已完成 | modules/ai-browser/features/{features} |
| 7 | 技能（Skill）系统：用户可安装、管理、创建技能，扩展 Agent 能力 | @moonseeker1 | 已完成 | modules/agent/features/{features} |
| 8 | 国际化支持：支持 7 种语言（英、中简、中繁、日、法、西、德） | @moonseeker1 | 已完成 | — |
| 9 | 跨平台构建：支持 macOS（Universal）、Windows（x64 NSIS）、Linux（x64 AppImage） | @moonseeker1 | 已完成 | — |
| 10 | Hyper Space 多 Agent 编排：Leader-Worker 模式的多 Agent 协作系统 | @moonseeker1 | 已完成 | modules/automation/features/{features} |
| 11 | MCP 代理服务：为远程 Agent 会话暴露内置 MCP 工具（App 管理、GitHub 搜索等） | @moonseeker1 | 已完成 | modules/remote-agent/features/{features} |
| 12 | 通知渠道集成：支持邮件、企业微信、钉钉、飞书、Webhook 等通知推送 | @moonseeker1 | 已完成 | modules/automation/features/{features} |

## 驱动

-> architecture/electron-react-sdk-v1.md

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始项目级 PRD，涵盖 v2.0.2 全部功能 | @moonseeker1 |
