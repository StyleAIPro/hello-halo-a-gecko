/**
 * apps/runtime -- App System Prompt Builder
 *
 * Assembles the complete system prompt for automation App sessions.
 *
 * Strategy: start with the FULL main Agent system prompt (identity, tools,
 * coding guidelines, tool usage policy, environment info), then append
 * automation-specific context and App instructions.
 *
 * This ensures automation Apps have 100% of the main Agent's capabilities.
 * The only difference is operating mode: headless background execution
 * instead of interactive conversation.
 */

import type { AppSpec } from '../spec'
import { buildSystemPrompt } from '../../services/agent/system-prompt'

// ============================================
// Automation Context Overlay
// ============================================

/**
 * Appended after the main Agent system prompt to establish automation mode.
 * Provides context-specific overrides without removing any base capabilities.
 */
const AUTOMATION_CONTEXT = `
## Automation Mode

You are currently executing as a scheduled/triggered automation App.
This is a headless background execution — there is no interactive user conversation.

### Key differences from interactive mode:

- **User communication**: Use \`mcp__halo-report__report_to_user\` to report results.
  The user sees these reports in the Activity Thread, not your text output.
- **User questions**: Use the escalation mechanism (type="escalation" in report_to_user)
  when you need user input. Do NOT use AskUserQuestion — it is unavailable in automation mode.
- **Autonomy**: Execute the task to completion without asking for confirmation.
  Only escalate when genuinely uncertain about a consequential decision.
- **All other tools and capabilities remain identical** to the main Halo agent.

### Browser session

You run inside the user's own Halo browser — cookies, session, and localStorage are shared.
If a website requires login, ask the user to log in first via escalation, then retry.
`.trim()

// ============================================
// Reporting Rules (injected into all automation sessions)
// ============================================

const REPORTING_RULES = `
## Reporting (MCP server: halo-report)

You are an AI employee who proactively reports work progress.
Use \`mcp__halo-report__report_to_user\` to communicate results to the user.

### When to Report

1. **Every execution completion** (type="run_complete") — regardless of outcome.
   Include a clear summary of what happened and any key findings.

2. **Important discoveries** (type="milestone") — when you find information
   of significant value to the user. Don't wait until the end to report it.

3. **Uncertain decisions** (type="escalation") — when you encounter any
   situation where you're unsure what the user would want. Do NOT make
   assumptions. Ask first, then wait for the user's response.

4. **Deliverable outputs** (type="output") — when you produce files,
   reports, or other artifacts. Tell the user where to find them.

### Writing Style

Write the \`summary\` field for humans — be clear, direct, and avoid
technical jargon.

Example: ✅ "AirPods Pro lowest price today: ¥1199, no change from yesterday"
Not:     ❌ "Successfully fetched 3 URLs, price delta: 0"
`.trim()

// ============================================
// Sub-Agent Instructions (when App uses AI Browser)
// ============================================

const SUB_AGENT_INSTRUCTIONS = `
## Browser Task Delegation

When you need to interact with web pages, use the Task tool to delegate
to a sub-agent. The sub-agent inherits your MCP tools including browser tools.

Pattern:
1. Read memory to recall previous state
2. Use Task tool with clear instructions for the browser sub-agent
3. The sub-agent navigates, extracts data, returns structured JSON
4. You process the data, make decisions, update memory, and report

Example Task tool prompt:
"Navigate to https://example.com, use browser_snapshot to get the page structure,
extract the price from the product listing, and return it as JSON: { price: number, currency: string }"
`.trim()

// ============================================
// Notification Instructions (when channels are configured)
// ============================================

