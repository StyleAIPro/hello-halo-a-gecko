#!/usr/bin/env node
/**
 * Patch @anthropic-ai/claude-agent-sdk for AICO-Bot remote agent usage.
 *
 * Why: The SDK's unstable_v2_createSession (Tz class) hardcodes many options
 * instead of forwarding them from the caller. This prevents AICO-Bot from setting
 * cwd, systemPrompt, maxThinkingTokens, etc. This script patches the minified
 * SDK to forward these options.
 *
 * Run: node scripts/patch-sdk.mjs
 *      (called automatically by the build script)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, '..', '..', '..')

// Resolve SDK path — check both root and package-level node_modules
const sdkPaths = [
  join(rootDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs'),
]

let sdkPath = null
for (const p of sdkPaths) {
  if (existsSync(p)) {
    sdkPath = p
    break
  }
}

if (!sdkPath) {
  console.log('[patch-sdk] SDK not found, skipping patch')
  process.exit(0)
}

let sdk = readFileSync(sdkPath, 'utf-8')

// Check if already patched
if (sdk.includes('[PATCHED] AICO-Bot SDK patch applied')) {
  console.log('[patch-sdk] Already patched, skipping')
  process.exit(0)
}

let patchCount = 0

// === PATCH 1: Tz constructor — Remove CLAUDE_CODE_ENTRYPOINT ===
const entryPattern = 'if(!J.CLAUDE_CODE_ENTRYPOINT)J.CLAUDE_CODE_ENTRYPOINT="sdk-ts";'
if (sdk.includes(entryPattern)) {
  // Must use empty-string replacement, not // comment — minified code has no
  // newlines for thousands of chars, so a // comment would comment out critical code.
  sdk = sdk.replace(entryPattern, '')
  patchCount++
} else {
  console.warn('[patch-sdk] WARNING: Could not find CLAUDE_CODE_ENTRYPOINT in Tz constructor')
}

// === PATCH 2: Tz constructor — Forward all options to mX (ProcessTransport) ===
const oldMxCtor = 'new mX({abortController:this.abortController,pathToClaudeCodeExecutable:X,env:J,executable:$.executable??(g1()?"bun":"node"),executableArgs:$.executableArgs??[],extraArgs:{},thinkingConfig:void 0,maxTurns:void 0,maxBudgetUsd:void 0,model:$.model,fallbackModel:void 0,permissionMode:$.permissionMode??"default",allowDangerouslySkipPermissions:!1,continueConversation:!1,resume:$.resume,settingSources:[],allowedTools:$.allowedTools??[],disallowedTools:$.disallowedTools??[],mcpServers:{},strictMcpConfig:!1,canUseTool:!!$.canUseTool,hooks:!!$.hooks,includePartialMessages:!1,forkSession:!1,resumeSessionAt:void 0})'

if (sdk.includes(oldMxCtor)) {
  const newMxCtor = 'new mX({abortController:this.abortController,pathToClaudeCodeExecutable:X,' +
    'cwd:$.cwd,' +
    'stderr:$.stderr,' +
    'env:J,' +
    'executable:$.executable??(g1()?"bun":"node"),' +
    'executableArgs:$.executableArgs??[],' +
    'extraArgs:$.extraArgs??{},' +
    'thinkingConfig:void 0,' +
    'maxTurns:$.maxTurns??void 0,' +
    'maxBudgetUsd:$.maxBudgetUsd??void 0,' +
    'model:$.model,' +
    'fallbackModel:$.fallbackModel??void 0,' +
    'permissionMode:$.permissionMode??"default",' +
    'allowDangerouslySkipPermissions:$.allowDangerouslySkipPermissions??!1,' +
    'continueConversation:$.continueConversation??!1,' +
    'resume:$.resume,' +
    'settingSources:$.settingSources??[],' +
    'allowedTools:$.allowedTools??[],' +
    'disallowedTools:$.disallowedTools??[],' +
    'mcpServers:$.mcpServers??{},' +
    'strictMcpConfig:$.strictMcpConfig??!1,' +
    'canUseTool:!!$.canUseTool,' +
    'hooks:!!$.hooks,' +
    'includePartialMessages:$.includePartialMessages??!0,' +
    'forkSession:$.forkSession??!1,' +
    'resumeSessionAt:$.resumeSessionAt??void 0,' +
    'sandbox:$.sandbox})'

  sdk = sdk.replace(oldMxCtor, newMxCtor)
  patchCount++
  console.log('[patch-sdk] Patched: Forwarded cwd + all options to ProcessTransport')
} else {
  console.warn('[patch-sdk] WARNING: Could not find mX constructor in Tz class')
}

// === PATCH 3: Tz constructor — Pass initConfig (systemPrompt) to Query ===
const oldQueryCtor = 'this.query=new lX(Q,!1,$.canUseTool,$.hooks,this.abortController,new Map)'

if (sdk.includes(oldQueryCtor)) {
  const sp = 'typeof $.systemPrompt==="string"?$.systemPrompt:($.systemPrompt?.append??"")'
  const newQueryCtor =
    'const _sp=' + sp + ';' +
    'const _ic={systemPrompt:_sp,appendSystemPrompt:$.systemPrompt?.type==="preset"?$.systemPrompt.append:void 0,agents:$.agents};' +
    'this.query=new lX(Q,!1,$.canUseTool,$.hooks,this.abortController,new Map,void 0,_ic)'

  sdk = sdk.replace(oldQueryCtor, newQueryCtor)
  patchCount++
  console.log('[patch-sdk] Patched: Pass systemPrompt via initConfig to Query')
} else {
  console.warn('[patch-sdk] WARNING: Could not find Query constructor in Tz class')
}

// === PATCH 4: Tz — Add methods (interrupt, setModel, setMaxThinkingTokens, setPermissionMode, pid) ===
const oldClose = 'close(){if(this.closed)return;this.closed=!0,this.inputStream.done(),setTimeout(()=>{if(!this.abortController.signal.aborted)this.abortController.abort()},UI).unref()}async[Symbol.asyncDispose](){this.close()}}'

if (sdk.includes(oldClose)) {
  const newMethods =
    'async interrupt(){return this.query.interrupt()}' +
    'async setModel($){return this.query.setModel($)}' +
    'async setMaxThinkingTokens($){return this.query.setMaxThinkingTokens($)}' +
    'async setPermissionMode($){return this.query.setPermissionMode($)}' +
    'get pid(){return this.query?.transport?.process?.pid}' +
    oldClose  // Keep the original close method

  sdk = sdk.replace(oldClose, newMethods)
  patchCount++
  console.log('[patch-sdk] Patched: Added interrupt/setModel/setMaxThinkingTokens/setPermissionMode/pid to Tz')
} else {
  console.warn('[patch-sdk] WARNING: Could not find close method in Tz class')
}

// === PATCH 5: ProcessTransport (mX) — Remove CLAUDE_CODE_ENTRYPOINT ===
const mxEntryPattern = 'if(!U.CLAUDE_CODE_ENTRYPOINT)U.CLAUDE_CODE_ENTRYPOINT="sdk-ts";'
if (sdk.includes(mxEntryPattern)) {
  // Must use empty-string replacement — minified code has no newlines nearby,
  // a // comment would comment out ~10KB of critical class code.
  sdk = sdk.replace(mxEntryPattern, '')
  patchCount++
} else {
  console.warn('[patch-sdk] WARNING: Could not find CLAUDE_CODE_ENTRYPOINT in ProcessTransport')
}

// === PATCH 6: query function (Aa) — Remove CLAUDE_AGENT_SDK_VERSION ===
const verPattern = 'process.env.CLAUDE_AGENT_SDK_VERSION="0.2.87";'
if (sdk.includes(verPattern)) {
  // Must use empty-string replacement — minified code has no newlines nearby.
  sdk = sdk.replace(verPattern, '')
  patchCount++
} else {
  // Try with a generic version pattern
  const verMatch = sdk.match(/process\.env\.CLAUDE_AGENT_SDK_VERSION="[^"]+";/)
  if (verMatch) {
    sdk = sdk.replace(verMatch[0], '')
    patchCount++
    console.log('[patch-sdk] Patched: Removed CLAUDE_AGENT_SDK_VERSION (generic match)')
  } else {
    console.warn('[patch-sdk] WARNING: Could not find CLAUDE_AGENT_SDK_VERSION')
  }
}

// === PATCH 7: query function — Remove CLAUDE_CODE_ENTRYPOINT ===
const queryEntryPattern = 'if(!s4.CLAUDE_CODE_ENTRYPOINT)s4.CLAUDE_CODE_ENTRYPOINT="sdk-ts";'
if (sdk.includes(queryEntryPattern)) {
  // Must use empty-string replacement — minified code has no newlines nearby.
  sdk = sdk.replace(queryEntryPattern, '')
  patchCount++
} else {
  console.warn('[patch-sdk] WARNING: Could not find CLAUDE_CODE_ENTRYPOINT in query function')
}

// Add patch marker AFTER shebang (shebang must stay on line 1, otherwise
// CJS require() of this .mjs file fails with SyntaxError on the "!" in "#!")
const shebangAndSdk = sdk.match(/^#!\/usr\/bin\/env node\n([\s\S]*)/)
if (shebangAndSdk) {
  sdk = '#!/usr/bin/env node\n// [PATCHED] AICO-Bot SDK patch applied\n' + shebangAndSdk[1]
} else {
  sdk = '// [PATCHED] AICO-Bot SDK patch applied\n' + sdk
}

writeFileSync(sdkPath, sdk)
console.log(`[patch-sdk] Applied ${patchCount} patches to ${sdkPath}`)
