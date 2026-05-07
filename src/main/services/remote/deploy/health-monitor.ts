/**
 * Health Monitor - Health check timer, deployment integrity check, orphan cleanup
 *
 * Extracted from remote-deploy.service.ts using composition pattern.
 * All functions take (service: RemoteDeployService, ...) as first parameter.
 */

import { getDeployPath, getRemoteAgentProxyPath } from './agent-deployer';
import type { RemoteDeployService } from './remote-deploy.service';

/**
 * Start the periodic health check loop.
 * Runs every 30 seconds for all connected servers with an assigned port.
 */
export function startHealthMonitor(service: RemoteDeployService): void {
  const svc = service as any;
  const clazz = svc.constructor;

  // Use static flag to prevent duplicate timers across hot-reloads
  if (clazz.globalHealthTimer) {
    svc.healthCheckTimer = clazz.globalHealthTimer;
    return;
  }

  clazz.globalHealthTimer = setInterval(() => {
    runHealthCheck(service).catch((err: Error) => {
      console.error('[RemoteDeployService] Health check error:', err);
    });
  }, clazz.HEALTH_CHECK_INTERVAL_MS);
  svc.healthCheckTimer = clazz.globalHealthTimer;

  console.log('[RemoteDeployService] Health monitor started');
}

/**
 * Stop the periodic health check loop.
 */
export function stopHealthMonitor(service: RemoteDeployService): void {
  const svc = service as any;
  const clazz = svc.constructor;

  if (svc.healthCheckTimer) {
    clearInterval(svc.healthCheckTimer);
    svc.healthCheckTimer = null;
    clazz.globalHealthTimer = null;
    console.log('[RemoteDeployService] Health monitor stopped');
  }
}

/**
 * Run a single health check pass over all eligible servers.
 */
async function runHealthCheck(service: RemoteDeployService): Promise<void> {
  const svc = service as any;

  if (svc.healthCheckInProgress) return;
  svc.healthCheckInProgress = true;

  try {
    const eligibleServers: Array<{ id: string; server: any }> = [];
    for (const [id, server] of svc.servers) {
      if (server.status === 'connected' && server.assignedPort) {
        const manager = svc.sshManagers.get(id);
        if (manager?.isConnected()) {
          eligibleServers.push({ id, server });
        }
      }
    }

    // Check all servers in parallel
    await Promise.allSettled(eligibleServers.map(({ id }) => checkServerHealth(service, id)));
  } finally {
    svc.healthCheckInProgress = false;
  }
}

/**
 * Check proxy health for a single server.
 */
async function checkServerHealth(service: RemoteDeployService, id: string): Promise<void> {
  const server = (service as any).servers.get(id);
  if (!server || !server.assignedPort) return;

  const manager = (service as any).sshManagers.get(id);
  if (!manager?.isConnected()) return;

  try {
    const port = server.assignedPort;
    const healthPort = port + 1;
    const healthCmd = `curl -s --connect-timeout 3 http://localhost:${healthPort}/health 2>/dev/null || echo '{}'`;
    const healthResult = await manager.executeCommandFull(healthCmd);

    let proxyRunning = false;
    try {
      const healthData = JSON.parse(healthResult.stdout || '{}');
      proxyRunning = healthData.status === 'ok';
    } catch {
      proxyRunning = false;
    }

    if (proxyRunning) {
      if (server.proxyRunning !== true) {
        await service.updateServer(id, { proxyRunning: true });
        service.emitDeployProgress(id, 'health-ok', 'Proxy is running');
        console.log(`[HealthMonitor] ${server.name}: proxy recovered, status OK`);
      }
    } else {
      if (server.proxyRunning !== false) {
        await service.updateServer(id, { proxyRunning: false });
        console.log(`[HealthMonitor] ${server.name}: proxy is down`);
      }
    }
  } catch (err) {
    console.warn(`[HealthMonitor] ${server?.name}: health check failed:`, err);
  }
}

/**
 * Check remote deploy status: file integrity and version freshness.
 * Returns { filesOk, needsUpdate } where needsUpdate is true if files are missing
 * or the remote build timestamp is older than the local one.
 */
