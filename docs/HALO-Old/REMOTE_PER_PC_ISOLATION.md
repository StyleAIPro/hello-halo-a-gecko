# Per-PC Remote Agent Proxy Isolation - Development Document

## 1. Background & Motivation

### Current Architecture (Multi-PC Shared Proxy)

```
PC A ──┐
PC B ──┼──► /opt/claude-deployment/ (single proxy instance, port 8080)
PC C ──┘       ├── tokens.json (multi-client whitelist)
               ├── ClaudeManager (shared across all PCs)
               └── BackgroundTaskManager (shared)
```

All PCs connecting to the same remote server share:
- One proxy process (`node dist/index.js`) on a fixed port (default 8080)
- One `tokens.json` whitelist for authentication
- One `ClaudeManager` instance managing all SDK sessions
- One set of logs, work directory, and system prompt

Isolation is limited to per-conversation `sdkSessionId` and per-request API credentials.

### Problems

1. **Resource contention** — One PC's long-running task can starve others
2. **Single point of failure** — Proxy crash affects all connected PCs
3. **Update conflicts** — Updating the proxy code restarts all PCs' sessions
4. **Debugging difficulty** — Logs from all PCs are interleaved
5. **Security coupling** — Token whitelist is shared; compromise affects all

### Target Architecture (Per-PC Isolated Proxy)

```
PC A ──► /opt/claude-deployment-client-7f3a1b9c/ (proxy, port 34567)
PC B ──► /opt/claude-deployment-client-8e2b4d6e/ (proxy, port 35891)
PC C ──► /opt/claude-deployment-client-c9d0e1f2/ (proxy, port 37234)
```

Each PC gets its own completely independent proxy instance:
- Dedicated deployment directory
- Dedicated port (deterministic based on machine identity)
- Dedicated proxy process
- Dedicated logs, data, tokens, system prompt
- Independent lifecycle (start, stop, update, crash recovery)

---

## 2. Machine Identity & Port Allocation

### 2.1 Machine Identity: `clientId`

Use OS-level machine identifiers instead of MAC addresses for stability:

| OS | Identifier Source | Command | Survives Reinstall |
|---|---|---|---|
| Windows | Registry `MachineGuid` | `reg query HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid` | No |
| macOS | IOPlatformUUID | `ioreg -rd1 -c IOPlatformExpertDevice \| grep IOPlatformUUID` | Yes |
| Linux | `/etc/machine-id` | `cat /etc/machine-id` | No |

**Implementation: Read via Node.js (no native dependencies required)**

```typescript
// src/main/services/remote-deploy/machine-id.ts

import { execSync } from 'child_process'
import * as fs from 'fs'
import * as crypto from 'crypto'

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
          { encoding: 'utf-8', timeout: 3000 }
        )
        const match = result.match(/MachineGuid\s+REG_SZ\s+(.+)/)
        if (match) return match[1].trim()
        break
      }
      case 'darwin': {
        const result = execSync(
          'ioreg -rd1 -c IOPlatformExpertDevice',
          { encoding: 'utf-8', timeout: 3000 }
        )
        const match = result.match(/"IOPlatformUUID"\s*=\s*"(.+?)"/)
        if (match) return match[1].trim()
        break
      }
      case 'linux': {
        if (fs.existsSync('/etc/machine-id')) {
          return fs.readFileSync('/etc/machine-id', 'utf-8').trim()
        }
        break
      }
    }
  } catch (e) {
    console.warn('[MachineId] Failed to read OS machine ID:', e)
  }

  // Fallback: hostname + username hash
  const os = require('os')
  const raw = `${os.hostname()}-${os.userInfo().username}`
  return crypto.createHash('sha256').update(raw).digest('hex')
}

/**
 * Derive a short clientId from machine ID.
 * Format: "client-{first12hex}"
 */
export function getClientId(): string {
  const machineId = getMachineId()
  const hash = crypto.createHash('sha256').update(machineId).digest('hex')
  return `client-${hash.substring(0, 12)}`
}
```

**Why not MAC address:**
- Multiple NICs on one machine (ethernet, WiFi, virtual) — ambiguous selection
- MAC can change when hardware changes (docking station, USB NIC)
- Machine ID is simpler and more widely used for this purpose

