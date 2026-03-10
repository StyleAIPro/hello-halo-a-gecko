/**
 * Skill IPC Handlers
 *
 * Exposes Skill management operations to the renderer process.
 *
 * Channels:
 *   skill:list              List installed skills
 *   skill:get-detail        Get skill detail by ID
 *   skill:install           Install a skill
 *   skill:uninstall         Uninstall a skill
 *   skill:toggle            Enable/disable a skill
 *   skill:export            Export a skill as YAML
 *   skill:generate          Generate a skill from conversation
 *   skill:market:list       List skills from market
 *   skill:market:search     Search skills in market
 *   skill:market:sources    Get market sources
 *   skill:config:get        Get skill library config
 *   skill:config:update     Update skill library config
 *   skill:refresh           Refresh installed skills list
 */

import { ipcMain } from 'electron';
import * as skillController from '../controllers/skill.controller';
import { ConversationService } from '../services/conversation.service';

export function registerSkillHandlers(
  conversationService: ConversationService
): void {
  // Initialize controller with dependencies
  skillController.initialize(conversationService);

  // ── skill:list ─────────────────────────────────────────────────────────
  ipcMain.handle(
    'skill:list',
    async () => {
      return skillController.listInstalledSkills();
    }
  );

  // ── skill:get-detail ───────────────────────────────────────────────────
  ipcMain.handle(
    'skill:get-detail',
    async (_event, skillId: string) => {
      return skillController.getSkillDetail(skillId);
    }
  );

  // ── skill:install ──────────────────────────────────────────────────────
  ipcMain.handle(
    'skill:install',
    async (_event, input: {
      mode: 'market' | 'yaml';
      skillId?: string;
      yamlContent?: string;
    }) => {
      if (input.mode === 'market' && input.skillId) {
        return skillController.installSkillFromMarket(input.skillId);
      } else if (input.mode === 'yaml' && input.yamlContent) {
        return skillController.installSkillFromYaml(input.yamlContent);
      }
      return {
        success: false,
        error: 'Invalid install parameters'
      };
    }
  );

  // ── skill:uninstall ────────────────────────────────────────────────────
  ipcMain.handle(
    'skill:uninstall',
    async (_event, skillId: string) => {
      return skillController.uninstallSkill(skillId);
    }
  );

  // ── skill:toggle ───────────────────────────────────────────────────────
  ipcMain.handle(
    'skill:toggle',
    async (_event, input: { skillId: string; enabled: boolean }) => {
      return skillController.toggleSkill(input.skillId, input.enabled);
    }
  );

  // ── skill:export ───────────────────────────────────────────────────────
  ipcMain.handle(
    'skill:export',
    async (_event, skillId: string) => {
      return skillController.exportSkill(skillId);
    }
  );

  // ── skill:generate ─────────────────────────────────────────────────────
  // Note: spaceId is kept for conversation lookup, not for installation location
  ipcMain.handle(
    'skill:generate',
    async (_event, input: {
      mode: 'conversation' | 'prompt';
      spaceId: string;
      conversationId?: string;
      name?: string;
      description?: string;
      triggerCommand?: string;
    }) => {
      if (input.mode === 'conversation') {
        return skillController.generateSkillFromConversation(input.spaceId, input.conversationId);
      } else if (input.mode === 'prompt' && input.name && input.description) {
        return skillController.generateSkillFromPrompt({
          spaceId: input.spaceId,
          conversationId: input.conversationId,
          name: input.name,
          description: input.description,
          triggerCommand: input.triggerCommand || ''
        });
      }
      return {
        success: false,
        error: 'Invalid generate parameters'
      };
    }
  );

  // ── skill:market:list ──────────────────────────────────────────────────
  ipcMain.handle(
    'skill:market:list',
    async (_event, sourceId?: string, page?: number, pageSize?: number) => {
      return skillController.listMarketSkills(sourceId, page, pageSize);
    }
  );

  // ── skill:market:search ────────────────────────────────────────────────
  ipcMain.handle(
    'skill:market:search',
    async (_event, query: string, sourceId?: string, page?: number, pageSize?: number) => {
      return skillController.searchMarketSkills(query, sourceId, page, pageSize);
    }
  );

  // ── skill:market:sources ───────────────────────────────────────────────
  ipcMain.handle(
    'skill:market:sources',
    async () => {
      return skillController.getMarketSources();
    }
  );

  // ── skill:market:reset-cache ───────────────────────────────────────────
  ipcMain.handle(
    'skill:market:reset-cache',
    async (_event, sourceId?: string) => {
      return skillController.resetMarketCache(sourceId);
    }
  );

  // ── skill:market:set-active ────────────────────────────────────────────
  ipcMain.handle(
    'skill:market:set-active',
    async (_event, sourceId: string) => {
      return skillController.setActiveMarketSource(sourceId);
    }
  );

  // ── skill:market:toggle-source ─────────────────────────────────────────
  ipcMain.handle(
    'skill:market:toggle-source',
    async (_event, input: { sourceId: string; enabled: boolean }) => {
      return skillController.toggleMarketSource(input.sourceId, input.enabled);
    }
  );

  // ── skill:market:add-source ────────────────────────────────────────────
  ipcMain.handle(
    'skill:market:add-source',
    async (_event, source: { name: string; url: string; repos?: string[]; description?: string }) => {
      return skillController.addMarketSource(source);
    }
  );

  // ── skill:market:remove-source ─────────────────────────────────────────
  ipcMain.handle(
    'skill:market:remove-source',
    async (_event, sourceId: string) => {
      return skillController.removeMarketSource(sourceId);
    }
  );

  // ── skill:market:detail ────────────────────────────────────────────────
  ipcMain.handle(
    'skill:market:detail',
    async (_event, skillId: string) => {
      return skillController.getMarketSkillDetail(skillId);
    }
  );

  // ── skill:config:get ───────────────────────────────────────────────────
  ipcMain.handle(
    'skill:config:get',
    async () => {
      return skillController.getSkillConfig();
    }
  );

  // ── skill:config:update ────────────────────────────────────────────────
  ipcMain.handle(
    'skill:config:update',
    async (_event, config: Record<string, unknown>) => {
      return skillController.updateSkillConfig(config);
    }
  );

  // ── skill:refresh ──────────────────────────────────────────────────────
  ipcMain.handle(
    'skill:refresh',
    async () => {
      return skillController.refreshSkills();
    }
  );

  // ── skill:files ────────────────────────────────────────────────────────
  ipcMain.handle(
    'skill:files',
    async (_event, skillId: string) => {
      return skillController.getSkillFiles(skillId);
    }
  );

  // ── skill:file-content ─────────────────────────────────────────────────
  ipcMain.handle(
    'skill:file-content',
    async (_event, skillId: string, filePath: string) => {
      return skillController.getSkillFileContent(skillId, filePath);
    }
  );

  // ── skill:analyze-conversations ───────────────────────────────────────────────────
  ipcMain.handle(
    'skill:analyze-conversations',
    async (_event, spaceId: string, conversationIds: string[]) => {
      return skillController.analyzeConversations(spaceId, conversationIds);
    }
  );

  // ── skill:create-temp-session ───────────────────────────────────────────────────────
  ipcMain.handle(
    'skill:create-temp-session',
    async (_event, options: {
      skillName: string;
      context: any;
    }) => {
      return skillController.createTempAgentSession(options);
    }
  );

  // ── skill:send-temp-message ───────────────────────────────────────────────────────
  ipcMain.handle(
    'skill:send-temp-message',
    async (event, sessionId: string, message: string) => {
      // Set up streaming callback
      const onChunk = (chunk: string) => {
        event.sender.send('skill:temp-message-chunk', sessionId, chunk);
      };
      return skillController.sendTempAgentMessage(sessionId, message, onChunk);
    }
  );

  // ── skill:close-temp-session ────────────────────────────────────────────────────────
  ipcMain.handle(
    'skill:close-temp-session',
    async (_event, sessionId: string) => {
      return skillController.closeTempAgentSession(sessionId);
    }
  );

  console.log('[SkillIPC] Skill handlers registered (19 channels)');
}