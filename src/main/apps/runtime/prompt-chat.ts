/**
 * apps/runtime -- App Chat System Prompt Builder
 *
 * Builds the system prompt for interactive chat sessions with automation Apps.
 *
 * Key difference from automation mode (prompt.ts):
 * - Automation mode: headless background execution, uses report_to_user
 * - Chat mode: interactive conversation with the user, responds directly
 *
 * Structure mirrors the automation prompt but with chat-specific overlays.
 */

import type { AppSpec } from '../spec'
import { buildSystemPrompt } from '../../services/agent/system-prompt'

// ============================================
// Chat Context Overlay
// ============================================

/**
 * Appended after the main Agent system prompt to establish chat mode
 * for an automation App. The AI retains all base capabilities but
 * operates in the context of a specific App's domain.
 */
const APP_CHAT_CONTEXT = `
## App Chat Mode

You are chatting interactively with the user about this automation App's domain.
You have the App's memory and context available.

### Key behaviors:

- **Respond directly** to the user in conversation. Do NOT use report_to_user —
  the user sees your text output directly in the chat interface.
- **Use memory** (\`mcp__halo-memory__memory_read\` / \`memory_write\`) to recall
  and persist relevant information across conversations.
- **All tools and capabilities** from the main Halo agent are available to you.
- **Stay in domain**: Focus on the App's area of expertise as defined by its
  instructions. You can still use general capabilities when the user asks.
- **AskUserQuestion**: Available in chat mode — use it when you need structured
  input from the user (choices, confirmations).
`.trim()

// ============================================
// Public API
// ============================================

export interface AppChatPromptOptions {
  /** The App's specification */
  appSpec: AppSpec
  /** Memory instructions (from memory.getPromptInstructions()) */
  memoryInstructions: string
  /** User configuration values */
  userConfig?: Record<string, unknown>
  /** Whether the App uses AI Browser */
  usesAIBrowser?: boolean
  /** Working directory for the agent */
  workDir: string
  /** Display model name */
  modelInfo?: string
}

/**
 * Build the complete system prompt for an App chat session.
 *
 * Structure:
 * 1. Full main Agent system prompt (identity, tools, coding guidelines, env)
 * 2. App Chat context overlay (interactive mode, direct response)
 * 3. App-specific system_prompt (from spec)
 * 4. Memory instructions (from memory service)
 * 5. User configuration (if any)
 */
export function buildAppChatSystemPrompt(options: AppChatPromptOptions): string {
  const sections: string[] = []

  // 1. Full main Agent system prompt
  sections.push(buildSystemPrompt({
    workDir: options.workDir,
    modelInfo: options.modelInfo,
  }))

  // 2. App Chat context overlay
  sections.push(APP_CHAT_CONTEXT)

  // 3. App-specific instructions (from App spec)
  if (options.appSpec.system_prompt) {
    sections.push(`## App Instructions\n\n${options.appSpec.system_prompt}`)
  }

  // 4. Memory instructions
  if (options.memoryInstructions) {
    sections.push(options.memoryInstructions)
  }

  // 5. User configuration context
  if (options.userConfig && Object.keys(options.userConfig).length > 0) {
    sections.push(
      `## User Configuration\n\n` +
      `The user has configured the following settings for this App:\n\n` +
      `\`\`\`json\n${JSON.stringify(options.userConfig, null, 2)}\n\`\`\``
    )
  }

  return sections.join('\n\n---\n\n')
}
