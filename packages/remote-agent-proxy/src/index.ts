#!/usr/bin/env node

import { config as configDotenv } from 'dotenv'
import { RemoteAgentServer } from './server.js'
import type { RemoteServerConfig, TokensFile } from './types.js'
import * as path from 'path'
import * as fs from 'fs'

// Load .env file from deployment directory
const deployPath = '/opt/claude-deployment/.env'
const deployDir = '/opt/claude-deployment'
configDotenv({ path: deployPath })

/**
 * Load token whitelist from tokens.json.
 * Falls back to REMOTE_AGENT_AUTH_TOKEN env var if tokens.json doesn't exist.
 */
function loadTokensFromDisk(tokensPath: string): { tokens: string[]; firstToken?: string } {
  try {
    if (fs.existsSync(tokensPath)) {
      const data: TokensFile = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'))
      if (data.version === 1 && Array.isArray(data.tokens) && data.tokens.length > 0) {
        const tokens = data.tokens.map(t => t.token)
        console.log(`[RemoteAgentProxy] Loaded ${tokens.length} tokens from tokens.json`)
        return { tokens, firstToken: tokens[0] }
      }
    }
  } catch (e) {
    console.warn('[RemoteAgentProxy] Failed to load tokens.json, falling back to env var:', e)
  }
  return { tokens: [] }
}

function loadConfig(): RemoteServerConfig {
  const tokensPath = path.join(deployDir, 'tokens.json')
  const { tokens: whitelistedTokens, firstToken } = loadTokensFromDisk(tokensPath)

  const config: RemoteServerConfig = {
    port: parseInt(process.env.REMOTE_AGENT_PORT || process.env.PORT || '8080'),
    // Bootstrap token: prefer first token from whitelist, fallback to env var
    authToken: firstToken || process.env.REMOTE_AGENT_AUTH_TOKEN || process.env.AUTH_TOKEN,
    // Token whitelist from tokens.json
    authTokens: whitelistedTokens,
    tokensFilePath: tokensPath,
    workDir: process.env.REMOTE_AGENT_WORK_DIR || process.env.WORK_DIR,
    claudeApiKey: process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY,
    claudeBaseUrl: process.env.ANTHROPIC_BASE_URL || process.env.CLAUDE_BASE_URL,
    model: process.env.ANTHROPIC_MODEL || process.env.CLAUDE_MODEL,
    pathToClaudeCodeExecutable: process.env.PATH_TO_CLAUDE_CODE_EXECUTABLE
  }

  console.log('[RemoteAgentProxy] Configuration loaded:')
  console.log(`  - Port: ${config.port}`)
  console.log(`  - Auth Token (bootstrap): ${config.authToken ? 'configured' : 'none'}`)
  console.log(`  - Auth Token Whitelist: ${config.authTokens && config.authTokens.length > 0 ? `${config.authTokens.length} token(s)` : 'none (using bootstrap token only)'}`)
  console.log(`  - Tokens File: ${config.tokensFilePath}`)
  console.log(`  - Work Dir: ${config.workDir || 'default'}`)
  console.log(`  - API Key: ${config.claudeApiKey ? 'configured' : 'none'}`)
  console.log(`  - Base URL: ${config.claudeBaseUrl || 'default'}`)
  console.log(`  - Model: ${config.model || 'default'}`)
  console.log(`  - Claude Code Path: ${config.pathToClaudeCodeExecutable || 'not set (SDK mode)'}`)

  return config
}

function main(): void {
  const config = loadConfig()
  const server = new RemoteAgentServer(config)

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n[RemoteAgentProxy] Shutting down server...')
    server.close()
    process.exit(0)
  })

  process.on('SIGTERM', () => {
    console.log('\n[RemoteAgentProxy] Shutting down server...')
    server.close()
    process.exit(0)
  })
}

main()
