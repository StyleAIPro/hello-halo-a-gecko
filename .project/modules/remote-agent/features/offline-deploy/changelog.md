# 变更记录 — offline-deploy

| 日期 | 内容 | 指令人 | 触发来源 |
|------|------|--------|---------|
| 2026-04-23 | 新增离线部署包功能：构建时打包 Node.js + node_modules + dist 为自包含 tar.xz，嵌入 EXE，远端零网络依赖部署（除 Claude API） | @MoonSeeker | offline-deploy-bundle-v1 |
| 2026-05-11 | 恢复批量离线部署按钮：标题栏新增「Batch Deploy」按钮，并行对所有服务器执行离线部署，`handleDeployOffline` 增加 `skipSpinner`/`skipAlert` 可选参数 | @MoonSeeker | feature-batch-offline-deploy-v1 |
