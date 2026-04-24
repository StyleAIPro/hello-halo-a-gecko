/**
 * Slash command executor
 *
 * Responsibilities:
 * - Parse complete command text (e.g. "/skill list")
 * - Route to corresponding handler
 * - local commands: frontend processing
 * - ipc commands: via api layer (auto-adapts Electron/HTTP)
 * - Return structured execution result
 */

import { api } from '../../api';
import { slashCommandRegistry } from './slash-command-registry';
import type { SlashCommandExecutionResult } from './types';
import type { InstalledSkill } from '../../../shared/skill/skill-types';
import i18n from 'i18next';

const t = i18n.t.bind(i18n);

interface ParsedCommand {
  commandName: string;
  subcommandName?: string;
  args: string[];
}

/**
 * Parse complete command text
 * Input: "/skill install my-skill" -> { commandName: 'skill', subcommandName: 'install', args: ['my-skill'] }
 */
function parseFullCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;

  const parts = trimmed.substring(1).split(/\s+/);
  const commandName = parts[0];
  if (!commandName) return null;

  const command = slashCommandRegistry.getCommand(commandName);
  if (!command) return null;

  if (command.subcommands && command.subcommands.length > 0) {
    const subcommandName = parts[1];
    if (!subcommandName) {
      return { commandName, args: [] };
    }
    const subcommand = command.subcommands.find((sc) => sc.name === subcommandName);
    if (!subcommand) {
      return { commandName, args: parts.slice(1) };
    }
    return {
      commandName,
      subcommandName,
      args: parts.slice(2),
    };
  }

  return { commandName, args: parts.slice(1) };
}

/**
 * Execute a slash command
 */
export async function executeSlashCommand(fullText: string): Promise<SlashCommandExecutionResult> {
  const parsed = parseFullCommand(fullText);
  if (!parsed) {
    return {
      success: false,
      message: t('Unknown command: {{command}}', { command: fullText }),
    };
  }

  const command = slashCommandRegistry.getCommand(parsed.commandName);
  if (!command) {
    return {
      success: false,
      message: t('Unknown command: {{command}}', { command: `/${parsed.commandName}` }),
    };
  }

  if (parsed.commandName === 'skill') {
    return executeSkillCommand(parsed);
  }

  return {
    success: false,
    message: t('Unknown command: {{command}}', { command: `/${parsed.commandName}` }),
  };
}

/**
 * Execute /skill subcommands
 */
