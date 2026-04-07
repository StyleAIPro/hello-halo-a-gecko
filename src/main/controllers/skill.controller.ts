/**
 * Skill Controller
 * 处理 Skill 相关的业务逻辑
 */

import { SkillManager } from '../services/skill/skill-manager';
import { SkillMarketService } from '../services/skill/skill-market-service';
import { SkillGeneratorService } from '../services/skill/skill-generator';
import { ConversationService } from '../services/conversation.service';
import { remoteDeployService } from '../services/remote-deploy/remote-deploy.service';
import { SkillGenerateOptions } from '../../shared/skill/skill-types';

let skillManager: SkillManager;
let skillMarket: SkillMarketService;
let skillGenerator: SkillGeneratorService;
let initPromise: Promise<void> | null = null;

export function initialize(conversationService: ConversationService): void {
  skillManager = SkillManager.getInstance();
  skillMarket = SkillMarketService.getInstance();
  skillGenerator = SkillGeneratorService.getInstance(conversationService);

  initPromise = Promise.all([
    skillManager.initialize(),
    skillMarket.initialize()
  ]).then(() => {
    // explicitly return void
  }).catch(err => {
    console.error('[SkillController] Failed to initialize:', err);
  });
}

async function ensureInitialized(): Promise<void> {
  if (initPromise) {
    await initPromise;
  }
}

/**
 * Fallback: 直接从 GitHub 下载 SKILL.md 并写入本地目录安装
 * 当 npx 不可用时使用（如新 PC 未安装 Node.js）
 */
async function installSkillFromGitHub(
  githubRepo: string,
  skillName: string,
  onOutput?: (data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => void
): Promise<{ success: boolean; error?: string }> {
  const path = await import('path');
  const fs = await import('fs/promises');
  const { getAgentsSkillsDir } = await import('../services/config.service');
  const { parse as parseYaml } = await import('yaml');

  const skillId = skillName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '-');
  const skillDir = path.join(getAgentsSkillsDir(), skillId);

  onOutput?.({ type: 'stdout', content: `npx not available, downloading directly from GitHub...\n` });

  // 尝试多个可能的 GitHub 路径
  const branches = ['main', 'master'];
  const pathVariants = [
    `skills/${skillName}/SKILL.md`,
    `skills/${skillName}/SKILL.yaml`,
    `skills-${skillName}/SKILL.md`,
    `skills-${skillName}/SKILL.yaml`,
    `${skillName}/SKILL.md`,
    `${skillName}/SKILL.yaml`,
  ];

  let skillContent: string | null = null;
  let isYaml = false;
  let usedBranch = 'main';
  let usedPath = '';

  for (const branch of branches) {
    for (const variant of pathVariants) {
      const url = `https://raw.githubusercontent.com/${githubRepo}/${branch}/${variant}`;
      try {
        onOutput?.({ type: 'stdout', content: `  Trying ${url}...\n` });
        const response = await fetch(url);
        if (response.ok) {
          skillContent = await response.text();
          usedBranch = branch;
          usedPath = variant;
          isYaml = variant.endsWith('.yaml')
          break;
        }
      } catch {
        // continue
      }
    }
    if (skillContent) break;
  }

  if (!skillContent) {
    const error = `Failed to download skill files from GitHub repo: ${githubRepo}`;
    onOutput?.({ type: 'error', content: `  ${error}\n` });
    return { success: false, error };
  }

  onOutput?.({ type: 'stdout', content: `  Downloaded ${usedPath} (${skillContent.length} bytes)\n` });

  try {
    // 创建技能目录
    await fs.mkdir(skillDir, { recursive: true });

    if (isYaml) {
      // SKILL.yaml 格式：直接写入文件，由 loadSkills 读取
      await fs.writeFile(path.join(skillDir, 'SKILL.yaml'), skillContent, 'utf-8');
    } else {
      // SKILL.md 格式：写入 SKILL.md（Claude Code 原生格式）
      // 同时解析 frontmatter 生成 META.json 以便 loadSkills 识别
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillContent, 'utf-8');

      // 尝试从 SKILL.md 的 frontmatter 解析元数据
      const frontmatterMatch = skillContent.match(/^---\n([\s\S]*?)\n---/)
      if (frontmatterMatch) {
        try {
          const meta = parseYaml(frontmatterMatch[1]);
          const metaJson = {
            appId: skillId,
            spec: meta,
            enabled: true,
            installedAt: new Date().toISOString()
          };
          await fs.writeFile(
            path.join(skillDir, 'META.json'),
            JSON.stringify(metaJson, null, 2),
            'utf-8'
          );
        } catch {
          // frontmatter 解析失败，写入基本 META.json
          const metaJson = {
            appId: skillId,
            enabled: true,
            installedAt: new Date().toISOString()
          };
          await fs.writeFile(
            path.join(skillDir, 'META.json'),
            JSON.stringify(metaJson, null, 2),
            'utf-8'
          );
        }
      } else {
        // 没有 frontmatter，写入基本 META.json
        const metaJson = {
          appId: skillId,
          enabled: true,
          installedAt: new Date().toISOString()
        };
        await fs.writeFile(
          path.join(skillDir, 'META.json'),
          JSON.stringify(metaJson, null, 2),
          'utf-8'
        );
      }
    }

    // 刷新技能列表
    await skillManager.refresh();

    onOutput?.({ type: 'complete', content: `✓ Skill installed successfully (via GitHub download)!\n` });
    return { success: true };
  } catch (error) {
    const err = error as Error;
    onOutput?.({ type: 'error', content: `  Failed to write skill files: ${err.message}\n` });
    return { success: false, error: err.message };
  }
}