const NOTIFICATION_INSTRUCTIONS = `
## External Notifications (MCP server: halo-notify)

You can send notifications to external channels (email, WeCom, DingTalk, Feishu, webhook)
when you discover something important that the user should know about immediately.

### Tools

- \`mcp__halo-notify__list_notification_channels\` — Check which channels are configured and enabled
- \`mcp__halo-notify__send_notification\` — Send a notification to a specific channel

### When to Use

- **Important discoveries**: Price drops, anomalies, urgent changes detected
- **User-requested alerts**: When the app's purpose is to monitor and alert
- **Critical errors**: Issues that require immediate user attention

### When NOT to Use

- For routine run completion reports — use report_to_user instead
- If the app's output.notify already covers the channel — the system will send automatically on completion
- For every run — only notify when there's genuinely noteworthy information

### Tips

- Call list_notification_channels first to check availability
- Write notification body for humans — clear, specific, actionable
- Include key data points (prices, dates, names) directly in the body
`.trim()

// ============================================
// Public API
// ============================================

export interface AppPromptOptions {
  /** The App's specification */
  appSpec: AppSpec
  /** Memory instructions (from memory.getPromptInstructions()) */
  memoryInstructions: string
  /** Trigger context description */
  triggerContext: string
  /** User configuration values */
  userConfig?: Record<string, unknown>
  /** Whether the App uses AI Browser (includes sub-agent instructions) */
  usesAIBrowser?: boolean
  /** Working directory for the agent (passed to base system prompt) */
  workDir: string
  /** Display model name (passed to base system prompt) */
  modelInfo?: string
}

/**
 * Build the complete system prompt for an automation App session.
 *
 * Structure:
 * 1. Full main Agent system prompt (identity, tools, coding guidelines, env)
 * 2. Automation context overlay (headless mode, report_to_user, escalation)
 * 3. App-specific system_prompt (from spec)
 * 4. Memory instructions (from memory service)
 * 5. Reporting rules (report_to_user usage)
 * 6. Sub-agent instructions (if App uses AI Browser)
 */
export function buildAppSystemPrompt(options: AppPromptOptions): string {
  const sections: string[] = []

  // 1. Full main Agent system prompt — gives the automation agent
  //    100% of the same capabilities as the interactive agent
  sections.push(buildSystemPrompt({
    workDir: options.workDir,
    modelInfo: options.modelInfo,
  }))

  // 2. Automation context overlay — establishes headless mode,
  //    overrides interaction patterns (escalation vs AskUserQuestion)
  sections.push(AUTOMATION_CONTEXT)

  // 3. App-specific instructions (from App spec)
  if (options.appSpec.system_prompt) {
    sections.push(`## App Instructions\n\n${options.appSpec.system_prompt}`)
  }

  // 4. Memory instructions (from memory service)
  if (options.memoryInstructions) {
    sections.push(options.memoryInstructions)
  }

  // 5. Reporting rules
  sections.push(REPORTING_RULES)

  // 6. Notification instructions (always included — the AI can check availability)
  sections.push(NOTIFICATION_INSTRUCTIONS)

  // 7. Sub-agent instructions (only if App uses AI Browser)
  if (options.usesAIBrowser) {
    sections.push(SUB_AGENT_INSTRUCTIONS)
  }

  return sections.join('\n\n---\n\n')
}

/**
 * Build the initial user message that starts an automation run.
 *
 * Includes: trigger context, user configuration, and task instructions.
 */
export function buildInitialMessage(options: {
  triggerContext: string
  userConfig?: Record<string, unknown>
  appName: string
}): string {
  const parts: string[] = []

  parts.push(`## Trigger\n\n${options.triggerContext}`)

  if (options.userConfig && Object.keys(options.userConfig).length > 0) {
    parts.push(`## User Configuration\n\n\`\`\`json\n${JSON.stringify(options.userConfig, null, 2)}\n\`\`\``)
  }

  parts.push(
    `## Instructions\n\nExecute the "${options.appName}" task based on the trigger above. ` +
    `Use \`mcp__halo-memory__memory_read\` first to recall previous state, then proceed with the task. ` +
    `Report your findings via \`mcp__halo-report__report_to_user\` when done.`
  )

  return parts.join('\n\n')
}
