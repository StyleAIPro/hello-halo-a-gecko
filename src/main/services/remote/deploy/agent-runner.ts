/**
 * Agent Runner - Agent start/stop/restart, system prompt sync, remote command execution, log retrieval
 *
 * Extracted from remote-deploy.service.ts using composition pattern.
 * All functions take (service: RemoteDeployService, ...) as first parameter.
 */

import type { SSHManager } from '../ssh/ssh-manager';
import { SYSTEM_PROMPT_TEMPLATE } from '../../agent/system-prompt';
import { removePooledConnection } from '../ws/remote-ws-client';
import { getDeployPath, escapeEnvValue, REQUIRED_SDK_VERSION, AGENT_CHECK_COMMAND } from './agent-deployer';
import type { RemoteDeployService } from './remote-deploy.service';

/**
 * Register this instance's auth token with a running remote proxy.
 * Called when the proxy is already running (started by another instance, e.g. dev + packaged).
 */
export async function registerTokenOnRemote(service: RemoteDeployService, id: string): Promise<void> {
  const server = (service as any).servers.get(id);
  if (!server) {
    throw new Error(`Server not found: ${id}`);
  }

  const manager = service.getSSHManager(id);
  const port = server.assignedPort;
  if (!port) {
    console.warn('[RemoteDeployService] No port assigned, cannot register token');
    return;
  }

  const healthPort = port + 1;
  const token = server.authToken;
  if (!token) {
    console.warn('[RemoteDeployService] No auth token, skipping registration');
    return;
  }

  try {
    // Register token via health port HTTP endpoint
    const tokenB64 = Buffer.from(JSON.stringify({ token })).toString('base64');
    const cmd = `echo '${tokenB64}' | base64 -d | curl -s -X POST -H "Content-Type: application/json" -d @- http://localhost:${healthPort}/tokens`;
    const result = await manager.executeCommandFull(cmd);

    try {
      const response = JSON.parse(result.stdout || '{}');
      if (response.success) {
        console.log(
          `[RemoteDeployService] Token registered on remote proxy (total tokens: ${response.totalTokens}, new: ${response.added})`,
        );
      } else {
        console.warn(
          '[RemoteDeployService] Token registration returned failure:',
          response.error,
        );
      }
    } catch {
      console.warn(
        '[RemoteDeployService] Could not parse token registration response, proxy may be running old version',
      );
    }
  } catch (error) {
    console.error('[RemoteDeployService] Token registration error:', error);
  }

  // Persist token to tokens.json for survival across proxy restarts
  const deployPath = getDeployPath(server);
  const tokenB64 = Buffer.from(token).toString('base64');
  const persistCmd = `node -e "const fs=require('fs');const p='${deployPath}/tokens.json';let t=[];try{t=JSON.parse(fs.readFileSync(p,'utf8'));}catch{}const tk=Buffer.from('${tokenB64}','base64').toString();if(!t.includes(tk)){t.push(tk);fs.writeFileSync(p,JSON.stringify(t,null,2));}"`;
  await manager.executeCommand(persistCmd).catch((e: Error) => {
    console.warn('[RemoteDeployService] Failed to persist token to tokens.json:', e);
  });
}

/**
 * Start the agent on the remote server
 */
