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
 *   skill:market:detail     Get market skill detail
 *   skill:config:get        Get skill library config
 *   skill:config:update     Update skill library config
 *   skill:refresh           Refresh installed skills list
 */

import { ipcMain } from 'electron';
import * as skillController from '../controllers/skill.controller';
import type { ConversationService } from '../services/conversation.service';

export function registerSkillHandlers(conversationService: ConversationService): void {
  // Initialize controller with dependencies
  skillController.initialize(conversationService);

  // ── skill:list ─────────────────────────────────────────────────────────
  ipcMain.handle('skill:list', async () => {
    return skillController.listInstalledSkills();
  });

  // ── skill:get-detail ───────────────────────────────────────────────────
  ipcMain.handle('skill:get-detail', async (_event, skillId: string) => {
    return skillController.getSkillDetail(skillId);
  });

  // ── skill:install ──────────────────────────────────────────────────────
  ipcMain.handle(
    'skill:install',
    async (
      event,
      input: {
        mode: 'market' | 'yaml';
        skillId?: string;
        yamlContent?: string;
      },
    ) => {
      if (input.mode === 'market' && input.skillId) {
        // 流式输出回调
        const onOutput = (data: {
          type: 'stdout' | 'stderr' | 'complete' | 'error';
          content: string;
        }) => {
          event.sender.send('skill:install-output', input.skillId, data);
        };
        return skillController.installSkillFromMarket(input.skillId, onOutput);
      } else if (input.mode === 'yaml' && input.yamlContent) {
        return skillController.installSkillFromYaml(input.yamlContent);
      }
      return {
        success: false,
        error: 'Invalid install parameters',
      };
    },
  );

  // ── skill:uninstall ────────────────────────────────────────────────────
  ipcMain.handle('skill:uninstall', async (_event, skillId: string) => {
    return skillController.uninstallSkill(skillId);
  });

  // ── skill:install-multi ────────────────────────────────────────────────
  ipcMain.handle(
    'skill:install-multi',
    async (
      event,
      input: {
        skillId: string;
        targets: Array<{ type: 'local' } | { type: 'remote'; serverId: string }>;
      },
    ) => {
      const onOutput = (
        targetKey: string,
        data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string },
      ) => {
        event.sender.send('skill:install-output', input.skillId, { ...data, targetKey });
      };
      return skillController.installSkillMultiTarget(input.skillId, input.targets, onOutput);
    },
  );

  // ── skill:uninstall-multi ──────────────────────────────────────────────
  ipcMain.handle(
    'skill:uninstall-multi',
    async (
      event,
      input: {
        appId: string;
        targets: Array<{ type: 'local' } | { type: 'remote'; serverId: string }>;
      },
    ) => {
      const onOutput = (
        targetKey: string,
        data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string },
      ) => {
        event.sender.send('skill:uninstall-output', input.appId, { ...data, targetKey });
      };
      return skillController.uninstallSkillMultiTarget(input.appId, input.targets, onOutput);
    },
  );

  // ── skill:sync-to-remote ───────────────────────────────────────────────
  ipcMain.handle(
    'skill:sync-to-remote',
    async (event, input: { skillId: string; serverId: string }) => {
      const onOutput = (data: {
        type: 'stdout' | 'stderr' | 'complete' | 'error';
        content: string;
      }) => {
        event.sender.send('skill:sync-output', input.skillId, input.serverId, data);
      };
      return skillController.syncLocalSkillToRemote(input.skillId, input.serverId, onOutput);
    },
  );

  // ── skill:sync-from-remote ─────────────────────────────────────────────
  ipcMain.handle(
    'skill:sync-from-remote',
    async (event, input: { skillId: string; serverId: string }) => {
      const onOutput = (data: {
        type: 'stdout' | 'stderr' | 'complete' | 'error';
        content: string;
      }) => {
        event.sender.send('skill:sync-from-remote-output', input.skillId, input.serverId, data);
      };
      return skillController.syncRemoteSkillToLocal(input.skillId, input.serverId, onOutput);
    },
  );

  // ── skill:toggle ───────────────────────────────────────────────────────
  ipcMain.handle('skill:toggle', async (_event, input: { skillId: string; enabled: boolean }) => {
    return skillController.toggleSkill(input.skillId, input.enabled);
  });

  // ── skill:export ───────────────────────────────────────────────────────
  ipcMain.handle('skill:export', async (_event, skillId: string) => {
    return skillController.exportSkill(skillId);
  });

  // ── skill:generate ─────────────────────────────────────────────────────
  // Note: spaceId is kept for conversation lookup, not for installation location
  ipcMain.handle(
    'skill:generate',
    async (
      _event,
      input: {
        mode: 'conversation' | 'prompt';
        spaceId: string;
        conversationId?: string;
        name?: string;
        description?: string;
        triggerCommand?: string;
      },
    ) => {
      if (input.mode === 'conversation') {
        return skillController.generateSkillFromConversation(input.spaceId, input.conversationId);
      } else if (input.mode === 'prompt' && input.name && input.description) {
        return skillController.generateSkillFromPrompt({
          spaceId: input.spaceId,
          conversationId: input.conversationId,
          name: input.name,
          description: input.description,
          triggerCommand: input.triggerCommand || '',
        });
      }
      return {
        success: false,
        error: 'Invalid generate parameters',
      };
    },
  );

  // ── skill:market:list ──────────────────────────────────────────────────
  ipcMain.handle('skill:market:list', async (_event, page?: number, pageSize?: number) => {
    return skillController.listMarketSkills(page, pageSize);
  });

  // ── skill:market:search ────────────────────────────────────────────────
  ipcMain.handle(
    'skill:market:search',
    async (_event, query: string, page?: number, pageSize?: number) => {
      return skillController.searchMarketSkills(query, page, pageSize);
    },
  );

  // ── skill:market:detail ────────────────────────────────────────────────
  ipcMain.handle('skill:market:detail', async (_event, skillId: string) => {
    return skillController.getMarketSkillDetail(skillId);
  });

  // ── skill:market:sources ────────────────────────────────────────────────
  ipcMain.handle('skill:market:sources', async () => {
    return skillController.getMarketSources();
  });

  // ── skill:market:add-source ─────────────────────────────────────────────
  ipcMain.handle(
    'skill:market:add-source',
    async (
      _event,
      source: { name: string; url: string; repos?: string[]; description?: string },
    ) => {
      return skillController.addMarketSource(source);
    },
  );

  // ── skill:market:remove-source ──────────────────────────────────────────
  ipcMain.handle('skill:market:remove-source', async (_event, sourceId: string) => {
    return skillController.removeMarketSource(sourceId);
  });

  // ── skill:market:toggle-source ──────────────────────────────────────────
  ipcMain.handle(
    'skill:market:toggle-source',
    async (_event, input: { sourceId: string; enabled: boolean }) => {
      return skillController.toggleMarketSource(input.sourceId, input.enabled);
    },
  );

  // ── skill:market:set-active ─────────────────────────────────────────────
  ipcMain.handle('skill:market:set-active', async (_event, sourceId: string) => {
    return skillController.setActiveMarketSource(sourceId);
  });

  // ── skill:config:get ───────────────────────────────────────────────────
  ipcMain.handle('skill:config:get', async () => {
    return skillController.getSkillConfig();
  });

  // ── skill:config:update ────────────────────────────────────────────────
  ipcMain.handle('skill:config:update', async (_event, config: Record<string, unknown>) => {
    return skillController.updateSkillConfig(config);
  });

  // ── skill:refresh ──────────────────────────────────────────────────────
  ipcMain.handle('skill:refresh', async () => {
    return skillController.refreshSkills();
  });

  // ── skill:files ────────────────────────────────────────────────────────
  ipcMain.handle('skill:files', async (_event, skillId: string) => {
    return skillController.getSkillFiles(skillId);
  });

  // ── skill:file-content ─────────────────────────────────────────────────
  ipcMain.handle('skill:file-content', async (_event, skillId: string, filePath: string) => {
    return skillController.getSkillFileContent(skillId, filePath);
  });

  // ── skill:file-save ────────────────────────────────────────────────────
  ipcMain.handle(
    'skill:file-save',
    async (_event, skillId: string, filePath: string, content: string) => {
      return skillController.saveSkillFileContent(skillId, filePath, content);
    },
  );

  // ── skill:analyze-conversations ───────────────────────────────────────────────────
  ipcMain.handle(
    'skill:analyze-conversations',
    async (_event, spaceId: string, conversationIds: string[]) => {
      return skillController.analyzeConversations(spaceId, conversationIds);
    },
  );

  // ── skill:create-temp-session ───────────────────────────────────────────────────────
  ipcMain.handle(
    'skill:create-temp-session',
    async (
      event,
      options: {
        skillName: string;
        context: any;
      },
    ) => {
      // Set up streaming callback for initial message response
      // Use skill:temp-message-chunk event (same as send-temp-message) for consistency
      const onChunk = (sessionId: string, chunk: any) => {
        event.sender.send('skill:temp-message-chunk', sessionId, chunk);
      };
      return skillController.createTempAgentSession({
        ...options,
        onChunk,
      });
    },
  );

  // ── skill:send-temp-message ───────────────────────────────────────────────────────
  ipcMain.handle('skill:send-temp-message', async (event, sessionId: string, message: string) => {
    // Set up streaming callback
    const onChunk = (chunk: string) => {
      event.sender.send('skill:temp-message-chunk', sessionId, chunk);
    };
    return skillController.sendTempAgentMessage(sessionId, message, onChunk);
  });

  // ── skill:close-temp-session ────────────────────────────────────────────────────────
  ipcMain.handle('skill:close-temp-session', async (_event, sessionId: string) => {
    return skillController.closeTempAgentSession(sessionId);
  });

  // ============================================
  // Skill Conversation (持久化会话)
  // ============================================

  // ── skill:conversation:list ────────────────────────────────────────────────────────
  ipcMain.handle('skill:conversation:list', async (_event, relatedSkillId?: string) => {
    return skillController.listSkillConversations(relatedSkillId);
  });

  // ── skill:conversation:get ──────────────────────────────────────────────────────────
  ipcMain.handle('skill:conversation:get', async (_event, conversationId: string) => {
    return skillController.getSkillConversation(conversationId);
  });

  // ── skill:conversation:create ───────────────────────────────────────────────────────
  ipcMain.handle(
    'skill:conversation:create',
    async (_event, title?: string, relatedSkillId?: string) => {
      return skillController.createSkillConversation(title, relatedSkillId);
    },
  );

  // ── skill:conversation:delete ───────────────────────────────────────────────────────
  ipcMain.handle('skill:conversation:delete', async (_event, conversationId: string) => {
    return skillController.deleteSkillConversation(conversationId);
  });

  // ── skill:conversation:send ─────────────────────────────────────────────────────────
  // 注意：现在使用标准的 agent:* IPC 事件发送流式数据（与主对话框相同）
  ipcMain.handle(
    'skill:conversation:send',
    async (
      _event,
      conversationId: string,
      message: string,
      metadata?: {
        selectedConversations?: Array<{
          id: string;
          title: string;
          spaceName: string;
          messageCount: number;
          formattedContent?: string;
        }>;
        sourceWebpages?: Array<{
          url: string;
          title?: string;
          content?: string;
        }>;
      },
    ) => {
      return skillController.sendSkillConversationMessage(conversationId, message, metadata);
    },
  );

  // ── skill:conversation:stop ─────────────────────────────────────────────────────────
  ipcMain.handle('skill:conversation:stop', async (_event, conversationId: string) => {
    return skillController.stopSkillGeneration(conversationId);
  });

  // ── skill:conversation:close ────────────────────────────────────────────────────────
  ipcMain.handle('skill:conversation:close', async (_event, conversationId: string) => {
    return skillController.closeSkillConversation(conversationId);
  });

  // ── skill:fetch-webpage ────────────────────────────────────────────────────────────
  // 获取网页内容（用于从网页创建技能）
  ipcMain.handle('skill:fetch-webpage', async (_event, url: string) => {
    return skillController.fetchWebPageContent(url);
  });

  // ── skill:market:push-to-github ────────────────────────────────────────────────
  // 推送本地技能到 GitHub 仓库（通过 PR）
  ipcMain.handle(
    'skill:market:push-to-github',
    async (_event, skillId: string, targetRepo: string, targetPath?: string) => {
      return skillController.pushSkillToGitHub(skillId, targetRepo, targetPath);
    },
  );

  // ── skill:market:list-repo-dirs ────────────────────────────────────────────────
  // 列出 GitHub 仓库 skills/ 目录下的子目录
  ipcMain.handle('skill:market:list-repo-dirs', async (_event, repo: string) => {
    return skillController.listRepoDirectories(repo);
  });

  // ── skill:market:validate-repo ─────────────────────────────────────────────────
  // 验证 GitHub 仓库是否可用作技能源
  ipcMain.handle('skill:market:validate-repo', async (_event, repo: string) => {
    return skillController.validateGitHubRepo(repo);
  });

  // ── GitCode skill operations ────────────────────────────────────────────────

  ipcMain.handle(
    'skill:market:push-to-gitcode',
    async (_event, skillId: string, targetRepo: string, targetPath?: string) => {
      return skillController.pushSkillToGitCode(skillId, targetRepo, targetPath);
    },
  );

  ipcMain.handle('skill:market:list-gitcode-repo-dirs', async (_event, repo: string) => {
    return skillController.listGitCodeRepoDirectories(repo);
  });

  ipcMain.handle('skill:market:validate-gitcode-repo', async (_event, repo: string) => {
    return skillController.validateGitCodeRepo(repo);
  });

  ipcMain.handle('skill:market:set-gitcode-token', async (_event, token: string) => {
    return skillController.setGitCodeToken(token);
  });

  console.log('[SkillIPC] Skill handlers registered');
}
