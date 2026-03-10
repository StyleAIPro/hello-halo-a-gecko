export interface RemoteServerConfig {
    port: number;
    authToken?: string;
    workDir?: string;
    claudeApiKey?: string;
    claudeBaseUrl?: string;
    model?: string;
    maxThinkingTokens?: number;
}
export interface ClientMessage {
    type: 'auth' | 'claude:chat' | 'fs:list' | 'fs:read' | 'fs:write' | 'fs:upload' | 'fs:delete' | 'ping' | 'tool:approve' | 'tool:reject';
    sessionId?: string;
    payload?: {
        messages?: any[];
        options?: ChatOptions & {
            workDir?: string;
        };
        stream?: boolean;
        path?: string;
        content?: string;
        token?: string;
        toolId?: string;
        reason?: string;
    };
}
/**
 * Extended chat options with workDir support
 */
export interface ChatOptions {
    maxTokens?: number;
    system?: string;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
    maxThinkingTokens?: number;
    workDir?: string;
}
export interface ServerMessage {
    type: 'auth:success' | 'auth:failed' | 'claude:stream' | 'claude:complete' | 'claude:error' | 'fs:result' | 'fs:error' | 'pong' | 'tool:call' | 'tool:delta' | 'tool:result' | 'tool:error' | 'terminal:output' | 'thought' | 'thought:delta' | // Thinking process events
    'mcp:status' | // MCP server status
    'compact:boundary' | // Context compression notification
    'text:block-start';
    sessionId?: string;
    data?: any;
}
export interface FileInfo {
    name: string;
    isDirectory: boolean;
    size: number;
    modifiedTime: Date;
}
export interface ToolCallData {
    id: string;
    name: string;
    input: any;
    status: 'started' | 'running' | 'delta' | 'result' | 'error';
    output?: any;
    error?: string;
}
export interface TerminalOutputData {
    content: string;
    type: 'stdout' | 'stderr';
}
export interface ThoughtData {
    id: string;
    type: 'thinking' | 'tool_use' | 'tool_result' | 'text' | 'error' | 'result';
    content?: string;
    timestamp: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    toolResult?: {
        output: string;
        isError: boolean;
        timestamp: string;
    };
    isStreaming?: boolean;
    isReady?: boolean;
    errorCode?: string;
}
export interface ThoughtDeltaData {
    thoughtId: string;
    delta?: string;
    content?: string;
    isComplete?: boolean;
    toolInput?: Record<string, unknown>;
    toolResult?: {
        output: string;
        isError: boolean;
        timestamp: string;
    };
    isReady?: boolean;
    isToolInput?: boolean;
    isToolResult?: boolean;
}
//# sourceMappingURL=types.d.ts.map