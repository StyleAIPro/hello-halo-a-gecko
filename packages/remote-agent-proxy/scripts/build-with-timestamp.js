#!/usr/bin/env node

/**
 * Build script with timestamp
 * Compiles TypeScript and adds build timestamp to dist/version.json
 */

import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.join(__dirname, '..')
const distDir = path.join(rootDir, 'dist')

console.log('Building remote-agent-proxy...')

// Step 1: Compile TypeScript
try {
  execSync('tsc', { cwd: rootDir, stdio: 'inherit' })
  console.log('TypeScript compilation successful')
} catch (error) {
  console.error('TypeScript compilation failed')
  process.exit(1)
}

// Step 2: Generate build info
const now = new Date()
const buildInfo = {
  version: '1.0.0',
  buildTimestamp: now.toISOString(),
  buildTime: now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
  buildTimeUTC: now.toLocaleString('en-US', { timeZone: 'UTC' }),
  nodeVersion: process.version,
  platform: process.platform,
  arch: process.arch
}

// Read package.json version
try {
  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8'))
  buildInfo.version = packageJson.version
} catch (e) {
  console.warn('Could not read package.json version')
}

// Step 3: Write build info to dist/version.json
fs.writeFileSync(
  path.join(distDir, 'version.json'),
  JSON.stringify(buildInfo, null, 2) + '\n'
)

console.log('Build info written to dist/version.json:')
console.log(JSON.stringify(buildInfo, null, 2))

// Step 4: Also create a build-info.js module that can be imported
const buildInfoModule = `// Auto-generated build info
export const buildInfo = ${JSON.stringify(buildInfo, null, 2)};
export const BUILD_TIMESTAMP = '${buildInfo.buildTimestamp}';
export const BUILD_TIME = '${buildInfo.buildTime}';
export const VERSION = '${buildInfo.version}';
`

fs.writeFileSync(
  path.join(distDir, 'build-info.js'),
  buildInfoModule
)

console.log('\nBuild completed successfully!')
