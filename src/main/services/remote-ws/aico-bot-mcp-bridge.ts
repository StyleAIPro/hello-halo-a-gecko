/**
 * AICO-Bot MCP Bridge
 *
 * Collects PC resource MCP tool definitions (ai-browser, gh-search, user-configured),
 * serializes them for WebSocket transmission, and dispatches incoming tool
 * calls from the remote proxy to the correct local handler.
 *
 * Architecture: Only PC resources are bridged to the remote proxy.
 * Business logic tools (aico-bot-apps, hyper-space) are NOT bridged —
 * the remote proxy has its own independent implementations.
 *
 * Key design:
 * - Tool handlers are kept in memory on the AICO-Bot side (never serialized)
 * - Only metadata (name, description, inputSchema) is sent to the remote proxy
 * - The remote proxy reconstructs in-process MCP servers using these definitions
 */

import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { buildAllTools as buildAiBrowserTools } from '../ai-browser/sdk-mcp-server'
import { browserContext } from '../ai-browser/context'
import { buildAllTools as buildGhSearchTools } from '../gh-search/sdk-mcp-server'

// ============================================
// Types
// ============================================

/** Serialized MCP tool definition for WebSocket transmission */
export interface AicoBotMcpToolDef {
  name: string
  description: string
  /** Zod raw shape, serialized as plain object */
  inputSchema: Record<string, any>
  /** Source MCP server name */
  serverName: string
}

/** Capability flags advertised to the remote proxy */
export interface AicoBotMcpCapabilities {
  aiBrowser: boolean
  ghSearch: boolean
  version: number
}

// ============================================
// AicoBotMcpBridge
// ============================================

export class AicoBotMcpBridge {
  /**
   * Map of tool name -> { handler, serverName }
   * Handlers are closure-captured functions from the original MCP tool definitions.
   * They are never serialized — only used for local execution.
   */
  private tools = new Map<string, { handler: (args: any, extra: any) => Promise<any>; serverName: string }>()

  /**
   * Collect tool definitions from local PC resource MCP servers and build the handler map.
   *
   * Only bridges PC resource tools (ai-browser, gh-search). Business logic tools
   * (aico-bot-apps, hyper-space) are handled independently by the remote proxy.
   *
   * @param spaceId - Space ID (reserved for future use with user-configured MCP)
   * @param includeAiBrowser - Whether to include ai-browser tools (default: true)
   * @returns Serialized tool definitions for WebSocket transmission
   */
  collectTools(spaceId: string, includeAiBrowser = true): AicoBotMcpToolDef[] {
    this.tools.clear()

    const allDefs: AicoBotMcpToolDef[] = []

    // 1. AI Browser tools (26 tools) — PC resource, bridged
    if (includeAiBrowser) {
      try {
        const aiBrowserTools = buildAiBrowserTools(browserContext)
        for (const toolDef of aiBrowserTools) {
          const def = toolDef as SdkMcpToolDefinition
          this.tools.set(def.name, {
            handler: def.handler,
            serverName: 'ai-browser'
          })
          allDefs.push({
            name: def.name,
            description: def.description,
            inputSchema: def.inputSchema as Record<string, any>,
            serverName: 'ai-browser'
          })
        }
        console.log(`[AicoBotMcpBridge] Collected ${aiBrowserTools.length} ai-browser tools`)
      } catch (error) {
        console.warn(`[AicoBotMcpBridge] Failed to collect ai-browser tools:`, error)
      }
    }

    // 2. GitHub Search tools (8 tools) — PC resource, bridged
    try {
      const ghSearchTools = buildGhSearchTools()
      for (const toolDef of ghSearchTools) {
        const def = toolDef as SdkMcpToolDefinition
        this.tools.set(def.name, {
          handler: def.handler,
          serverName: 'gh-search'
        })
        allDefs.push({
          name: def.name,
          description: def.description,
          inputSchema: def.inputSchema as Record<string, any>,
          serverName: 'gh-search'
        })
      }
      console.log(`[AicoBotMcpBridge] Collected ${ghSearchTools.length} gh-search tools`)
    } catch (error) {
      console.warn(`[AicoBotMcpBridge] Failed to collect gh-search tools:`, error)
    }

    // Note: aico-bot-apps tools are NOT bridged. The remote proxy has its own
    // independent AppManager + AppRuntime (Phase 3).

    console.log(`[AicoBotMcpBridge] Total: ${allDefs.length} tools collected`)
    return allDefs
  }

  /**
   * Add user-configured MCP tool definitions to the bridge.
   * These are tools from MCP servers configured by the user in settings.
   *
   * @param tools - Tool definitions from user-configured MCP servers
   */
  addUserMcpTools(tools: AicoBotMcpToolDef[]): void {
    for (const toolDef of tools) {
      // Don't overwrite existing tools
      if (!this.tools.has(toolDef.name)) {
        // No handler for user MCP tools — they will be handled via
        // a generic MCP client connection in a future phase
        this.tools.set(toolDef.name, {
          handler: async () => ({
            content: [{ type: 'text', text: 'User MCP tool execution not yet implemented in bridge mode' }],
            isError: true
          }),
          serverName: toolDef.serverName
        })
      }
    }
    console.log(`[AicoBotMcpBridge] Added ${tools.length} user MCP tool definitions (handlers pending future phase)`)
  }

  /**
   * Handle an incoming MCP tool call from the remote proxy.
   * Dispatches to the correct local handler and returns the result.
   *
   * @param toolName - Name of the tool to call (e.g. 'browser_click')
   * @param args - Tool input arguments
   * @returns CallToolResult shape: { content: [...], isError?: boolean }
   */
  async handleToolCall(toolName: string, args: Record<string, unknown>): Promise<any> {
    const entry = this.tools.get(toolName)
    if (!entry) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
        isError: true
      }
    }

    console.log(`[AicoBotMcpBridge] Executing tool: ${entry.serverName}:${toolName}`)

    try {
      const result = await entry.handler(args, null)
      // Handler may return CallToolResult or a string
      if (typeof result === 'string') {
        return { content: [{ type: 'text', text: result }] }
      }
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[AicoBotMcpBridge] Tool error (${entry.serverName}:${toolName}):`, message)
      return {
        content: [{ type: 'text', text: `Error executing ${toolName}: ${message}` }],
        isError: true
      }
    }
  }

  /**
   * Get the number of registered tools.
   */
  getToolCount(): number {
    return this.tools.size
  }

  /**
   * Get the capabilities based on registered tools.
   */
  getCapabilities(): AicoBotMcpCapabilities {
    let aiBrowser = false
    let ghSearch = false

    for (const entry of this.tools.values()) {
      if (entry.serverName === 'ai-browser') aiBrowser = true
      if (entry.serverName === 'gh-search') ghSearch = true
    }

    return {
      aiBrowser,
      ghSearch,
      version: 2,
    }
  }

  /**
   * Clean up tool references.
   */
  dispose(): void {
    this.tools.clear()
    console.log('[AicoBotMcpBridge] Disposed')
  }
}
