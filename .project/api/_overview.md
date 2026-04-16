# API -- General Conventions

> 最后同步：2026-04-16
> 指令人：@moonseeker1
> **本文档必须与代码保持一致，任何接口变更必须立即更新**

## 双模式架构

AICO-Bot 提供两套完全对称的 API 接口，共享相同的 Controller 业务逻辑层：

| 模式 | 触发条件 | 传输方式 | 用途 |
|------|---------|---------|------|
| **Electron IPC** | 桌面应用内 | `ipcMain.handle` / `ipcRenderer.invoke` | 本地渲染进程调用 |
| **HTTP REST** | 远程访问 | Express 路由 `/api/*` | 远程 Web 客户端调用 |

渲染器 API 层（`src/renderer/api/`）通过 `isElectron()` 自动检测模式：
- Electron 模式：通过 Preload 桥 `window.aicoBot.xxx()` 调用
- 远程 Web 模式：通过 HTTP 端点 + WebSocket 事件调用

## 统一响应格式

所有 IPC 和 HTTP 端点均返回统一的 `{ success, data/error }` 结构：

```typescript
interface ControllerResponse<T = unknown> {
  success: boolean
  data?: T          // success=true 时存在
  error?: string    // success=false 时存在
}
```

## IPC 通道命名规范

通道名格式为 `资源:操作`，例如 `space:list`、`conversation:create`。

调用方式：
```typescript
// 渲染进程
const result = await window.aicoBot.listSpaces()
// result = { success: true, data: [...] }
```

## HTTP 路由规范

路由格式为 `/api/资源`，RESTful 风格：

| HTTP 方法 | 路径示例 | 说明 |
|-----------|---------|------|
| GET | `/api/spaces` | 列表查询 |
| POST | `/api/spaces` | 创建 |
| GET | `/api/spaces/:id` | 获取详情 |
| PUT | `/api/spaces/:id` | 更新 |
| DELETE | `/api/spaces/:id` | 删除 |

HTTP 错误状态码映射：
| HTTP 状态码 | 含义 |
|------------|------|
| 200 | 成功（body 中 success=true/false） |
| 400 | 参数缺失或无效 |
| 403 | 访问被拒绝（路径安全检查） |
| 404 | 资源未找到 |
| 422 | Schema 验证失败 |
| 503 | 服务未就绪（如 AppManager 未初始化） |

## 认证

- **Electron IPC 模式**：无需认证，渲染进程直接通过 IPC 调用
- **HTTP 远程访问模式**：通过 Bearer Token 认证（Header: `Authorization: Bearer <token>`），Token 在启用远程访问时自动生成

## 主进程事件推送

主进程向渲染进程推送事件使用 `mainWindow.webContents.send()`：
- Agent 流式事件：`agent:message`、`agent:thought`、`agent:tool-use` 等
- 远程状态变更：`remote:status-change`
- 技能安装输出：`skill:install-output`

远程 Web 模式下，这些事件通过 WebSocket 广播。

## 代码来源

| 层 | 文件路径 |
|----|---------|
| Controller | `src/main/controllers/*.controller.ts` |
| IPC Handler | `src/main/ipc/*.ts` |
| HTTP Routes | `src/main/http/routes/index.ts` |
| Preload 桥 | `src/preload/index.ts` |
| 渲染器 API | `src/renderer/api/` |

## 变更

| 日期 | 内容 | 指令人 | 来源功能 |
|------|------|--------|---------|
| 2026-04-16 | 初始文档创建 | @moonseeker1 | 初始 |
