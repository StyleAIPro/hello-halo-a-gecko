/**
 * platform/memory -- Prompt Instructions
 *
 * Generates system prompt fragments that teach the AI how to use memory tools.
 * The content varies based on caller scope (user vs app) and what memory
 * currently exists.
 *
 * V2: Emphasizes state-document model, structured headings, efficient
 * read modes (headers → section), and replace-over-append for maintenance.
 */

import { existsSync } from 'fs'
import type { MemoryCallerScope } from './types'
import { getMemoryFilePath } from './paths'
import { getReadableScopes } from './permissions'
import { getFileSize } from './file-ops'

/** Files larger than this hint the AI to use headers mode first */
const LARGE_FILE_HINT_BYTES = 4096

/**
 * Generate system prompt instructions for memory usage.
 *
 * @param caller - Identity of the caller
 * @returns Markdown-formatted prompt fragment
 */
export async function generatePromptInstructions(caller: MemoryCallerScope): Promise<string> {
  const readableScopes = getReadableScopes(caller)

  // Check which memory files exist and their sizes
  const existingMemory: Array<{ scope: string; sizeBytes: number }> = []
  for (const scope of readableScopes) {
    if (caller.type === 'user' && scope === 'app') continue
    if (scope === 'app' && !caller.appId) continue

    try {
      const filePath = getMemoryFilePath(caller, scope)
      if (existsSync(filePath)) {
        const size = await getFileSize(filePath)
        existingMemory.push({ scope, sizeBytes: size })
      }
    } catch {
      // Ignore path resolution errors
    }
  }

  const hasLargeMemory = existingMemory.some(m => m.sizeBytes > LARGE_FILE_HINT_BYTES)

  // Build the instructions
  const lines: string[] = []

  lines.push('## Memory (MCP server: halo-memory)')
  lines.push('')
  lines.push('You have persistent memory across sessions via MCP server "halo-memory".')
  lines.push('')
  lines.push('### Available Tools (prefix: mcp__halo-memory__)')
  lines.push('- `memory_read` - Read from a memory scope (supports modes: full, headers, section, tail)')
  lines.push('- `memory_write` - Write to a memory scope (append or replace)')
  lines.push('- `memory_list` - List archived memory files')
  lines.push('')

  // Scope descriptions
  if (caller.type === 'user') {
    lines.push('### Scopes')
    lines.push('- **user**: Your personal memory (preferences, habits, cross-project knowledge)')
    lines.push('- **space**: Project-specific knowledge (conventions, architecture decisions, known issues)')
  } else {
    lines.push('### Scopes')
    lines.push('- **user**: User preferences (read-only)')
    lines.push('- **space**: Shared workspace knowledge (append-only)')
    lines.push('- **app**: Your private app memory (full read/write)')
  }
  lines.push('')

  // What exists + size hints
  if (existingMemory.length > 0) {
    const scopeInfo = existingMemory.map(m => {
      const sizeKB = (m.sizeBytes / 1024).toFixed(1)
      return `${m.scope} (${sizeKB}KB)`
    }).join(', ')
    lines.push(`Memory files exist for: ${scopeInfo}.`)

    if (hasLargeMemory) {
      lines.push('Large memory detected -- use mode="headers" first, then mode="section" to read specific parts.')
    } else {
      lines.push('Read them at the start of your task.')
    }
  } else {
    lines.push('No memory files exist yet. Create them as you learn useful information.')
  }
  lines.push('')

  // Rules (V2: state-document emphasis, structured headings, replace guidance)
  lines.push('### Rules')
  lines.push('- Read memory at the START of a task to recall context')
  lines.push('- For large memory files, use mode="headers" first, then read specific sections')
  lines.push('- memory.md is a STATE document, not a log')
  lines.push('  - Write what the NEXT run needs: patterns, tracking lists, decisions, config')
  lines.push('  - Do NOT write: execution timestamps, task confirmations, per-run diary entries')
  lines.push('- Structure memory with clear markdown headings (## State, ## Patterns, ## Config)')
  lines.push('- When memory has stale/duplicate content, use mode="replace" to write a clean version')
  lines.push('- NEVER store secrets, API keys, or credentials in memory')

  return lines.join('\n')
}