**Reinstall consideration:**
- Windows/Linux machine ID changes on OS reinstall, but this is acceptable because:
  - AICO-Bot local config (including server list) is likely lost on reinstall anyway
  - User re-adds the remote server, gets a new clientId, new deployment directory
  - Old deployment becomes an orphan, cleaned up by the idle timeout (7 days)

### 2.2 Port Allocation: Deterministic Hash + Collision Detection

```
Range: 30000 - 40000 (10001 ports)
Algorithm: hash(clientId) % 10001 + 30000
```

```typescript
// src/main/services/remote-deploy/port-allocator.ts

import * as crypto from 'crypto'

const PORT_RANGE_START = 30000
const PORT_RANGE_END = 40000
const PORT_RANGE_SIZE = PORT_RANGE_END - PORT_RANGE_START + 1  // 10001

/**
 * Calculate the preferred port for a given clientId.
 * Deterministic: same clientId always returns the same port.
 */
export function calculatePreferredPort(clientId: string): number {
  const hash = crypto.createHash('sha256').update(clientId).digest()
  const hashInt = hash.readUInt32BE(0)
  return PORT_RANGE_START + (hashInt % PORT_RANGE_SIZE)
}

/**
 * Resolve the actual port to use, with collision detection.
 * SSH to remote server and check if the preferred port is available.
 * If occupied by a different clientId's proxy, increment and retry.
 *
 * @param sshManager - Connected SSH manager for the remote server
 * @param clientId - This PC's client identifier
 * @returns The allocated port number
 */
export async function resolvePort(
  sshManager: SSHManager,
  clientId: string
): Promise<number> {
  let port = calculatePreferredPort(clientId)
  const maxAttempts = 20

  for (let i = 0; i < maxAttempts; i++) {
    // Check if this port is already owned by our clientId
    // (proxy running with our clientId in the process args)
    const ownedByUs = await isPortOwnedByClient(sshManager, port, clientId)
    if (ownedByUs) {
      return port  // Our proxy is already running on this port
    }

    // Check if port is free
    const isFree = await isPortFree(sshManager, port)
    if (isFree) {
      return port
    }

    // Port is occupied by something else, try next
    console.warn(`[PortAllocator] Port ${port} is occupied, trying ${port + 1}`)
    port = PORT_RANGE_START + ((port - PORT_RANGE_START + 1) % PORT_RANGE_SIZE)
  }

  throw new Error(`Failed to find available port in range ${PORT_RANGE_START}-${PORT_RANGE_END}`)
}

async function isPortFree(sshManager: SSHManager, port: number): Promise<boolean> {
  const result = await sshManager.executeCommandFull(
    `ss -tln | grep ':${port} ' || echo "FREE"`
  )
  return result.stdout.includes('FREE')
}

async function isPortOwnedByClient(
  sshManager: SSHManager,
  port: number,
  clientId: string
): Promise<boolean> {
  const deployPath = `/opt/claude-deployment-${clientId}`
  const result = await sshManager.executeCommandFull(
    `pgrep -f "node.*${deployPath}" >/dev/null 2>&1 && echo "OURS" || echo "NOT_OURS"`
  )
  if (result.stdout.includes('OURS')) {
    // Verify it's actually listening on this port
    const portCheck = await sshManager.executeCommandFull(
      `ss -tln | grep ':${port} ' || echo "NOT_LISTENING"`
    )
    return !portCheck.stdout.includes('NOT_LISTENING')
  }
  return false
}
```

**Collision probability:** With 10001 ports and N PCs:
- 2 PCs: ~0.01% chance of collision
- 5 PCs: ~0.1% chance
- 10 PCs: ~0.5% chance

In practice, most users have 1-3 PCs per server, so collisions are extremely rare.

---

## 3. Remote Deployment Directory Structure

### Per-PC Directory Layout

