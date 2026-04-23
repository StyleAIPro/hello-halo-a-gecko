/**
 * Conversation Export Utility
 *
 * Exports a full conversation (including thoughts, tool calls, results)
 * as a beautifully formatted Markdown file.
 */

import { api } from '../api';
import type { Conversation, Message, Thought } from '../types';
import { getToolFriendlyFormat, truncateText } from '../components/chat/thought-utils';
import { useNotificationStore } from '../stores/notification.store';

// ============================================
// Markdown Generation
// ============================================

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatTimeShort(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function thoughtTypeIcon(type: Thought['type']): string {
  switch (type) {
    case 'thinking':
      return '💡';
    case 'tool_use':
      return '🔧';
    case 'tool_result':
      return '📋';
    case 'text':
      return '💬';
    case 'system':
      return '⚙️';
    case 'error':
      return '❌';
    case 'result':
      return '✅';
    default:
      return '📌';
  }
}

function thoughtTypeLabel(type: Thought['type']): string {
  switch (type) {
    case 'thinking':
      return 'Thinking';
    case 'tool_use':
      return 'Tool Call';
    case 'tool_result':
      return 'Tool Result';
    case 'text':
      return 'AI';
    case 'system':
      return 'System';
    case 'error':
      return 'Error';
    case 'result':
      return 'Complete';
    default:
      return 'AI';
  }
}

function renderThought(thought: Thought): string {
  const lines: string[] = [];
  const icon = thoughtTypeIcon(thought.type);
  const label = thoughtTypeLabel(thought.type);
  const time = formatTimeShort(thought.timestamp);

  // Header
  let header = `### ${icon} ${label}`;
  if (thought.toolName) header += ` - ${thought.toolName}`;
  header += `\n> ${time}`;
  if (thought.duration) header += ` · ${(thought.duration / 1000).toFixed(1)}s`;
  if (thought.isError || thought.toolResult?.isError) header += ' ⚠️';
  lines.push(header);
  lines.push('');

  // Content
  if (thought.type === 'tool_use') {
    // Tool input - friendly format
    const friendly = getToolFriendlyFormat(thought.toolName || '', thought.toolInput);
    if (friendly) {
      lines.push(friendly);
      lines.push('');
    }

    // Raw JSON input (truncated)
    if (thought.toolInput && Object.keys(thought.toolInput).length > 0) {
      const json = JSON.stringify(thought.toolInput, null, 2);
      if (json !== '{}') {
        lines.push('<details>');
        lines.push('<summary>Input</summary>');
        lines.push('');
        lines.push('```json');
        lines.push(truncateText(json, 3000));
        lines.push('```');
        lines.push('</details>');
        lines.push('');
      }
    }

    // Tool result
    if (thought.toolResult?.output) {
      lines.push('#### Result');
      lines.push('');
      lines.push('```');
      lines.push(truncateText(thought.toolResult.output, 5000));
      lines.push('```');
      lines.push('');
    }
  } else if (thought.type === 'error') {
    lines.push(`> ⚠️ ${thought.content}`);
    lines.push('');
  } else {
    // thinking, text, system, etc.
    const content = thought.content || thought.toolOutput || '';
    if (content) {
      lines.push(content);
      lines.push('');
    }
  }

  return lines.join('\n');
}

function renderThoughtsSection(thoughts: Thought[]): string {
  if (!thoughts || thoughts.length === 0) return '';

  const lines: string[] = [];
  lines.push('<details>');
  lines.push('<summary>🧠 Thought Process</summary>');
  lines.push('');

  // Stats
  const toolCount = thoughts.filter((t) => t.type === 'tool_use').length;
  const errorCount = thoughts.filter((t) => t.type === 'error' || t.toolResult?.isError).length;
  let statsLine = `> ${thoughts.length} steps`;
  if (toolCount > 0) statsLine += ` · ${toolCount} tool calls`;
  if (errorCount > 0) statsLine += ` · ${errorCount} errors`;

  // Duration
  if (thoughts.length >= 2) {
    const start = new Date(thoughts[0].timestamp).getTime();
    const end = new Date(thoughts[thoughts.length - 1].timestamp).getTime();
    const duration = ((end - start) / 1000).toFixed(1);
    statsLine += ` · ${duration}s`;
  }
  lines.push(statsLine);
  lines.push('');

  // Divider
  lines.push('---');
  lines.push('');

  // Render each thought, indented with blockquote for visual separation
  for (const thought of thoughts) {
    lines.push('> ' + renderThought(thought).split('\n').join('\n> '));
    lines.push('>');
    lines.push('> ---');
    lines.push('');
  }

  lines.push('</details>');
  return lines.join('\n');
}

function renderTokenUsage(usage: Message['tokenUsage']): string {
  if (!usage) return '';
  const parts: string[] = [];
  parts.push(`${usage.inputTokens} input`);
  parts.push(`${usage.outputTokens} output`);
  if (usage.cacheReadTokens) parts.push(`${usage.cacheReadTokens} cache read`);
  if (usage.cacheCreationTokens) parts.push(`${usage.cacheCreationTokens} cache create`);
  let cost = '';
  if (usage.totalCostUsd !== undefined && usage.totalCostUsd !== null) {
    cost =
      usage.totalCostUsd < 0.01
        ? `$${usage.totalCostUsd.toFixed(4)}`
        : `$${usage.totalCostUsd.toFixed(2)}`;
  }
  return `> Tokens: ${parts.join(' · ')}${cost ? ` · Cost: ${cost}` : ''}`;
}

function renderFileChanges(fileChanges: Message['metadata']['fileChanges']): string {
  if (!fileChanges || fileChanges.totalFiles === 0) return '';
  const lines: string[] = [];
  lines.push('> 📝 File Changes: ');
  if (fileChanges.edited?.length) {
    for (const f of fileChanges.edited) {
      lines.push(`> - \`${f.file}\` (+${f.added} -${f.removed})`);
    }
  }
  if (fileChanges.created?.length) {
    for (const f of fileChanges.created) {
      lines.push(`> - \`${f.file}\` (+${f.lines} new)`);
    }
  }
  lines.push(
    `> Total: ${fileChanges.totalAdded} added, ${fileChanges.totalRemoved} removed across ${fileChanges.totalFiles} file(s)`,
  );
  return lines.join('\n');
}

function renderMessage(msg: Message): string {
  const lines: string[] = [];

  // Role header
  const roleIcon = msg.role === 'user' ? '👤' : msg.role === 'system' ? '⚙️' : '🤖';
  const roleName = msg.role === 'user' ? 'User' : msg.role === 'system' ? 'System' : 'Assistant';
  let header = `## ${roleIcon} ${roleName}`;
  if (msg.agentName) header += ` (${msg.agentName})`;
  header += `\n> ${formatTimestamp(msg.timestamp)}`;
  lines.push(header);
  lines.push('');

  // Images
  if (msg.images?.length) {
    for (const img of msg.images) {
      lines.push(`📷 [Image: ${img.name || 'attachment'}]`);
    }
    lines.push('');
  }

  // Content
  if (msg.content) {
    lines.push(msg.content);
    lines.push('');
  }

  // Error
  if (msg.error) {
    lines.push(`> ❌ Error: ${msg.error}`);
    lines.push('');
  }

  // Token usage
  const usageStr = renderTokenUsage(msg.tokenUsage);
  if (usageStr) {
    lines.push(usageStr);
    lines.push('');
  }

  // File changes
  const fileChangesStr = renderFileChanges(msg.metadata?.fileChanges);
  if (fileChangesStr) {
    lines.push(fileChangesStr);
    lines.push('');
  }

  // Thoughts
  const thoughtsStr = renderThoughtsSection(msg.thoughts || []);
  if (thoughtsStr) {
    lines.push(thoughtsStr);
    lines.push('');
  }

  // Separator
  lines.push('---');
  lines.push('');

  return lines.join('\n');
}

export function conversationToMarkdown(conversation: Conversation): string {
  const lines: string[] = [];

  // Header
  lines.push(`# ${conversation.title}`);
  lines.push('');
  lines.push(
    `> Created: ${formatTimestamp(conversation.createdAt)} | Updated: ${formatTimestamp(conversation.updatedAt)}`,
  );
  if (conversation.messages.length > 0) {
    lines.push(`> ${conversation.messages.length} messages`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Messages
  for (const msg of conversation.messages) {
    lines.push(renderMessage(msg));
  }

  // Footer
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('*Exported from AICO-Bot*');

  return lines.join('\n');
}

// ============================================
// Export Function (fetch + generate + download)
// ============================================

async function loadAllThoughts(
  spaceId: string,
  conversationId: string,
  conversation: Conversation,
): Promise<Conversation> {
  const messagesWithThoughts = await Promise.all(
    conversation.messages.map(async (msg) => {
      if (msg.thoughts === null) {
        // Thoughts stored separately, need to load
        try {
          const response = await api.getMessageThoughts(spaceId, conversationId, msg.id);
          if (response.success && response.data) {
            return { ...msg, thoughts: response.data as Thought[] };
          }
        } catch (err) {
          console.error(`Failed to load thoughts for message ${msg.id}:`, err);
        }
      }
      return msg;
    }),
  );
  return { ...conversation, messages: messagesWithThoughts };
}

function triggerDownload(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 100);
}

export async function exportConversationAsMarkdown(
  spaceId: string,
  conversationId: string,
): Promise<void> {
  const showToast = useNotificationStore.getState().show;

  try {
    // 1. Fetch full conversation
    const response = await api.getConversation(spaceId, conversationId);
    if (!response.success || !response.data) {
      showToast({
        title: 'Export failed',
        body: 'Failed to load conversation data.',
        variant: 'error',
        duration: 4000,
      });
      throw new Error('Failed to load conversation');
    }

    const conversation = response.data as Conversation;

    // 2. Load all thoughts (including separately stored ones)
    const fullConversation = await loadAllThoughts(spaceId, conversationId, conversation);

    // 3. Generate markdown
    const markdown = conversationToMarkdown(fullConversation);

    // 4. Trigger download
    const safeTitle = sanitizeFilename(conversation.title || 'conversation');
    const date = new Date().toISOString().slice(0, 10);
    const filename = `${safeTitle}_${date}.md`;
    triggerDownload(markdown, filename);

    // 5. Show success toast
    showToast({
      title: 'Export succeeded',
      body: `${filename}`,
      variant: 'success',
      duration: 3000,
    });
  } catch (err) {
    // Only show toast if not already shown above
    if (err?.message !== 'Failed to load conversation') {
      showToast({
        title: 'Export failed',
        body: err instanceof Error ? err.message : 'Unknown error',
        variant: 'error',
        duration: 4000,
      });
    }
    throw err;
  }
}
