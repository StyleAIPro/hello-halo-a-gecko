/**
 * Remote Access Module - Remote access coordination and Cloudflare tunnel
 */

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
} from './remote.service';

export {
  startTunnel,
  stopTunnel,
  getTunnelStatus,
  onTunnelStatusChange,
  checkCloudflaredAvailable,
} from './tunnel.service';