```
/opt/claude-deployment-client-{clientId}/
├── dist/                    # Proxy compiled code
│   ├── index.js
│   ├── server.js
│   ├── claude-manager.js
│   ├── types.js
│   └── version.json
├── node_modules/            # npm dependencies
├── patches/                 # SDK patches
├── scripts/
│   └── register-token.cjs   # Token management script
├── config/
│   └── system-prompt.txt    # Per-PC system prompt
├── logs/
│   └── output.log
├── data/                    # Runtime data
├── tokens.json              # Single token (this PC only)
├── package.json
├── .env                     # Per-PC environment config
└── version.json             # Build metadata
```

### Key Differences from Current Layout

| Aspect | Current | New (Per-PC) |
|---|---|---|
| Base path | `/opt/claude-deployment/` | `/opt/claude-deployment-client-{clientId}/` |
| Port | Fixed 8080 or user-configured `wsPort` | Calculated from clientId, 30000-40000 range |
| tokens.json | Multi-client whitelist | Single token (simplified auth) |
| Process | One shared process | One process per clientId |
| Logs | Interleaved from all PCs | Isolated per-PC |

---

## 4. Data Model Changes

### 4.1 `RemoteServer` Type Changes

File: `src/shared/types/index.ts`

```typescript
export interface RemoteServer {
  id: string
  name: string
  host: string
  sshPort: number
  username: string
  password: string  // encrypted
  wsPort: number
  authToken: string
  status: 'disconnected' | 'connected' | 'deploying' | 'error'
  error?: string
  workDir?: string
  claudeApiKey?: string
  claudeBaseUrl?: string
  claudeModel?: string
  aiSourceId?: string
  sdkInstalled?: boolean
  sdkVersion?: string
  agentPath?: string

  // === NEW FIELDS (Per-PC Isolation) ===
  clientId?: string        // This PC's machine identity (e.g., "client-7f3a1b9c2e4d")
  assignedPort?: number    // Actual port allocated on remote server (30000-40000 range)
  deployPath?: string      // Full path on remote server (e.g., "/opt/claude-deployment-client-7f3a1b9c")
  // === END NEW FIELDS ===
}
```

### 4.2 `RemoteServerConfig` Internal Type Changes

File: `src/main/services/remote-deploy/remote-deploy.service.ts`

```typescript
export interface RemoteServerConfig extends RemoteServer {
  ssh: SSHConfig
  lastConnected?: Date
}
```

No additional fields needed — inherits `clientId`, `assignedPort`, `deployPath` from `RemoteServer`.

### 4.3 Constant Changes

```typescript
// BEFORE
const DEPLOY_AGENT_PATH = '/opt/claude-deployment'

// AFTER — no global constant; compute per-server
function getDeployPath(clientId: string): string {
  return `/opt/claude-deployment-${clientId}`
}
```

---

## 5. Code Changes — Detailed Specification

### 5.1 New Files

| File | Purpose |
|---|---|
| `src/main/services/remote-deploy/machine-id.ts` | Machine ID reading + clientId derivation |
| `src/main/services/remote-deploy/port-allocator.ts` | Deterministic port calculation + collision detection |

### 5.2 Modified Files

#### 5.2.1 `src/shared/types/index.ts`

- Add `clientId`, `assignedPort`, `deployPath` fields to `RemoteServer` interface
- These are optional (`?`) for backward compatibility during migration

#### 5.2.2 `src/main/services/remote-deploy/remote-deploy.service.ts`

This is the most heavily modified file. All hardcoded `DEPLOY_AGENT_PATH` references must be replaced with `server.deployPath`.

**A. Remove global constant, add helper function:**

```typescript
// REMOVE:
// const DEPLOY_AGENT_PATH = '/opt/claude-deployment'

// ADD:
function getDeployPath(server: RemoteServerConfig): string {
  if (server.deployPath) return server.deployPath
  // Fallback for legacy servers without clientId
  return '/opt/claude-deployment'
}
```

**B. `addServer()` — Lines ~269-310:**

Add clientId calculation and port resolution after server object creation:

