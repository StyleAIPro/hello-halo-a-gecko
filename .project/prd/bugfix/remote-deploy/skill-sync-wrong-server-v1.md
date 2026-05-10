# Bugfix: 技能同步到服务器 — 使用 shell echo+base64 传输文件内容，大文件或特殊内容导致失败

## 元信息

| 字段 | 值 |
|------|-----|
| 级别 | bugfix |
| 状态 | confirmed |
| 指令人 | misakamikoto |
| 创建时间 | 2026-05-08 |
| 优先级 | P1 |
| 影响范围 | 仅后端（远程技能同步） |

## 问题背景

用户在技能库页面点击"同步到服务器"时，部分技能报错 "NOT CONNECTED" 或 "unable to exec"。**即使只有一台远程服务器，只有特定几个 skill 会出现此问题，其余 skill 同步正常。**

## 根因分析（已确认）

### 根因：文件上传使用 shell echo 命令传输 base64 编码内容，不适合大文件

**数据流（确认无误）：**

- UI: `SkillLibrary.tsx:1044` -> `syncSkillToRemote(selectedSkillId, syncTargetServerId)`
- Service: `remote-skill-manager.ts:708-709` -> 核心上传逻辑：

```typescript
const base64Content = Buffer.from(file.content).toString('base64');
await manager.executeCommand(`echo "${base64Content}" | base64 -d > '${remotePath}'`);
```

**`executeCommand` 使用 SSH `exec` 通道发送 shell 命令。** 存在两个问题：

1. **命令长度限制**：SSH exec 通道和远程 shell 对命令字符串有长度限制。Linux 的 `MAX_ARG_STRLEN` 通常为 128KB。当技能文件较大时（~96KB 以上），base64 编码后超过此限制，SSH 服务器返回 "unable to exec" 错误。
2. **Shell 元字符风险**：虽然 base64 输出本身只含 `[A-Za-z0-9+/=]`，但整个命令字符串通过 shell 解析，任何边界情况（路径含特殊字符等）都可能导致命令解析失败。

**为什么只有特定 skill 失败**：文件内容较小的 skill 生成的 base64 命令在长度限制内，正常执行；含有较大文件（如大型 JSON、资源文件）的 skill 则超出限制，触发 "unable to exec"。

## 修复方案

### 修改 1：SSHManager 新增 SFTP 写入方法

**文件**：`src/main/services/remote/ssh/ssh-manager.ts`

新增 `writeFile` 方法，使用 SFTP 子系统直接写入 Buffer，避免 shell 命令限制：

```typescript
async writeFile(remotePath: string, data: Buffer): Promise<void> {
  return this.withLock(async () => {
    await this.initSFTP();
    return new Promise<void>((resolve, reject) => {
      const stream = this.sftp!.createWriteStream(remotePath, { mode: 0o644 });
      stream.on('error', (err: Error) => {
        console.error(`[SSHManager] SFTP write error for ${remotePath}:`, err);
        reject(err);
      });
      stream.on('close', () => {
        console.debug(`[SSHManager] SFTP write completed: ${remotePath}`);
        resolve();
      });
      stream.end(data);
    });
  });
}
```

SFTP 是二进制安全的文件传输协议，没有命令长度限制，也不经过 shell 解析。

### 修改 2：syncLocalSkillToRemote 改用 SFTP 写入

**文件**：`src/main/services/remote/deploy/remote-skill-manager.ts`（第 704-711 行）

将 base64 echo 命令替换为 SFTP `writeFile`：

```typescript
// Upload each file via SFTP (binary-safe, no command length limit)
for (const file of files) {
  const remotePath = `${remoteSkillDir}/${file.relativePath}`;
  const remoteDir = path.dirname(remotePath);
  await manager.executeCommand(`mkdir -p '${remoteDir}'`);
  await manager.writeFile(remotePath, Buffer.from(file.content));
  onOutput?.({ type: 'stdout', content: `  ✓ ${file.relativePath}\n` });
}
```

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/services/remote/ssh/ssh-manager.ts` | 修改 | 新增 `writeFile(remotePath, data)` 方法，使用 SFTP 写入 Buffer |
| `src/main/services/remote/deploy/remote-skill-manager.ts` | 修改 | `syncLocalSkillToRemote()` 文件上传从 shell base64 echo 改为 SFTP writeFile |

## 验收标准

### 核心功能

- [ ] 含有大文件的技能能正常同步到远程服务器（不再报 "unable to exec"）
- [ ] 小文件技能同步功能不受影响
- [ ] SFTP writeFile 日志记录上传文件路径

### 回归验证

- [ ] 服务器配置未变更时，同步功能正常工作
- [ ] 多文件技能同步正常
- [ ] `npm run typecheck && npm run build` 通过

## 开发前必读

| 类别 | 文件 | 阅读目的 |
|------|------|---------|
| 源码文件 | `src/main/services/remote/ssh/ssh-manager.ts` | 理解 SSHManager 的 SFTP 子系统初始化和 `withLock` 并发控制 |
| 源码文件 | `src/main/services/remote/deploy/remote-skill-manager.ts` | 理解 `syncLocalSkillToRemote()` 的完整流程和文件上传逻辑 |
