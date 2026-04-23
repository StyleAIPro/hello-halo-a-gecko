/**
 * AICO-Bot MCP Proxy Server
 *
 * Exposes AICO-Bot's built-in MCP tools (aico-bot-apps, gh-search) via the
 * MCP Streamable HTTP protocol. This allows remote Claude instances
 * to access these tools through an HTTP connection.
 *
 * Architecture:
 * - Single HTTP server on 127.0.0.1
 * - Per-space McpServer instances (cached in Map)
 * - URL path encodes spaceId: /mcp/:spaceId
 * - Auth via Bearer token
 *
 * Tools exposed:
 * - aico-bot-apps: 8 tools (list, create, update, delete, get, pause, resume, trigger)
 * - gh-search: 8 tools (search repos, issues, PRs, code, commits; view issue, PR, repo)
 *
 * NOT exposed (requires local resources):
 * - ai-browser: requires local BrowserContext / CDP connection
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildTools as buildAicoBotAppsTools } from '../../apps/conversation-mcp/index.js';
import { buildAllTools as buildGhSearchTools } from '../gh-search/sdk-mcp-server.js';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';

// ============================================
// Types
// ============================================

interface SpaceMcpEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastUsed: number;
}

// ============================================
// Constants
// ============================================

const DEFAULT_PORT = 3848;
const SPACE_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes

// ============================================
// MCP Proxy Server
// ============================================

export class AicoBotMcpProxyServer {
  private httpServer: ReturnType<typeof createServer> | null = null;
  private port: number = DEFAULT_PORT;
  private authToken: string;
  private spaceServers = new Map<string, SpaceMcpEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(authToken: string) {
    this.authToken = authToken;
  }

  /**
   * Start the MCP proxy HTTP server.
   * @param port - Optional port to listen on (defaults to 3848)
   * @returns The actual port used
   */
  async start(port?: number): Promise<number> {
    this.port = port || DEFAULT_PORT;

    this.httpServer = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        console.error('[MCP Proxy] Error handling request:', err);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });
    });

    // Start periodic cleanup of stale space servers
    this.cleanupTimer = setInterval(() => this.cleanupStaleServers(), CLEANUP_INTERVAL_MS);

    return new Promise((resolve, reject) => {
      this.httpServer!.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          // Port in use, try next port
          this.port++;
          this.httpServer!.listen(this.port, '127.0.0.1', () => {
            console.log(`[MCP Proxy] Listening on port ${this.port} (fallback)`);
            resolve(this.port);
          });
        } else {
          reject(err);
        }
      });

      this.httpServer!.listen(this.port, '127.0.0.1', () => {
        console.log(`[MCP Proxy] Listening on http://127.0.0.1:${this.port}`);
        resolve(this.port);
      });
    });
  }

  /**
   * Get the port the proxy is listening on.
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Get the MCP URL for a specific space.
   */
  getUrl(spaceId: string): string {
    return `http://127.0.0.1:${this.port}/mcp/${spaceId}`;
  }

  /**
   * Stop the MCP proxy server.
   */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    // Close all space servers
    for (const entry of this.spaceServers.values()) {
      try {
        entry.server.close();
      } catch {
        // Ignore errors during cleanup
      }
    }
    this.spaceServers.clear();

    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }

    console.log('[MCP Proxy] Stopped');
  }

  /**
   * Handle an incoming HTTP request.
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Only handle /mcp/* paths
    const url = new URL(req.url || '/', `http://127.0.0.1:${this.port}`);
    if (!url.pathname.startsWith('/mcp/')) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    // Auth check
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${this.authToken}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    // Extract spaceId from path: /mcp/:spaceId(/remainder)
    const pathAfterMcp = url.pathname.substring('/mcp/'.length);
    const spaceId = pathAfterMcp.split('/')[0];

    if (!spaceId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing spaceId in URL path: /mcp/:spaceId' }));
      return;
    }

    // Get or create per-space MCP server
    const entry = this.getOrCreateSpaceServer(spaceId);

    // Rewrite URL to strip the /mcp/:spaceId prefix
    // The StreamableHTTPServerTransport expects paths relative to the server root
    const remainder = url.pathname.substring(`/mcp/${spaceId}`.length) || '/';
    (req as any)._originalUrl = req.url;
    req.url = remainder + url.search;

    // Forward to the transport
    await entry.transport.handleRequest(req, res);
  }

  /**
   * Get or create an MCP server instance for a specific space.
   */
  private getOrCreateSpaceServer(spaceId: string): SpaceMcpEntry {
    const existing = this.spaceServers.get(spaceId);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing;
    }

    console.log(`[MCP Proxy] Creating MCP server for space: ${spaceId}`);

    // Create a unified McpServer for this space
    const server = new McpServer({
      name: `aico-bot-mcp-proxy-${spaceId.substring(0, 8)}`,
      version: '1.0.0',
    });

    // Register aico-bot-apps tools (space-specific)
    const aicoBotAppsTools = buildAicoBotAppsTools(spaceId);
    for (const toolDef of aicoBotAppsTools) {
      this.registerSdkToolOnMcpServer(server, toolDef as SdkMcpToolDefinition);
    }
    console.log(
      `[MCP Proxy] Registered ${aicoBotAppsTools.length} aico-bot-apps tools for space ${spaceId}`,
    );

    // Register gh-search tools (stateless, shared)
    const ghSearchTools = buildGhSearchTools();
    for (const toolDef of ghSearchTools) {
      this.registerSdkToolOnMcpServer(server, toolDef as SdkMcpToolDefinition);
    }
    console.log(
      `[MCP Proxy] Registered ${ghSearchTools.length} gh-search tools for space ${spaceId}`,
    );

    // Create transport and connect
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    server.connect(transport);

    const entry: SpaceMcpEntry = {
      server,
      transport,
      lastUsed: Date.now(),
    };
    this.spaceServers.set(spaceId, entry);

    return entry;
  }

  /**
   * Register an SDK tool definition on a @modelcontextprotocol/sdk McpServer.
   *
   * The SDK's tool() returns SdkMcpToolDefinition with:
   * - name: string
   * - description: string
   * - inputSchema: Zod raw shape
   * - handler: (args, extra) => Promise<CallToolResult>
   *
   * McpServer.tool() accepts: (name, description, paramsSchema, handler)
   */
  private registerSdkToolOnMcpServer(server: McpServer, toolDef: SdkMcpToolDefinition): void {
    server.tool(toolDef.name, toolDef.description, toolDef.inputSchema, toolDef.handler as any);
  }

  /**
   * Clean up stale space servers that haven't been used recently.
   */
  private cleanupStaleServers(): void {
    const now = Date.now();
    for (const [spaceId, entry] of this.spaceServers) {
      if (now - entry.lastUsed > SPACE_CACHE_TTL_MS) {
        console.log(`[MCP Proxy] Cleaning up stale server for space: ${spaceId}`);
        try {
          entry.server.close();
        } catch {
          // Ignore errors during cleanup
        }
        this.spaceServers.delete(spaceId);
      }
    }
  }
}