export async function startAgent(service: RemoteDeployService, id: string): Promise<void> {
  const server = (service as any).servers.get(id);
  if (!server) {
    throw new Error(`Server not found: ${id}`);
  }

  const manager = service.getSSHManager(id);
  const deployPath = getDeployPath(server);
  const port = server.assignedPort;

  // Ensure logs directory exists
  await manager.executeCommand(`mkdir -p ${deployPath}/logs`);

  // Read and display build info before starting
  try {
    const versionJsonResult = await manager.executeCommandFull(
      `cat ${deployPath}/dist/version.json 2>/dev/null || echo ""`,
    );
    if (versionJsonResult.stdout.trim()) {
      const buildInfo = JSON.parse(versionJsonResult.stdout);
      const buildInfoMsg = [
        '========================================',
        'Remote Agent Build Info:',
        `  Version: ${buildInfo.version || 'unknown'}`,
        `  Build Time: ${buildInfo.buildTime || buildInfo.buildTimestamp || 'unknown'}`,
        `  Node: ${buildInfo.nodeVersion || 'unknown'}`,
        `  Platform: ${buildInfo.platform || 'unknown'} (${buildInfo.arch || 'unknown'})`,
        '========================================',
      ].join('\n');
      console.log('[RemoteDeployService] Remote agent build info:');
      console.log(buildInfoMsg);
      service.emitCommandOutput(id, 'output', buildInfoMsg);
    }
  } catch (e) {
    console.warn('[RemoteDeployService] Could not read remote build info:', e);
  }

  // Check if proxy is healthy via health endpoint (authoritative)
  const healthPort = (port || 8080) + 1;
  let proxyHealthy = false;
  try {
    const healthResult = await manager.executeCommandFull(
      `curl -s --connect-timeout 3 http://localhost:${healthPort}/health 2>/dev/null || echo '{}'`,
    );
    const healthData = JSON.parse(healthResult.stdout || '{}');
    proxyHealthy = healthData.status === 'ok';
  } catch {
    // proxyHealthy remains false
  }

  if (proxyHealthy) {
    console.log(
      '[RemoteDeployService] Agent already running and healthy, skipping start (proxy supports multiple connections)',
    );
    await registerTokenOnRemote(service, id);
    return;
  }

  // Proxy not healthy -- check if a stale process exists and clean it up
  const checkResult = await manager.executeCommandFull(
    `pgrep -f "node.*${deployPath}" || echo "not running"`,
  );

  if (checkResult.exitCode === 0 && !checkResult.stdout.includes('not running')) {
    // Process exists -- verify it's actually healthy via health endpoint
    const healthPortLocal = port + 1;
    const healthCheck = await manager.executeCommandFull(
      `curl -s --connect-timeout 2 http://localhost:${healthPortLocal}/health 2>/dev/null || echo '{}'`,
    );
    try {
      const healthData = JSON.parse(healthCheck.stdout || '{}');
      if (healthData.status === 'ok') {
        console.log('[RemoteDeployService] Agent already running and healthy, skipping start');
        return;
      }
    } catch {
      // Health check failed -- process is zombie, kill and restart
    }
    console.log(
      '[RemoteDeployService] Agent process exists but unhealthy, killing and restarting...',
    );
    await service.stopAgent(id);
  }

  // Start the agent server with environment variables
  const escapeEnvValue = (value: string | undefined): string => {
    if (!value) return "''";
    return `'${value.replace(/'/g, "'\\''")}'`;
  };

  const envVars = [
    `REMOTE_AGENT_PORT=${port}`,
    `REMOTE_AGENT_AUTH_TOKEN=${escapeEnvValue(server.authToken)}`,
    server.workDir ? `REMOTE_AGENT_WORK_DIR=${escapeEnvValue(server.workDir)}` : null,
    `IS_SANDBOX=1`,
    `DEPLOY_DIR=${deployPath}`,
  ]
    .filter(Boolean)
    .join(' ');

  const indexPath = `${deployPath}/dist/index.js`;

  console.log(
    `[RemoteDeployService] Starting agent with env: PORT=${port}, WORK_DIR=${server.workDir || '(not set, will use per-session workDir)'}, DEPLOY_DIR=${deployPath}`,
  );

  const startCommand = `nohup env PATH="/usr/local/bin:/usr/local/node-v*/bin:$PATH" ${envVars} node ${indexPath} > ${deployPath}/logs/output.log 2>&1 &`;
  await manager.executeCommand(startCommand);

  // Wait a moment for the process to start
  await new Promise((resolve) => setTimeout(resolve, 5000));

  // Check if it's running by checking the port (try both ss and netstat)
  const verifyResult = await manager.executeCommandFull(
    `(ss -tln 2>/dev/null || netstat -tln 2>/dev/null) | grep ":${port}" || echo "NOT_RUNNING"`,
  );

  if (verifyResult.stdout.includes('NOT_RUNNING')) {
    // Check the logs for error
    let logOutput = '';
    try {
      const logResult = await manager.executeCommandFull(
        `tail -50 ${deployPath}/logs/output.log 2>&1 || echo "No log file"`,
      );
      logOutput = logResult.stdout || logResult.stderr || 'No logs available';
      console.error('[RemoteDeployService] Agent startup failed. Logs:', logOutput);
      service.emitCommandOutput(id, 'error', `Agent startup logs:\n${logOutput}`);
    } catch (e) {
      console.error('[RemoteDeployService] Failed to read logs:', e);
    }

    // Also check if node process is running at all
    const processCheck = await manager.executeCommandFull(
      `ps aux | grep -E "node.*${deployPath}" | grep -v grep || echo "NO_PROCESS"`,
    );
    console.log('[RemoteDeployService] Process check:', processCheck.stdout);

    // Self-repair: if logs indicate missing dependencies, run npm install and retry once
    const missingDepPattern = /ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package/;
    if (missingDepPattern.test(logOutput)) {
      console.log(
        '[RemoteDeployService] Startup failed due to missing dependencies, attempting self-repair...',
      );
      service.emitCommandOutput(id, 'output', '检测到依赖缺失，自动修复中...');

      // Stop any leftover process
      await manager.executeCommand(`pkill -f "node.*${deployPath}" || true`);

      // Run npm install
      service.emitCommandOutput(id, 'output', '执行 npm install...');
      const repairResult = await manager.executeCommandStreaming(
        `cd ${deployPath} && export PATH="/usr/local/bin:$PATH" && npm install --legacy-peer-deps 2>&1`,
        (type, data) => {
          const lines = data.split('\n').filter((line: string) => line.trim());
          for (const line of lines) {
            service.emitCommandOutput(id, type === 'stderr' ? 'error' : 'output', line);
          }
        },
      );

      if (repairResult.exitCode !== 0) {
        throw new Error(
          `Failed to start agent - dependency repair failed. Logs: ${logOutput.slice(0, 500)}`,
        );
      }

      service.emitCommandOutput(id, 'success', '✓ 依赖修复完成，重新启动 agent...');

      // Retry start
      await manager.executeCommand(startCommand);
      await new Promise((resolve) => setTimeout(resolve, 5000));

      const retryResult = await manager.executeCommandFull(
        `(ss -tln 2>/dev/null || netstat -tln 2>/dev/null) | grep ":${port}" || echo "NOT_RUNNING"`,
      );

      if (retryResult.stdout.includes('NOT_RUNNING')) {
        let retryLog = '';
        try {
          const retryLogResult = await manager.executeCommandFull(
            `tail -30 ${deployPath}/logs/output.log 2>&1 || echo ""`,
          );
          retryLog = retryLogResult.stdout || '';
        } catch {}

        throw new Error(
          `Failed to start agent after dependency repair. Logs: ${retryLog.slice(0, 500)}`,
        );
      }

      console.log(
        `[RemoteDeployService] Agent started after self-repair on: ${server.name}, port ${port}`,
      );
      return;
    }

    throw new Error(
      `Failed to start agent process - port ${port} not listening. Logs: ${logOutput.slice(0, 500)}`,
    );
  }

  console.log(`[RemoteDeployService] Agent started on: ${server.name}, port ${port}`);
}

/**
 * Stop the agent on the remote server
 */
export async function stopAgent(service: RemoteDeployService, id: string): Promise<void> {
  const server = (service as any).servers.get(id);
  if (!server) {
    throw new Error(`Server not found: ${id}`);
  }

  // Disconnect pooled WebSocket connections BEFORE stopping the agent.
  // This prevents "socket hang up" errors from propagating when the
  // remote agent process is killed while connections are still active.
  removePooledConnection(id);

  const manager = service.getSSHManager(id);

  // Ensure SSH connection is established before executing command
  if (!manager.isConnected()) {
    await service.connectServer(id);
  }

  // Kill any node process running from the deployment directory
  const deployPath = getDeployPath(server);
  await manager.executeCommand(`pkill -f "node.*${deployPath}" || true`);

  console.log(`[RemoteDeployService] Agent stopped on: ${server.name}`);
}

/**
 * Restart agent with new configuration (e.g., updated API key)
 * This only restarts the agent process, doesn't redeploy code
 */
export async function restartAgentWithNewConfig(service: RemoteDeployService, id: string): Promise<void> {
  const server = (service as any).servers.get(id);
  if (!server) {
    throw new Error(`Server not found: ${id}`);
  }

  console.log(`[RemoteDeployService] Restarting agent with new config for: ${server.name}`);

  // Check if agent is currently running
  const manager = service.getSSHManager(id);
  const deployPath = getDeployPath(server);
  const checkResult = await manager.executeCommandFull(
    `pgrep -f "node.*${deployPath}" || echo "not running"`,
  );

  if (checkResult.exitCode === 0 && !checkResult.stdout.includes('not running')) {
    // Agent is running, restart it with new config
    console.log(`[RemoteDeployService] Agent is running, restarting with new config...`);
    await service.stopAgent(id);
    await service.startAgent(id);
    console.log(`[RemoteDeployService] Agent restarted with new config`);
  } else {
    console.log(`[RemoteDeployService] Agent not running, no restart needed`);
  }
}

/**
 * Restart remote agent proxy if it is currently running.
 * Used after skill uninstall to ensure the proxy reloads its skill list.
 */
export async function restartAgentIfRunning(
  service: RemoteDeployService,
  id: string,
  onOutput?: (data: {
    type: 'stdout' | 'stderr' | 'complete' | 'error';
    content: string;
  }) => void,
): Promise<void> {
  const server = (service as any).servers.get(id);
  if (!server) throw new Error(`Server not found: ${id}`);

  const manager = service.getSSHManager(id);
  const deployPath = getDeployPath(server);
  const checkResult = await manager.executeCommandFull(
    `pgrep -f "node.*${deployPath}" || echo "not running"`,
  );

  if (checkResult.exitCode === 0 && !checkResult.stdout.includes('not running')) {
    onOutput?.({
      type: 'stdout',
      content: `[${server.name}] Restarting agent proxy to reload skills...\n`,
    });
    await service.stopAgent(id);
    await service.startAgent(id);
    onOutput?.({ type: 'stdout', content: `[${server.name}] Agent proxy restarted.\n` });
  } else {
    onOutput?.({
      type: 'stdout',
      content: `[${server.name}] Agent proxy not running, skip restart.\n`,
    });
  }
}