```typescript
async addServer(config: RemoteServerConfigInput): Promise<string> {
  const id = this.generateId()

  // === NEW: Compute machine identity ===
  const clientId = getClientId()
  // =====================================

  const server: RemoteServerConfig = {
    id,
    name: config.name,
    ssh: config.ssh,
    wsPort: config.wsPort,
    authToken: config.authToken || this.generateAuthToken(),
    status: 'disconnected',
    workDir: config.workDir,
    claudeApiKey: config.claudeApiKey,
    claudeBaseUrl: config.claudeBaseUrl,
    claudeModel: config.claudeModel,
    aiSourceId: config.aiSourceId,
    // === NEW FIELDS ===
    clientId,
    deployPath: `/opt/claude-deployment-${clientId}`,
    // assignedPort resolved after SSH connect
  }

  this.servers.set(id, server)
  await this.saveServers()

  try {
    await this.connectServer(id)

    // === NEW: Resolve port after SSH is connected ===
    const manager = this.sshManagers.get(id)!
    const assignedPort = await resolvePort(manager, clientId)
    await this.updateServer(id, { assignedPort })
    // ================================================

    // ... existing auto-detect logic ...
  } catch (error) {
    // ... existing error handling ...
  }

  return id
}
```

**C. `connectServer()` — Lines ~559-620:**

Add port resolution if not yet assigned (covers reconnection after AICO-Bot restart):

```typescript
// After SSH connection is established and token registered:
if (!server.assignedPort) {
  const clientId = server.clientId || getClientId()
  const manager = this.sshManagers.get(id)!
  const assignedPort = await resolvePort(manager, clientId)
  await this.updateServer(id, {
    clientId,
    assignedPort,
    deployPath: `/opt/claude-deployment-${clientId}`
  })
}
```

**D. `deployAgentCode()` — Lines ~682-1030:**

Replace all `DEPLOY_AGENT_PATH` with `getDeployPath(server)`:

```typescript
// Before (example):
await manager.executeCommand(`mkdir -p ${DEPLOY_AGENT_PATH}/dist`)

// After:
const deployPath = getDeployPath(server)
await manager.executeCommand(`mkdir -p ${deployPath}/dist`)
```

This affects approximately 30+ references throughout the method. Every occurrence of `DEPLOY_AGENT_PATH` must be replaced.

**E. `updateAgentCode()` — Lines ~1036-1290:**

Same replacement pattern as `deployAgentCode()`. Additionally, the health check port changes:

```typescript
// Before:
const healthPort = (server.wsPort || 8080) + 1

// After:
const healthPort = server.assignedPort! + 1
```

**F. `startAgent()` — Lines ~1436-1596:**

Major changes — use per-PC deploy path and assigned port:

```typescript
async startAgent(id: string): Promise<void> {
  const server = this.servers.get(id)
  if (!server) throw new Error(`Server not found: ${id}`)

  const manager = this.getSSHManager(id)
  const deployPath = getDeployPath(server)
  const port = server.assignedPort

  if (!port) throw new Error('No assigned port. Connect to server first.')

  // Ensure logs directory exists
  await manager.executeCommand(`mkdir -p ${deployPath}/logs`)

  // ... (build info check with deployPath) ...

  // Check if process is already running
  const checkResult = await manager.executeCommandFull(
    `pgrep -f "node.*${deployPath}" || echo "not running"`
  )

  if (checkResult.exitCode === 0 && !checkResult.stdout.includes('not running')) {
    console.log('[RemoteDeployService] Agent already running, restarting...')
    await this.stopAgent(id)
  }

  // Register auth token
  await this.registerTokenOnRemote(id)

  // Read bootstrap token from tokens.json
  let bootstrapToken = server.authToken
  try {
    const tokensResult = await manager.executeCommandFull(
      `node -e "const d=JSON.parse(require('fs').readFileSync('${deployPath}/tokens.json','utf-8'));console.log(d.tokens[0]?.token||'')"`
    )
    if (tokensResult.exitCode === 0 && tokensResult.stdout.trim()) {
      bootstrapToken = tokensResult.stdout.trim()
    }
  } catch (e) {
    console.warn('[RemoteDeployService] Failed to read bootstrap token:', e)
  }

  // Start agent with per-PC port and path
  const envVars = [
    `REMOTE_AGENT_PORT=${port}`,
    `REMOTE_AGENT_AUTH_TOKEN=${escapeEnvValue(bootstrapToken)}`,
    server.workDir ? `REMOTE_AGENT_WORK_DIR=${escapeEnvValue(server.workDir)}` : null,
    `IS_SANDBOX=1`,
    `DEPLOY_DIR=${deployPath}`,  // NEW: tell proxy its own deploy directory
  ].filter(Boolean).join(' ')

  const indexPath = `${deployPath}/dist/index.js`
  const startCommand = `nohup env PATH="/usr/local/bin:/usr/local/node-v*/bin:$PATH" ${envVars} node ${indexPath} > ${deployPath}/logs/output.log 2>&1 &`

  await manager.executeCommand(startCommand)

  // Wait and verify port is listening
  await new Promise(resolve => setTimeout(resolve, 5000))
  // ... (port verification with server.assignedPort) ...
}
```

