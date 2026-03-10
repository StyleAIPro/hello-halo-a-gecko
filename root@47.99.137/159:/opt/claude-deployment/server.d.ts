import type { RemoteServerConfig } from './types.js';
export declare class RemoteAgentServer {
    private config;
    private server;
    private clients;
    private claudeManager;
    constructor(config: RemoteServerConfig);
    private setupServer;
    private handleMessage;
    private handleAuth;
    private handleClaudeChat;
    /**
     * Handle file operations using V2 Session
     */
    private handleFileOperation;
    private sendMessage;
    private sendError;
    close(): void;
}
//# sourceMappingURL=server.d.ts.map