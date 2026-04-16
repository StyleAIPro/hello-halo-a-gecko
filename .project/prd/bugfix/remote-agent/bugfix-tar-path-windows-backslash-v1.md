# PRD [Bug 修复级] — Windows 下 createDeployPackage tar 命令因反斜杠路径失败

> 版本：bugfix-tar-path-windows-backslash-v1
> 日期：2026-04-16
> 指令人：@claude
> 归属模块：modules/remote-agent
> 严重程度：Critical（远程部署完全不可用）
> 所属功能：features/remote-deploy

## 问题描述

- **期望行为**：远程部署正常创建 tar.gz 包并上传
- **实际行为**：`createDeployPackage()` 在 Windows 上报错 `Failed to create deployment package: Error: Command failed: tar ... Cannot connect to C: resolve failed`
- **复现步骤**：Windows 环境，连接远程服务器后执行部署操作

## 根因分析

`createDeployPackage()` 拼接 tar 命令时直接使用 Node.js `path.join()` 生成的路径（含反斜杠 `\`）：

```
tar -czf "C:\Users\...\temp.tar.gz" -C "E:\Project\...\remote-agent-proxy" package.json dist patches scripts
```

Windows 上的 `tar` 来自 Git Bash / MSYS2，它将反斜杠视为转义字符。`C:\Users\...` 被解析为 `C:` + 转义字符 `U`，导致路径无法解析。

## 修复方案

在拼接 tar 参数前，将路径中的反斜杠统一替换为正斜杠：

```typescript
const normalizedPackagePath = packagePath.replace(/\\/g, '/');
const normalizedPackageDir = packageDir.replace(/\\/g, '/');
```

改动范围：`src/main/services/remote-deploy/remote-deploy.service.ts` — `createDeployPackage()` 方法，2 行新增。

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-04-16 | 初始 Bug 修复 PRD | @claude |