**G. `stopAgent()` — Lines ~1601-1625:**

```typescript
async stopAgent(id: string): Promise<void> {
  const server = this.servers.get(id)
  if (!server) throw new Error(`Server not found: ${id}`)

  this.removePooledConnection(id)

  const manager = this.getSSHManager(id)
  const deployPath = getDeployPath(server)

  await manager.executeCommand(
    `pkill -f "node.*${deployPath}" || true`
  )
}
```

**H. `registerTokenOnRemote()` — Lines ~1632-1670:**

```typescript
async registerTokenOnRemote(id: string): Promise<void> {
  const server = this.servers.get(id)
  if (!server) throw new Error(`Server not found: ${id}`)

  await this.ensureSshConnectionInternal(id)
  const manager = this.sshManagers.get(id)
  if (!manager || !manager.isConnected()) {
    throw new Error(`SSH not connected for ${id}`)
  }

  const token = server.authToken
  const clientId = server.clientId || server.id  // Prefer machine clientId
  const hostname = os.hostname()
  const deployPath = getDeployPath(server)

  const scriptPath = `${deployPath}/scripts/register-token.cjs`
  const registerCmd = `node ${scriptPath} '${token}' '${clientId}' '${hostname}' '' '' '' ''`

  try {
    const result = await manager.executeCommandFull(registerCmd)
    // ... existing success/warning handling ...
  } catch (e) {
    console.error('[RemoteDeployService] Failed to register token:', e)
  }
}
```

**I. `getOrCreateWsClient()` — Lines ~1969-2005:**

```typescript
private getOrCreateWsClient(id: string, server: RemoteServerConfig): any {
  const { RemoteWsClient } = require('../remote-ws/remote-ws-client')

  const existingClient = (RemoteWsClient as any).getRemoteWsClient(id)
  if (existingClient) return existingClient

  // Resolve API credentials
  const config = getConfig()
  const sourceId = server.aiSourceId || config.aiSources?.currentId
  const currentSource = sourceId ? config.aiSources?.sources?.find(s => s.id === sourceId) : undefined
  const apiKeyRaw = server.claudeApiKey || currentSource?.apiKey || config.api?.apiKey
  const apiKey = apiKeyRaw ? decryptString(apiKeyRaw) : undefined
  const baseUrl = server.claudeBaseUrl || currentSource?.apiUrl
  const model = server.claudeModel || currentSource?.model || config.api?.model

  const wsConfig = {
    serverId: id,
    host: server.ssh.host,
    port: server.assignedPort || server.wsPort || 8080,  // CHANGED: prefer assignedPort
    useSshTunnel: false,
    authToken: server.password || '',
    apiKey,
    baseUrl: baseUrl || undefined,
    model: model || undefined
  }

  return new RemoteWsClient(wsConfig)
}
```

#### 5.2.3 `packages/remote-agent-proxy/src/index.ts`

Make deploy directory dynamic (read from env var):

```typescript
// Before:
const deployDir = '/opt/claude-deployment'

// After:
const deployDir = process.env.DEPLOY_DIR || '/opt/claude-deployment'
```

This allows the proxy to know its own per-PC directory path, which it needs for:
- Loading `tokens.json`
- Loading `.env`
- System prompt path

#### 5.2.4 `src/main/services/remote-ws/remote-ws-client.ts`

**Connection pool key change:**

The pool is currently keyed by `serverId`. This remains correct because each `serverId` already represents one PC's connection to one remote server.

