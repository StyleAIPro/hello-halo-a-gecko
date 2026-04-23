/**
 * Mailbox Service for Multi-Agent Group Chat
 *
 * Provides durable, file-based messaging between agents.
 * Messages are stored as JSON files in ~/.aico-bot/spaces/{spaceId}/mailboxes/.
 *
 * Uses write-then-rename atomic pattern for writes (safe on NTFS)
 * and a cursor-based polling approach for reads.
 *
 * @module mailbox
 */

import { join } from 'path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  rmSync,
} from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { getSpacesDir } from '../config.service';
import { createLogger } from '../../utils/logger';
import type {
  MailboxMessage,
  MailboxFile,
  MailboxMessageType,
  MailboxPayload,
} from '../../../shared/types/mailbox';
import { createEmptyMailboxFile, isProtocolMessage } from '../../../shared/types/mailbox';

const log = createLogger('mailbox');

// ============================================
// Mailbox Service
// ============================================

/**
 * Manages file-based mailboxes for agent messaging.
 *
 * Each agent in a Hyper Space has its own mailbox file.
 * Messages are appended atomically and read with a cursor.
 */
export class MailboxService {
  /** Track initialized space IDs to avoid duplicate init */
  private initializedSpaces: Set<string> = new Set();

  /** Track agent IDs per space for broadcast support */
  private spaceAgents: Map<string, Set<string>> = new Map();

  /**
   * Initialize mailboxes for all agents in a team.
   * Creates the mailboxes directory and one file per agent.
   */
  initialize(spaceId: string, teamId: string, agentIds: string[]): void {
    const mailboxesDir = this.getMailboxesDir(spaceId);

    // Create directory if it doesn't exist
    if (!existsSync(mailboxesDir)) {
      mkdirSync(mailboxesDir, { recursive: true });
      log.info(`Created mailboxes directory: ${mailboxesDir}`);
    }

    // Create mailbox file for each agent
    for (const agentId of agentIds) {
      const filePath = this.getMailboxPath(spaceId, agentId);
      if (!existsSync(filePath)) {
        const mailbox = createEmptyMailboxFile(agentId, teamId);
        this.writeMailboxFile(filePath, mailbox);
        log.debug(`Created mailbox for agent: ${agentId}`);
      }
    }

    // Track agents for broadcast support
    this.spaceAgents.set(spaceId, new Set(agentIds));
    this.initializedSpaces.add(spaceId);

    log.info(`Initialized mailboxes for space ${spaceId}: ${agentIds.length} agents`);
  }

  /**
   * Destroy all mailboxes for a space.
   * Removes the entire mailboxes directory.
   */
  destroy(spaceId: string): void {
    const mailboxesDir = this.getMailboxesDir(spaceId);

    try {
      if (existsSync(mailboxesDir)) {
        rmSync(mailboxesDir, { recursive: true, force: true });
        log.info(`Destroyed mailboxes for space: ${spaceId}`);
      }
    } catch (err) {
      log.error(`Failed to destroy mailboxes for space ${spaceId}:`, err);
    }

    this.spaceAgents.delete(spaceId);
    this.initializedSpaces.delete(spaceId);
  }

  /**
   * Post a message to a specific agent's mailbox.
   * Uses atomic write-then-rename pattern.
   */
  postMessage(
    spaceId: string,
    recipientId: string,
    message: Omit<MailboxMessage, 'id' | 'timestamp'>,
  ): string {
    const messageId = uuidv4();
    const fullMessage: MailboxMessage = {
      ...message,
      id: messageId,
      timestamp: Date.now(),
    };

    const filePath = this.getMailboxPath(spaceId, recipientId);

    if (!existsSync(filePath)) {
      log.warn(`Mailbox file not found for ${recipientId}, skipping post`);
      return messageId;
    }

    try {
      // Read current mailbox
      const mailbox = this.readMailboxFile(filePath);

      // Append new message
      mailbox.messages.push(fullMessage);

      // Write atomically (write to .tmp, then rename)
      this.writeMailboxFileAtomic(filePath, mailbox);

      log.debug(`Posted ${message.type} message to ${recipientId}: ${messageId}`);
    } catch (err) {
      log.error(`Failed to post message to ${recipientId}:`, err);
    }

    return messageId;
  }

  /**
   * Broadcast a message to all agents in a space.
   * Optionally excludes one agent (e.g., the sender).
   */
  broadcastMessage(
    spaceId: string,
    message: Omit<MailboxMessage, 'id' | 'timestamp'>,
    excludeAgentId?: string,
  ): string[] {
    const agentIds = this.spaceAgents.get(spaceId);
    if (!agentIds) {
      log.warn(`No agents tracked for space ${spaceId}, cannot broadcast`);
      return [];
    }

    const messageIds: string[] = [];

    for (const agentId of agentIds) {
      if (agentId === excludeAgentId) continue;
      if (agentId === message.senderId) continue; // Don't send to self

      const id = this.postMessage(spaceId, agentId, message);
      messageIds.push(id);
    }

    log.debug(`Broadcast ${message.type} to ${messageIds.length} agents in space ${spaceId}`);
    return messageIds;
  }

