#!/usr/bin/env node
/**
 * Token Registration Script for RemoteAgentProxy
 *
 * Usage: node register-token.js <token> <clientId> [hostname] [tokensPath]
 *
 * This script is called via SSH from Halo clients to register their auth token
 * in the remote server's tokens.json whitelist file.
 *
 * Output:
 *   TOKEN_REGISTERED - New token was added
 *   TOKEN_UPDATED     - Existing token's lastSeen was updated
 *   TOKEN_ERROR       - Something went wrong
 */

const fs = require('fs')
const path = require('path')

const token = process.argv[2]
const clientId = process.argv[3]
const hostname = process.argv[4] || 'unknown'
const tokensPath = process.argv[5] || '/opt/claude-deployment/tokens.json'

if (!token || !clientId) {
  console.error('Usage: register-token.js <token> <clientId> [hostname] [tokensPath]')
  process.exit(1)
}

try {
  let data = { version: 1, tokens: [] }

  // Read existing file
  try {
    if (fs.existsSync(tokensPath)) {
      data = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'))
      if (data.version !== 1) {
        // Unknown version, reset
        data = { version: 1, tokens: [] }
      }
    }
  } catch (readError) {
    // Corrupted file, start fresh
    console.error(`Warning: Failed to read ${tokensPath}, starting fresh: ${readError.message}`)
    data = { version: 1, tokens: [] }
  }

  // Check if token already exists
  const existing = data.tokens.find(t => t.token === token)
  if (existing) {
    // Update lastSeen and hostname
    existing.lastSeen = new Date().toISOString()
    if (hostname !== 'unknown') {
      existing.hostname = hostname
    }
    existing.clientId = clientId
  } else {
    // Add new entry
    data.tokens.push({
      token: token,
      clientId: clientId,
      hostname: hostname,
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString()
    })
  }

  // Ensure directory exists
  const dir = path.dirname(tokensPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  // Atomic write: write to .tmp then rename
  const tmpPath = tokensPath + '.tmp'
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2))
  fs.renameSync(tmpPath, tokensPath)

  if (existing) {
    console.log('TOKEN_UPDATED')
  } else {
    console.log('TOKEN_REGISTERED')
  }
} catch (error) {
  console.error('TOKEN_ERROR: ' + error.message)
  process.exit(1)
}
