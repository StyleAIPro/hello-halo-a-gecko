# Bugfix: 远程部署 Node.js 版本校验 + 安装 fallback

## 元信息

- **时间**: 2026-04-21
- **状态**: confirmed
- **优先级**: P0
- **指令人**: StyleAIPro
- **影响范围**: 仅后端（remote-deploy）
- **PRD 级别**: bugfix

## 问题描述

远程服务器部署时存在两个问题：

1. **版本不校验**：`buildNodeInstallCommand()` 仅检查 Node.js 是否存在（`node --version`），不校验版本号。如果系统预装了 Node.js 12（如 Ubuntu 默认 `apt install nodejs`），会被误判为"已安装"而跳过，导致后续 npm 不存在或版本不兼容。
2. **安装无 fallback**：默认路径使用 NodeSource（`deb.nodesource.com`），内网环境下 curl 失败后整个安装链断裂，没有 fallback 到二进制 tarball 安装。

## 技术方案

### 1. buildNodeInstallCommand() 版本校验

将 `if node --version > /dev/null 2>&1` 改为检查目标版本（v20.x）：
```bash
NODE_MAJOR=$(node --version 2>/dev/null | sed 's/v\([0-9]*\).*/\1/')
if [ "$NODE_MAJOR" = "20" ]; then echo "Node.js 20.x already installed"; else ...; fi
```

### 2. 默认路径增加 fallback

NodeSource 失败时自动 fallback 到二进制 tarball（与镜像源路径相同的安装方式）：
```bash
elif [ -f /etc/debian_version ]; then
  (curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs) || \
  (rm -rf ... && curl -fsSL ...tar.xz && tar -xJf ... && ln -sf ...)
```

### 3. deployAgentCode / deployAgentSDK 安装后校验

Node.js 安装完成后，校验 `node --version` 输出是否匹配 v20.x，不匹配则报错并提示手动处理。

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/services/remote-deploy/remote-deploy.service.ts` | 修改 | buildNodeInstallCommand() 版本校验 + fallback + 安装后校验 |

## 开发前必读

- `src/main/services/remote-deploy/remote-deploy.service.ts` — buildNodeInstallCommand()、deployAgentCode()、deployAgentSDK()
- `src/main/services/remote-ssh/ssh-manager.ts` — executeCommand vs executeCommandFull 行为差异

## 验收标准

- [ ] 服务器预装 Node.js 12 时，部署自动检测版本不匹配并重新安装 Node.js 20
- [ ] NodeSource 不可达时自动 fallback 到二进制 tarball 安装
- [ ] 安装完成后验证 node/npm 版本，不匹配时报明确错误
- [ ] Add Server 和 Update Agent 流程均生效
- [ ] `npm run typecheck && npm run lint && npm run build` 通过