  /**
   * Poll for unread messages from an agent's mailbox.
   * Returns messages after the agent's lastReadIndex cursor.
   * Updates the cursor after reading.
   */
  pollMessages(agentId: string, spaceId: string): MailboxMessage[] {
    const filePath = this.getMailboxPath(spaceId, agentId);

    if (!existsSync(filePath)) {
      return [];
    }

    try {
      const mailbox = this.readMailboxFile(filePath);
      const startIndex = mailbox.lastReadIndex + 1;

      if (startIndex >= mailbox.messages.length) {
        return []; // Nothing new
      }

      // Extract unread messages
      const unread = mailbox.messages.slice(startIndex);

      // Update cursor
      mailbox.lastReadIndex = mailbox.messages.length - 1;
      this.writeMailboxFileAtomic(filePath, mailbox);

      log.debug(`${agentId} polled ${unread.length} new messages`);
      return unread;
    } catch (err) {
      log.error(`Failed to poll messages for ${agentId}:`, err);
      return [];
    }
  }

  /**
   * Get the count of unread messages for an agent.
   */
  getUnreadCount(agentId: string, spaceId: string): number {
    const filePath = this.getMailboxPath(spaceId, agentId);

    if (!existsSync(filePath)) {
      return 0;
    }

    try {
      const mailbox = this.readMailboxFile(filePath);
      return mailbox.messages.length - 1 - mailbox.lastReadIndex;
    } catch (err) {
      log.error(`Failed to get unread count for ${agentId}:`, err);
      return 0;
    }
  }

  /**
   * Get all messages from an agent's mailbox (for debugging/admin).
   * Does NOT update the read cursor.
   */
  getAllMessages(agentId: string, spaceId: string): MailboxMessage[] {
    const filePath = this.getMailboxPath(spaceId, agentId);

    if (!existsSync(filePath)) {
      return [];
    }

    try {
      const mailbox = this.readMailboxFile(filePath);
      return mailbox.messages;
    } catch (err) {
      log.error(`Failed to read all messages for ${agentId}:`, err);
      return [];
    }
  }

  /**
   * Get all chat-visible messages (non-protocol) from an agent's mailbox.
   */
  getChatMessages(agentId: string, spaceId: string): MailboxMessage[] {
    return this.getAllMessages(agentId, spaceId).filter((msg) => !isProtocolMessage(msg));
  }

  /**
   * Add a new agent to an existing space's mailbox system.
   */
  addAgent(spaceId: string, teamId: string, agentId: string): void {
    const agents = this.spaceAgents.get(spaceId);
    if (agents) {
      agents.add(agentId);
    }

    const filePath = this.getMailboxPath(spaceId, agentId);
    if (!existsSync(filePath)) {
      const mailbox = createEmptyMailboxFile(agentId, teamId);
      this.writeMailboxFile(filePath, mailbox);
      log.info(`Added mailbox for agent: ${agentId} in space ${spaceId}`);
    }
  }

  /**
   * Remove an agent's mailbox from a space.
   */
  removeAgent(spaceId: string, agentId: string): void {
    const agents = this.spaceAgents.get(spaceId);
    if (agents) {
      agents.delete(agentId);
    }

    const filePath = this.getMailboxPath(spaceId, agentId);
    try {
      if (existsSync(filePath)) {
        unlinkSync(filePath);
        log.info(`Removed mailbox for agent: ${agentId} in space ${spaceId}`);
      }
    } catch (err) {
      log.error(`Failed to remove mailbox for ${agentId}:`, err);
    }
  }

  /**
   * Check if a space's mailbox system is initialized.
   */
  isInitialized(spaceId: string): boolean {
    return this.initializedSpaces.has(spaceId);
  }

  /**
   * Get all agent IDs tracked for a space.
   */
  getAgentIds(spaceId: string): string[] {
    const agents = this.spaceAgents.get(spaceId);
    return agents ? Array.from(agents) : [];
  }

  // ============================================
  // Private Methods
  // ============================================

  /**
   * Get the mailboxes directory path for a space.
   */
  private getMailboxesDir(spaceId: string): string {
    return join(getSpacesDir(), spaceId, 'mailboxes');
  }

  /**
   * Get the mailbox file path for a specific agent.
   */
  private getMailboxPath(spaceId: string, agentId: string): string {
    // Sanitize agentId for use as filename (replace problematic chars)
    const safeAgentId = agentId.replace(/[^a-zA-Z0-9_\-]/g, '_');
    return join(this.getMailboxesDir(spaceId), `${safeAgentId}.json`);
  }

  /**
   * Read and parse a mailbox file.
   */
  private readMailboxFile(filePath: string): MailboxFile {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as MailboxFile;
  }

  /**
   * Write a mailbox file (non-atomic, for initial creation).
   */
  private writeMailboxFile(filePath: string, mailbox: MailboxFile): void {
    writeFileSync(filePath, JSON.stringify(mailbox, null, 2), 'utf-8');
  }

  /**
   * Write a mailbox file atomically using write-then-rename.
   * This is safe on NTFS and most POSIX filesystems.
   */
  private writeMailboxFileAtomic(filePath: string, mailbox: MailboxFile): void {
    const tmpPath = `${filePath}.tmp`;

    try {
      // Write to temp file
      writeFileSync(tmpPath, JSON.stringify(mailbox, null, 2), 'utf-8');

      // Atomic rename (overwrites existing file)
      writeFileSync(filePath, readFileSync(tmpPath, 'utf-8'), 'utf-8');

      // Clean up temp file
      try {
        unlinkSync(tmpPath);
      } catch {
        // Ignore cleanup errors
      }
    } catch (err) {
      // Clean up temp file on error
      try {
        if (existsSync(tmpPath)) {
          unlinkSync(tmpPath);
        }
      } catch {
        // Ignore cleanup errors
      }
      throw err;
    }
  }
}

// ============================================
// Singleton Export
// ============================================

/** Global mailbox service instance */
export const mailboxService = new MailboxService();
