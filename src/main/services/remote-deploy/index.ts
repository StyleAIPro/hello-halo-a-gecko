export {
  RemoteDeployService,
  RemoteServerConfig,
  RemoteServerConfigInput,
} from './remote-deploy.service';

export { getClientId, getMachineId } from './machine-id';
export { calculatePreferredPort, resolvePort } from './port-allocator';

// Re-export shared types
export type {
  RemoteServer,
  RemoteServerConnection,
  RemoteFileMessage,
  RemoteClaudeMessage,
  FileInfo,
} from '../../../shared/types';
