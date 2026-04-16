# 功能 — ssh-tunnel

> 日期：2026-04-16
> 指令人：@moonseeker1
> 来源 PRD：无（初始文档化）
> 所属模块：modules/remote-agent/remote-agent-v1

## 描述
SSH 隧道服务，通过 `ssh2` 库在本地与远程服务器之间建立 SSH 端口转发（Local Port Forwarding），使远程 Agent Proxy 服务可通过 `localhost:{localPort}` 访问。支持按服务器 ID 共享隧道（多个空间使用同一服务器的同一隧道）、引用计数管理、动态端口分配和冲突检测、反向隧道（Remote Port Forwarding）以及跨平台端口可用性检查。作为单例服务（`sshTunnelService`）运行，继承 `EventEmitter` 提供隧道生命周期事件。

## 依赖
- `ssh2` — SSH2 客户端/服务端库（`Client`、`ConnectConfig`）
- Node.js `net` — 本地 TCP 服务器
- Node.js `child_process` — 跨平台端口检查（`netstat`/`lsof`）
- `src/main/services/remote-ssh/ssh-manager.ts` — SSH 配置管理（`SSHConfig`、`SSHManager`）

## 实现逻辑

### 正常流程

**建立隧道（`establishTunnel()`）**
1. 使用 `serverId` 作为隧道 key，检查是否已有活跃隧道
2. 若已有且 SSH 连接存活 → 复用隧道，将 `spaceId` 加入 `spaces` Set，返回已有 `localPort`
3. 若已有但连接已死 → 清理旧隧道
4. 自动分配本地端口（`getOrAssignLocalPort()`）：按 serverId 维护端口映射，避免冲突
5. 构建 SSH 连接配置（`ConnectConfig`）：支持密码或私钥认证，30 秒连接超时，30 秒心跳间隔
6. SSH `ready` 后创建本地 TCP Server 监听 `127.0.0.1:{localPort}`
7. 每个 TCP 连接通过 `client.forwardOut()` 转发到远程 `localhost:{remotePort}`
8. 双向管道：`socket.pipe(stream).pipe(socket)`
9. 存储隧道信息到 `tunnels` Map，emit `tunnel:established` 事件

**关闭隧道（`closeTunnel()`）**
1. 从隧道的 `spaces` Set 中移除 `spaceId`
2. 引用计数归零时才真正关闭隧道（`cleanupTunnel()`）
3. 清理步骤：释放端口 → 关闭本地 TCP Server → 关闭 SSH Client → 从 Map 移除

**反向隧道（`createReverseTunnel()`）**
1. 复用已有 SSH 连接（不创建新连接）
2. 调用 `client.forwardIn()` 绑定远程端口
3. 监听 `tcpip` 事件，将远程连接通过 `net.connect()` 转发到本地服务
4. 返回实际绑定的远程端口号

**端口管理**
- `getOrAssignLocalPort()` — 每个 serverId 绑定唯一端口，通过 `findAvailablePort()` 从 basePort（通常 8080）开始扫描
- `findAvailablePort()` — 跨平台同步检查：Windows 用 `netstat -ano`，macOS/Linux 用 `lsof -i`
- `usedPorts` Set — 跟踪已分配端口，防止冲突

### 异常流程
1. **SSH 连接失败** — `client.on('error')` reject Promise，emit `tunnel:error` 事件
2. **SSH 连接断开** — `client.on('close')` 触发 `cleanupTunnel()`，emit `tunnel:closed` 事件
3. **本地端口冲突** — `findAvailablePort()` 在 8080-8180 范围内扫描可用端口
4. **forwardOut 失败** — 错误日志记录，销毁 socket
5. **TCP Server 错误** — 触发 `cleanupTunnel()`，reject 连接 Promise
6. **无可用端口** — 抛出异常（扫描 100 个端口均不可用）
7. **反向隧道无活跃连接** — 抛出错误要求先调用 `establishTunnel()`

## 涉及 API
- `SshTunnelService` 单例方法：`establishTunnel()`、`closeTunnel()`、`isTunnelActive()`、`getTunnelStatuses()`、`closeAllTunnels()`、`createReverseTunnel()`、`getTunnelLocalPort()`

## 涉及数据
- `SshTunnelConfig` — 隧道配置（spaceId、serverId、host、port、username、password/privateKey、localPort、remotePort）
- `TunnelStatus` — 隧道状态（spaceId、serverId、host、active、localPort、remotePort、error）
- 内部 `tunnels` Map — serverId -> { client, config, server, spaces }

## 变更
-> changelog.md
