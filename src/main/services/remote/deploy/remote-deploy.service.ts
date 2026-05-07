/**
 * Remote Deploy Service — Aggregation Layer
 *
 * This file is the thin facade that composes the service from sub-modules.
 * All private state lives here; logic is delegated to extracted functions.
 */

import type { SSHConfig } from '../ssh/ssh-manager';
import { SSHManager } from '../ssh/ssh-manager';
import type { RemoteServer } from '../../../../shared/types';
import type { InstalledSkill } from '../../../../shared/skill/skill-types';
import type { SkillFileNode } from '../../../../shared/skill/skill-types';

// Sub-module imports (composition pattern)
import * as serverManager from './server-manager';
import * as agentDeployer from './agent-deployer';
import * as agentRunner from './agent-runner';
import * as remoteSkillManager from './remote-skill-manager';
import * as healthMonitor from './health-monitor';

// Re-export utility functions and constants for consumers
export { agentDeployer };
export { escapeEnvValue, getDeployPath, getRemoteAgentProxyPath } from './agent-deployer';
export { REQUIRED_SDK_VERSION, AGENT_CHECK_COMMAND } from './agent-deployer';

// Extended server config with runtime fields not persisted
export interface RemoteServerConfig extends RemoteServer {
  ssh: SSHConfig;
  lastConnected?: Date;
}

export interface RemoteServerConfigInput extends Omit<
  RemoteServerConfig,
  'id' | 'status' | 'lastConnected'
> {
  ssh: SSHConfig;
}

export interface UpdateOperationState {
  inProgress: boolean;
  completedAt?: number;
  success?: boolean;
  data?: any;
  error?: string;
}

export class RemoteDeployService {
  private servers: Map<string, RemoteServerConfig> = new Map();
  private sshManagers: Map<string, SSHManager> = new Map();
  private statusCallbacks: Set<(serverId: string, config: RemoteServer) => void> = new Set();
  private commandOutputCallbacks: Set<
    (serverId: string, type: 'command' | 'output' | 'error' | 'success', content: string) => void
  > = new Set();
  private deployProgressCallbacks: Set<
    (serverId: string, stage: string, message: string, progress?: number) => void
  > = new Set();
  // Track update operations so the UI can restore state after component remount
  private updateOperations: Map<string, UpdateOperationState> = new Map();

  // Health monitor
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private healthCheckInProgress = false;
  private static readonly HEALTH_CHECK_INTERVAL_MS = 30_000;
  private static globalHealthTimer: ReturnType<typeof setInterval> | null = null;

  // Operation watchdog: auto-fail stale operations after timeout
  private static readonly OPERATION_WATCHDOG_MS = 10 * 60 * 1000; // 10 minutes
  private operationWatchdogs: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor() {
    serverManager.loadServers(this);
    healthMonitor.startHealthMonitor(this);
  }

  // ===== Event subscription / emission =====

  onCommandOutput(
    callback: (
      serverId: string,
      type: 'command' | 'output' | 'error' | 'success',
      content: string,
    ) => void,
  ): () => void {
    this.commandOutputCallbacks.add(callback);
    return () => this.commandOutputCallbacks.delete(callback);
  }

  onDeployProgress(
    callback: (serverId: string, stage: string, message: string, progress?: number) => void,
  ): () => void {
    this.deployProgressCallbacks.add(callback);
    return () => this.deployProgressCallbacks.delete(callback);
  }

  emitCommandOutput(
    serverId: string,
    type: 'command' | 'output' | 'error' | 'success',
    content: string,
  ): void {
    this.commandOutputCallbacks.forEach((callback) => callback(serverId, type, content));
  }

  emitDeployProgress(
    serverId: string,
    stage: string,
    message: string,
    progress?: number,
  ): void {
    console.log(`[RemoteDeployService][${serverId}] ${stage}: ${message}`);
    this.deployProgressCallbacks.forEach((callback) =>
      callback(serverId, stage, message, progress),
    );
  }

  // ===== Update operation state tracking =====