export async function listInstalledSkills() {
  try {
    await ensureInitialized();
    const skills = skillManager.getInstalledSkills();
    return { success: true, data: skills };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to list skills' };
  }
}

export async function getSkillDetail(skillId: string) {
  try {
    await ensureInitialized();
    const skill = skillManager.getSkill(skillId);
    if (!skill) {
      return { success: false, error: 'Skill not found' };
    }
    return { success: true, data: skill };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to get skill detail' };
  }
}

export async function installSkillFromMarket(
  skillId: string,
  onOutput?: (data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => void
): Promise<{ success: boolean; error?: string }> {
  try {
    await ensureInitialized();

    console.log('[SkillController] Installing skill from market:', skillId);

    // 1. 获取技能安装信息
    const downloadResult = await skillMarket.downloadSkill(skillId);

    if (!downloadResult.success || !downloadResult.githubRepo || !downloadResult.skillName) {
      const error = downloadResult.error || 'Failed to download skill';
      onOutput?.({ type: 'error', content: error });
      return { success: false, error };
    }

    console.log('[SkillController] Skill info:', {
      githubRepo: downloadResult.githubRepo,
      skillName: downloadResult.skillName
    });

    // 2. 使用 npx 命令安装技能
    // 命令格式：npx skills add <github-repo> --skill <skill-name> -y --global
    // 默认安装到 ~/.agents/skills/
    const { spawn } = await import('child_process');

    const command = 'npx';
    const args = [
      '--yes',
      'skills',
      'add',
      `https://github.com/${downloadResult.githubRepo}`,
      '--skill',
      downloadResult.skillName,
      '-y',
      '--global'
    ];

    const fullCommand = `${command} ${args.join(' ')}`;
    console.log('[SkillController] Executing command:', fullCommand);
    onOutput?.({ type: 'stdout', content: `$ ${fullCommand}\n` });

    return new Promise((resolve) => {
      const childProcess = spawn(command, args, {
        env: { ...process.env },
        timeout: 120000, // 2 分钟超时
        shell: true  // Windows 上 npx 是 .cmd 文件，需要 shell 才能执行
      });

      let hasError = false;

      childProcess.stdout?.on('data', (data: Buffer) => {
        const content = data.toString();
        console.log('[SkillController] stdout:', content);
        onOutput?.({ type: 'stdout', content });
      });

      childProcess.stderr?.on('data', (data: Buffer) => {
        const content = data.toString();
        // 忽略 npm 警告
        if (!content.toLowerCase().includes('npm warn')) {
          console.warn('[SkillController] stderr:', content);
          onOutput?.({ type: 'stderr', content });
        }
      });

      childProcess.on('error', (error: Error) => {
        console.error('[SkillController] Process error:', error);
        hasError = true;
        const msg = error.message;
        onOutput?.({ type: 'stderr', content: `\n✗ ${msg}\n` });
        // npx not found 或其他启动错误 -> fallback 到 GitHub 下载
        onOutput?.({ type: 'stdout', content: '\n--- Fallback: downloading from GitHub ---\n' });
        installSkillFromGitHub(downloadResult.githubRepo!, downloadResult.skillName!, onOutput)
          .then(resolve)
          .catch(() => resolve({ success: false, error: msg }));
      });

      childProcess.on('close', async (code: number) => {
        console.log('[SkillController] Process exited with code:', code);

        if (code === 0 && !hasError) {
          onOutput?.({ type: 'complete', content: '\n✓ Skill installed successfully!\n' });

          try {
            await skillManager.refresh();
          } catch (refreshError) {
            console.warn('[SkillController] Failed to refresh skills:', refreshError);
          }

          resolve({ success: true });
        } else {
          // npx 执行失败（非 0 退出码） -> fallback 到 GitHub 下载
          onOutput?.({ type: 'stdout', content: '\n--- Fallback: downloading from GitHub ---\n' });
          const result = await installSkillFromGitHub(downloadResult.githubRepo!, downloadResult.skillName!, onOutput);
          if (result.success) {
            resolve({ success: true });
          } else {
            onOutput?.({ type: 'error', content: `\n✗ Both npx and GitHub download failed.\n` });
            resolve({ success: false, error: result.error });
          }
        }
      });
    });
  } catch (error) {
    console.error('[SkillController] Failed to install skill:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to install skill';
    onOutput?.({ type: 'error', content: errorMessage });
    return { success: false, error: errorMessage };
  }
}

export async function installSkillFromYaml(yamlContent: string): Promise<{ success: boolean; skillId?: string; error?: string }> {
  try {
    const skillId = await skillManager.importSkill(yamlContent);
    return { success: true, skillId };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to install skill' };
  }
}

export async function uninstallSkill(skillId: string) {
  try {
    const result = await skillManager.uninstallSkill(skillId);
    return { success: result, error: result ? undefined : 'Failed to uninstall skill' };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to uninstall skill' };
  }
}

/**
 * Install skill on local and/or specified remote servers.
 * Returns a map of target -> result status.
 */
export async function installSkillMultiTarget(
  skillId: string,
  targets: Array<{ type: 'local' } | { type: 'remote'; serverId: string }>,
  onOutput?: (targetKey: string, data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => void
): Promise<{ results: Record<string, { success: boolean; error?: string }> }> {
  const results: Record<string, { success: boolean; error?: string }> = {};

  // Step 1: Get skill info from market (needed for remote install)
  let githubRepo: string | undefined;
  let skillName: string | undefined;

  try {
    await ensureInitialized();
    const downloadResult = await skillMarket.downloadSkill(skillId);
    if (downloadResult.success && downloadResult.githubRepo && downloadResult.skillName) {
      githubRepo = downloadResult.githubRepo;
      skillName = downloadResult.skillName;
    }
  } catch (e) {
    console.warn('[SkillController] Failed to download skill info for multi-target install:', e);
  }

  // Step 2: Execute installations in parallel
  const tasks = targets.map(async (target) => {
    const key = target.type === 'local' ? 'local' : `remote:${target.serverId}`;

    if (target.type === 'local') {
      // Local install - use existing market install logic
      const localOnOutput = onOutput ? (data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => {
        onOutput(key, data);
      } : undefined;

      const result = await installSkillFromMarket(skillId, localOnOutput);
      results[key] = result;
    } else {
      // Remote install
      if (!githubRepo || !skillName) {
        onOutput?.(key, { type: 'error', content: 'Failed to get skill info for remote install\n' });
        results[key] = { success: false, error: 'Failed to get skill info' };
        return;
      }

      const remoteOnOutput = onOutput ? (data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => {
        onOutput(key, data);
      } : undefined;

      try {
        const result = await remoteDeployService.installRemoteSkill(target.serverId, skillId, githubRepo, skillName, remoteOnOutput);
        results[key] = result;
      } catch (error) {
        const err = error instanceof Error ? error.message : 'Remote install failed';
        onOutput?.(key, { type: 'error', content: `${err}\n` });
        results[key] = { success: false, error: err };
      }
    }
  });

  await Promise.all(tasks);

  // Refresh local skills if local was a target
  if (targets.some(t => t.type === 'local')) {
    try {
      await skillManager.refresh();
    } catch (e) {
      console.warn('[SkillController] Failed to refresh skills after multi-target install:', e);
    }
  }

  return { results };
}

/**
 * Uninstall skill from local and/or specified remote servers.
 */
export async function uninstallSkillMultiTarget(
  appId: string,
  targets: Array<{ type: 'local' } | { type: 'remote'; serverId: string }>,
  onOutput?: (targetKey: string, data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => void
): Promise<{ results: Record<string, { success: boolean; error?: string }> }> {
  const results: Record<string, { success: boolean; error?: string }> = {};

  const tasks = targets.map(async (target) => {
    const key = target.type === 'local' ? 'local' : `remote:${target.serverId}`;

    if (target.type === 'local') {
      try {
        const result = await skillManager.uninstallSkill(appId);
        results[key] = { success: result };
        onOutput?.(key, { type: 'complete', content: `✓ Skill "${appId}" uninstalled locally\n` });
      } catch (error) {
        const err = error instanceof Error ? error.message : 'Local uninstall failed';
        onOutput?.(key, { type: 'error', content: `✗ ${err}\n` });
        results[key] = { success: false, error: err };
      }
    } else {
      const remoteOnOutput = onOutput ? (data: { type: 'stdout' | 'stderr' | 'complete' | 'error'; content: string }) => {
        onOutput(key, data);
      } : undefined;

      try {
        const result = await remoteDeployService.uninstallRemoteSkill(target.serverId, appId, remoteOnOutput);
        results[key] = result;
      } catch (error) {
        const err = error instanceof Error ? error.message : 'Remote uninstall failed';
        onOutput?.(key, { type: 'error', content: `[remote] ${err}\n` });
        results[key] = { success: false, error: err };
      }
    }
  });

  await Promise.all(tasks);

  // Refresh local skills if local was a target
  if (targets.some(t => t.type === 'local')) {
    try {
      await skillManager.refresh();
    } catch (e) {
      console.warn('[SkillController] Failed to refresh skills after multi-target uninstall:', e);
    }
  }

  return { results };
}

export async function toggleSkill(skillId: string, enabled: boolean) {
  try {
    const result = await skillManager.toggleSkill(skillId, enabled);
    return { success: result, error: result ? undefined : 'Failed to toggle skill' };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to toggle skill' };
  }
}

export async function exportSkill(skillId: string) {
  try {
    const yamlContent = await skillManager.exportSkill(skillId);
    if (!yamlContent) {
      return { success: false, error: 'Skill not found' };
    }
    return { success: true, data: yamlContent };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to export skill' };
  }
}

export async function generateSkillFromConversation(spaceId: string, conversationId?: string) {
  try {
    const result = await skillGenerator.generateFromConversation(spaceId, conversationId);
    return result;
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to generate skill' };
  }
}

export async function generateSkillFromPrompt(options: SkillGenerateOptions) {
  try {
    const result = await skillGenerator.generateFromPrompt(options);
    return result;
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to generate skill' };
  }
}

// Market functions
export async function listMarketSkills(page?: number, pageSize?: number) {
  try {
    console.log('[SkillController] listMarketSkills called:', { page, pageSize });
    const result = await skillMarket.getSkills(page, pageSize);
    console.log('[SkillController] listMarketSkills result:', {
      skillsCount: result.skills.length,
      total: result.total,
      hasMore: result.hasMore
    });
    return { success: true, data: result };
  } catch (error) {
    console.error('[SkillController] listMarketSkills error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to fetch market skills' };
  }
}

export async function searchMarketSkills(query: string, page?: number, pageSize?: number) {
  try {
    const result = await skillMarket.searchSkills(query, page, pageSize);
    return { success: true, data: result };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to search skills' };
  }
}

export async function resetMarketCache(): Promise<{ success: boolean }> {
  skillMarket.resetCache();
  return { success: true };
}

// Market source management functions
export async function getMarketSources() {
  try {
    await ensureInitialized();
    const sources = skillMarket.getSources();
    return { success: true, data: sources };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to get market sources' };
  }
}

export async function addMarketSource(source: { name: string; url: string; repos?: string[]; description?: string }) {
  try {
    await ensureInitialized();
    const newSource = await skillMarket.addSource(source);
    return { success: true, data: newSource };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to add market source' };
  }
}

export async function removeMarketSource(sourceId: string) {
  try {
    await ensureInitialized();
    const result = await skillMarket.removeSource(sourceId);
    return { success: result, error: result ? undefined : 'Failed to remove market source (only custom sources can be removed)' };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to remove market source' };
  }
}

export async function toggleMarketSource(sourceId: string, enabled: boolean) {
  try {
    await ensureInitialized();
    await skillMarket.toggleSource(sourceId, enabled);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to toggle market source' };
  }
}

export async function setActiveMarketSource(sourceId: string) {
  try {
    await ensureInitialized();
    await skillMarket.setActiveSource(sourceId);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to set active market source' };
  }
}

export async function getMarketSkillDetail(skillId: string) {
  try {
    const skill = await skillMarket.getSkillDetail(skillId);
    if (!skill) {
      return { success: false, error: 'Skill not found' };
    }
    return { success: true, data: skill };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to get skill detail' };
  }
}

// Config functions
export async function getSkillConfig() {
  try {
    const config = skillManager.getConfig();
    return { success: true, data: config };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to get skill config' };
  }
}

export async function updateSkillConfig(config: Partial<Record<string, unknown>>) {
  try {
    await skillManager.updateConfig(config);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to update skill config' };
  }
}

export async function refreshSkills() {
  try {
    await ensureInitialized();
    await skillManager.refresh();
    const skills = skillManager.getInstalledSkills();
    return { success: true, data: skills };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to refresh skills' };
  }
}

export async function getSkillFiles(skillId: string) {
  try {
    await ensureInitialized();
    const files = await skillManager.getSkillFiles(skillId);
    return { success: true, data: files };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to get skill files' };
  }
}

export async function getSkillFileContent(skillId: string, filePath: string) {
  try {
    await ensureInitialized();
    const content = await skillManager.getSkillFileContent(skillId, filePath);
    if (content === null) {
      return { success: false, error: 'File not found or cannot be read' };
    }
    return { success: true, data: content };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to get file content' };
  }
}

export async function saveSkillFileContent(skillId: string, filePath: string, content: string) {
  try {
    await ensureInitialized();
    const success = await skillManager.saveSkillFileContent(skillId, filePath, content);
    if (!success) {
      return { success: false, error: 'Failed to save file' };
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to save file content' };
  }
}

// ============================================
// Skill Generator & Temp Agent Session
// ============================================

import { conversationAnalyzer } from '../services/skill/conversation-analyzer';
import {
  createTempAgentSession as createSdkTempSession,
  sendTempAgentMessage,
  closeTempAgentSession as closeSdkTempSession,
  getTempSessionStatus
} from '../services/skill/temp-agent-session';
import { findSimilarSkills } from '../services/skill/similarity-calculator';

// ============================================
// Skill Conversation Service (持久化会话)
// ============================================

import * as skillConversationService from '../services/skill/skill-conversation.service';

/**
 * 列出技能生成器的所有会话
 * @param relatedSkillId 可选，按技能 ID 过滤会话
 */
export async function listSkillConversations(relatedSkillId?: string) {
  try {
    const conversations = skillConversationService.listSkillConversations(relatedSkillId);
    return { success: true, data: conversations };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list skill conversations'
    };
  }
}

/**
 * 获取技能生成器会话详情
 */
export async function getSkillConversation(conversationId: string) {
  try {
    const conversation = skillConversationService.getSkillConversation(conversationId);
    if (!conversation) {
      return { success: false, error: 'Conversation not found' };
    }
    return { success: true, data: conversation };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get skill conversation'
    };
  }
}

/**
 * 创建新的技能生成器会话
 * @param title 会话标题
 * @param relatedSkillId 可选，关联的技能 ID
 */
export async function createSkillConversation(title?: string, relatedSkillId?: string) {
  try {
    const conversation = skillConversationService.createSkillConversation(title, relatedSkillId);
    return { success: true, data: conversation };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create skill conversation'
    };
  }
}

/**
 * 删除技能生成器会话
 */
export async function deleteSkillConversation(conversationId: string) {
  try {
    const result = skillConversationService.deleteSkillConversation(conversationId);
    return { success: result };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete skill conversation'
    };
  }
}

/**
 * 发送消息到技能生成器会话
 *
 * 注意：流式事件通过标准的 agent:message, agent:thought 等 IPC 通道发送，
 * 与主对话框使用相同的事件系统。前端通过 chat.store 处理这些事件。
 */
export async function sendSkillConversationMessage(
  conversationId: string,
  message: string,
  metadata?: {
    selectedConversations?: Array<{
      id: string
      title: string
      spaceName: string
      messageCount: number
      formattedContent?: string
    }>
    sourceWebpages?: Array<{
      url: string
      title?: string
      content?: string
    }>
  }
) {
  try {
    // 服务现在直接使用 sendToRenderer 发送标准的 IPC 事件
    const result = await skillConversationService.sendSkillMessage(conversationId, message, metadata);
    return result;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to send message'
    };
  }
}

/**
 * 停止技能生成器消息生成
 */
export async function stopSkillGeneration(conversationId: string) {
  try {
    skillConversationService.stopSkillGeneration(conversationId);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to stop generation'
    };
  }
}

/**
 * 关闭技能生成器会话
 */
export async function closeSkillConversation(conversationId: string) {
  try {
    skillConversationService.closeSkillSession(conversationId);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to close skill conversation'
    };
  }
}

