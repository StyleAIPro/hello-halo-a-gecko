/**
 * Server Manager - Server CRUD operations and SSH connection management
 *
 * Extracted from remote-deploy.service.ts using composition pattern.
 * All functions take (service: RemoteDeployService, ...) as first parameter.
 */

import { app } from 'electron';
import type { SSHConfig } from '../ssh/ssh-manager';
import { SSHManager } from '../ssh/ssh-manager';
import { getConfig, saveConfig } from '../../config.service';
import type { RemoteServer } from '../../../../shared/types';
import { getClientId } from './machine-id';
import { resolvePort } from './port-allocator';
import type { RemoteDeployService } from './remote-deploy.service';

// Re-export types needed by this module (consumed via barrel)
export type { RemoteDeployService };

/**
 * Convert shared RemoteServer to internal RemoteServerConfig
 */
export function toInternalConfig(
  _service: RemoteDeployService,
  server: RemoteServer,
): import('./remote-deploy.service').RemoteServerConfig {
  return {
    ...server,
    status: server.status || 'disconnected',
    ssh: {
      host: server.host,
      port: server.sshPort,
      username: server.username,
      password: server.password,
    },
  };
}

/**
 * Convert internal RemoteServerConfig to shared RemoteServer
 */
export function toSharedConfig(
  _service: RemoteDeployService,
  config: import('./remote-deploy.service').RemoteServerConfig,
): RemoteServer {
  const { ssh, lastConnected, ...rest } = config as any;

  // Safety check for ssh object
  if (!ssh) {
    console.error('[RemoteDeployService] toSharedConfig - ssh is undefined:', config);
    throw new Error('SSH configuration is missing');
  }

  return {
    ...rest,
    host: ssh.host,
    sshPort: ssh.port,
    username: ssh.username,
    password: ssh.password,
  };
}

/**
 * Load servers from config
 */
export function loadServers(service: RemoteDeployService): void {
  const config = getConfig();
  const servers = config.remoteServers || [];

  for (const server of servers) {
    const internalConfig = toInternalConfig(service, server);
    (service as any).servers.set(server.id, {
      ...internalConfig,
      status: 'disconnected',
    });
  }

  console.log(`[RemoteDeployService] Loaded ${(service as any).servers.size} servers from config`);
}

/**
 * Save servers to config
 */
export async function saveServers(service: RemoteDeployService): Promise<void> {
  const config = getConfig();
  const serverList = Array.from((service as any).servers.values()).map((s: any) => {
    const shared = toSharedConfig(service, s);
    return {
      ...shared,
      status: 'disconnected' as const, // Don't persist connection status
    };
  });

  saveConfig({
    ...config,
    remoteServers: serverList,
  });

  console.log(`[RemoteDeployService] Saved ${serverList.length} servers to config`);
}

/**
 * Generate a unique server ID
 */
