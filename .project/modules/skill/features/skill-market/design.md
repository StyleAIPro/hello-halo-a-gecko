# 功能 — 技能市场

> 日期：2026-04-16
> 指令人：@moonseeker1
> 所属模块：modules/skill/skill-system-v1

## 描述
提供技能市场的浏览、搜索和安装功能。支持从 GitHub 和 GitCode 源安装技能。

## 依赖
- skill-market-service（市场服务后端）
- github-skill-source / gitcode-skill-source（技能源）

## 实现逻辑
### 正常流程
1. 加载可用技能列表
2. 用户浏览/搜索技能
3. 用户点击安装
4. 从对应源下载并安装技能

## 涉及文件
- `services/skill/skill-market-service.ts` — 市场服务后端
- `services/skill/github-skill-source.service.ts` — GitHub 源
- `services/skill/gitcode-skill-source.service.ts` — GitCode 源
- `renderer/components/skill/SkillMarket.tsx` — 市场页面
- `renderer/components/skill/SkillLibrary.tsx` — 技能库 UI

## 变更
→ changelog.md
