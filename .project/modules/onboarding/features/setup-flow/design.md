# 功能 — 初始化配置流程

> 日期：2026-04-16
> 指令人：@moonseeker1
> 所属模块：modules/onboarding/onboarding-v1

## 描述
应用首次启动的初始化配置流程，包括 API 密钥配置和 Git Bash 环境检测。

## 依赖
- settings 模块（配置保存）
- ai-sources 模块（API 认证）
- git-bash.service（Git Bash 检测）

## 实现逻辑
1. 引导用户配置 API 密钥
2. 检测 Git Bash 安装状态
3. 未安装时提供安装引导
4. 完成后标记初始化完成

## 涉及文件
- `services/git-bash.service.ts` — Git Bash 服务
- `services/git-bash-installer.service.ts` — Git Bash 安装器
- `renderer/components/setup/SetupFlow.tsx` — 初始化流程
- `renderer/components/setup/ApiSetup.tsx` — API 配置
- `renderer/components/setup/GitBashSetup.tsx` — Git Bash 安装
- `renderer/components/setup/GitBashWarningBanner.tsx` — 警告横幅
- `renderer/components/setup/LoginSelector.tsx` — 登录方式选择

## 变更
→ changelog.md