async function executeSkillCommand(parsed: ParsedCommand): Promise<SlashCommandExecutionResult> {
  const subcommand = parsed.subcommandName;

  switch (subcommand) {
    case 'list': {
      try {
        const result = await api.skillList();
        if (result.success && result.data) {
          const skills = result.data as InstalledSkill[];
          if (skills.length === 0) {
            return { success: true, message: t('No skills installed') };
          }
          const list = skills
            .map((s) => `- ${s.spec.name} (${s.appId})${s.enabled ? '' : ' [disabled]'}`)
            .join('\n');
          return {
            success: true,
            message: t('{{count}} skill(s) installed:\n{{list}}', { count: skills.length, list }),
            data: skills,
          };
        }
        return { success: false, message: result.error ?? t('Failed to list skills') };
      } catch (error) {
        return {
          success: false,
          message: t('Failed to list skills: {{error}}', {
            error: error instanceof Error ? error.message : String(error),
          }),
        };
      }
    }

    case 'install': {
      const skillId = parsed.args[0];
      if (!skillId) {
        return {
          success: false,
          message: t('Missing required argument: {{arg}}', { arg: 'skillId' }),
        };
      }
      try {
        const result = await api.skillInstall({ mode: 'market', skillId });
        if (result.success) {
          return {
            success: true,
            message: t('Skill "{{name}}" installed successfully', { name: skillId }),
          };
        }
        return {
          success: false,
          message: t('Failed to install: {{error}}', { error: result.error ?? 'Unknown error' }),
        };
      } catch (error) {
        return {
          success: false,
          message: t('Failed to install: {{error}}', {
            error: error instanceof Error ? error.message : String(error),
          }),
        };
      }
    }

    case 'uninstall': {
      const skillId = parsed.args[0];
      if (!skillId) {
        return {
          success: false,
          message: t('Missing required argument: {{arg}}', { arg: 'skillId' }),
        };
      }
      try {
        const result = await api.skillUninstall(skillId);
        if (result.success) {
          return { success: true, message: t('Skill "{{name}}" uninstalled', { name: skillId }) };
        }
        return {
          success: false,
          message: t('Failed to uninstall: {{error}}', { error: result.error ?? 'Unknown error' }),
        };
      } catch (error) {
        return {
          success: false,
          message: t('Failed to uninstall: {{error}}', {
            error: error instanceof Error ? error.message : String(error),
          }),
        };
      }
    }

    case 'info': {
      const skillId = parsed.args[0];
      if (!skillId) {
        return {
          success: false,
          message: t('Missing required argument: {{arg}}', { arg: 'skillId' }),
        };
      }
      try {
        const result = await api.skillMarketDetail(skillId);
        if (result.success && result.data) {
          const skill = result.data as Record<string, unknown>;
          const info = [
            `**${skill.name}** v${skill.version}`,
            (skill.description as string) ?? '',
            `Author: ${(skill.author as string) ?? 'Unknown'}`,
            Array.isArray(skill.tags) && skill.tags.length > 0
              ? `Tags: ${(skill.tags as string[]).join(', ')}`
              : '',
          ]
            .filter(Boolean)
            .join('\n');
          return { success: true, message: info, data: skill };
        }
        return { success: false, message: result.error ?? t('Failed to get skill details') };
      } catch (error) {
        return {
          success: false,
          message: t('Failed to get skill details: {{error}}', {
            error: error instanceof Error ? error.message : String(error),
          }),
        };
      }
    }

    case 'search': {
      const query = parsed.args.join(' ');
      if (!query) {
        return {
          success: false,
          message: t('Missing required argument: {{arg}}', { arg: 'query' }),
        };
      }
      try {
        const result = await api.skillMarketSearch(query);
        if (result.success && result.data) {
          const data = result.data as { skills: unknown[]; total: number };
          if (data.skills.length === 0) {
            return { success: true, message: t('No matching skills found') };
          }
          const skills = data.skills as Array<{ name: string; description?: string }>;
          const list = skills
            .slice(0, 10)
            .map((s) => `- **${s.name}**: ${s.description ?? ''}`)
            .join('\n');
          return {
            success: true,
            message: t('Found {{count}} skill(s):\n{{list}}', { count: data.total, list }),
            data: data.skills,
          };
        }
        return { success: false, message: result.error ?? t('Failed to search skills') };
      } catch (error) {
        return {
          success: false,
          message: t('Failed to search skills: {{error}}', {
            error: error instanceof Error ? error.message : String(error),
          }),
        };
      }
    }

    case 'enable': {
      const skillId = parsed.args[0];
      if (!skillId) {
        return {
          success: false,
          message: t('Missing required argument: {{arg}}', { arg: 'skillId' }),
        };
      }
      try {
        const result = await api.skillToggle(skillId, true);
        if (result.success) {
          return { success: true, message: t('Skill "{{name}}" enabled', { name: skillId }) };
        }
        return {
          success: false,
          message: t('Failed to enable: {{error}}', { error: result.error ?? 'Unknown error' }),
        };
      } catch (error) {
        return {
          success: false,
          message: t('Failed to enable: {{error}}', {
            error: error instanceof Error ? error.message : String(error),
          }),
        };
      }
    }

    case 'disable': {
      const skillId = parsed.args[0];
      if (!skillId) {
        return {
          success: false,
          message: t('Missing required argument: {{arg}}', { arg: 'skillId' }),
        };
      }
      try {
        const result = await api.skillToggle(skillId, false);
        if (result.success) {
          return { success: true, message: t('Skill "{{name}}" disabled', { name: skillId }) };
        }
        return {
          success: false,
          message: t('Failed to disable: {{error}}', { error: result.error ?? 'Unknown error' }),
        };
      } catch (error) {
        return {
          success: false,
          message: t('Failed to disable: {{error}}', {
            error: error instanceof Error ? error.message : String(error),
          }),
        };
      }
    }

    case 'refresh': {
      try {
        const result = await api.skillRefresh();
        if (result.success) {
          return { success: true, message: t('Skills list refreshed successfully') };
        }
        return {
          success: false,
          message: t('Failed to refresh: {{error}}', { error: result.error ?? 'Unknown error' }),
        };
      } catch (error) {
        return {
          success: false,
          message: t('Failed to refresh: {{error}}', {
            error: error instanceof Error ? error.message : String(error),
          }),
        };
      }
    }

    case 'create': {
      const name = parsed.args[0];
      const description = parsed.args.slice(1).join(' ');
      if (!name) {
        return {
          success: false,
          message: t('Missing required argument: {{arg}}', { arg: 'name' }),
        };
      }
      if (!description) {
        return {
          success: false,
          message: t('Missing required argument: {{arg}}', { arg: 'description' }),
        };
      }
      try {
        const result = await api.skillGenerateFromPrompt({
          spaceId: '',
          name,
          description,
          triggerCommand: `/${name.toLowerCase().replace(/\s+/g, '-')}`,
        });
        if (result.success) {
          return { success: true, message: t('Skill "{{name}}" created successfully', { name }) };
        }
        return {
          success: false,
          message: t('Failed to create: {{error}}', { error: result.error ?? 'Unknown error' }),
        };
      } catch (error) {
        return {
          success: false,
          message: t('Failed to create: {{error}}', {
            error: error instanceof Error ? error.message : String(error),
          }),
        };
      }
    }

    default:
      return {
        success: false,
        message: t('Unknown subcommand: {{subcommand}}', { subcommand: subcommand ?? '' }),
      };
  }
}