  startUpdate(id: string): void {
    this.updateOperations.set(id, { inProgress: true });

    const existingWatchdog = this.operationWatchdogs.get(id);
    if (existingWatchdog) clearTimeout(existingWatchdog);

    const watchdog = setTimeout(() => {
      const op = this.updateOperations.get(id);
      if (op?.inProgress) {
        console.warn(`[RemoteDeployService] Operation watchdog triggered for ${id}`);
        this.failUpdate(
          id,
          `操作超时（超过 ${Math.round(RemoteDeployService.OPERATION_WATCHDOG_MS / 1000)}s 未完成）`,
        );
      }
    }, RemoteDeployService.OPERATION_WATCHDOG_MS);
    this.operationWatchdogs.set(id, watchdog);
  }

  completeUpdate(id: string, data?: any): void {
    const watchdog = this.operationWatchdogs.get(id);
    if (watchdog) {
      clearTimeout(watchdog);
      this.operationWatchdogs.delete(id);
    }
    this.updateOperations.set(id, {
      inProgress: false,
      completedAt: Date.now(),
      success: true,
      data,
    });
  }

  failUpdate(id: string, error: string): void {
    const watchdog = this.operationWatchdogs.get(id);
    if (watchdog) {
      clearTimeout(watchdog);
      this.operationWatchdogs.delete(id);
    }
    this.updateOperations.set(id, {
      inProgress: false,
      completedAt: Date.now(),
      success: false,
      error,
    });
  }

  getUpdateStatus(id: string): UpdateOperationState | null {
    return this.updateOperations.get(id) || null;
  }

  cancelOperation(id: string): void {
    console.log(`[RemoteDeployService] cancelOperation called for ${id}`);
    const watchdog = this.operationWatchdogs.get(id);
    if (watchdog) {
      clearTimeout(watchdog);
      this.operationWatchdogs.delete(id);
    }
    this.failUpdate(id, '用户取消了操作');

    const manager = this.sshManagers.get(id);
    if (manager) {
      manager.disconnect();
    }

    this.emitCommandOutput(id, 'error', '操作已被用户取消');
  }

  getInProgressUpdates(): string[] {
    const result: string[] = [];
    for (const [id, state] of this.updateOperations) {
      if (state.inProgress) result.push(id);
    }
    return result;
  }

  acknowledgeUpdate(id: string): void {
    this.updateOperations.delete(id);
  }

  // ===== Server Manager delegates =====

  toInternalConfig = serverManager.toInternalConfig.bind(null, this);
  toSharedConfig = serverManager.toSharedConfig.bind(null, this);
  loadServers = serverManager.loadServers.bind(null, this);
  saveServers = serverManager.saveServers.bind(null, this);
  generateId = serverManager.generateId.bind(null, this);
  generateAuthToken = serverManager.generateAuthToken.bind(null, this);

  addServer = serverManager.addServer.bind(null, this);
  getServers = serverManager.getServers.bind(null, this);
  getServer = serverManager.getServer.bind(null, this);
  updateServer = serverManager.updateServer.bind(null, this);
  updateServerAiSource = serverManager.updateServerAiSource.bind(null, this);
  updateServerModel = serverManager.updateServerModel.bind(null, this);
  removeServer = serverManager.removeServer.bind(null, this);

  getSSHManager = serverManager.getSSHManager.bind(null, this);
  ensureSshConnection = serverManager.ensureSshConnection.bind(null, this);
  ensureSshConnectionHealthy = serverManager.ensureSshConnectionHealthy.bind(null, this);
  connectServer = serverManager.connectServer.bind(null, this);
  disconnectServer = serverManager.disconnectServer.bind(null, this);
  disconnectAll = serverManager.disconnectAll.bind(null, this);

  onStatusChange = serverManager.onStatusChange.bind(null, this);
  offStatusChange = serverManager.offStatusChange.bind(null, this);
  notifyStatusChange = serverManager.notifyStatusChange.bind(null, this);

  // ===== Agent Deployer delegates =====

