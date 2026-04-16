#!/usr/bin/env node

import { config as configDotenv } from 'dotenv'
import { RemoteAgentServer } from './server.js'
import type { RemoteServerConfig } from './types.js'
import * as path from 'path'
import * as fs from 'fs'

// Load .env file from deployment directory
// DEPLOY_DIR is set by the start command to enable per-PC isolation
const deployDir = process.env.DEPLOY_DIR || '/opt/claude-deployment'
const deployPath = path.join(deployDir, '.env')
configDotenv({ path: deployPath })

function loadConfig(): RemoteServerConfig {
  const config: RemoteServerConfig = {
    port: parseInt(process.env.REMOTE_AGENT_PORT || process.env.PORT || '8080'),
    authToken: process.env.REMOTE_AGENT_AUTH_TOKEN || process.env.AUTH_TOKEN,
    workDir: process.env.REMOTE_AGENT_WORK_DIR || process.env.WORK_DIR,
    pathToClaudeCodeExecutable: process.env.PATH_TO_CLAUDE_CODE_EXECUTABLE
  }

  console.log('[RemoteAgentProxy] Configuration loaded:')
  console.log(`  - Port: ${config.port}`)
  console.log(`  - Auth Token: ${config.authToken ? 'configured' : 'none (open access)'}`)
  console.log(`  - Deploy Dir: ${deployDir}`)
  console.log(`  - Work Dir: ${config.workDir || 'default'}`)
  console.log(`  - Claude Code Path: ${config.pathToClaudeCodeExecutable || 'not set (SDK mode)'}`)
  console.log(`  - Model credentials: per-request only (from AICO-Bot client)`)

  return config
}

/**
 * Migrate skills from ~/.claude/skills/ to ~/.agents/skills/ if not already present.
 * This runs on every startup so that skills placed in Claude's default directory
 * are automatically picked up by AICO-Bot.
 */
function migrateClaudeSkills(): void {
  const home = process.env.HOME || '/root'
  const claudeSkillsDir = path.join(home, '.claude', 'skills')
  const agentsSkillsDir = path.join(home, '.agents', 'skills')

  if (!fs.existsSync(claudeSkillsDir)) return

  if (!fs.existsSync(agentsSkillsDir)) {
    fs.mkdirSync(agentsSkillsDir, { recursive: true })
  }

  try {
    const entries = fs.readdirSync(claudeSkillsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const srcPath = path.join(claudeSkillsDir, entry.name)
        const destPath = path.join(agentsSkillsDir, entry.name)
        if (!fs.existsSync(destPath)) {
          fs.cpSync(srcPath, destPath, { recursive: true })
          console.log(`[Migration] Migrated Claude skill: ${entry.name}`)
        }
      }
    }
  } catch (error) {
    console.error('[Migration] Failed to migrate Claude skills:', error)
  }
}

function main(): void {
  migrateClaudeSkills()
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