export async function checkDeployFilesIntegrity(service: RemoteDeployService, id: string): Promise<{ filesOk: boolean; needsUpdate: boolean }> {
  const server = (service as any).servers.get(id);
  if (!server) return { filesOk: false, needsUpdate: true };

  const manager = (service as any).sshManagers.get(id);
  if (!manager?.isConnected()) return { filesOk: false, needsUpdate: true };

  const deployPath = getDeployPath(server);
  const checkCmd = [
    `test -f ${deployPath}/dist/index.js`,
    `test -f ${deployPath}/dist/server.js`,
    `test -f ${deployPath}/dist/claude-manager.js`,
    `test -f ${deployPath}/dist/types.js`,
    `test -f ${deployPath}/package.json`,
    `test -d ${deployPath}/node_modules`,
    `test -f ${deployPath}/dist/version.json`,
  ].join(' && ');

  try {
    const result = await manager.executeCommandFull(`${checkCmd} && echo OK || echo MISSING`);
    const filesOk = result.stdout.trim() === 'OK';
    if (!filesOk) {
      return { filesOk: false, needsUpdate: true };
    }

    // Files exist -- compare build timestamps
    const localVersion = service.getLocalAgentVersion();
    if (!localVersion?.buildTimestamp) {
      return { filesOk: true, needsUpdate: false };
    }

    const remoteVersionResult = await manager.executeCommandFull(
      `cat ${deployPath}/dist/version.json 2>/dev/null || echo ""`,
    );
    try {
      const remoteVersion = JSON.parse(remoteVersionResult.stdout || '{}');
      const remoteTs = remoteVersion.buildTimestamp || '';
      const needsUpdate = remoteTs !== localVersion.buildTimestamp;
      if (needsUpdate) {
        console.log(
          `[RemoteDeploy] Version mismatch for ${server.name}: remote=${remoteTs}, local=${localVersion.buildTimestamp}`,
        );
      }
      return { filesOk: true, needsUpdate };
    } catch {
      // version.json parse failed -- treat as needing update
      return { filesOk: true, needsUpdate: true };
    }
  } catch {
    return { filesOk: false, needsUpdate: true };
  }
}

/**
 * Scan remote server for all per-PC deployment directories and report their status.
 * Used for orphan cleanup -- identifying abandoned deployments.
 */
export async function cleanupOrphanDeployments(service: RemoteDeployService, id: string): Promise<{
  active: Array<{ clientId: string; path: string; port: number }>;
  inactive: Array<{ clientId: string; path: string; lastModified: string }>;
}> {
  const server = (service as any).servers.get(id);
  if (!server) throw new Error(`Server not found: ${id}`);

  const manager = service.getSSHManager(id);
  if (!manager.isConnected()) {
    await service.connectServer(id);
  }

  // List all deployment directories
  const dirs = await manager.executeCommandFull(
    `ls -d /opt/claude-deployment-client-* 2>/dev/null || echo "NONE"`,
  );
  const active: Array<{ clientId: string; path: string; port: number }> = [];
  const inactive: Array<{ clientId: string; path: string; lastModified: string }> = [];

  if (dirs.stdout.includes('NONE')) return { active, inactive };

  const dirList = dirs.stdout.trim().split('\n').filter(Boolean);
  for (const dir of dirList) {
    const clientId = dir.replace('/opt/claude-deployment-', '');

    // Check if process is running
    const procCheck = await manager.executeCommandFull(
      `pgrep -f "node.*${dir}" || echo "NOT_RUNNING"`,
    );

    if (!procCheck.stdout.includes('NOT_RUNNING')) {
      // Active -- try to read port from process env
      const portResult = await manager.executeCommandFull(
        `ps aux | grep "node.*${dir}" | grep -o 'REMOTE_AGENT_PORT=[0-9]*' | head -1 | cut -d= -f2`,
      );
      active.push({
        clientId,
        path: dir,
        port: parseInt(portResult.stdout.trim()) || 0,
      });
    } else {
      // Inactive -- get last modified time
      const statResult = await manager.executeCommandFull(
        `stat -c '%Y' ${dir} 2>/dev/null || echo "0"`,
      );
      const timestamp = parseInt(statResult.stdout.trim()) * 1000;
      inactive.push({ clientId, path: dir, lastModified: new Date(timestamp).toISOString() });
    }
  }

  return { active, inactive };
}

/**
 * Delete an inactive deployment directory on the remote server.
 * Cannot delete the current PC's own active deployment.
 */
export async function deleteDeployment(service: RemoteDeployService, id: string, clientId: string): Promise<void> {
  const server = (service as any).servers.get(id);
  if (!server) throw new Error(`Server not found: ${id}`);

  // Safety: don't allow deleting own deployment
  if (clientId === server.clientId) {
    throw new Error('Cannot delete your own active deployment');
  }

  const manager = service.getSSHManager(id);
  if (!manager.isConnected()) {
    await service.connectServer(id);
  }

  const deployPath = `/opt/claude-deployment-${clientId}`;

  // Stop process if running
  await manager.executeCommand(`pkill -f "node.*${deployPath}" || true`);

  // Delete directory
  await manager.executeCommand(`rm -rf ${deployPath}`);

  console.log(`[RemoteDeployService] Deleted deployment: ${deployPath}`);
}