  deployToServer = agentDeployer.deployToServer.bind(null, this);
  deployAgentCode = agentDeployer.deployAgentCode.bind(null, this);
  updateAgentCode = agentDeployer.updateAgentCode.bind(null, this);
  deployAgentCodeOffline = agentDeployer.deployAgentCodeOffline.bind(null, this);
  updateAgentCodeOffline = agentDeployer.updateAgentCodeOffline.bind(null, this);
  isOfflineBundleAvailable = agentDeployer.isOfflineBundleAvailable.bind(null, this);
  getOfflineBundlePath = agentDeployer.getOfflineBundlePath.bind(null, this);

  // ===== Agent Runner delegates =====

  startAgent = agentRunner.startAgent.bind(null, this);
  stopAgent = agentRunner.stopAgent.bind(null, this);
  restartAgentWithNewConfig = agentRunner.restartAgentWithNewConfig.bind(null, this);
  restartAgentIfRunning = agentRunner.restartAgentIfRunning.bind(null, this);
  syncSystemPrompt = agentRunner.syncSystemPrompt.bind(null, this);
  getAgentLogs = agentRunner.getAgentLogs.bind(null, this);
  getLocalAgentVersion = agentRunner.getLocalAgentVersion.bind(null, this);
  isAgentRunning = agentRunner.isAgentRunning.bind(null, this);
  executeCommand = agentRunner.executeCommand.bind(null, this);

  listRemoteFiles = agentRunner.listRemoteFiles.bind(null, this);
  readRemoteFile = agentRunner.readRemoteFile.bind(null, this);
  writeRemoteFile = agentRunner.writeRemoteFile.bind(null, this);
  deleteRemoteFile = agentRunner.deleteRemoteFile.bind(null, this);

  updateAgent = agentRunner.updateAgent.bind(null, this);
  verifyProxyHealth = agentRunner.verifyProxyHealth.bind(null, this);
  checkRemoteSdkVersion = agentRunner.checkRemoteSdkVersion.bind(null, this);
  getSSHManagerForServer = agentRunner.getSSHManagerForServer.bind(null, this);
  sendAgentMessage = agentRunner.sendAgentMessage.bind(null, this);
  sendAgentChat = agentRunner.sendAgentChat.bind(null, this);
  subscribeToTaskUpdates = agentRunner.subscribeToTaskUpdates.bind(null, this);
  listRemoteTasks = agentRunner.listRemoteTasks.bind(null, this);
  cancelRemoteTask = agentRunner.cancelRemoteTask.bind(null, this);
  getOrCreateWsClient = agentRunner.getOrCreateWsClient.bind(null, this);

  detectAgentInstalled = agentRunner.detectAgentInstalled.bind(null, this);
  checkAgentInstalled = agentRunner.checkAgentInstalled.bind(null, this);
  deployAgentSDK = agentRunner.deployAgentSDK.bind(null, this);

  // ===== Remote Skill Manager delegates =====

  listRemoteSkills = remoteSkillManager.listRemoteSkills.bind(null, this);
  listRemoteSkillFiles = remoteSkillManager.listRemoteSkillFiles.bind(null, this);
  readRemoteSkillFile = remoteSkillManager.readRemoteSkillFile.bind(null, this);
  installRemoteSkill = remoteSkillManager.installRemoteSkill.bind(null, this);
  syncLocalSkillToRemote = remoteSkillManager.syncLocalSkillToRemote.bind(null, this);
  syncRemoteSkillToLocal = remoteSkillManager.syncRemoteSkillToLocal.bind(null, this);
  uninstallRemoteSkill = remoteSkillManager.uninstallRemoteSkill.bind(null, this);
  ensureFreshConnection = remoteSkillManager.ensureFreshConnection.bind(null, this);
  executeWithTimeout = remoteSkillManager.executeWithTimeout.bind(null, this);

  // ===== Health Monitor delegates =====

  startHealthMonitor = healthMonitor.startHealthMonitor.bind(null, this);
  stopHealthMonitor = healthMonitor.stopHealthMonitor.bind(null, this);
  checkDeployFilesIntegrity = healthMonitor.checkDeployFilesIntegrity.bind(null, this);
  cleanupOrphanDeployments = healthMonitor.cleanupOrphanDeployments.bind(null, this);
  deleteDeployment = healthMonitor.deleteDeployment.bind(null, this);
}

// Export singleton instance
export const remoteDeployService = new RemoteDeployService();