**Port resolution in connection config:**

The `port` field in `RemoteWsClientConfig` must use `assignedPort`. This is handled by the caller (`getOrCreateWsClient` and `send-message.ts`).

#### 5.2.5 `src/main/services/agent/send-message.ts`

In `executeRemoteMessage()`, update the WebSocket connection target to use `assignedPort`:

```typescript
// Where wsConfig is constructed, ensure port uses assignedPort:
const wsConfig = {
  serverId: server.id,
  host: resolvedHost,
  port: server.assignedPort || server.wsPort || 8080,
  // ...
}
```

#### 5.2.6 `src/main/services/remote-ssh/ssh-tunnel.service.ts`

The SSH tunnel currently forwards to a fixed remote port. Update to use `assignedPort`:

```typescript
// Where tunnel is established:
const remotePort = server.assignedPort || server.wsPort || 8080
```

#### 5.2.7 `src/main/ipc/remote-server.ts`

IPC handlers that call `remoteDeployService` methods don't need changes themselves, since the service methods are the ones being modified. However, verify that any IPC handlers that directly reference `DEPLOY_AGENT_PATH` are updated.

---

## 6. Proxy Idle Timeout (7-Day Auto-Stop)

### Mechanism

The proxy process itself implements idle detection. When no WebSocket client has been connected for 7 consecutive days, the proxy gracefully shuts down.

### Implementation Location

File: `packages/remote-agent-proxy/src/server.ts`

```typescript
// Add to RemoteAgentServer class:

private lastClientActivity: Date = new Date()
private idleCheckInterval?: NodeJS.Timeout
private static readonly IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000  // 7 days

constructor(config: RemoteServerConfig) {
  // ... existing constructor code ...

  // Start idle check
  this.idleCheckInterval = setInterval(() => this.checkIdleTimeout(), 60 * 60 * 1000)  // Check hourly
}

private checkIdleTimeout(): void {
  // If there are connected clients, reset the timer
  let hasConnectedClients = false
  for (const [ws, state] of this.clients) {
    if (ws.readyState === WebSocket.OPEN && state.authenticated) {
      hasConnectedClients = true
      break
    }
  }

  if (hasConnectedClients) {
    this.lastClientActivity = new Date()
    return
  }

  const idleMs = Date.now() - this.lastClientActivity.getTime()
  if (idleMs >= RemoteAgentServer.IDLE_TIMEOUT_MS) {
    console.log(`[RemoteAgentServer] No clients connected for 7 days, shutting down`)
    this.close()
    process.exit(0)
  }
}

// In connection handler, update activity timestamp:
// this.lastClientActivity = new Date()

// In close() method:
close(): void {
  if (this.idleCheckInterval) {
    clearInterval(this.idleCheckInterval)
  }
  // ... existing close logic ...
}
```

### Restart on Demand

When a PC sends a message and the proxy is not running, `send-message.ts` already has logic to detect this and call `startAgent()`. Since the deployment directory and code are preserved, the proxy starts in seconds.

---

## 7. Orphan Cleanup

### Problem

Over time, abandoned deployment directories accumulate on remote servers (e.g., after OS reinstall on a PC generates a new clientId).

### Solution

Add a new IPC method `remote-server:cleanup` that:

1. Lists all `/opt/claude-deployment-client-*` directories on the remote server
2. For each directory, checks if the corresponding proxy process is running
3. Returns a report to the user showing:
   - Active deployments (with clientId, port, process status)
   - Inactive deployments (no running process, last modified time)
4. User can select which inactive deployments to delete

