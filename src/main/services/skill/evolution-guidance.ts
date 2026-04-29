/**
 * Evolution Guidance - System Prompt Integration
 *
 * Generates guidance text that is appended to the Agent's system prompt,
 * encouraging the Agent to:
 * 1. Report when a skill worked well or poorly
 * 2. Suggest improvements to skill prompts
 * 3. Note which skills were useful in the current task
 *
 * This provides the "runtime feedback loop" that feeds data back
 * into the evolution system.
 */

import type { EvolutionGuidanceContext } from '../../../shared/skill/skill-evolution-types';
import { SkillManager } from './skill-manager';

/**
 * Build the evolution guidance text to append to the system prompt.
 * Returns an empty string if no skills are enabled.
 */
export function buildEvolutionGuidance(): string {
  const skillManager = SkillManager.getInstance();
  if (!skillManager) return '';

  const skills = skillManager.getInstalledSkills().filter((s) => s.enabled);
  if (skills.length === 0) return '';

  const skillList = skills
    .map(
      (s) =>
        `- \`${s.spec.trigger_command || `/${s.appId}`}\`: ${s.spec.description || s.spec.name}`,
    )
    .join('\n');

  return `

# Skill Evolution Feedback

You have the following skills available. When you use a skill during this conversation, please note:

1. **After using a skill**: Briefly mention if the skill was helpful or if the instructions could be improved.
2. **When a skill fails**: Describe what went wrong and what the skill instructions should have covered.
3. **When you improvise**: If you completed a task manually that a skill should have handled, note what the skill was missing.

Available skills:
${skillList}

This feedback helps the system automatically improve skill quality over time.
`.trim();
}

/**
 * Parse agent response for skill feedback signals.
 * Returns extracted feedback entries keyed by skillId.
 */
export function parseSkillFeedbackFromResponse(
  response: string,
): Array<{ skillId: string; feedback: 'positive' | 'negative'; note: string }> {
  const results: Array<{ skillId: string; feedback: 'positive' | 'negative'; note: string }> = [];

  const skillManager = SkillManager.getInstance();
  if (!skillManager) return results;

  const skills = skillManager.getInstalledSkills();

  for (const skill of skills) {
    const trigger = skill.spec.trigger_command || `/${skill.appId}`;
    const escapedTrigger = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const skillNamePattern = new RegExp(
      `(?:skill|${escapedTrigger})[\\s:]+.*?(?:helpful|useful|good|great|worked|well|success)`,
      'i',
    );
    const negativePattern = new RegExp(
      `(?:skill|${escapedTrigger})[\\s:]+.*?(?:fail|wrong|bad|didn'?t work|unhelpful|poor|missing)`,
      'i',
    );

    if (skillNamePattern.test(response)) {
      results.push({
        skillId: skill.appId,
        feedback: 'positive',
        note: extractNote(response, trigger),
      });
    } else if (negativePattern.test(response)) {
      results.push({
        skillId: skill.appId,
        feedback: 'negative',
        note: extractNote(response, trigger),
      });
    }
  }

  return results;
}

function extractNote(response: string, trigger: string): string {
  const idx = response.toLowerCase().indexOf(trigger.toLowerCase());
  if (idx === -1) return '';
  const start = Math.max(0, idx - 20);
  const end = Math.min(response.length, idx + trigger.length + 150);
  return response.slice(start, end).trim();
}
