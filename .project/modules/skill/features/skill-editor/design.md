# 功能 — 技能编辑器

> 日期：2026-04-16
> 指令人：@moonseeker1
> 所属模块：modules/skill/skill-system-v1

## 描述
提供技能的创建、编辑和预览功能。用户可以定义技能的触发条件、系统提示词和工具配置。

## 依赖
- skill-manager（技能管理后端）
- skill-generator（技能生成）

## 实现逻辑
### 正常流程
1. 用户打开技能编辑器
2. 编辑技能名称、描述、触发条件
3. 配置系统提示词和工具
4. 保存技能到 skill-store

## 涉及文件
- `services/skill/skill-generator.ts` — 技能生成/编辑后端
- `renderer/components/skill/SkillEditor/` — 技能编辑器 UI

## 变更
→ changelog.md