```typescript
// In remote-deploy.service.ts:

async cleanupOrphanDeployments(id: string): Promise<{
  active: Array<{ clientId: string; path: string; port: number }>
  inactive: Array<{ clientId: string; path: string; lastModified: Date }>
}> {
  const server = this.servers.get(id)
  if (!server) throw new Error(`Server not found: ${id}`)

  const manager = this.getSSHManager(id)

  // List all deployment directories
  const dirs = await manager.executeCommandFull(
    `ls -d /opt/claude-deployment-client-* 2>/dev/null || echo "NONE"`
  )

  const active: Array<{ clientId: string; path: string; port: number }> = []
  const inactive: Array<{ clientId: string; path: string; lastModified: Date }> = []

  if (dirs.stdout.includes('NONE')) return { active, inactive }

  const dirList = dirs.stdout.trim().split('\n').filter(Boolean)
  for (const dir of dirList) {
    const clientId = dir.replace('/opt/claude-deployment-', '')

    // Check if process is running
    const procCheck = await manager.executeCommandFull(
      `pgrep -f "node.*${dir}" || echo "NOT_RUNNING"`
    )

    if (!procCheck.stdout.includes('NOT_RUNNING')) {
      // Active — try to read port from process env
      const portResult = await manager.executeCommandFull(
        `ps aux | grep "node.*${dir}" | grep -o 'REMOTE_AGENT_PORT=[0-9]*' | head -1 | cut -d= -f2`
      )
      active.push({
        clientId,
        path: dir,
        port: parseInt(portResult.stdout.trim()) || 0
      })
    } else {
      // Inactive — get last modified time
      const statResult = await manager.executeCommandFull(
        `stat -c '%Y' ${dir} 2>/dev/null || echo "0"`
      )
      const lastModified = new Date(parseInt(statResult.stdout.trim()) * 1000)
      inactive.push({ clientId, path: dir, lastModified })
    }
  }

  return { active, inactive }
}

async deleteDeployment(id: string, clientId: string): Promise<void> {
  const server = this.servers.get(id)
  if (!server) throw new Error(`Server not found: ${id}`)

  // Safety: don't allow deleting own deployment
  if (clientId === server.clientId) {
    throw new Error('Cannot delete your own active deployment')
  }

  const manager = this.getSSHManager(id)
  const deployPath = `/opt/claude-deployment-${clientId}`

  // Stop process if running
  await manager.executeCommand(`pkill -f "node.*${deployPath}" || true`)

  // Delete directory
  await manager.executeCommand(`rm -rf ${deployPath}`)
}
```

---

## 8. Migration Strategy

### Legacy Servers (No clientId)

Servers added before this change will have `clientId: undefined` and `deployPath: undefined`. The migration is handled gracefully:

1. **`connectServer()` detects missing clientId** — computes it and resolves port
2. **`deployAgentCode()` / `updateAgentCode()`** — use legacy path `/opt/claude-deployment/` as fallback if `deployPath` is undefined
3. **First "Update Agent" after upgrade** — deploys to new per-PC path, old `/opt/claude-deployment/` remains untouched

Migration flow for a legacy server:

```
1. User upgrades AICO-Bot to new version
2. Existing server entries load with clientId=undefined, deployPath=undefined
3. User clicks "Connect" → connectServer() computes clientId + resolvePort()
   → saves clientId and assignedPort to server config
   → deployPath is still undefined (old proxy is still at /opt/claude-deployment/)
4. User clicks "Update Agent" → deploys to new per-PC directory
   → old /opt/claude-deployment/ is left as-is
   → deployPath is now set to /opt/claude-deployment-client-{clientId}/
5. Future operations use the new path
```

### Shared Server Migration (Multiple PCs)

If multiple PCs were previously sharing `/opt/claude-deployment/`:

1. First PC to update → deploys its own instance, old shared proxy keeps running
2. Other PCs still connect to old shared proxy until they also update
3. After all PCs have updated, old shared proxy can be manually cleaned up

No coordination between PCs is required.

---

## 9. Update Agent Flow (Post-Isolation)

