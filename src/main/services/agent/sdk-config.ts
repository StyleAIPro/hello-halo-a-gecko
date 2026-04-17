/**
 * Agent Module - SDK Configuration Builder
 *
 * Pure functions for building SDK configuration.
 * Centralizes all SDK-related configuration logic to ensure consistency
 * between send-message.ts and session-manager.ts.
 */

import path from 'path';
import os from 'os';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  symlinkSync,
  lstatSync,
  unlinkSync,
  readdirSync,
  statSync,
} from 'fs';
import { app } from 'electron';
import { ensureOpenAICompatRouter, encodeBackendConfig } from '../../openai-compat-router';
import type { ApiCredentials } from './types';
import { inferOpenAIWireApi } from './helpers';
import { buildSystemPrompt, DEFAULT_ALLOWED_TOOLS } from './system-prompt';
import { createCanUseTool } from './permission-handler';
import { sendToRenderer } from './helpers';

// ============================================
// Configuration
// ============================================

/**
 * When true, Anthropic requests route through the local router for interceptor
 * coverage (warmup, preflight, etc.) with zero-conversion passthrough.
 * When false, Anthropic requests go directly to the API via the SDK's built-in
 * HTTP client — no router, no interceptors, no overhead.
 *
 * Toggle this to A/B test proxy overhead vs direct SDK performance.
 * OpenAI/OAuth providers always route through the router regardless of this flag.
 */
const PROXY_ANTHROPIC = true;

// ============================================
// Types
// ============================================

/**
 * Resolved credentials ready for SDK use.
 * This is the output of credential resolution process.
 */
export interface ResolvedSdkCredentials {
  /** Base URL for Anthropic API (may be OpenAI compat router) */
  anthropicBaseUrl: string;
  /** API key for Anthropic API (may be encoded backend config) */
  anthropicApiKey: string;
  /** Model to pass to SDK (may be fake Claude model for compat) */
  sdkModel: string;
  /** User's actual configured model name (for display) */
  displayModel: string;
  /** Context window size in tokens (for compression threshold calculation) */
  contextWindow?: number;
}

/**
 * Parameters for building SDK environment variables
 */
export interface SdkEnvParams {
  anthropicApiKey: string;
  anthropicBaseUrl: string;
  /** User-configured context window size (tokens). Passed as CLAUDE_CODE_AUTO_COMPACT_WINDOW
   *  to the CLI subprocess so its autocompact threshold matches the displayed context. */
  contextWindow?: number;
  /** Display model name for sub-agent model override */
  displayModel?: string;
  /** SDK model name for sub-agent model override */
  sdkModel?: string;
}

/**
 * Parameters for building base SDK options
 */
export interface BaseSdkOptionsParams {
  /** Resolved SDK credentials */
  credentials: ResolvedSdkCredentials;
  /** Working directory for the agent */
  workDir: string;
  /** Path to headless Electron binary */
  electronPath: string;
  /** Space ID */
  spaceId: string;
  /** Conversation ID */
  conversationId: string;
  /** Abort controller for cancellation */
  abortController: AbortController;
  /** Optional stderr handler (for error accumulation) */
  stderrHandler?: (data: string) => void;
  /** Optional MCP servers configuration */
  mcpServers?: Record<string, any> | null;
  /** Maximum tool call turns per message (from config) */
  maxTurns?: number;
  /** Context window size in tokens (for compression threshold calculation) */
  contextWindow?: number;
  /** Optional agent ID for Hyper Space worker routing */
  agentId?: string;
  /** Optional agent name for Hyper Space worker routing */
  agentName?: string;
}

// ============================================
// Credential Resolution
// ============================================

