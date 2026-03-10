#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = require("dotenv");
const server_js_1 = require("./server.js");
// Load .env file from deployment directory
const deployPath = '/opt/claude-deployment/.env';
(0, dotenv_1.config)({ path: deployPath });
function loadConfig() {
    const config = {
        port: parseInt(process.env.REMOTE_AGENT_PORT || process.env.PORT || '8080'),
        authToken: process.env.REMOTE_AGENT_AUTH_TOKEN || process.env.AUTH_TOKEN,
        workDir: process.env.REMOTE_AGENT_WORK_DIR || process.env.WORK_DIR,
        // Support both ANTHROPIC_AUTH_TOKEN (for third-party APIs) and ANTHROPIC_API_KEY
        claudeApiKey: process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY,
        claudeBaseUrl: process.env.ANTHROPIC_BASE_URL || process.env.CLAUDE_BASE_URL,
        model: process.env.ANTHROPIC_MODEL || process.env.CLAUDE_MODEL
    };
    console.log('[RemoteAgentProxy] Configuration loaded:');
    console.log(`  - Port: ${config.port}`);
    console.log(`  - Auth Token: ${config.authToken ? 'configured' : 'none'}`);
    console.log(`  - Work Dir: ${config.workDir || 'default'}`);
    console.log(`  - API Key: ${config.claudeApiKey ? 'configured' : 'none'}`);
    console.log(`  - Base URL: ${config.claudeBaseUrl || 'default'}`);
    console.log(`  - Model: ${config.model || 'default'}`);
    return config;
}
function main() {
    const config = loadConfig();
    const server = new server_js_1.RemoteAgentServer(config);
    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n[RemoteAgentProxy] Shutting down server...');
        server.close();
        process.exit(0);
    });
    process.on('SIGTERM', () => {
        console.log('\n[RemoteAgentProxy] Shutting down server...');
        server.close();
        process.exit(0);
    });
}
main();
//# sourceMappingURL=index.js.map