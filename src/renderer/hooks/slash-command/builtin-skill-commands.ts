/**
 * Built-in /skill command definition
 *
 * Provides 9 subcommands covering installed skill management,
 * market operations, and skill lifecycle. All subcommands use execution: 'ipc'
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
    {
      name: 'enable',
      labelKey: 'Enable Skill',
      descriptionKey: 'Enable a disabled skill',
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
      name: 'disable',
      labelKey: 'Disable Skill',
      descriptionKey: 'Disable an enabled skill',
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
      name: 'refresh',
      labelKey: 'Refresh Skills',
      descriptionKey: 'Reload installed skills list',
      arguments: [],
      execution: 'ipc',
    },
    {
      name: 'create',
      labelKey: 'Create Skill',
      descriptionKey: 'Create a new skill from a prompt',
      arguments: [
        {
          name: 'name',
          type: 'string',
          required: true,
          descriptionKey: 'Skill name',
          placeholderKey: 'Enter skill name',
        },
        {
          name: 'description',
          type: 'rest',
          required: true,
          descriptionKey: 'Skill description',
          placeholderKey: 'Enter skill description',
        },
      ],
      execution: 'ipc',
    },
  ],
};