/**
 * Resolve API credentials for SDK use.
 *
 * This function handles the complexity of different providers:
 * - Anthropic: Routed through OpenAI compat router (PROXY_ANTHROPIC=true)
 * - OpenAI/OAuth: Route through OpenAI compat router with encoded config
 *
 * Important: The model is encoded into the apiKey (ANTHROPIC_API_KEY env var)
 * at session creation time. Model changes require session rebuild — they cannot
 * be switched dynamically via setModel(). See config.service.ts getAiSourcesSignature().
 *
 * @param credentials - Raw API credentials from getApiCredentials()
 * @returns Resolved credentials ready for SDK
 */
export async function resolveCredentialsForSdk(
  credentials: ApiCredentials,
): Promise<ResolvedSdkCredentials> {
  // Experimental: route Anthropic through local router for interceptor coverage
  if (PROXY_ANTHROPIC && credentials.provider === 'anthropic') {
    return resolveAnthropicPassthrough(credentials);
  }

  // ── Original logic (identical to pre-optimization code) ──
  // Start with direct values
  let anthropicBaseUrl = credentials.baseUrl;
  let anthropicApiKey = credentials.apiKey;
  let sdkModel = credentials.model || 'claude-opus-4-5-20251101';
  const displayModel = credentials.displayModel || credentials.model;

  // For non-Anthropic providers (openai or OAuth), use the OpenAI compat router
  if (credentials.provider !== 'anthropic') {
    const router = await ensureOpenAICompatRouter({ debug: false });
    anthropicBaseUrl = router.baseUrl;

    // Use apiType from credentials (set by provider), fallback to inference
    const apiType =
      credentials.apiType ||
      (credentials.provider === 'oauth'
        ? 'chat_completions'
        : inferOpenAIWireApi(credentials.baseUrl));

    anthropicApiKey = encodeBackendConfig({
      url: credentials.baseUrl,
      key: credentials.apiKey,
      model: credentials.model,
      headers: credentials.customHeaders,
      apiType,
      forceStream: credentials.forceStream,
      filterContent: credentials.filterContent,
    });

    // Pass a fake Claude model to CC for normal request handling
    sdkModel = 'claude-sonnet-4-6';

    console.log(
      `[SDK Config] ${credentials.provider} provider: routing via ${anthropicBaseUrl}, apiType=${apiType}`,
    );
  }

  return {
    anthropicBaseUrl,
    anthropicApiKey,
    sdkModel,
    displayModel,
    contextWindow: credentials.contextWindow,
  };
}

/**
 * Resolve Anthropic credentials via local router passthrough (experimental).
 * Isolated from the main path — only called when PROXY_ANTHROPIC = true.
 */
async function resolveAnthropicPassthrough(
  credentials: ApiCredentials,
): Promise<ResolvedSdkCredentials> {
  const router = await ensureOpenAICompatRouter({ debug: false });

  // 确保 baseUrl 存在，如果不存在则使用默认值
  const baseUrl = credentials.baseUrl || 'https://api.anthropic.com';
  const configUrl = baseUrl.replace(/\/+$/, '') + '/v1/messages';

  const anthropicApiKey = encodeBackendConfig({
    url: configUrl,
    key: credentials.apiKey,
    model: credentials.model,
    headers: credentials.customHeaders,
    apiType: 'anthropic_passthrough',
    forceStream: credentials.forceStream,
    filterContent: credentials.filterContent,
  });

  console.log(`[SDK Config] Anthropic passthrough: routing via ${router.baseUrl}`);

  return {
    anthropicBaseUrl: router.baseUrl,
    anthropicApiKey,
    sdkModel: credentials.model || 'claude-opus-4-5-20251101',
    displayModel: credentials.displayModel || credentials.model,
    contextWindow: credentials.contextWindow,
  };
}

// ============================================
// Sandbox Settings (written to settings.json)
// ============================================

