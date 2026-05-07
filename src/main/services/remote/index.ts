// Remote Infrastructure - Barrel File
// Re-exports from access, deploy, ssh, ws sub-modules

export {
  enableRemoteAccess,
  disableRemoteAccess,
  enableTunnel,
  disableTunnel,
  getRemoteAccessStatus,
  onRemoteAccessStatusChange,
  generateQRCode,
  setCustomPassword,
  regeneratePassword,
  type RemoteAccessStatus,
  startTunnel,
  stopTunnel,
  getTunnelStatus,
  onTunnelStatusChange,
  checkCloudflaredAvailable,
} from './access';

export {
  RemoteDeployService,
  RemoteServerConfig,
  RemoteServerConfigInput,
  getClientId,
  getMachineId,
  calculatePreferredPort,
  resolvePort,
  remoteDeployService,
} from './deploy';

export type {
  RemoteServer,
  RemoteServerConnection,
  RemoteFileMessage,
  RemoteClaudeMessage,
  FileInfo,
} from './deploy';

export {
  SSHManager,
  type SSHConfig,
  type SSHExecuteResult,
} from './ssh';

export {
  RemoteWsClient,
  acquireConnection,
  releaseConnection,
  removePooledConnection,
  getPoolStats,
  getRemoteWsClient,
} from './ws';

export type {
  RemoteWsClientConfig,
  ClientMessage,
  ServerMessage,
} from './ws';