/**
 * 分析对话，提取技能模式
 */
export async function analyzeConversations(
  spaceId: string,
  conversationIds: string[]
) {
  try {
    // 分析对话
    const analysisResult = await conversationAnalyzer.analyzeConversations(spaceId, conversationIds);

    // 获取已安装的技能
    await ensureInitialized();
    const installedSkills = skillManager.getInstalledSkills();

    // 查找相似技能
    const similarSkills = findSimilarSkills(analysisResult, installedSkills, 0.5);

    // 生成建议
    const suggestedName = generateSkillName(analysisResult);
    const suggestedCommand = generateTriggerCommand(analysisResult);

    return {
      success: true,
      data: {
        analysisResult: {
          userIntent: {
            taskType: analysisResult.userIntent.taskType,
            primaryGoal: analysisResult.userIntent.primaryGoal,
            keywords: analysisResult.userIntent.keywords
          },
          toolPattern: {
            toolSequence: analysisResult.toolPattern.toolSequence,
            successPattern: analysisResult.toolPattern.successPattern
          },
          reusability: {
            score: analysisResult.reusability.score,
            patterns: analysisResult.reusability.patterns
          }
        },
        similarSkills: similarSkills.map(s => ({
          skill: s.skill,
          similarity: s.similarity,
          matchReasons: s.matchReasons,
          suggestedImprovements: s.suggestedImprovements
        })),
        suggestedName,
        suggestedCommand
      }
    };
  } catch (error) {
    console.error('[SkillController] Failed to analyze conversations:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to analyze conversations'
    };
  }
}