```
User clicks "Update Agent"
    │
    ▼
updateAgentCode(serverId)
    │
    ├── Resolve deploy path: getDeployPath(server)
    │   → /opt/claude-deployment-client-{clientId}/
    │
    ├── Check if first deploy for this clientId
    │   → test -f {deployPath}/version.json
    │   → Missing → full deployAgentCode()
    │
    ├── [Incremental Update Path]
    │   │
    │   ├── 1. Ensure remote directories
    │   │      mkdir -p {deployPath}/{dist,patches,config,logs,scripts}
    │   │
    │   ├── 2. Detect npm path
    │   │
    │   ├── 3. Package & upload
    │   │      tar.gz → SFTP upload → extract to {deployPath}/
    │   │
    │   ├── 4. Conditional npm install
    │   │      Compare package.json MD5
    │   │      → Different: npm install --legacy-peer-deps
    │   │      → Same: check missing deps
    │   │
    │   ├── 5. Global SDK install (version-pinned)
    │   │      npm install -g @anthropic-ai/claude-agent-sdk@{VERSION}
    │   │      ⚠️ VERSION from centralized config (future: sdk-versions.json)
    │   │
    │   ├── 6. Upload patched sdk.mjs (if patches exist)
    │   │
    │   ├── 7. Sync system prompt to {deployPath}/config/
    │   │
    │   ├── 8. Register auth token
    │   │      → {deployPath}/scripts/register-token.cjs
    │   │
    │   └── 9. Restart agent
    │          → stopAgent() → pkill -f "node.*{deployPath}"
    │          → startAgent() → nohup node {deployPath}/dist/index.js
    │          → REMOTE_AGENT_PORT={assignedPort}
    │          → Verify port is listening
    │
    ▼
deployAgentCode(serverId)  [Full Deploy Path]
    │
    ├── Create {deployPath}/ + subdirectories
    ├── Detect/install Node.js v20.18.1
    ├── Detect/install npx
    ├── Upload tar.gz → extract to {deployPath}/
    ├── rm -rf {deployPath}/node_modules → npm install --legacy-peer-deps
    ├── npm install -g @anthropic-ai/claude-agent-sdk@{VERSION}
    ├── Upload SDK patches
    ├── Sync system prompt
    └── Start agent on {assignedPort}
```

---

## 10. Summary of Changes

### New Files (2)

| File | Lines (est.) | Description |
|---|---|---|
| `src/main/services/remote-deploy/machine-id.ts` | ~60 | Machine ID reader + clientId derivation |
| `src/main/services/remote-deploy/port-allocator.ts` | ~80 | Deterministic port calculation + collision detection via SSH |

### Modified Files (7)

| File | Scope of Change | Description |
|---|---|---|
| `src/shared/types/index.ts` | +3 fields | Add `clientId`, `assignedPort`, `deployPath` to `RemoteServer` |
| `src/main/services/remote-deploy/remote-deploy.service.ts` | Major | Replace all `DEPLOY_AGENT_PATH` with per-server path; update `addServer`, `connectServer`, `deployAgentCode`, `updateAgentCode`, `startAgent`, `stopAgent`, `registerTokenOnRemote`, `getOrCreateWsClient`; add `cleanupOrphanDeployments`, `deleteDeployment` |
| `src/main/services/agent/send-message.ts` | Minor | Update wsConfig port to use `assignedPort` |
| `src/main/services/remote-ssh/ssh-tunnel.service.ts` | Minor | Update tunnel target port to use `assignedPort` |
| `src/main/services/remote-ws/remote-ws-client.ts` | None | Already keyed by serverId; port comes from caller config |
| `packages/remote-agent-proxy/src/index.ts` | Minor | Make deploy directory dynamic via `DEPLOY_DIR` env var |
| `packages/remote-agent-proxy/src/server.ts` | Minor | Add 7-day idle timeout logic; read deploy dir from env |
| `src/main/ipc/remote-server.ts` | Minor | Add `remote-server:cleanup` IPC handler |

### Risk Areas

| Risk | Mitigation |
|---|---|
| Legacy server migration | Graceful fallback to `/opt/claude-deployment/` when `deployPath` is undefined |
| Port collision on busy servers | Automatic increment with max 20 retries |
| Multiple AICO-Bot instances on same PC (dev + prod) | Same clientId, same port — second instance reuses existing proxy |
| Remote server disk space | Each deployment ~50MB; orphan cleanup command available |
| `pkill` targeting wrong process | Match on full deploy path, not just "claude-deployment" |

### Out of Scope (Deferred)

- **SDK version unification** between local and remote spaces — tracked separately
- **Docker-based isolation** — not needed for this iteration
- **SDK version pinning** (sdk-versions.json) — will be added as a separate task
- **Per-PC proxy monitoring dashboard** — future enhancement
