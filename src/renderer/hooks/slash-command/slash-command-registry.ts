/**
 * Slash command registry (renderer singleton)
 *
 * Responsibilities:
 * - Manage all registered slash commands
 * - Query matching commands/subcommands based on user input and cursor position
 * - Provide command parsing capability (parseInput)
 */

import type { SlashCommand, SlashCommandMatch } from './types';

class SlashCommandRegistry {
  private commands: Map<string, SlashCommand> = new Map();

  /** Register a single command */
  register(command: SlashCommand): void {
    this.commands.set(command.name, command);
  }

  /** Batch register */
  registerAll(commands: SlashCommand[]): void {
    for (const cmd of commands) {
      this.register(cmd);
    }
  }

  /** Unregister a command */
  unregister(commandName: string): void {
    this.commands.delete(commandName);
  }

  /** Get all registered commands (sorted by name) */
  getAllCommands(): SlashCommand[] {
    return Array.from(this.commands.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Get a specific command */
  getCommand(name: string): SlashCommand | undefined {
    return this.commands.get(name);
  }

  /**
   * Parse user input, return match result
   *
   * Rules:
   * 1. Text line starts with "/" (allow leading whitespace)
   * 2. From "/" to cursor position is the parsing scope
   *
   * Examples:
   *   "/sk" cursor=3        -> type:'command', query:'sk'
   *   "/skill " cursor=7    -> type:'subcommand', command:skill, query:''
   *   "/skill in" cursor=9  -> type:'subcommand', command:skill, query:'in'
   *   "/skill install " cursor=16 -> type:'argument', subcommand:install
   */
  parseInput(input: string, cursorPosition: number): SlashCommandMatch {
    // Find the line containing the cursor
    const lineStart = input.lastIndexOf('\n', cursorPosition - 1) + 1;
    const lineText = input.substring(lineStart, cursorPosition);

    // Check if line starts with / (ignore leading whitespace)
    const match = lineText.match(/^(\s*)\/(\S*)\s*(.*)?$/);
    if (!match) {
      return { type: 'none' };
    }

    const [, leadingSpace, commandName, rest] = match;

    // Ensure cursor is after the /
    const slashIndex = lineStart + leadingSpace.length;
    if (cursorPosition <= slashIndex) {
      return { type: 'none' };
    }

    const command = this.getCommand(commandName);

    if (!command) {
      // Command name not fully matched, return command-level filter
      return {
        type: 'command',
        query: commandName,
        matchedText: `/${commandName}`,
        commandStart: slashIndex,
      };
    }

    // Command matched, check for subcommands
    if (command.subcommands && command.subcommands.length > 0) {
      const fullCommandEnd = slashIndex + 1 + commandName.length;
      if (cursorPosition <= fullCommandEnd) {
        // Cursor still on the command name
        return {
          type: 'command',
          query: commandName,
          matchedText: `/${commandName}`,
          commandStart: slashIndex,
          command,
        };
      }

      // Parse subcommand
      const restText = rest ?? '';
      const trimmedRest = restText.trimStart();
      const parts = trimmedRest.split(/\s+/);
      const subcommandName = parts[0] ?? '';

      // Check if there's a space after the command name (required before subcommand)
      if (restText.length === 0) {
        // Just "/skill" with no space - cursor might be right after
        if (cursorPosition === fullCommandEnd) {
          return {
            type: 'subcommand',
            command,
            query: '',
            matchedText: `/${commandName}`,
            commandStart: slashIndex,
          };
        }
      }

      const subcommand = command.subcommands.find((sc) => sc.name === subcommandName);

      if (!subcommand) {
        // Subcommand name not fully matched
        return {
          type: 'subcommand',
          command,
          query: subcommandName,
          matchedText: `/${commandName} ${subcommandName}`,
          commandStart: slashIndex,
        };
      }

      // Subcommand matched, check arguments
      const argsAfterSubcommand = parts.slice(1);
      if (
        argsAfterSubcommand.length === 0 ||
        (argsAfterSubcommand.length === 1 && argsAfterSubcommand[0] === '')
      ) {
        return {
          type: 'argument',
          command,
          subcommand,
          argumentIndex: 0,
          matchedText: `/${commandName} ${subcommandName}`,
          commandStart: slashIndex,
        };
      }

      // Arguments present
      const nonEmptyArgs = argsAfterSubcommand.filter(Boolean);
      return {
        type: 'argument',
        command,
        subcommand,
        argumentIndex: Math.max(0, nonEmptyArgs.length - 1),
        matchedText: `/${commandName} ${subcommandName} ${trimmedRest.substring(subcommandName.length).trimStart()}`,
        commandStart: slashIndex,
      };
    }

    // Command without subcommands
    return {
      type: 'command',
      command,
      matchedText: `/${commandName}`,
      commandStart: slashIndex,
    };
  }
}

export const slashCommandRegistry = new SlashCommandRegistry();