/**
 * This uploads the template with placeholders intact.
 * The remote server will replace placeholders at runtime with its own values.
 */
export async function syncSystemPrompt(service: RemoteDeployService, id: string): Promise<void> {
  const server = (service as any).servers.get(id);
  if (!server) {
    throw new Error(`Server not found: ${id}`);
  }

  const manager = service.getSSHManager(id);

  try {
    // Create config directory if not exists
    const deployPath = getDeployPath(server);
    await manager.executeCommand(`mkdir -p ${deployPath}/config`);

    // Write system prompt template to file
    // The template uses ${VAR} placeholders that will be replaced at runtime by the remote server
    const remotePath = `${deployPath}/config/system-prompt.txt`;

    // Use base64 encoding to safely transfer the prompt template
    const base64Content = Buffer.from(SYSTEM_PROMPT_TEMPLATE).toString('base64');
    const uploadCommand = `echo "${base64Content}" | base64 -d > ${remotePath}`;

    await manager.executeCommand(uploadCommand);

    console.log(`[RemoteDeployService] System prompt template synced to ${remotePath}`);
  } catch (error) {
    console.error('[RemoteDeployService] Failed to sync system prompt:', error);
    throw error;
  }
}

/**
 * Get agent server logs
 */
export async function getAgentLogs(service: RemoteDeployService, id: string, lines: number = 100): Promise<string> {
  const server = (service as any).servers.get(id);
  if (!server) {
    throw new Error(`Server not found: ${id}`);
  }

  const manager = service.getSSHManager(id);
  try {
    const deployPath = getDeployPath(server);
    const logPath = `${deployPath}/logs/output.log`;
    const result = await manager.executeCommandFull(`tail -${lines} ${logPath}`);
    return result.stdout;
  } catch (error) {
    console.error('[RemoteDeployService] Failed to get agent logs:', error);
    throw error;
  }
}

/**
 * Get the local agent package version and build info
 */
export function getLocalAgentVersion(_service: RemoteDeployService): { version?: string; buildTime?: string; buildTimestamp?: string } | null {
  try {
    const { getRemoteAgentProxyPath } = require('./agent-deployer');
    const packageDir = getRemoteAgentProxyPath();
    const distDir = require('path').join(packageDir, 'dist');

    // First try to read version.json (generated by build script)
    const versionJsonPath = require('path').join(distDir, 'version.json');
    const fs = require('fs');
    if (fs.existsSync(versionJsonPath)) {
      const versionJson = JSON.parse(fs.readFileSync(versionJsonPath, 'utf-8'));
      return {
        version: versionJson.version,
        buildTime: versionJson.buildTime,
        buildTimestamp: versionJson.buildTimestamp,
      };
    }

    // Fallback to reading package.json
    const packageJsonPath = require('path').join(packageDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      return {
        version: packageJson.version,
        buildTime: packageJson.buildTime,
        buildTimestamp: packageJson.buildTimestamp,
      };
    }
    return null;
  } catch (error) {
    console.error('[RemoteDeployService] Failed to read local agent version:', error);
    return null;
  }
}

/**
 * Check if agent server is running
 */
export async function isAgentRunning(service: RemoteDeployService, id: string): Promise<boolean> {
  const server = (service as any).servers.get(id);
  if (!server) {
    throw new Error(`Server not found: ${id}`);
  }

  const manager = service.getSSHManager(id);
  try {
    // Check if the WebSocket port is listening
    const port = server.assignedPort;
    const result = await manager.executeCommandFull(
      `ss -tln | grep ":${port}" || echo "NOT_RUNNING"`,
    );
    return !result.stdout.includes('NOT_RUNNING');
  } catch {
    return false;
  }
}

/**
 * Execute a command on the remote server
 */
export async function executeCommand(service: RemoteDeployService, id: string, command: string): Promise<string> {
  const server = (service as any).servers.get(id);
  if (!server) {
    throw new Error(`Server not found: ${id}`);
  }

  if (server.status !== 'connected') {
    await service.connectServer(id);
  }

  const manager = service.getSSHManager(id);
  return manager.executeCommand(command);
}

// ===== Remote file operations =====

/**
 * List remote files via `ls -la`, parsed into structured FileInfo objects
 */
export async function listRemoteFiles(
  service: RemoteDeployService,
  id: string,
  directory?: string,
): Promise<
  Array<{
    name: string;
    isDirectory: boolean;
    size: number;
    modifiedTime: Date;
  }>
> {
  const dir = directory || '/opt/remote-agent-proxy';
  const output = await service.executeCommand(id, `ls -la "${dir}"`);
  const lines = output.trim().split('\n').slice(1); // Skip total line
  return lines
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      const name = parts[parts.length - 1];
      const isDir = line.startsWith('d');
      return {
        name,
        isDirectory: isDir,
        size: parseInt(parts[4] || '0', 10),
        modifiedTime: new Date(),
      };
    })
    .filter((f) => f.name !== '.' && f.name !== '..');
}

/**
 * Read a remote file via SSH
 */
export async function readRemoteFile(service: RemoteDeployService, id: string, filePath: string): Promise<string> {
  return service.executeCommand(id, `cat "${filePath}"`);
}

/**
 * Write content to a remote file via SSH (single-quote escaped)
 */