/**
 * Sandbox configuration
 *
 * Sandbox is enabled primarily for performance optimization (skips some runtime checks).
 * Network and filesystem access are intentionally permissive - the goal is not strict
 * security isolation, but rather to enable SDK's internal optimizations.
 *
 * Note: Do NOT add `network.allowedDomains` config unless you actually need domain filtering.
 * Setting this array (even to ['*']) triggers SDK's network proxy infrastructure, which:
 *   - Starts HTTP + SOCKS proxy servers (performance overhead)
 *   - Routes all network requests through the proxy (added latency)
 *   - Has a bug where '*' wildcard is not properly handled (causes false blocks)
 *
 * Security note: SDK has built-in filesystem restrictions (e.g., protecting AICO-Bot config files)
 * that are separate from these sandbox settings.
 */
const SANDBOX_CONFIG = {
  enabled: false,
  autoAllowBashIfSandboxed: true,
  // No network config → proxy servers won't start → no performance overhead
};
let sandboxSettingsWritten = false;

/**
 * Merge skill directories from multiple sourceDirs into targetDir.
 * For duplicate skill names, the one with the most recent modification time wins.
 * Creates individual junctions in targetDir pointing to the winning source directories.
 */
function mergeSkillsDirs(sourceDirs: string[], targetDir: string): void {
  // Collect candidates: skillName -> { sourcePath, mtime }
  const candidates = new Map<string, { sourcePath: string; mtime: number }>();

  for (const sourceDir of sourceDirs) {
    try {
      if (!existsSync(sourceDir)) continue;
      const entries = readdirSync(sourceDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const sourcePath = path.join(sourceDir, entry.name);
        try {
          const stat = statSync(sourcePath);
          const mtime = stat.mtimeMs;
          const existing = candidates.get(entry.name);
          if (!existing || mtime > existing.mtime) {
            candidates.set(entry.name, { sourcePath, mtime });
          }
        } catch {
          // stat failed, skip
        }
      }
    } catch (err) {
      console.warn('[SDK Config] Failed to read source dir:', sourceDir, err);
    }
  }

  // Clean up existing junctions in targetDir that no longer have a source
  try {
    if (existsSync(targetDir)) {
      const existingEntries = readdirSync(targetDir, { withFileTypes: true });
      for (const entry of existingEntries) {
        if (!entry.isDirectory()) continue;
        if (!candidates.has(entry.name)) {
          const targetPath = path.join(targetDir, entry.name);
          try {
            unlinkSync(targetPath);
            console.log(`[SDK Config] Removed stale skill link: ${entry.name}`);
          } catch {
            // ignore
          }
        }
      }
    }
  } catch {
    // ignore
  }

  // Create/update junctions for all winning candidates
  for (const [name, { sourcePath }] of candidates) {
    const targetPath = path.join(targetDir, name);
    // Remove existing link/dir to recreate with the winning source
    try {
      unlinkSync(targetPath);
    } catch {
      // doesn't exist, proceed to create
    }
    try {
      symlinkSync(sourcePath, targetPath, 'junction');
      console.log(`[SDK Config] Linked skill: ${name} -> ${sourcePath}`);
    } catch (err) {
      console.warn(`[SDK Config] Failed to link skill ${name}:`, err);
    }
  }
}

/**
 * Ensure sandbox config exists in CLAUDE_CONFIG_DIR/settings.json.
 *
 * By writing sandbox to the userSettings file, the CLI reads it natively
 * without needing --settings flag. This avoids the CLI writing a temp file
 * to $TMPDIR and chokidar watching the entire tmpdir (which crashes on
 * macOS due to Unix socket files like CloudClient).
 *
 * Runs once per process lifetime — subsequent calls are no-ops.
 */
function ensureSandboxSettings(configDir: string): void {
  if (sandboxSettingsWritten) return;
  mkdirSync(configDir, { recursive: true });
  const settingsPath = path.join(configDir, 'settings.json');
  try {
    let settings: Record<string, any> = {};
    if (existsSync(settingsPath)) {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    }
    let dirty = false;
    if (JSON.stringify(settings.sandbox) !== JSON.stringify(SANDBOX_CONFIG)) {
      settings.sandbox = SANDBOX_CONFIG;
      dirty = true;
    }
    if (settings.skipWebFetchPreflight !== true) {
      settings.skipWebFetchPreflight = true;
      dirty = true;
    }
    if (dirty) {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    }
  } catch (err) {
    console.error('[SDK Config] Failed to write sandbox settings:', err);
  }
  sandboxSettingsWritten = true;
}