/**
 * 创建临时 Agent 会话
 * 支持直接传入 context 或通过对话分析生成 context
 * @param onChunk 可选的流式回调,用于创建会话后自动发送初始消息
 */
export async function createTempAgentSession(
  options: {
    skillName: string;
    conversationIds?: string[];
    spaceIds?: string[];
    context?: {
      conversationAnalysis?: any;
      similarSkills?: any[];
      mode?: 'create' | 'optimize';
      initialPrompt?: string;
    };
    onChunk?: (chunk: StreamChunk) => void
  }
) {
  try {
    // 如果直接提供了 context，直接使用
    if (options.context) {
      console.log('[SkillController] Using provided context:', {
        hasInitialPrompt: !!options.context.initialPrompt,
        mode: options.context.mode
      });

      const result = await createSdkTempSession({
        skillName: options.skillName,
        context: {
          conversationAnalysis: options.context.conversationAnalysis || null,
          similarSkills: options.context.similarSkills || [],
          mode: options.context.mode || 'create',
          initialPrompt: options.context.initialPrompt
        },
        onChunk: options.onChunk
      });
      return result;
    }

    // 如果提供了对话ID，分析这些对话（可选）
    let context: any = { mode: 'create' };

    if (options.conversationIds && options.conversationIds.length > 0 && options.spaceIds) {
      try {
        // 合并所有对话的分析结果
        const analysisResults = [];
        for (let i = 0; i < options.conversationIds.length; i++) {
          const convId = options.conversationIds[i];
          const spaceId = options.spaceIds[i];
          if (spaceId) {
            const result = await conversationAnalyzer.analyzeConversation(spaceId, convId);
            analysisResults.push(result);
          }
        }

        // 合并分析结果
        if (analysisResults.length > 0) {
          const mergedAnalysis = mergeAnalysisResults(analysisResults);

          // 查找相似技能
          const installedSkills = skillManager.getInstalledSkills();
          const similarSkills = findSimilarSkills(mergedAnalysis, installedSkills, 0.5);

          context = {
            mode: similarSkills.length > 0 ? 'optimize' : 'create',
            conversationAnalysis: mergedAnalysis,
            similarSkills
          };
        }
      } catch (error) {
        console.warn('[SkillController] Failed to analyze conversations, creating without analysis:', error);
      }
    }

    const result = await createSdkTempSession({
      skillName: options.skillName,
      context,
      onChunk: options.onChunk
    });
    return result;
  } catch (error) {
    console.error('[SkillController] Failed to create temp session:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create temp session'
    };
  }
}

