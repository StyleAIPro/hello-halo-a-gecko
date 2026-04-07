/**
 * Halo MCP Proxy - Public API
 *
 * Provides a singleton MCP proxy server that exposes Halo's built-in
 * MCP tools (halo-apps, gh-search) via HTTP for remote Claude sessions.
 */

import { HaloMcpProxyServer } from './mcp-proxy-server.js'

let instance: HaloMcpProxyServer | null = null

/**
 * Get or create the singleton MCP proxy server.
 * Starts the server if not already running.
 */
export async function getMcpProxy(authToken: string): Promise<HaloMcpProxyServer> {
  if (!instance) {
    instance = new HaloMcpProxyServer(authToken)
    await instance.start()
  }
  return instance
}

/**
 * Get the MCP proxy instance if it's running.
 */
export function getMcpProxyInstance(): HaloMcpProxyServer | null {
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

export { HaloMcpProxyServer } from './mcp-proxy-server.js'
