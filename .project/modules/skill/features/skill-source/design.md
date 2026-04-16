# 功能 — 技能源管理

> 日期：2026-04-16
> 指令人：@moonseeker1
> 所属模块：modules/skill/skill-system-v1

## 描述
管理技能的安装来源，包括技能源认证、拉取和同步。支持 GitHub 和 GitCode 两个主要技能源平台。

## 依赖
- github-auth.service / gitcode-auth.service（认证服务）
- skill-manager（技能安装/卸载）

## 实现逻辑
### 正常流程
1. 配置技能源（GitHub/GitCode）
2. 认证技能源平台
3. 拉取可用技能列表
4. 安装/更新技能

## 涉及文件
- `services/skill/github-skill-source.service.ts` — GitHub 技能源
- `services/skill/gitcode-skill-source.service.ts` — GitCode 技能源

## 变更
→ changelog.md