export async function writeRemoteFile(service: RemoteDeployService, id: string, filePath: string, content: string): Promise<void> {
  const escapedContent = content.replace(/'/g, "'\\''");
  await service.executeCommand(id, `echo '${escapedContent}' > "${filePath}"`);
}

/**
 * Delete a remote file/directory via SSH
 */
export async function deleteRemoteFile(service: RemoteDeployService, id: string, filePath: string): Promise<void> {
  await service.executeCommand(id, `rm -rf "${filePath}"`);
}

// ===== Agent update orchestration =====

/**
 * Full agent update: stop --> deploy code --> verify --> return version info
 *
 * This orchestrates the multi-step update that was previously in the IPC handler.
 */
export async function updateAgent(service: RemoteDeployService, id: string): Promise<{
  message: string;
  remoteVersion: string;
  remoteBuildTime?: string;
  localVersion: string;
  localBuildTime?: string;
}> {
  const server = (service as any).servers.get(id);
  if (!server) throw new Error(`Server not found: ${id}`);
  console.log(`[RemoteDeploy] Updating agent for ${id}...`);

  // Check remote environment: files, version freshness, and SDK independently
  const deployCheck = await service.checkDeployFilesIntegrity(id);
  const sdkOk = await (service as any).checkRemoteSdkVersion(id);
  const needsCodeDeploy = !deployCheck.filesOk || deployCheck.needsUpdate;

  console.log(
    `[RemoteDeploy] Detection for ${server.name}: files=${deployCheck.filesOk}, needsUpdate=${deployCheck.needsUpdate}, sdk=${sdkOk}`,
  );

  // Stop agent first (regardless of what needs updating)
  await service.stopAgent(id);

  // Deploy only what's needed
  if (needsCodeDeploy || !sdkOk) {
    const reasons: string[] = [];
    if (!deployCheck.filesOk) reasons.push('files missing');
    if (deployCheck.needsUpdate && deployCheck.filesOk) reasons.push('version outdated');
    if (!sdkOk) reasons.push('SDK mismatch');

    service.emitDeployProgress(id, 'update', `Deploying (${reasons.join(', ')})...`);

    if (!sdkOk) {
      console.log(`[RemoteDeploy] SDK version mismatch, installing SDK...`);
      await service.deployAgentSDK(id);
    }

    if (needsCodeDeploy) {
      console.log(`[RemoteDeploy] Deploying proxy code (${reasons.join(', ')})...`);
      await service.deployAgentCode(id);
    }
  } else {
    console.log(`[RemoteDeploy] Files and SDK OK for ${server.name}, restarting agent only`);
    service.emitDeployProgress(id, 'update', 'Files and SDK verified, restarting agent...');
  }

  // Start proxy (or let deployAgentCode's internal start handle it)
  // deployAgentCode internally calls startAgent, so only call if we didn't deploy code
  if (!needsCodeDeploy) {
    await service.startAgent(id);
  }

  // Immediately verify proxy health
  await (service as any).verifyProxyHealth(id);

  const localVersionInfo = service.getLocalAgentVersion();
  const result = {
    message:
      needsCodeDeploy || !sdkOk
        ? 'Agent updated and restarted successfully'
        : 'Agent restarted (files and SDK already up to date)',
    remoteVersion: REQUIRED_SDK_VERSION,
    localVersion: localVersionInfo?.version || 'unknown',
    localBuildTime: localVersionInfo?.buildTime,
  };

  console.log(`[RemoteDeploy] Agent update complete for ${id}`, result);
  service.completeUpdate(id, result);
  return result;
}

/**
 * Verify proxy health immediately after starting agent.
 * Updates proxyRunning on the server config so the UI reflects the real state
 * without waiting for the background health monitor cycle.
 */
export async function verifyProxyHealth(service: RemoteDeployService, id: string): Promise<void> {
  const server = (service as any).servers.get(id);
  if (!server || !server.assignedPort) return;

  const manager = (service as any).sshManagers.get(id);
  if (!manager?.isConnected()) return;

  // Wait briefly for proxy to initialize
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const healthPort = server.assignedPort + 1;
  const healthCmd = `curl -s --connect-timeout 3 http://localhost:${healthPort}/health 2>/dev/null || echo '{}'`;
  try {
    const healthResult = await manager.executeCommandFull(healthCmd);
    const healthData = JSON.parse(healthResult.stdout || '{}');
    const isOk = healthData.status === 'ok';
    await service.updateServer(id, { proxyRunning: isOk });
    console.log(`[RemoteDeploy] Immediate health check for ${server.name}: proxyRunning=${isOk}`);
  } catch {
    await service.updateServer(id, { proxyRunning: false });
    console.warn(`[RemoteDeploy] Immediate health check failed for ${server.name}`);
  }
}

/**
 * Check if the remote SDK version matches the required version.
 */
export async function checkRemoteSdkVersion(service: RemoteDeployService, id: string): Promise<boolean> {
  const server = (service as any).servers.get(id);
  if (!server) return false;

  const manager = (service as any).sshManagers.get(id);
  if (!manager?.isConnected()) return false;

  try {
    const result = await manager.executeCommandFull(AGENT_CHECK_COMMAND);
    const stdout = result.stdout.trim();
    const installed =
      stdout.includes('@anthropic-ai/claude-agent-sdk') && !stdout.includes('NOT_INSTALLED');
    if (!installed) return false;

    const versionMatch = stdout.match(/@anthropic-ai\/claude-agent-sdk@([\d.]+)/);
    const version = versionMatch ? versionMatch[1] : '';
    return version === REQUIRED_SDK_VERSION;
  } catch {
    return false;
  }
}

/**
 * Get the SSH manager for a server (for streaming execution)
 */
export function getSSHManagerForServer(service: RemoteDeployService, id: string): SSHManager | undefined {
  const server = (service as any).servers.get(id);
  if (!server) {
    return undefined;
  }
  if (server.status !== 'connected') {
    return undefined;
  }
  return service.getSSHManager(id);
}

/**
 * Send a message to the agent via SSH (for operations not yet supported by WebSocket)
 */
export async function sendAgentMessage(service: RemoteDeployService, id: string, message: any): Promise<any> {
  const server = (service as any).servers.get(id);
  if (!server) {
    throw new Error(`Server not found: ${id}`);
  }

  // For now, this is a placeholder
  // In the full implementation, this would use WebSocket client
  console.log(`[RemoteDeployService] Sending message to agent:`, message.type);

  return {
    type: 'response',
    success: true,
  };
}

/**
 * Send a chat message to the remote agent via WebSocket
 * Returns response with tokenUsage for display in chat UI
 */
export async function sendAgentChat(
  service: RemoteDeployService,
  id: string,
  params: { sessionId?: string; content: string; attachments?: any[] },
): Promise<{
  response: string;
  sessionId?: string;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    totalCostUsd: number;
    contextWindow: number;
  };
}> {
  const server = (service as any).servers.get(id);
  if (!server) {
    throw new Error(`Server not found: ${id}`);
  }

  // Get the WebSocket client for this server
  const wsClient = (service as any).getOrCreateWsClient(id, server);

  try {
    // Send chat message with streaming
    const result = await wsClient.sendChatWithStream(
      params.sessionId || `session-${Date.now()}`,
      [{ role: 'user', content: params.content }],
    );

    return {
      response: result.content,
      sessionId: params.sessionId,
      tokenUsage: result.tokenUsage
        ? {
            inputTokens: result.tokenUsage.inputTokens || 0,
            outputTokens: result.tokenUsage.outputTokens || 0,
            cacheReadTokens: result.tokenUsage.cacheReadTokens || 0,
            cacheCreationTokens: result.tokenUsage.cacheCreationTokens || 0,
            totalCostUsd: result.tokenUsage.totalCostUsd || 0,
            contextWindow: result.tokenUsage.contextWindow || 200000,
          }
        : undefined,
    };
  } catch (error) {
    console.error(`[RemoteDeployService] Failed to send chat to agent:`, error);
    throw error;
  }
}

/**
 * Subscribe to real-time task updates from a remote server.
 * Forwards task:update events to the main window via IPC.
 */
export function subscribeToTaskUpdates(service: RemoteDeployService, serverId: string): () => void {
  const { BrowserWindow } = require('electron');
  const wsClient = (service as any).getOrCreateWsClient(serverId, (service as any).servers.get(serverId));
  const handler = (data: any) => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send('remote-server:task-update', { serverId, data });
    }
  };
  wsClient.on('task:update', handler);
  return () => {
    wsClient.off('task:update', handler);
  };
}

/**
 * List background tasks on a remote server
 */
export function listRemoteTasks(service: RemoteDeployService, serverId: string): Promise<any[]> {
  const wsClient = (service as any).getOrCreateWsClient(serverId, (service as any).servers.get(serverId));
  return new Promise((resolve, _reject) => {
    const handler = (data: any) => {
      wsClient.off('task:list', handler);
      resolve(data);
    };
    wsClient.on('task:list', handler);
    wsClient.listTasks();
    // Timeout after 5s
    setTimeout(() => {
      wsClient.off('task:list', handler);
      resolve([]);
    }, 5000);
  });
}