// ============================================
// Environment Variables
// ============================================

/**
 * Prefixes to strip from inherited env before spawning CC subprocess.
 * Prevents leaked vars (ANTHROPIC_AUTH_TOKEN, OPENAI_API_KEY, CLAUDE_CODE_SSE_PORT, etc.)
 * from overriding AICO-Bot's explicit configuration.
 */
const AI_SDK_ENV_PREFIXES = ['ANTHROPIC_', 'OPENAI_', 'CLAUDE_'];

/**
 * Specific env vars to strip from inherited env before spawning CC subprocess.
 * These are vars that don't match the prefix patterns but should still be removed.
 */
const AI_SDK_ENV_VARS_TO_STRIP = ['CLAUDECODE'];

/**
 * Copy of process.env with all AI SDK variables removed.
 */
export function getCleanUserEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (AI_SDK_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      delete env[key];
    }
    // Also strip specific vars that don't match prefixes
    if (AI_SDK_ENV_VARS_TO_STRIP.includes(key)) {
      delete env[key];
    }
  }
  return env;
}

/**
 * Build env for CC subprocess.
 * Inherits user env (PATH, HOME, SSH, proxy, etc.) for toolchain compat,
 * strips AI SDK vars, then sets exactly what CC needs.
 */
export function buildSdkEnv(params: SdkEnvParams): Record<string, string | number> {
  const env: Record<string, string | number | undefined> = {
    ...getCleanUserEnv(),

    // Electron: run as Node.js process
    ELECTRON_RUN_AS_NODE: 1,
    ELECTRON_NO_ATTACH_CONSOLE: 1,

    // API credentials
    ANTHROPIC_API_KEY: params.anthropicApiKey,
    ANTHROPIC_BASE_URL: params.anthropicBaseUrl,

    // AICO-Bot's unified config dir at ~/.agents/
    // Skills are stored in ~/.agents/skills/ and ~/.claude/skills/
    // SDK config in ~/.agents/claude-config/
    CLAUDE_CONFIG_DIR: (() => {
      const agentsDir = path.join(os.homedir(), '.agents');
      const configDir = path.join(agentsDir, 'claude-config');
      const skillsDir = path.join(agentsDir, 'skills');
      const claudeSkillsDir = path.join(os.homedir(), '.claude', 'skills');
      const configSkillsDir = path.join(configDir, 'skills');

      // Ensure directories exist
      if (!existsSync(agentsDir)) {
        mkdirSync(agentsDir, { recursive: true });
      }
      if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
      }
      if (!existsSync(skillsDir)) {
        mkdirSync(skillsDir, { recursive: true });
      }
      if (!existsSync(claudeSkillsDir)) {
        mkdirSync(claudeSkillsDir, { recursive: true });
      }

      // Setup configSkillsDir to merge skills from both source directories
      // SDK looks for skills in $CLAUDE_CONFIG_DIR/skills/
      // We need to make both ~/.agents/skills/ and ~/.claude/skills/ visible
      if (!existsSync(configSkillsDir)) {
        // First time: create a real directory and link each skill individually
        mkdirSync(configSkillsDir, { recursive: true });
        console.log('[SDK Config] Created skills directory:', configSkillsDir);
      }

      // If configSkillsDir is a junction (legacy), remove it and recreate as real dir
      const configSkillsStat = existsSync(configSkillsDir) ? lstatSync(configSkillsDir) : null;
      if (configSkillsStat && configSkillsStat.isSymbolicLink()) {
        try {
          unlinkSync(configSkillsDir);
          mkdirSync(configSkillsDir, { recursive: true });
          console.log('[SDK Config] Replaced legacy junction with directory:', configSkillsDir);
        } catch (err) {
          console.warn('[SDK Config] Failed to replace legacy junction:', err);
        }
      }

      // Merge skills from both directories into configSkillsDir
      // For duplicates, the one with the most recent modification time wins
      mergeSkillsDirs([skillsDir, claudeSkillsDir], configSkillsDir);

      // Create .claude/skills junction inside configDir for SDK project-level skill discovery.
      // The SDK in "bare" mode (SDK subprocess) only loads skills from <add-dir>/.claude/skills/,
      // NOT from the user-level configDir/skills/. By creating this junction and passing configDir
      // as an additionalDirectory, the CLI discovers our merged skills through the project path.
      const dotClaudeDir = path.join(configDir, '.claude');
      const dotClaudeSkillsDir = path.join(dotClaudeDir, 'skills');
      if (!existsSync(dotClaudeDir)) {
        mkdirSync(dotClaudeDir, { recursive: true });
      }
      if (!existsSync(dotClaudeSkillsDir)) {
        try {
          symlinkSync(configSkillsDir, dotClaudeSkillsDir, 'junction');
          console.log('[SDK Config] Created .claude/skills junction ->', configSkillsDir);
        } catch (err) {
          console.warn('[SDK Config] Failed to create .claude/skills junction:', err);
        }
      }

      ensureSandboxSettings(configDir);
      return configDir;
    })(),

    // Localhost bypasses proxy (for OpenAI compat router)
    NO_PROXY: 'localhost,127.0.0.1',
    no_proxy: 'localhost,127.0.0.1',

    // Disable non-essential traffic
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_COST_WARNINGS: '1',
    CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK: '1',

    // Performance: skip warmup calls + raise V8 heap ceiling
    CLAUDE_CODE_REMOTE: 'true',

    // Context window: tell CLI subprocess the real context window so autocompact
    // triggers at the correct threshold (default ~200K, user may configure 1M+).
    // Without this, CLI uses its internal model DB default and compresses too early.
    ...(params.contextWindow ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: params.contextWindow } : {}),

    // Performance: skip file snapshot I/O (AICO-Bot doesn't expose /rewind)
    CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: '1',

    // Windows: pass through Git Bash path (set by git-bash.service during startup)
    // This was stripped by getCleanUserEnv() along with all CLAUDE_* vars
    ...(process.env.CLAUDE_CODE_GIT_BASH_PATH
      ? { CLAUDE_CODE_GIT_BASH_PATH: process.env.CLAUDE_CODE_GIT_BASH_PATH }
      : {}),
  };

  // Override sub-agent model to inherit parent session model.
  // Built-in agents like "Explore" hardcode model: "haiku", which the SDK resolves
  // to claude-haiku-4-5-20251001. Locally the OpenAI Compat Router replaces this with
  // BackendConfig.model (request-handler.ts:375), but setting this env var explicitly
  // ensures consistency and avoids unnecessary round-trips through the router for model
  // substitution. Highest priority in SDK's Ik6() model resolution function.
  const subagentModel = params.displayModel || params.sdkModel;
  if (subagentModel) {
    env.CLAUDE_CODE_SUBAGENT_MODEL = subagentModel;
  }

  return env as Record<string, string | number>;
}

