#!/usr/bin/env node

import { config as configDotenv } from 'dotenv'
import { RemoteAgentServer } from './server.js'
import type { RemoteServerConfig } from './types.js'
import * as path from 'path'

// Load .env file from deployment directory
const deployPath = '/opt/claude-deployment/.env'
configDotenv({ path: deployPath })

function loadConfig(): RemoteServerConfig {
  const config: RemoteServerConfig = {
    port: parseInt(process.env.REMOTE_AGENT_PORT || process.env.PORT || '8080'),
    authToken: process.env.REMOTE_AGENT_AUTH_TOKEN || process.env.AUTH_TOKEN,
    workDir: process.env.REMOTE_AGENT_WORK_DIR || process.env.WORK_DIR,
    // Support both ANTHROPIC_AUTH_TOKEN (for third-party APIs) and ANTHROPIC_API_KEY
    claudeApiKey: process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY,
    claudeBaseUrl: process.env.ANTHROPIC_BASE_URL || process.env.CLAUDE_BASE_URL,
    model: process.env.ANTHROPIC_MODEL || process.env.CLAUDE_MODEL
  }

  console.log('[RemoteAgentProxy] Configuration loaded:')
  console.log(`  - Port: ${config.port}`)
  console.log(`  - Auth Token: ${config.authToken ? 'configured' : 'none'}`)
  console.log(`  - Work Dir: ${config.workDir || 'default'}`)
  console.log(`  - API Key: ${config.claudeApiKey ? 'configured' : 'none'}`)
  console.log(`  - Base URL: ${config.claudeBaseUrl || 'default'}`)
  console.log(`  - Model: ${config.model || 'default'}`)

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