/**
 * Cancel a background task on a remote server
 */
export function cancelRemoteTask(service: RemoteDeployService, serverId: string, taskId: string): Promise<boolean> {
  const wsClient = (service as any).getOrCreateWsClient(serverId, (service as any).servers.get(serverId));
  return new Promise((resolve, _reject) => {
    const handler = (data: any) => {
      wsClient.off('task:cancel', handler);
      resolve(data?.success ?? false);
    };
    wsClient.on('task:cancel', handler);
    wsClient.cancelTask(taskId);
    setTimeout(() => {
      wsClient.off('task:cancel', handler);
      resolve(false);
    }, 5000);
  });
}

/**
 * Get or create WebSocket client for a server
 */
export function getOrCreateWsClient(service: RemoteDeployService, id: string, server: any): any {
  // Dynamic import to avoid circular dependency
  const { RemoteWsClient } = require('../ws/remote-ws-client');

  // Check if we already have a client for this server
  const existingClient = (RemoteWsClient as any).getRemoteWsClient(id);
  if (existingClient) {
    return existingClient;
  }

  // Resolve API credentials -- server card aiSourceId takes precedence, then global AI source
  const { getConfig } = require('../../config.service');
  const { decryptString } = require('../../auth/secure-storage.service');
  const config = getConfig();
  const sourceId = server.aiSourceId || config.aiSources?.currentId;
  const currentSource = sourceId
    ? config.aiSources?.sources?.find((s: any) => s.id === sourceId)
    : undefined;

  // Decrypt apiKey (handles both encrypted aiSources and plaintext server card values)
  const apiKeyRaw = server.claudeApiKey || currentSource?.apiKey || config.api?.apiKey;
  const apiKey = apiKeyRaw ? decryptString(apiKeyRaw) : undefined;
  const baseUrl = server.claudeBaseUrl || currentSource?.apiUrl;
  const model = server.claudeModel || currentSource?.model || config.api?.model;

  // Create new WebSocket client
  const wsConfig = {
    serverId: id,
    host: server.ssh.host,
    port: server.assignedPort, // Prefer per-PC assigned port
    useSshTunnel: false, // TODO: Support SSH tunneling
    authToken: server.authToken || '',
    // Bind server card API credentials to this connection (per-PC isolation)
    apiKey,
    baseUrl: baseUrl || undefined,
    model: model || undefined,
  };

  const client = new RemoteWsClient(wsConfig);
  return client;
}

// ===== Agent installed check =====

/**
 * Lightweight detection of claude-agent-sdk on remote server
 * Unlike checkAgentInstalled(), this does NOT emit terminal output
 * Used for quick auto-detection when adding/connecting to a server
 */