export function generateId(_service: RemoteDeployService): string {
  return `server-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Generate a random auth token
 */
export function generateAuthToken(_service: RemoteDeployService): string {
  return Buffer.from(`${Date.now()}-${Math.random()}`).toString('base64').substring(0, 32);
}

/**
 * Add a new server configuration
 * Automatically checks and deploys claude-agent-sdk if not installed
 */
export async function addServer(
  service: RemoteDeployService,
  config: import('./remote-deploy.service').RemoteServerConfigInput,
): Promise<string> {
  const id = generateId(service);
  console.log('[RemoteDeployService] addServer - Input:', JSON.stringify(config));

  // Compute machine identity for per-PC isolation (dev vs packaged)
  const clientId = getClientId(app.isPackaged ? 'packaged' : 'dev');

  service.emitDeployProgress(id, 'add', 'Saving server configuration...', 5);

  // Build complete RemoteServerConfig with all required fields
  const server: import('./remote-deploy.service').RemoteServerConfig = {
    id,
    name: config.name,
    ssh: config.ssh,
    authToken: config.authToken || generateAuthToken(service),
    status: 'disconnected',
    // Include optional fields for Claude API configuration
    workDir: config.workDir,
    claudeApiKey: config.claudeApiKey,
    claudeBaseUrl: config.claudeBaseUrl,
    claudeModel: config.claudeModel,
    aiSourceId: config.aiSourceId,
    // Per-PC isolation fields
    clientId,
    deployPath: `/opt/claude-deployment-${clientId}`,
  };

  console.log(
    '[RemoteDeployService] addServer - Server object before save:',
    JSON.stringify(server),
  );

  (service as any).servers.set(id, server);
  await saveServers(service);

  const shared = toSharedConfig(service, server);
  console.log('[RemoteDeployService] addServer - Shared config:', JSON.stringify(shared));
  console.log(`[RemoteDeployService] Added server: ${server.name} (${id})`);

  service.emitDeployProgress(id, 'ssh', 'Establishing SSH connection...', 10);

  // Only establish SSH connection, do NOT auto-deploy
  // Deployment is handled separately via "Update Agent" button
  try {
    await service.connectServer(id);
    console.log(
      `[RemoteDeployService] Server ${server.name} connected (deployment skipped - use Update Agent)`,
    );

    // Resolve port after SSH is connected
    const manager = (service as any).sshManagers.get(id);
    if (manager && manager.isConnected()) {
      service.emitDeployProgress(id, 'port', 'Allocating port on remote server...', 50);
      try {
        const assignedPort = await resolvePort(manager, clientId);
        await service.updateServer(id, { assignedPort });
        console.log(`[RemoteDeployService] Assigned port ${assignedPort} for client ${clientId}`);
      } catch (portError) {
        console.warn(`[RemoteDeployService] Port resolution failed:`, portError);
      }
    }

    // After SSH is connected, detect existing agent status (SDK + proxy)
    try {
      console.log(`[RemoteDeployService] Auto-detecting existing agent on ${server.name}...`);
      service.emitDeployProgress(id, 'detect', 'Detecting remote agent...', 55);

      const deployCheck = await service.checkDeployFilesIntegrity(id);
      const sdkOk = await (service as any).checkRemoteSdkVersion(id);

      console.log(
        `[RemoteDeployService] Detection for ${server.name}: files=${deployCheck.filesOk}, needsUpdate=${deployCheck.needsUpdate}, sdk=${sdkOk}`,
      );

      if (!deployCheck.filesOk || deployCheck.needsUpdate || !sdkOk) {
        // Auto-deploy: files missing, version outdated, or SDK mismatch
        const reasons: string[] = [];
        if (!deployCheck.filesOk) reasons.push('files missing');
        if (deployCheck.needsUpdate && deployCheck.filesOk) reasons.push('version outdated');
        if (!sdkOk) reasons.push('SDK mismatch');
        const reasonMsg = reasons.join(', ');

        service.emitDeployProgress(id, 'deploy', `Deploying (${reasonMsg})...`, 60);
        console.log(`[RemoteDeployService] Auto-deploying agent on ${server.name}: ${reasonMsg}`);

        await service.updateServer(id, { status: 'deploying' });

        try {
          // Deploy SDK if needed
          if (!sdkOk) {
            await service.deployAgentSDK(id);
          }

          // Deploy code if needed
          if (!deployCheck.filesOk || deployCheck.needsUpdate) {
            await service.deployAgentCode(id);
          }

          await service.updateServer(id, { status: 'connected' });

          // Verify after deploy
          await (service as any).verifyProxyHealth(id);

          service.emitDeployProgress(id, 'complete', 'Server added and agent deployed', 100);
          console.log(`[RemoteDeployService] Auto-deploy completed for ${server.name}`);
        } catch (deployError) {
          console.error(
            `[RemoteDeployService] Auto-deploy failed for ${server.name}:`,
            deployError,
          );
          await service.updateServer(id, {
            status: 'connected',
            error: `Auto-deploy failed: ${(deployError as Error).message}`,
          });
          service.emitDeployProgress(
            id,
            'complete',
            `Server added but deploy failed: ${(deployError as Error).message}. Use Update Agent to retry.`,
            100,
          );
        }
      } else {
        // Files and SDK are OK -- check if proxy needs restart
        const currentServer = (service as any).servers.get(id);
        if (currentServer?.proxyRunning && currentServer.assignedPort) {
          // Proxy running -- restart to sync new authToken
          service.emitDeployProgress(id, 'restart', 'Restarting proxy with new credentials...', 90);
          console.log(
            `[RemoteDeployService] Proxy is running on ${server.name}, restarting to sync new auth token...`,
          );

          try {
            await service.stopAgent(id);
            await service.startAgent(id);
            await (service as any).verifyProxyHealth(id);
            console.log(`[RemoteDeployService] Proxy restarted successfully on ${server.name}`);
          } catch (restartError) {
            console.warn(
              `[RemoteDeployService] Failed to restart proxy on ${server.name}:`,
              restartError,
            );
          }
        } else {
          // Proxy not running -- start it
          service.emitDeployProgress(id, 'start', 'Starting proxy...', 90);
          try {
            await service.startAgent(id);
            await (service as any).verifyProxyHealth(id);
            console.log(`[RemoteDeployService] Proxy started on ${server.name}`);
          } catch (startError) {
            console.warn(
              `[RemoteDeployService] Failed to start proxy on ${server.name}:`,
              startError,
            );
          }
        }

        service.emitDeployProgress(id, 'complete', 'Server added successfully', 100);
      }
    } catch (detectError) {
      // Detection failure should not block the server addition
      console.warn(`[RemoteDeployService] Auto-detect failed for ${server.name}:`, detectError);
      service.emitDeployProgress(id, 'complete', 'Server added (detection failed)', 100);
    }

    service.emitDeployProgress(id, 'complete', 'Server added successfully', 100);
  } catch (error) {
    console.error('[RemoteDeployService] Connection failed:', error);
    service.emitDeployProgress(
      id,
      'error',
      `Connection failed: ${error instanceof Error ? error.message : String(error)}`,
      0,
    );
    await service.updateServer(id, {
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return id;
}

/**
 * Get all servers
 */
export function getServers(service: RemoteDeployService): RemoteServer[] {
  return Array.from((service as any).servers.values()).map((s: any) => toSharedConfig(service, s));
}

/**
 * Get a specific server by ID
 */
export function getServer(service: RemoteDeployService, id: string): RemoteServer | undefined {
  const config = (service as any).servers.get(id);
  return config ? toSharedConfig(service, config) : undefined;
}

/**
 * Update a server configuration
 * Note: If password is not provided or empty, the original password is preserved
 * Handles both direct RemoteServerConfig updates and IPC calls with RemoteServer format
 */
export async function updateServer(
  service: RemoteDeployService,
  id: string,
  updates: Partial<Omit<import('./remote-deploy.service').RemoteServerConfig, 'id'>> & Record<string, any>,
): Promise<void> {
  const server = (service as any).servers.get(id);
  if (!server) {
    throw new Error(`Server not found: ${id}`);
  }

  const originalPassword = server.ssh?.password;
  let processedUpdates = { ...updates };

  // Handle password field from IPC (flat RemoteServer format)
  // If updates has top-level 'password' field, we need to handle it specially
  if ('password' in updates && !('ssh' in updates)) {
    const newPassword = updates.password;
    if (newPassword && newPassword.trim() !== '') {
      // Non-empty password: update ssh config
      processedUpdates = {
        ...updates,
        ssh: {
          ...server.ssh,
          host: updates.host ?? server.ssh.host,
          port: updates.sshPort ?? server.ssh.port,
          username: updates.username ?? server.ssh.username,
          password: newPassword,
        },
      };
      console.log(`[RemoteDeployService] Updating password for server ${server.name}`);
    } else {
      // Empty or missing password: preserve original, update other ssh fields
      processedUpdates = {
        ...updates,
        ssh: {
          ...server.ssh,
          host: updates.host ?? server.ssh.host,
          port: updates.sshPort ?? server.ssh.port,
          username: updates.username ?? server.ssh.username,
          password: originalPassword, // Preserve original
        },
      };
      console.log(`[RemoteDeployService] Preserving original password for server ${server.name}`);
    }
    // Remove flat fields that are now in ssh
    delete processedUpdates.password;
    delete processedUpdates.host;
    delete processedUpdates.sshPort;
    delete processedUpdates.username;
  }
  // Handle ssh.password directly (RemoteServerConfig format)
  else if (updates.ssh && 'password' in updates.ssh) {
    const newPassword = updates.ssh.password;
    if ((!newPassword || newPassword.trim() === '') && originalPassword) {
      processedUpdates.ssh = {
        ...updates.ssh,
        password: originalPassword,
      };
      console.log(
        `[RemoteDeployService] Preserving original password for server ${server.name} (ssh.password)`,
      );
    }
  }

  (service as any).servers.set(id, { ...server, ...processedUpdates });
  await saveServers(service);
  (service as any).notifyStatusChange(id, (service as any).servers.get(id)!);
}

/**
 * Update the AI source bound to a remote server.
 * Resolves the AI source's credentials and updates server card fields.
 */
export async function updateServerAiSource(
  service: RemoteDeployService,
  serverId: string,
  aiSourceId: string,
): Promise<void> {
  const server = (service as any).servers.get(serverId);
  if (!server) {
    throw new Error(`Server not found: ${serverId}`);
  }

  const config = getConfig();
  const source = config.aiSources?.sources?.find((s) => s.id === aiSourceId);
  if (!source) {
    throw new Error(`AI source not found: ${aiSourceId}`);
  }

  const claudeApiKey =
    source.authType === 'api-key' ? source.apiKey || '' : source.accessToken || '';
  const claudeBaseUrl = source.apiUrl || '';
  const claudeModel = source.model || '';

  await service.updateServer(serverId, {
    aiSourceId,
    claudeApiKey,
    claudeBaseUrl,
    claudeModel,
  });

  console.log(
    `[RemoteDeployService] Updated AI source for server ${server.name}: ${source.name} (${claudeModel})`,
  );
}

/**
 * Update only the model within the current AI source bound to a remote server.
 * Does not change the AI source -- only updates the model.
 */
export async function updateServerModel(
  service: RemoteDeployService,
  serverId: string,
  model: string,
): Promise<void> {
  const server = (service as any).servers.get(serverId);
  if (!server) {
    throw new Error(`Server not found: ${serverId}`);
  }

  if (!server.aiSourceId) {
    throw new Error(`Server ${server.name} has no AI source configured`);
  }

  const config = getConfig();
  const source = config.aiSources?.sources?.find((s) => s.id === server.aiSourceId);
  if (!source) {
    throw new Error(`AI source not found: ${server.aiSourceId}`);
  }

  await service.updateServer(serverId, {
    claudeModel: model,
  });

  console.log(`[RemoteDeployService] Updated model for server ${server.name}: ${model}`);
}

/**
 * Remove a server
 */
export async function removeServer(service: RemoteDeployService, id: string): Promise<void> {
  const server = (service as any).servers.get(id);
  if (server) {
    await service.disconnectServer(id);
    (service as any).servers.delete(id);
    await saveServers(service);
    console.log(`[RemoteDeployService] Removed server: ${server.name} (${id})`);
  }
}

// ===== SSH Connection Management =====

/**
 * Get or create SSH manager for a server
 * NOTE: Does NOT replace disconnected managers -- callers must reconnect via connectServer()
 * This prevents race conditions where a recently-connected manager gets replaced by a
 * fresh disconnected one during rapid successive calls.
 */
export function getSSHManager(service: RemoteDeployService, id: string): SSHManager {
  let manager = (service as any).sshManagers.get(id);
  if (!manager) {
    manager = new SSHManager();
    (service as any).sshManagers.set(id, manager);
  }
  return manager;
}

/**
 * Ensure SSH connection is established for a server.
 * Reconnects the existing manager if needed. This is the preferred way
 * to ensure connectivity before SSH operations.
 */
export async function ensureSshConnection(service: RemoteDeployService, id: string): Promise<void> {
  await ensureSshConnectionInternal(service, id);
}

/**
 * Internal implementation of SSH connection establishment.
 */
async function ensureSshConnectionInternal(service: RemoteDeployService, id: string): Promise<void> {
  const server = (service as any).servers.get(id);
  if (!server) throw new Error(`Server not found: ${id}`);

  const manager = (service as any).sshManagers.get(id);
  if (manager && manager.isConnected()) {
    return; // Already connected
  }

  // Reconnect using existing manager (or create new if none exists)
  const mgr = getSSHManager(service, id);
  console.log(`[RemoteDeployService] Ensuring SSH connection for ${server.name} (${id})...`);
  await mgr.connect(server.ssh);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  if (!mgr.isConnected()) {
    throw new Error(`Failed to establish SSH connection to ${server.name}`);
  }
}

/**
 * Check SSH connection health and reconnect if needed.
 * Used before long-running operations to prevent "Not connected" errors
 * when the connection silently dropped (e.g., during OS suspend, network
 * switch, or window focus change).
 */
export async function ensureSshConnectionHealthy(service: RemoteDeployService, id: string): Promise<void> {
  const server = (service as any).servers.get(id);
  if (!server) throw new Error(`Server not found: ${id}`);

  const manager = (service as any).sshManagers.get(id);
  if (!manager) {
    await ensureSshConnectionInternal(service, id);
    return;
  }

  if (!manager.isConnected()) {
    console.log(`[RemoteDeployService] SSH connection dropped, reconnecting...`);
    await ensureSshConnectionInternal(service, id);
    return;
  }

  // Connection appears active -- run a lightweight health check
  try {
    await manager.executeCommand('echo ok');
  } catch (err) {
    console.log(`[RemoteDeployService] SSH health check failed, reconnecting...`);
    await ensureSshConnectionInternal(service, id);
  }
}

/**
 * Connect to a server
 */
export async function connectServer(service: RemoteDeployService, id: string): Promise<void> {
  const server = (service as any).servers.get(id);
  if (!server) {
    throw new Error(`Server not found: ${id}`);
  }

  console.log(
    `[RemoteDeployService] connectServer called for ${server.name} (${id}), current status: ${server.status}`,
  );

  if (server.status === 'connected') {
    console.log(
      `[RemoteDeployService] Server ${server.name} already connected, checking SSH state...`,
    );
    const manager = (service as any).sshManagers.get(id);
    console.log(`[RemoteDeployService] SSH state: ${manager?.isConnected()}`);
    if (manager && manager.isConnected()) {
      console.log(`[RemoteDeployService] SSH is connected, reusing connection`);
      return;
    }
    console.log(`[RemoteDeployService] SSH is not connected, will reconnect`);
  }

  await service.updateServer(id, { status: 'connecting' });

  try {
    console.log(`[RemoteDeployService] Establishing SSH connection for ${server.name}...`);
    service.emitDeployProgress(id, 'ssh', 'Connecting to remote server...', 15);

    await ensureSshConnectionInternal(service, id);

    const manager = (service as any).sshManagers.get(id);
    console.log(
      `[RemoteDeployService] Verifying SSH connection after ensureSshConnection: ${manager?.isConnected()}`,
    );

    if (!manager?.isConnected()) {
      throw new Error('SSH connection not established');
    }

    service.emitDeployProgress(id, 'ssh', 'SSH connection established', 30);

    // Resolve per-PC isolation fields if not yet assigned (covers reconnection after restart)
    if (!server.assignedPort) {
      const clientId = server.clientId || getClientId(app.isPackaged ? 'packaged' : 'dev');
      const mgr = (service as any).sshManagers.get(id);
      if (mgr && mgr.isConnected()) {
        service.emitDeployProgress(id, 'port', 'Allocating port on remote server...', 45);
        try {
          const assignedPort = await resolvePort(mgr, clientId);
          await service.updateServer(id, {
            clientId,
            assignedPort,
            deployPath: `/opt/claude-deployment-${clientId}`,
          });
          console.log(
            `[RemoteDeployService] Resolved port ${assignedPort} for client ${clientId} on reconnect`,
          );
        } catch (portError) {
          console.warn(`[RemoteDeployService] Port resolution failed on reconnect:`, portError);
        }
      }
    }

    await service.updateServer(id, {
      status: 'connected',
      error: undefined,
      lastConnected: new Date(),
    });

    // Auto-detect CPU architecture for offline deployment
    if (!server.detectedArch) {
      try {
        const mgr = (service as any).sshManagers.get(id);
        if (mgr && mgr.isConnected()) {
          const archResult = await mgr.executeCommand('uname -m', { timeoutMs: 10_000 });
          const arch = archResult.trim();
          const detectedArch =
            arch === 'x86_64' ? 'x64' : arch === 'aarch64' ? 'arm64' : undefined;
          if (detectedArch) {
            await service.updateServer(id, { detectedArch });
            console.log(
              `[RemoteDeployService] Detected architecture on connect: ${arch} (${detectedArch})`,
            );
          }
        }
      } catch {
        // Non-critical, ignore
      }
    }

    // Detect agent status after connection so proxyRunning is accurate
    try {
      await service.detectAgentInstalled(id);
    } catch (detectError) {
      console.warn(
        `[RemoteDeployService] Agent detection failed after connect for ${server.name}:`,
        detectError,
      );
    }

    // Reset auto-recover failure count on successful (re)connection

    console.log(`[RemoteDeployService] Connected to server: ${server.name}`);
  } catch (error) {
    const err = error as Error;
    console.error(`[RemoteDeployService] connectServer error for ${server.name}:`, err);
    await service.updateServer(id, {
      status: 'error',
      error: err.message,
    });
    throw error;
  }
}

/**
 * Disconnect from a server
 */
export async function disconnectServer(service: RemoteDeployService, id: string): Promise<void> {
  const manager = (service as any).sshManagers.get(id);
  if (manager) {
    manager.disconnect();
    (service as any).sshManagers.delete(id);
  }

  const server = (service as any).servers.get(id);
  if (server && (server.status === 'connected' || server.status === 'connecting')) {
    await service.updateServer(id, { status: 'disconnected', error: undefined });
    console.log(`[RemoteDeployService] Disconnected from server: ${server.name}`);
  }
}

/**
 * Disconnect all servers
 */
export function disconnectAll(service: RemoteDeployService): void {
  for (const [id] of (service as any).servers) {
    service.disconnectServer(id);
  }
}

/**
 * Register a status change callback
 */
export function onStatusChange(
  service: RemoteDeployService,
  callback: (serverId: string, config: RemoteServer) => void,
): void {
  (service as any).statusCallbacks.add(callback);
}

/**
 * Remove a status change callback
 */
export function offStatusChange(
  service: RemoteDeployService,
  callback: (serverId: string, config: RemoteServer) => void,
): void {
  (service as any).statusCallbacks.delete(callback);
}

/**
 * Notify all registered callbacks of a status change
 */
export function notifyStatusChange(
  service: RemoteDeployService,
  serverId: string,
  config: import('./remote-deploy.service').RemoteServerConfig,
): void {
  const shared = toSharedConfig(service, config);
  for (const callback of (service as any).statusCallbacks) {
    try {
      callback(serverId, shared);
    } catch (error) {
      console.error('[RemoteDeployService] Status callback error:', error);
    }
  }
}
