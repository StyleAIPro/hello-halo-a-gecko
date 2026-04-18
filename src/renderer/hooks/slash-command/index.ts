/**
 * Slash command framework - module entry
 *
 * Re-exports all public types and functions.
 * Built-in commands are registered on module import.
 */

export type {
  SlashCommand,
  SlashCommandSubcommand,
  SlashCommandArgument,
  SlashCommandMatch,
  SlashCommandMenuItem,
  SlashCommandExecutionResult,
} from './types';
export { slashCommandRegistry } from './slash-command-registry';
export { executeSlashCommand } from './slash-command-executor';
export { useSlashCommand } from './useSlashCommand';

// Register built-in commands on import
import { slashCommandRegistry } from './slash-command-registry';
import { skillCommand } from './builtin-skill-commands';

slashCommandRegistry.register(skillCommand);