export async function detectAgentInstalled(service: RemoteDeployService, id: string): Promise<{ installed: boolean; version?: string }> {
  const server = (service as any).servers.get(id);
  if (!server) {
    throw new Error(`Server not found: ${id}`);
  }

  const manager = service.getSSHManager(id);

  // Only connect if not already connected
  if (!manager.isConnected()) {
    await service.connectServer(id);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (!manager.isConnected()) {
    return { installed: false };
  }

  try {
    // Level 1: Check SDK installation with version match
    service.emitDeployProgress(id, 'detect', 'Checking SDK installation...', 60);
    const result = await manager.executeCommandFull(AGENT_CHECK_COMMAND);
    const stdout = result.stdout.trim();
    const installed =
      stdout.includes('@anthropic-ai/claude-agent-sdk') && !stdout.includes('NOT_INSTALLED');

    let version: string | undefined;
    let versionMatched = false;
    if (installed) {
      const versionMatch = stdout.match(/@anthropic-ai\/claude-agent-sdk@([\d.]+)/);
      version = versionMatch ? versionMatch[1] : 'unknown';
      versionMatched = version === REQUIRED_SDK_VERSION;
    }

    // Level 1.5: Fallback -- check file existence directly
    // npm list -g may not find packages installed via cp (offline deploy)
    if (!installed) {
      const deployPath = getDeployPath(server);
      const fallbackCheck = await manager.executeCommandFull(
        `cat $(npm root -g 2>/dev/null)/@anthropic-ai/claude-agent-sdk/package.json 2>/dev/null | grep '"version"' || ` +
          `cat ${deployPath}/node_modules/@anthropic-ai/claude-agent-sdk/package.json 2>/dev/null | grep '"version"' || ` +
          `echo ""`,
      );
      const versionLine = fallbackCheck.stdout.trim();
      const fbVersionMatch = versionLine.match(/"version":\s*"([\d.]+)"/);
      if (fbVersionMatch) {
        version = fbVersionMatch[1];
        versionMatched = version === REQUIRED_SDK_VERSION;
        installed = true;
        console.log(
          `[RemoteDeployService] SDK found via file existence check, version=${version}`,
        );
      }
    }

    // Level 2: Check if proxy is running via health endpoint
    let proxyRunning = false;
    if (server.assignedPort) {
      service.emitDeployProgress(id, 'detect', 'Checking proxy service...', 75);
      try {
        const port = server.assignedPort;
        const healthPort = port + 1;
        const healthCmd = `curl -s --connect-timeout 3 http://localhost:${healthPort}/health 2>/dev/null || echo '{}'`;
        const healthResult = await manager.executeCommandFull(healthCmd);
        try {
          const healthData = JSON.parse(healthResult.stdout || '{}');
          proxyRunning = healthData.status === 'ok';
        } catch {
          proxyRunning = false;
        }
      } catch {
        proxyRunning = false;
      }
    }

    // Update server config with full detection results
    // Note: sdkInstalled=false when version mismatch -- treated as not properly installed
    const sdkOk = installed && versionMatched;
    await service.updateServer(id, {
      sdkInstalled: sdkOk,
      sdkVersion: version,
      sdkVersionMismatch: installed && !versionMatched,
      proxyRunning,
    });

    console.log(
      `[RemoteDeployService] detectAgentInstalled for ${server.name}: installed=${installed}, version=${version}, required=${REQUIRED_SDK_VERSION}, matched=${versionMatched}, proxyRunning=${proxyRunning}`,
    );

    return { installed: sdkOk, version };
  } catch (error) {
    console.error(`[RemoteDeployService] detectAgentInstalled failed for ${server.name}:`, error);
    return { installed: false };
  }
}

/**
 * Check if claude-agent-sdk is installed on remote server
 */
export async function checkAgentInstalled(
  service: RemoteDeployService,
  id: string,
): Promise<{ installed: boolean; version?: string; buildTime?: string }> {
  const server = (service as any).servers.get(id);
  if (!server) {
    throw new Error(`Server not found: ${id}`);
  }

  console.log(
    `[RemoteDeployService] Starting SDK check for ${server.name}, current status: ${server.status}`,
  );

  // Get the SSH manager first
  const manager = service.getSSHManager(id);

  // Check if SSH connection is actually established
  console.log(`[RemoteDeployService] Checking SSH connection state: ${manager.isConnected()}`);

  // Only connect if not already connected
  if (!manager.isConnected()) {
    console.log(`[RemoteDeployService] Not connected, connecting to ${server.name}...`);
    await service.connectServer(id);
    // Wait for connection to stabilize
    console.log(`[RemoteDeployService] Waiting for SSH connection to stabilize...`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  // Verify connection is ready
  console.log(
    `[RemoteDeployService] Verifying SSH connection state after connect: ${manager.isConnected()}`,
  );
  if (!manager.isConnected()) {
    throw new Error(`Failed to establish SSH connection to server: ${server.name}`);
  }

  try {
    // First, test connection with a simple pwd command
    console.log(
      `[RemoteDeployService] Testing SSH connection to ${server.name} with pwd command...`,
    );
    service.emitCommandOutput(id, 'command', 'pwd');
    const testResult = await manager.executeCommandFull('pwd');
    console.log(`[RemoteDeployService] pwd result: ${testResult.stdout}`);
    if (testResult.stdout.trim()) {
      service.emitCommandOutput(id, 'output', testResult.stdout.trim());
    }

    // Check if claude-agent-sdk is installed (try fast local check first, then fallback to npm list -g)
    console.log(`[RemoteDeployService] Checking for claude-agent-sdk...`);

    let installed = false;
    let version: string | undefined;

    // Fast path 1: Check local node_modules first (for offline deployments)
    const deployPath = getDeployPath(server);
    const localSdkCheckCmd = `test -f "${deployPath}/node_modules/@anthropic-ai/claude-agent-sdk/package.json" && cat "${deployPath}/node_modules/@anthropic-ai/claude-agent-sdk/package.json" | grep -oP '"version"\\s*:\\s*"\\K[^"]+' || echo ""`;

    console.log(`[RemoteDeployService] Trying fast local SDK check...`);
    service.emitCommandOutput(
      id,
      'command',
      `检查本地 SDK: ${deployPath}/node_modules/@anthropic-ai/claude-agent-sdk`,
    );

    try {
      const localResult = await manager.executeCommandFull(localSdkCheckCmd, { timeout: 5000 });
      const localVersion = localResult.stdout.trim();
      if (localVersion) {
        version = localVersion;
        installed = true;
        console.log(`[RemoteDeployService] Found SDK locally: version ${version}`);
        service.emitCommandOutput(id, 'success', `SDK 在本地部署路径找到 (版本: ${version})`);
      }
    } catch (error) {
      console.warn(`[RemoteDeployService] Local SDK check failed:`, error);
    }

    // Fallback: If not found locally, try npm list -g (slower but catches globally installed SDK)
    if (!installed) {
      console.log(`[RemoteDeployService] Local check failed, trying npm list -g...`);
      service.emitCommandOutput(id, 'command', AGENT_CHECK_COMMAND);
      try {
        const result = await manager.executeCommandFull(AGENT_CHECK_COMMAND, { timeout: 10000 });
        const stdout = result.stdout.trim();
        const stderr = result.stderr.trim();

        console.log(
          `[RemoteDeployService] npm list output: stdout="${stdout}", stderr="${stderr}"`,
        );

        if (stdout) {
          service.emitCommandOutput(id, 'output', stdout);
        }
        if (stderr && !stderr.includes('npm WARN')) {
          service.emitCommandOutput(id, 'error', stderr);
        }

        // npm list -g returns:
        // - If installed: "/path/to/node_modules/@anthropic-ai/claude-agent-sdk@x.y.z"
        // - If not installed: empty string or "empty string"
        if (
          stdout.includes('@anthropic-ai/claude-agent-sdk') &&
          !stdout.includes('NOT_INSTALLED')
        ) {
          installed = true;
          // Parse version from output like: "/path/node_modules/@anthropic-ai/claude-agent-sdk@0.1.0"
          const versionMatch = stdout.match(/@anthropic-ai\/claude-agent-sdk@([\d.]+)/);
          version = versionMatch ? versionMatch[1] : 'unknown';
        }
      } catch (npmError) {
        console.warn(`[RemoteDeployService] npm list -g timed out or failed:`, npmError);
        service.emitCommandOutput(id, 'warning', 'npm list -g 检查超时，可能是权限问题');
      }
    }

    const statusMessage = installed
      ? `claude-agent-sdk is installed (version: ${version})`
      : 'claude-agent-sdk is not installed';

    service.emitCommandOutput(id, 'success', statusMessage);
    console.log(
      `[RemoteDeployService] Agent check for ${server.name}: installed=${installed}, version=${version}`,
    );

    // Update server config with SDK status (only mark installed if version matches exactly)
    const versionMatched = installed && version === REQUIRED_SDK_VERSION;
    await service.updateServer(id, {
      sdkInstalled: versionMatched,
      sdkVersion: version,
      sdkVersionMismatch: installed && !versionMatched,
    });

    // Also read the deployed package.json to get build timestamp
    let buildTime: string | undefined;
    try {
      const deployPathInner = getDeployPath(server);
      const packageJsonResult = await manager.executeCommandFull(
        `cat ${deployPathInner}/package.json 2>/dev/null || echo ""`,
      );
      if (packageJsonResult.stdout.trim()) {
        const remotePackageJson = JSON.parse(packageJsonResult.stdout);
        if (remotePackageJson.buildTime) {
          buildTime = remotePackageJson.buildTime;
          console.log(`[RemoteDeployService] Remote agent build time: ${buildTime}`);
        }
        if (remotePackageJson.version && !version) {
          // Use package.json version as fallback
          version = remotePackageJson.version;
        }
      }
    } catch (pkgError) {
      console.warn('[RemoteDeployService] Failed to read remote package.json:', pkgError);
    }

    return { installed, version, buildTime };
  } catch (error) {
    console.error(`[RemoteDeployService] Failed to check agent on ${server.name}:`, error);
    throw error;
  }
}

/**
 * Deploy agent SDK to remote server via SCP
 */
export async function deployAgentSDK(service: RemoteDeployService, id: string): Promise<void> {
  const server = (service as any).servers.get(id);
  if (!server) {
    throw new Error(`Server not found: ${id}`);
  }

  console.log(
    `[RemoteDeployService] Starting SDK deployment for ${server.name}, current status: ${server.status}`,
  );

  // Get the SSH manager first
  const manager = service.getSSHManager(id);

  // Check if SSH connection is actually established
  console.log(`[RemoteDeployService] Checking SSH connection state: ${manager.isConnected()}`);

  // Only connect if not already connected
  if (!manager.isConnected()) {
    console.log(`[RemoteDeployService] Not connected, connecting to ${server.name}...`);
    await service.connectServer(id);
    // Wait for connection to stabilize
    console.log(`[RemoteDeployService] Waiting for SSH connection to stabilize...`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  // Verify connection is ready
  console.log(
    `[RemoteDeployService] Verifying SSH connection state after connect: ${manager.isConnected()}`,
  );
  if (!manager.isConnected()) {
    throw new Error(`Failed to establish SSH connection to server: ${server.name}`);
  }

  try {
    console.log(`[RemoteDeployService] Deploying agent SDK to ${server.name}`);
    service.emitCommandOutput(id, 'command', 'Starting deployment of claude-agent-sdk...');

    // First, test connection with a simple pwd command
    console.log(
      `[RemoteDeployService] Testing SSH connection to ${server.name} with pwd command...`,
    );
    service.emitCommandOutput(id, 'command', 'pwd');
    const testResult = await manager.executeCommandFull('pwd');
    console.log(`[RemoteDeployService] pwd result: ${testResult.stdout}`);
    if (testResult.stdout.trim()) {
      service.emitCommandOutput(id, 'output', testResult.stdout.trim());
    }

    // Check if Node.js is installed, install if not
    console.log('[RemoteDeployService] Checking Node.js installation...');
    service.emitCommandOutput(id, 'command', 'node --version');
    try {
      const nodeVersion = await manager.executeCommandFull('node --version');
      console.log(`[RemoteDeployService] Node.js version: ${nodeVersion.stdout.trim()}`);
      service.emitCommandOutput(id, 'output', nodeVersion.stdout.trim());
    } catch {
      // Node.js not installed, install it automatically
      console.log('[RemoteDeployService] Node.js not found, installing...');
      service.emitCommandOutput(id, 'command', 'Installing Node.js 20.x...');

      // Detect OS and architecture, then install Node.js
      const installNodeCmd = `ARCH=$(uname -m) && NODE_ARCH=$([ "$ARCH" = "aarch64" ] && echo "linux-arm64" || echo "linux-x64") && NODE_VER="v20.18.1" && if node --version > /dev/null 2>&1; then echo "Node.js already installed and working"; elif [ -f /etc/debian_version ]; then curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs; elif [ -f /etc/redhat-release ]; then curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && yum install -y nodejs; elif grep -qE "EulerOS|openEuler|hce" /etc/os-release 2>/dev/null; then echo "Detected EulerOS/openEuler on $ARCH, installing Node.js $NODE_VER for $NODE_ARCH..." && rm -rf /usr/local/node-v* /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx 2>/dev/null && (curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-$NODE_ARCH.tar.xz" -o /tmp/node.tar.xz || curl -fsSL "https://npmmirror.com/mirrors/node/$NODE_VER/node-$NODE_VER-$NODE_ARCH.tar.xz" -o /tmp/node.tar.xz) && tar -xJf /tmp/node.tar.xz -C /usr/local && rm /tmp/node.tar.xz && ln -sf /usr/local/node-$NODE_VER-$NODE_ARCH/bin/node /usr/local/bin/node && ln -sf /usr/local/node-$NODE_VER-$NODE_ARCH/bin/npm /usr/local/bin/npm && ln -sf /usr/local/node-$NODE_VER-$NODE_ARCH/bin/npx /usr/local/bin/npx; elif command -v apk > /dev/null 2>&1; then apk add nodejs npm; else echo "Unsupported OS: $(cat /etc/os-release 2>/dev/null | head -1)" && exit 1; fi`;

      // Node.js install may download packages, allow up to 5 minutes
      const nodeInstallResult = await manager.executeCommandFull(installNodeCmd, {
        timeoutMs: 300_000,
      });
      if (nodeInstallResult.stdout.trim()) {
        service.emitCommandOutput(id, 'output', nodeInstallResult.stdout.trim());
      }
      if (nodeInstallResult.exitCode !== 0) {
        service.emitCommandOutput(
          id,
          'error',
          `Failed to install Node.js: ${nodeInstallResult.stderr}`,
        );
        throw new Error(`Failed to install Node.js: ${nodeInstallResult.stderr}`);
      }

      // Configure npm to use Chinese mirror after installation
      await manager.executeCommand('npm config set registry https://registry.npmmirror.com');

      service.emitCommandOutput(id, 'success', 'Node.js installed successfully');
    }

    // Check if npm is installed (usually comes with Node.js)
    console.log('[RemoteDeployService] Checking npm installation...');
    service.emitCommandOutput(id, 'command', 'npm --version');
    try {
      const npmVersion = await manager.executeCommandFull('npm --version');
      console.log(`[RemoteDeployService] npm version: ${npmVersion.stdout.trim()}`);
      service.emitCommandOutput(id, 'output', npmVersion.stdout.trim());
    } catch {
      // npm not found - this shouldn't happen if Node.js was just installed
      service.emitCommandOutput(
        id,
        'error',
        'npm is not installed. This should not happen after Node.js installation.',
      );
      throw new Error('npm is not installed on the remote server. Please reinstall Node.js.');
    }

    // Check if npx is installed (usually comes with Node.js, but may be missing in some installations)
    console.log('[RemoteDeployService] Checking npx installation...');
    service.emitCommandOutput(id, 'command', 'npx --version');
    try {
      const npxVersion = await manager.executeCommandFull('npx --version');
      console.log(`[RemoteDeployService] npx version: ${npxVersion.stdout.trim()}`);
      service.emitCommandOutput(id, 'output', `npx: ${npxVersion.stdout.trim()}`);
    } catch {
      // npx not found - install it using npm
      console.log('[RemoteDeployService] npx not found, installing...');
      service.emitCommandOutput(id, 'command', 'npm install -g npx --force');
      const npxInstallResult = await manager.executeCommandFull('npm install -g npx --force', {
        timeoutMs: 120_000,
      });
      if (npxInstallResult.stdout.trim()) {
        service.emitCommandOutput(id, 'output', npxInstallResult.stdout.trim());
      }
      if (npxInstallResult.exitCode !== 0 && !npxInstallResult.stderr.includes('EEXIST')) {
        service.emitCommandOutput(id, 'error', `Failed to install npx: ${npxInstallResult.stderr}`);
        throw new Error(`Failed to install npx: ${npxInstallResult.stderr}`);
      }
      service.emitCommandOutput(id, 'success', 'npx installed successfully');

      // STEP 1: Clean up old standalone npx package FIRST (causes cb.apply errors with npm 10.x)
      console.log('[RemoteDeployService] Checking for standalone npx package...');
      const checkStandaloneNpx = await manager.executeCommandFull(
        'npm list -g npx 2>/dev/null || echo "NOT_FOUND"',
      );
      if (
        checkStandaloneNpx.stdout.includes('npx@') &&
        !checkStandaloneNpx.stdout.includes('npm@')
      ) {
        console.log('[RemoteDeployService] Found standalone npx package, removing...');
        const removeStandaloneCmd = 'npm uninstall -g npx 2>/dev/null || true';
        await manager.executeCommandFull(removeStandaloneCmd);
        service.emitCommandOutput(
          id,
          'output',
          'Removed standalone npx package (using npm built-in npx)',
        );
      }

      // STEP 2: Clean npm cache to prevent cb.apply errors
      await manager.executeCommand('npm cache clean --force 2>/dev/null || true', {
        timeoutMs: 60_000,
      });

      // STEP 3: After cleanup, verify npx is in PATH and create/fix symlink
      try {
        const npmPrefixResult = await manager.executeCommandFull('npm config get prefix');
        const npmPrefix = npmPrefixResult.stdout.trim() || '/usr/local';

        const findAndLinkCmd = `
            NPX_BIN=""
            # Try npm prefix location first (npm built-in npx)
            if [ -f "${npmPrefix}/bin/npx" ]; then
              NPX_BIN="${npmPrefix}/bin/npx"
            # Try node installation directory
            elif [ -f "/usr/local/node-v20.18.1-linux-arm64/bin/npx" ]; then
              NPX_BIN="/usr/local/node-v20.18.1-linux-arm64/bin/npx"
            # Fallback: search for npx
            else
              NPX_BIN=$(find /usr/local -name npx -type f 2>/dev/null | head -1)
            fi
            if [ -n "$NPX_BIN" ] && [ -x "$NPX_BIN" ]; then
              rm -f /usr/local/bin/npx
              ln -sf "$NPX_BIN" /usr/local/bin/npx
              echo "Created symlink: /usr/local/bin/npx -> $NPX_BIN"
            else
              echo "Could not find npx binary"
              exit 1
            fi
          `;
        const linkResult = await manager.executeCommandFull(findAndLinkCmd);
        if (linkResult.stdout.trim()) {
          service.emitCommandOutput(id, 'output', linkResult.stdout.trim());
        }
        if (linkResult.exitCode === 0) {
          service.emitCommandOutput(id, 'success', 'npx symlink created in /usr/local/bin');
        }

        // STEP 4: Verify npx works correctly after all fixes
        const verifyNpxCmd = await manager.executeCommandFull('npx --version 2>&1');
        if (verifyNpxCmd.exitCode === 0 && verifyNpxCmd.stdout.trim()) {
          service.emitCommandOutput(id, 'output', `npx version: ${verifyNpxCmd.stdout.trim()}`);
        } else if (verifyNpxCmd.stdout.includes('Error') || verifyNpxCmd.exitCode !== 0) {
          console.log(
            '[RemoteDeployService] npx still not working, creating alternative wrapper...',
          );
          const createWrapperCmd = `
              cat > /usr/local/bin/npx << 'WRAPPER'
#!/bin/sh
exec node "${npmPrefix}/lib/node_modules/npm/bin/npx-cli.js" "$@"
WRAPPER
              chmod +x /usr/local/bin/npx
            `;
          await manager.executeCommandFull(createWrapperCmd);
          service.emitCommandOutput(id, 'output', 'Created npx wrapper script');
        }
      } catch (linkError) {
        console.warn('[RemoteDeployService] Failed to create npx symlink:', linkError);
        // Don't throw - continue with deployment
      }
    }

    // Install Claude CLI globally (required for SDK to work)
    console.log('[RemoteDeployService] Checking Claude CLI installation...');
    service.emitCommandOutput(id, 'command', 'claude --version');
    try {
      const claudeVersion = await manager.executeCommandFull('claude --version');
      console.log(`[RemoteDeployService] Claude CLI version: ${claudeVersion.stdout.trim()}`);
      service.emitCommandOutput(id, 'output', `Claude CLI: ${claudeVersion.stdout.trim()}`);
    } catch {
      // Claude CLI not installed, install it
      console.log('[RemoteDeployService] Claude CLI not found, installing...');
      service.emitCommandOutput(id, 'command', 'npm install -g @anthropic-ai/claude-code');
      const claudeInstallResult = await manager.executeCommandFull(
        'npm install -g @anthropic-ai/claude-code',
        { timeoutMs: 180_000 },
      );
      if (claudeInstallResult.stdout.trim()) {
        service.emitCommandOutput(id, 'output', claudeInstallResult.stdout.trim());
      }
      if (claudeInstallResult.exitCode !== 0) {
        service.emitCommandOutput(
          id,
          'error',
          `Failed to install Claude CLI: ${claudeInstallResult.stderr}`,
        );
        throw new Error(`Failed to install Claude CLI: ${claudeInstallResult.stderr}`);
      }
      service.emitCommandOutput(id, 'success', 'Claude CLI installed successfully');
    }

    // Install claude-agent-sdk globally (skip if already at target version)
    console.log('[RemoteDeployService] Checking @anthropic-ai/claude-agent-sdk version...');
    service.emitCommandOutput(id, 'command', AGENT_CHECK_COMMAND);
    const sdkCheckResult = await manager.executeCommandFull(AGENT_CHECK_COMMAND);
    const sdkCheckStdout = sdkCheckResult.stdout.trim();
    const sdkAlreadyInstalled =
      sdkCheckStdout.includes('@anthropic-ai/claude-agent-sdk') &&
      !sdkCheckStdout.includes('NOT_INSTALLED');
    let sdkNeedsInstall = true;

    if (sdkAlreadyInstalled) {
      const versionMatch = sdkCheckStdout.match(/@anthropic-ai\/claude-agent-sdk@([\d.]+)/);
      const installedVersion = versionMatch ? versionMatch[1] : 'unknown';
      if (installedVersion === REQUIRED_SDK_VERSION) {
        service.emitCommandOutput(
          id,
          'output',
          `SDK ${REQUIRED_SDK_VERSION} already installed, skipping.`,
        );
        sdkNeedsInstall = false;
      } else {
        service.emitCommandOutput(
          id,
          'output',
          `SDK version mismatch: installed ${installedVersion}, need ${REQUIRED_SDK_VERSION}. Updating...`,
        );
      }
    }

    if (sdkNeedsInstall) {
      console.log('[RemoteDeployService] Installing @anthropic-ai/claude-agent-sdk globally...');

      // Configure npm to use Chinese mirror for faster installation
      console.log('[RemoteDeployService] Configuring npm mirror (npmmirror)...');
      await manager.executeCommand('npm config set registry https://registry.npmmirror.com');

      const installCmd = `npm install -g @anthropic-ai/claude-agent-sdk@${REQUIRED_SDK_VERSION}`;
      service.emitCommandOutput(id, 'command', installCmd);
      const installResult = await manager.executeCommandFull(installCmd, { timeoutMs: 180_000 });
      console.log('[RemoteDeployService] npm install output:', installResult.stdout);
      if (installResult.stdout.trim()) {
        service.emitCommandOutput(id, 'output', installResult.stdout.trim());
      }
      if (installResult.stderr) {
        console.log('[RemoteDeployService] npm install stderr:', installResult.stderr);
        service.emitCommandOutput(id, 'error', installResult.stderr.trim());
      }

      if (installResult.exitCode !== 0) {
        service.emitCommandOutput(
          id,
          'error',
          `npm install failed with exit code ${installResult.exitCode}`,
        );
        throw new Error(
          `npm install failed with exit code ${installResult.exitCode}: ${installResult.stderr}`,
        );
      }

      const successMsg = 'claude-agent-sdk installed successfully';
      service.emitCommandOutput(id, 'success', successMsg);
      console.log(`[RemoteDeployService] Agent SDK deployment completed for ${server.name}`);

      // Update SDK status after deployment
      const sdkCheck = await service.checkAgentInstalled(id);
      await service.updateServer(id, {
        sdkInstalled: sdkCheck.installed,
        sdkVersion: sdkCheck.version,
      });
    } // end if (sdkNeedsInstall)
  } catch (error) {
    const err = error as Error;
    console.error(`[RemoteDeployService] Failed to deploy agent SDK to ${server.name}:`, error);
    service.emitCommandOutput(id, 'error', err.message);
    throw error;
  }
}