/**
 * 合并多个分析结果
 */
function mergeAnalysisResults(results: any[]): any {
  if (results.length === 0) return null;
  if (results.length === 1) return results[0];

  // 合并用户意图
  const mergedIntent = {
    taskType: results[0].userIntent.taskType,
    primaryGoal: results.map(r => r.userIntent.primaryGoal).filter(Boolean).join('; '),
    contextInfo: [...new Set(results.flatMap(r => r.userIntent.contextInfo || []))],
    keywords: [...new Set(results.flatMap(r => r.userIntent.keywords || []))]
  };

  // 合并工具模式
  const mergedToolPattern = {
    toolSequence: [...new Set(results.flatMap(r => r.toolPattern.toolSequence || []))],
    successPattern: results.map(r => r.toolPattern.successPattern).join('\n'),
    toolStats: results.reduce((acc, r) => ({ ...acc, ...r.toolPattern.toolStats }), {})
  };

  // 合并可复用性
  const mergedReusability = {
    score: Math.max(...results.map(r => r.reusability.score)),
    patterns: [...new Set(results.flatMap(r => r.reusability.patterns || []))],
    suggestions: [...new Set(results.flatMap(r => r.reusability.suggestions || []))]
  };

  return {
    userIntent: mergedIntent,
    toolPattern: mergedToolPattern,
    reusability: mergedReusability,
    sourceConversationIds: results.flatMap(r => r.sourceConversationIds)
  };
}

