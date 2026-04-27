# 变更记录 — 技能源管理

| 日期 | 内容 | 指令人 | 触发来源 |
|------|------|--------|---------|
| 2026-04-24 | listSkillsFromRepo / listSkillsFromRepoStreaming 中 SKILL.md 不存在时跳过该目录，过滤 findSkillDirs 提升的分类目录 | 用户 | bugfix-non-skill-dirs-shown-v1 |
| 2026-04-25 | 远程 Direct Upload 安装目录名修正：从 skillName 派生短目录名（与本地 installSkillFromSource 一致），不再使用完整市场 ID 做目录名 | 用户 | bugfix-remote-skill-dir-name-v1 |
| 2026-04-24 | fetchSkillDirectoryContents 添加 SKIP_DIRS 过滤（跳过 input/test/node_modules 等非必要目录）+ fetchSkillFileContent 使用 skipRateLimit 加速文件下载 | 用户 | bugfix-skill-download-too-slow-v1 |
| 2026-04-24 | gitcodeFetch/gitcodeApiFetch 支持外部 AbortSignal，超时时取消 pending 请求防止级联失败 | 用户 | bugfix-install-timeout-cascading-v1 |
| 2026-04-24 | findSkillDirectoryPath fallback 递归扫描 maxDepth 降至 2 + 15s 超时 + 诊断日志 | 用户 | bugfix-skill-install-hang-v1 |
| 2026-04-22 | findSkillDirs 短路优化：检测到 SKILL.md 时将同级目录批量提升为候选 skill，减少递归 API 调用；validateRepo 改为轻量采样探测，避免完整扫描 | @moonseeker1 | bugfix-skill-scan-category-dir-v1 |
| 2026-04-26 | GitCode API 对齐：Base URL 修正、速率限制放宽、raw 端点、gitcodeAuthFetch 统一认证、请求计数修正、findSkillDirs 加 deadline + 并发控制 | @MoonSeeker | refactor-gitcode-api-alignment-v1 |
| 2026-04-16 | 初始设计 | @moonseeker1 | 新功能 |
