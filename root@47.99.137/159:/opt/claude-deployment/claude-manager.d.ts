import { type SDKSession } from '@anthropic-ai/claude-agent-sdk';
/**
 * Simple interface for chat messages
 */
export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
}
export interface ChatOptions {
    maxTokens?: number;
    system?: string;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
    maxThinkingTokens?: number;
    workDir?: string;
}
/**
 * Tool call from V2 Session
 */
export interface ToolCall {
    id: string;
    name: string;
    input: any;
    status: 'started' | 'running' | 'delta' | 'result' | 'error';
    output?: any;
    error?: string;
}
/**
 * Terminal output from V2 Session
 */
export interface TerminalOutput {
    content: string;
    type: 'stdout' | 'stderr';
}
/**
 * Thought event (for thinking, tool_use, etc.)
 */
export interface ThoughtEvent {
    id: string;
    type: 'thinking' | 'tool_use' | 'tool_result' | 'text' | 'error' | 'result';
    content?: string;
    timestamp: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    isStreaming?: boolean;
    isReady?: boolean;
    errorCode?: string;
}
/**
 * Thought delta event (streaming updates)
 */
export interface ThoughtDeltaEvent {
    thoughtId: string;
    delta?: string;
    content?: string;
    isComplete?: boolean;
    toolInput?: Record<string, unknown>;
    isReady?: boolean;
    isToolInput?: boolean;
    toolResult?: {
        output: string;
        isError: boolean;
        timestamp: string;
    };
    isToolResult?: boolean;
}
/**
 * MCP server status event
 */
export interface McpStatusEvent {
    servers: Array<{
        name: string;
        status: string;
    }>;
}
/**
 * Compact boundary event (context compression)
 */
export interface CompactBoundaryEvent {
    trigger: 'manual' | 'auto';
    preTokens: number;
}
/**
 * File operation result
 */
export interface FileOperation {
    type: 'read' | 'write' | 'delete' | 'list';
    path: string;
    result?: any;
    error?: string;
}
/**
 * File info for directory listing
 */
export interface FileInfo {
    name: string;
    isDirectory: boolean;
    size: number;
    modifiedTime: Date;
}
/**
 * Session configuration for rebuild detection
 */
export interface SessionConfig {
    model?: string;
    workDir?: string;
    apiKey?: string;
    baseUrl?: string;
}
/**
 * V2 Session info with metadata (aligned with local session-manager.ts)
 */
export interface V2SessionInfo {
    session: SDKSession;
    conversationId: string;
    createdAt: number;
    lastUsedAt: number;
    config: SessionConfig;
    configGeneration: number;
}
/**
 * Active session state for in-flight request tracking
 */
export interface ActiveSessionState {
    conversationId: string;
    abortController: AbortController;
}
/**
 * Claude Manager using V2 Session for full Claude Code capabilities
 *
 * Features (aligned with local):
 * - Session persistence (conversation history)
 * - Session resumption
 * - Process reuse (fast responses)
 * - Process health check before reuse
 * - Event-driven cleanup (process exit listener)
 * - Idle timeout cleanup (30 minutes)
 * - Config change detection
 * - Active request tracking
 */
export declare class ClaudeManager {
    private sessions;
    private activeSessions;
    private apiKey?;
    private baseUrl?;
    private pathToClaudeCodeExecutable?;
    private workDir?;
    private model?;
    private configGeneration;
    private cleanupIntervalId;
    constructor(apiKey?: string, baseUrl?: string, pathToClaudeCodeExecutable?: string, workDir?: string, model?: string);
    /**
     * Get current config for session creation
     */
    private getCurrentConfig;
    /**
     * Increment config generation (call when config changes)
     */
    updateConfig(apiKey?: string, baseUrl?: string, workDir?: string, model?: string): void;
    /**
     * Build SDK options for session creation
     * @param workDir - Optional override for working directory (per-session)
     */
    private buildSdkOptions;
    /**
     * Clean up a single session (aligned with local cleanupSession)
     */
    private cleanupSession;
    /**
     * Start the session cleanup interval (aligned with local)
     */
    private startCleanupInterval;
    /**
     * Stop the cleanup interval
     */
    private stopCleanupInterval;
    /**
     * Get or create a V2 session (aligned with local getOrCreateV2Session)
     *
     * Key features:
     * - Process health check before reuse
     * - Config change detection
     * - Active request tracking
     * - Per-session workDir support
     *
     * @param conversationId - Use conversationId as key (aligned with local)
     * @param workDir - Optional working directory override for this session
     */
    getOrCreateSession(conversationId: string, workDir?: string): Promise<SDKSession>;
    /**
     * Legacy method for backward compatibility
     * @deprecated Use getOrCreateSession instead
     */
    getSession(sessionId: string): SDKSession;
    /**
     * Register an active session (for in-flight request tracking)
     */
    registerActiveSession(conversationId: string, abortController: AbortController): void;
    /**
     * Unregister an active session
     */
    unregisterActiveSession(conversationId: string): void;
    /**
     * Resume an existing V2 session by session ID
     */
    resumeSession(sessionId: string): Promise<SDKSession>;
    /**
     * Stream chat messages using V2 session
     *
     * IMPORTANT: Only sends the LAST user message to the V2 session.
     * The V2 session maintains its own conversation history internally.
     *
     * @param sessionId - Session/conversation ID
     * @param messages - Chat messages (only last message is sent)
     * @param options - Chat options including workDir for per-session directory
     * @param onToolCall - Callback for tool call events
     * @param onTerminalOutput - Callback for terminal output events
     * @param onThought - Callback for thought events (thinking, tool_use start)
     * @param onThoughtDelta - Callback for thought delta events (streaming updates)
     * @param onMcpStatus - Callback for MCP server status events
     * @param onCompact - Callback for compact boundary events (context compression)
     */
    streamChat(sessionId: string, messages: ChatMessage[], options?: ChatOptions, onToolCall?: (tool: ToolCall) => void, onTerminalOutput?: (output: TerminalOutput) => void, onThought?: (thought: ThoughtEvent) => void, onThoughtDelta?: (delta: ThoughtDeltaEvent) => void, onMcpStatus?: (data: McpStatusEvent) => void, onCompact?: (data: CompactBoundaryEvent) => void): AsyncGenerator<{
        type: string;
        data?: any;
    }>;
    /**
     * Send a chat message without streaming
     */
    chat(sessionId: string, messages: ChatMessage[], options?: ChatOptions): Promise<string>;
    /**
     * Close a V2 session
     */
    closeSession(conversationId: string): void;
    /**
     * Close all sessions
     */
    closeAllSessions(): void;
    /**
     * Invalidate all sessions (called when config changes)
     */
    invalidateAllSessions(): void;
    /**
     * Get session statistics
     */
    getStats(): {
        totalSessions: number;
        activeRequests: number;
    };
    /**
     * List files in directory using V2 Session
     */
    listFiles(sessionId: string, path: string): Promise<FileInfo[]>;
    /**
     * Read file using V2 Session
     */
    readFile(sessionId: string, path: string): Promise<string>;
    /**
     * Write file using V2 Session
     */
    writeFile(sessionId: string, path: string, content: string): Promise<void>;
    /**
     * Delete file using V2 Session
     */
    deleteFile(sessionId: string, path: string): Promise<void>;
    /**
     * Execute command via V2 Session
     */
    executeCommand(sessionId: string, command: string): Promise<string>;
}
//# sourceMappingURL=claude-manager.d.ts.map