/**
 * 发送消息到临时会话
 */
export async function sendTempAgentMessageWithCallback(
  sessionId: string,
  message: string,
  onChunk: (chunk: any) => void
) {
  try {
    const result = await sendTempAgentMessage(sessionId, message, onChunk);
    return result;
  } catch (error) {
    console.error('[SkillController] Failed to send temp message:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to send message'
    };
  }
}

/**
 * 发送消息到临时会话（IPC 调用）
 * 使用 sendTempAgentMessageWithCallback 并提供 chunk 回调
 */
export async function sendTempAgentMessage(
  sessionId: string,
  message: string,
  onChunk?: (chunk: any) => void
) {
  return sendTempAgentMessageWithCallback(sessionId, message, onChunk || (() => {}));
}

/**
 * 关闭临时会话
 */
export async function closeTempAgentSession(sessionId: string) {
  try {
    const result = await closeSdkTempSession(sessionId);
    return result;
  } catch (error) {
    console.error('[SkillController] Failed to close temp session:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to close temp session'
    };
  }
}

// ============================================
// Helper Functions
// ============================================

/**
 * 生成技能名称
 */
function generateSkillName(analysis: any): string {
  const taskType = analysis.userIntent.taskType;
  const keywords = analysis.userIntent.keywords;

  // 基于任务类型生成名称
  const typeToName: Record<string, string> = {
    'Git 操作': 'git-helper',
    '构建编译': 'build-optimizer',
    '运行测试': 'test-runner',
    '部署发布': 'deploy-helper',
    '代码审查': 'code-reviewer',
    '代码重构': 'refactor-assistant',
    '调试修复': 'debug-helper',
    '创建生成': 'code-generator',
    '搜索查询': 'search-assistant',
    '分析解释': 'analyzer',
    'UI/样式': 'ui-styler',
    'API 开发': 'api-builder',
    '数据库操作': 'db-assistant'
  };

  let baseName = typeToName[taskType] || 'custom-skill';

  // 如果有特定的关键词，可以添加后缀
  if (keywords.length > 0) {
    const firstKeyword = keywords[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    if (firstKeyword && firstKeyword !== baseName.split('-')[0]) {
      baseName = `${firstKeyword}-helper`;
    }
  }

  return baseName;
}

/**
 * 生成触发命令
 */
function generateTriggerCommand(analysis: any): string {
  const name = generateSkillName(analysis);
  return `/${name.replace(/-/g, '')}`;
}

// ============================================
// Web Page Content Fetcher
// ============================================

/**
 * 获取网页内容（用于从网页创建技能）
 * 使用 MCP web_reader 工具获取网页内容
 */
export async function fetchWebPageContent(url: string): Promise<{
  success: boolean;
  data?: { title: string; content: string };
  error?: string;
}> {
  try {
    // 动态导入 MCP 工具
    const { MCPManager } = await import('../services/agent/mcp-manager');
    const mcpManager = MCPManager.getInstance();

    // 获取 web_reader 工具
    const webReader = mcpManager.getTool('web_reader', 'webReader');
    if (!webReader) {
      // 降级：使用简单的 HTTP fetch
      return await fetchWithHttp(url);
    }

    // 调用 MCP web_reader 工具
    const result = await mcpManager.callTool('web_reader', 'webReader', {
      url,
      return_format: 'markdown',
      retain_images: false,
      no_cache: false,
    });

    if (result.isError) {
      console.error('[SkillController] MCP web_reader error:', result.content);
      // 降级：使用简单的 HTTP fetch
      return await fetchWithHttp(url);
    }

    // 解析结果
    let content = '';
    let title = new URL(url).hostname;

    if (result.content) {
      for (const item of result.content) {
        if (item.type === 'text') {
          content += item.text || '';
        }
      }
    }

    // 从内容中提取标题
    const titleMatch = content.match(/^#\s+(.+)$/m);
    if (titleMatch) {
      title = titleMatch[1].trim();
    }

    // 限制内容长度（最多 5000 字符）
    if (content.length > 5000) {
      content = content.slice(0, 5000) + '\n\n...(内容已截断)';
    }

    return {
      success: true,
      data: { title, content }
    };
  } catch (error) {
    console.error('[SkillController] Failed to fetch webpage with MCP:', error);
    // 降级：使用简单的 HTTP fetch
    return await fetchWithHttp(url);
  }
}

/**
 * 降级方案：使用 HTTP fetch 获取网页内容
 */
async function fetchWithHttp(url: string): Promise<{
  success: boolean;
  data?: { title: string; content: string };
  error?: string;
}> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`
      };
    }

    let html = await response.text();

    // 提取标题
    let title = '';
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) {
      title = titleMatch[1].trim();
    }

    // 简单的 HTML to Markdown 转换
    let content = htmlToMarkdown(html);

    // 限制内容长度（最多 5000 字符）
    if (content.length > 5000) {
      content = content.slice(0, 5000) + '...(内容已截断)';
    }

    return {
      success: true,
      data: {
        title: title || new URL(url).hostname,
        content
      }
    };
  } catch (error) {
    console.error('[SkillController] Failed to fetch webpage:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : '获取网页失败'
    };
  }
}

/**
 * 简单的 HTML to Markdown 转换
 */
function htmlToMarkdown(html: string): string {
  let md = html;

  // 移除 script 和 style 标签及其内容
  md = md.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  md = md.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  md = md.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '');
  md = md.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '');
  md = md.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '');
  md = md.replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '');

  // 转换标题
  md = md.replace(/<h1[^>]*>([^<]+)<\/h1>/gi, '# $1\n\n');
  md = md.replace(/<h2[^>]*>([^<]+)<\/h2>/gi, '## $1\n\n');
  md = md.replace(/<h3[^>]*>([^<]+)<\/h3>/gi, '### $1\n\n');
  md = md.replace(/<h4[^>]*>([^<]+)<\/h4>/gi, '#### $1\n\n');
  md = md.replace(/<h5[^>]*>([^<]+)<\/h5>/gi, '##### $1\n\n');
  md = md.replace(/<h6[^>]*>([^<]+)<\/h6>/gi, '###### $1\n\n');

  // 转换段落
  md = md.replace(/<p[^>]*>([^<]+)<\/p>/gi, '$1\n\n');

  // 转换链接
  md = md.replace(/<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/gi, '[$2]($1)');

  // 转换加粗和斜体
  md = md.replace(/<(strong|b)[^>]*>([^<]+)<\/(strong|b)>/gi, '**$2**');
  md = md.replace(/<(em|i)[^>]*>([^<]+)<\/(em|i)>/gi, '*$2*');

  // 转换代码块
  md = md.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '```\n$1\n```\n\n');
  md = md.replace(/<code[^>]*>([^<]+)<\/code>/gi, '`$1`');

  // 转换列表
  md = md.replace(/<li[^>]*>([^<]+)<\/li>/gi, '- $1\n');
  md = md.replace(/<\/?[ou]l[^>]*>/gi, '\n');

  // 转换换行
  md = md.replace(/<br\s*\/?>/gi, '\n');

  // 移除其他 HTML 标签
  md = md.replace(/<[^>]+>/g, '');

  // 解码 HTML 实体
  md = md.replace(/&nbsp;/g, ' ');
  md = md.replace(/&amp;/g, '&');
  md = md.replace(/&lt;/g, '<');
  md = md.replace(/&gt;/g, '>');
  md = md.replace(/&quot;/g, '"');

  // 清理多余空白
  md = md.replace(/\n{3,}/g, '\n\n');
  md = md.replace(/[ \t]{2,}/g, ' ');
  md = md.trim();

  return md;
}
