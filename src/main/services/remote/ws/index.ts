export {
  RemoteWsClient,
  acquireConnection,
  releaseConnection,
  removePooledConnection,
  getPoolStats,
  getRemoteWsClient,
} from './remote-ws-client';

export type { RemoteWsClientConfig, ClientMessage, ServerMessage } from './remote-ws-client';
