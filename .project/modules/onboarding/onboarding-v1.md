# 模块 — 引导与初始化 onboarding-v1

> 版本：onboarding-v1
> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源架构：无（初始版本）

## 职责

管理首次使用引导和应用初始化流程，包括新手引导（Spotlight 高亮提示）、API 配置流程、Git Bash 安装检测等。确保用户能快速上手应用。

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    Onboarding Module                             │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐     │
│  │ onboarding     │  │  setup-flow   │  │  git-bash.service  │     │
│  │ .service.ts    │  │  (初始化流程) │  │  (Git Bash 检测)   │     │
│  │ (引导服务)      │ │               │ │                     │     │
│  └──────────────┘  └──────────────┘  └────────────────────┘     │
│                                                                  │
│  引导组件:                                                       │
│  ├── OnboardingOverlay (引导覆盖层)                              │
│  ├── Spotlight (聚焦高亮)                                        │
│  ├── SetupFlow (初始化流程)                                      │
│  ├── ApiSetup (API 配置)                                         │
│  ├── GitBashSetup (Git Bash 安装)                                │
│  └── LoginSelector (登录方式选择)                                │
└─────────────────────────────────────────────────────────────────┘

外部依赖:
  → settings 模块（配置保存）
  → ai-sources 模块（API 认证）
```

## 对外接口

### IPC Handle 通道

| 方法 | 通道名 | 输入 | 输出 | 说明 |
|------|--------|------|------|------|
| getOnboardingState | `onboarding:get-state` | 无 | `{ success, data }` | 获取引导状态 |
| completeOnboarding | `onboarding:complete` | 无 | `{ success }` | 完成引导 |
| getGitBashStatus | `git-bash:status` | 无 | `{ success, data }` | Git Bash 安装状态 |
| installGitBash | `git-bash:install` | 无 | `{ success }` | 安装 Git Bash |

## 内部组件

| 组件 | 职责 | 文件 |
|------|------|------|
| onboarding.service | 引导流程管理 | `services/onboarding.service.ts` |
| git-bash.service | Git Bash 检测与安装 | `services/git-bash.service.ts` |
| git-bash-installer.service | Git Bash 安装器 | `services/git-bash-installer.service.ts` |
| OnboardingOverlay | 引导覆盖层 | `renderer/components/onboarding/OnboardingOverlay.tsx` |
| Spotlight | 聚焦高亮组件 | `renderer/components/onboarding/Spotlight.tsx` |
| onboardingData | 引导步骤数据 | `renderer/components/onboarding/onboardingData.ts` |
| SetupFlow | 初始化流程容器 | `renderer/components/setup/SetupFlow.tsx` |
| ApiSetup | API 配置步骤 | `renderer/components/setup/ApiSetup.tsx` |
| GitBashSetup | Git Bash 安装步骤 | `renderer/components/setup/GitBashSetup.tsx` |
| GitBashWarningBanner | Git Bash 警告横幅 | `renderer/components/setup/GitBashWarningBanner.tsx` |
| LoginSelector | 登录方式选择 | `renderer/components/setup/LoginSelector.tsx` |
| onboarding.store | 引导状态管理 | `renderer/stores/onboarding.store.ts` |

### 归属 IPC Handler

| Handler | 文件 |
|---------|------|
| onboarding | `ipc/onboarding.ts` |
| git-bash | `ipc/git-bash.ts` |

## 功能列表

| 功能 | 状态 | 文档 |
|------|------|------|
| onboarding-flow | 已完成 | features/onboarding-flow/design.md |
| setup-flow | 已完成 | features/setup-flow/design.md |

## 绑定的 API

- 无

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始模块文档 | @moonseeker1 |