// ============================================
// SDK Options Builder
// ============================================

/**
 * Build base SDK options.
 *
 * This constructs the common SDK options used by both sendMessage and ensureSessionWarm.
 * Does NOT include dynamic configurations like AI Browser or Thinking mode.
 *
 * @param params - SDK options parameters
 * @returns Base SDK options object
 */
export function buildBaseSdkOptions(params: BaseSdkOptionsParams): Record<string, any> {
  const {
    credentials,
    workDir,
    electronPath,
    spaceId,
    conversationId,
    abortController,
    stderrHandler,
    mcpServers,
    contextWindow,
    agentId,
    agentName,
  } = params;

  console.log(
    `[SDK Config] buildBaseSdkOptions: workDir="${workDir}", spaceId="${spaceId}", contextWindow=${contextWindow || 'default'}`,
  );

  // Build environment variables
  const env = buildSdkEnv({
    anthropicApiKey: credentials.anthropicApiKey,
    anthropicBaseUrl: credentials.anthropicBaseUrl,
    contextWindow,
    displayModel: credentials.displayModel,
    sdkModel: credentials.sdkModel,
  });

  // Build base options
  const sdkOptions: Record<string, any> = {
    model: credentials.sdkModel,
    cwd: workDir,
    abortController,
    env,
    extraArgs: {
      'dangerously-skip-permissions': null,
    },
    stderr:
      stderrHandler ||
      ((data: string) => {
        console.error(`[Agent][${conversationId}] CLI stderr:`, data);
      }),
    // Use SDK's 'claude_code' preset (includes skills injection) with AICO-Bot customizations appended
    systemPrompt: {
      type: 'preset' as const,
      append: buildSystemPrompt({ workDir, modelInfo: credentials.displayModel }),
    },
    maxTurns: params.maxTurns ?? 50,
    allowedTools: [...DEFAULT_ALLOWED_TOOLS],
    // Explicitly disable WebFetch and WebSearch - use ai-browser and gh-search instead
    disallowedTools: ['WebFetch', 'WebSearch'],
    // Enable both 'user' and 'project' setting sources for skill loading.
    // The SDK in bare mode (Y9() check) only loads skills via the project path
    // (<add-dir>/.claude/skills/), not the user path. We pass configDir as an
    // additionalDirectory and create a .claude/skills junction inside it.
    settingSources: ['user', 'project'],
    additionalDirectories: [String(env.CLAUDE_CONFIG_DIR)],
    permissionMode: 'bypassPermissions' as const,
    canUseTool: createCanUseTool({
      sendToRenderer,
      spaceId,
      conversationId,
      agentId,
      agentName,
    }),
    // Requires SDK patch: enable token-level streaming (stream_event)
    includePartialMessages: true,
    executable: electronPath,
    executableArgs: ['--no-warnings'],
    // Sandbox config is written to CLAUDE_CONFIG_DIR/settings.json (see ensureSandboxSettings)
    // instead of passing via SDK's sandbox option → --settings flag → tmpdir temp file.
    // This avoids CLI creating a temp file and chokidar watching the entire tmpdir.

    // Context compaction is controlled via CLAUDE_CODE_AUTO_COMPACT_WINDOW env var
    // (set in buildSdkEnv). The SDK's compactThreshold/modelContextWindow options are
    // NOT part of SDKSessionOptions and are silently ignored.
  };

  // Add MCP servers if provided
  if (mcpServers && Object.keys(mcpServers).length > 0) {
    // createSdkMcpServer() returns objects with a live McpServer instance that
    // contains circular references. The SDK internally JSON.stringify's the
    // options during initialization. Add a toJSON method to each config so
    // serialization skips the non-serializable instance.
    for (const config of Object.values(mcpServers)) {
      const obj = config as any;
      if (obj.instance != null && typeof obj.toJSON !== 'function') {
        obj.toJSON = () => {
          const { instance, ...rest } = obj;
          return rest;
        };
      }
    }
    sdkOptions.mcpServers = mcpServers;
  }

  console.log(
    `[SDK Config] SDK options: systemPrompt=${JSON.stringify(sdkOptions.systemPrompt)?.slice(0, 80)}, settingSources=${JSON.stringify(sdkOptions.settingSources)}, additionalDirs=${JSON.stringify(sdkOptions.additionalDirectories)}, CLAUDE_CONFIG_DIR=${env.CLAUDE_CONFIG_DIR}`,
  );

  return sdkOptions;
}
