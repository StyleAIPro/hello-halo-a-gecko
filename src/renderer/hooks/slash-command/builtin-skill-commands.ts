/**
 * Built-in /skill command definition
 *
 * Provides 5 subcommands covering installed skill management
 * and market operations. All subcommands use execution: 'ipc'
 * to call existing API layer methods.
 */

import type { SlashCommand } from './types';

export const skillCommand: SlashCommand = {
  name: 'skill',
  labelKey: 'Skill Management',
  descriptionKey: 'View and manage installed skills',
  icon: 'Wrench',
  execution: 'ipc',
  subcommands: [
    {
      name: 'list',
      labelKey: 'List Skills',
      descriptionKey: 'Show all installed skills',
      arguments: [],
      execution: 'ipc',
    },
    {
      name: 'install',
      labelKey: 'Install Skill',
      descriptionKey: 'Install a skill from the marketplace',
      arguments: [
        {
          name: 'skillId',
          type: 'string',
          required: true,
          descriptionKey: 'Skill ID',
          placeholderKey: 'Enter skill ID',
        },
      ],
      execution: 'ipc',
    },
    {
      name: 'uninstall',
      labelKey: 'Uninstall Skill',
      descriptionKey: 'Uninstall a specific skill',
      arguments: [
        {
          name: 'skillId',
          type: 'string',
          required: true,
          descriptionKey: 'Skill ID',
          placeholderKey: 'Enter skill ID',
        },
      ],
      execution: 'ipc',
    },
    {
      name: 'info',
      labelKey: 'Skill Details',
      descriptionKey: 'View detailed skill information',
      arguments: [
        {
          name: 'skillId',
          type: 'string',
          required: true,
          descriptionKey: 'Skill ID',
          placeholderKey: 'Enter skill ID',
        },
      ],
      execution: 'ipc',
    },
    {
      name: 'search',
      labelKey: 'Search Skills',
      descriptionKey: 'Search the skill marketplace',
      arguments: [
        {
          name: 'query',
          type: 'rest',
          required: true,
          descriptionKey: 'Search keywords',
          placeholderKey: 'Enter search keywords',
        },
      ],
      execution: 'ipc',
    },
  ],
};
