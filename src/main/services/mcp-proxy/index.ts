/**
 * AICO-Bot MCP Proxy - Public API
 *
 * Provides a singleton MCP proxy server that exposes AICO-Bot's built-in
 * MCP tools (aico-bot-apps, gh-search) via HTTP for remote Claude sessions.
 */

import { AicoBotMcpProxyServer } from './mcp-proxy-server.js'

let instance: AicoBotMcpProxyServer | null = null

/**
 * Get or create the singleton MCP proxy server.
 * Starts the server if not already running.
 */
export async function getMcpProxy(authToken: string): Promise<AicoBotMcpProxyServer> {
  if (!instance) {
    instance = new AicoBotMcpProxyServer(authToken)
    await instance.start()
  }
  return instance
}

/**
 * Get the MCP proxy instance if it's running.
 */
export function getMcpProxyInstance(): AicoBotMcpProxyServer | null {
  return instance
}

/**
 * Stop the MCP proxy server.
 */
export async function stopMcpProxy(): Promise<void> {
  if (instance) {
    instance.stop()
    instance = null
  }
}

export { AicoBotMcpProxyServer } from './mcp-proxy-server.js'
