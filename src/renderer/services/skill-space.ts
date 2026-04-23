/**
 * Skill Space utilities for the renderer process
 */

// 固定的技能空间 ID（与主进程保持一致）
const SKILL_SPACE_ID = 'aico-bot-skill-creator';

/**
 * 获取技能空间 ID
 */
export function getSkillSpaceId(): string {
  return SKILL_SPACE_ID;
}
