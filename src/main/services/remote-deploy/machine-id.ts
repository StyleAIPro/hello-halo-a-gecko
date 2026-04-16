/**
 * Machine Identity Module
 * Provides stable per-PC identification for remote deployment isolation.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as os from 'os';

/**
 * Get a stable machine identifier for the current PC.
 * Priority: OS machine ID > hostname fallback
 */
export function getMachineId(): string {
  try {
    switch (process.platform) {
      case 'win32': {
        const result = execSync(
          'reg query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid',
          { encoding: 'utf-8', timeout: 3000 },
        );
        const match = result.match(/MachineGuid\s+REG_SZ\s+(.+)/);
        if (match) return match[1].trim();
        break;
      }
      case 'darwin': {
        const result = execSync('ioreg -rd1 -c IOPlatformExpertDevice', {
          encoding: 'utf-8',
          timeout: 3000,
        });
        const match = result.match(/"IOPlatformUUID"\s*=\s*"(.+?)"/);
        if (match) return match[1].trim();
        break;
      }
      case 'linux': {
        if (fs.existsSync('/etc/machine-id')) {
          return fs.readFileSync('/etc/machine-id', 'utf-8').trim();
        }
        break;
      }
    }
  } catch (e) {
    console.warn('[MachineId] Failed to read OS machine ID:', e);
  }

  // Fallback: hostname + username hash
  const raw = `${os.hostname()}-${os.userInfo().username}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Derive a short clientId from machine ID + mode suffix.
 * Dev and packaged instances get different clientIds so their
 * remote deployments, auth tokens, and proxy ports are isolated.
 * Format: "client-{first12hex}"
 * @param mode - "dev" or "packaged" to differentiate instances
 */
export function getClientId(mode: 'dev' | 'packaged' = 'dev'): string {
  const machineId = getMachineId();
  const hash = crypto.createHash('sha256').update(`${machineId}:${mode}`).digest('hex');
  return `client-${hash.substring(0, 12)}`;
}
