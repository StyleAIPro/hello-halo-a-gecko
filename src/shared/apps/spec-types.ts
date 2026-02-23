/**
 * Shared App Spec Types
 *
 * Pure TypeScript type definitions for the App Spec system.
 * These types are used by both the main process and the renderer process.
 *
 * IMPORTANT: This file must NOT import any Node.js or Electron APIs.
 * It is included in the renderer (web) tsconfig.
 *
 * All types here are manually mirrored from the Zod-derived types in
 * src/main/apps/spec/schema.ts. They must be kept in sync. When the Zod
 * schema changes, update these types accordingly.
 *
 * Why manual mirror instead of re-export?
 * - The renderer tsconfig does not include src/main/
 * - Importing from src/main/ would pull in Node.js types
 * - Zod schemas (runtime code) should not be bundled into the renderer
 */

// ============================================
// App Type
// ============================================

export type AppType = 'mcp' | 'skill' | 'automation' | 'extension'

// ============================================
// Filter Rules
// ============================================

export type FilterOp = 'eq' | 'neq' | 'contains' | 'matches' | 'gt' | 'lt' | 'gte' | 'lte'

export interface FilterRule {
  field: string
  op: FilterOp
  value: unknown
}

// ============================================
// Input Definition (config_schema items)
// ============================================

export type InputType = 'url' | 'text' | 'string' | 'number' | 'select' | 'boolean' | 'email'

export interface SelectOption {
  label: string
  value: string | number | boolean
}

export interface InputDef {
  key: string
  label: string
  type: InputType
  description?: string
  required?: boolean
  default?: unknown
  placeholder?: string
  options?: SelectOption[]
}

// ============================================
// Memory Schema
// ============================================

export interface MemoryField {
  type: string
  description?: string
}

export type MemorySchema = Record<string, MemoryField>

// ============================================
// Subscription Source Configs
// ============================================

export interface ScheduleSourceConfig {
  every?: string
  cron?: string
}

export interface FileSourceConfig {
  pattern?: string
  path?: string
}

export interface WebhookSourceConfig {
  path?: string
  secret?: string
}

export interface WebpageSourceConfig {
  watch?: string
  selector?: string
  url?: string
}

export interface RssSourceConfig {
  url?: string
}

export type CustomSourceConfig = Record<string, unknown>

// ============================================
// Subscription Source (discriminated union)
// ============================================

export type SubscriptionSourceType = 'schedule' | 'file' | 'webhook' | 'webpage' | 'rss' | 'custom'

export type SubscriptionSource =
  | { type: 'schedule'; config: ScheduleSourceConfig }
  | { type: 'file'; config: FileSourceConfig }
  | { type: 'webhook'; config: WebhookSourceConfig }
  | { type: 'webpage'; config: WebpageSourceConfig }
  | { type: 'rss'; config: RssSourceConfig }
  | { type: 'custom'; config: CustomSourceConfig }

// ============================================
// Frequency Definition
// ============================================

export interface FrequencyDef {
  default: string
  min?: string
  max?: string
}

// ============================================
// Subscription Definition
// ============================================

export interface SubscriptionDef {
  id?: string
  source: SubscriptionSource
  frequency?: FrequencyDef
  config_key?: string
}

// ============================================
// MCP Dependency Declaration
// ============================================

export interface McpDependency {
  id: string
  reason?: string
}

// ============================================
// MCP Server Config (for type=mcp)
// ============================================

export interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

// ============================================
// Notification Channel Type
// ============================================

export type NotificationChannelType = 'email' | 'wecom' | 'dingtalk' | 'feishu' | 'webhook'

// ============================================
// Output Notify Config
// ============================================

export interface OutputNotifyConfig {
  /** Send system desktop notification (default: true) */
  system?: boolean
  /** External notification channels to deliver to */
  channels?: NotificationChannelType[]
}

// ============================================
// Output Config
// ============================================

export interface OutputConfig {
  notify?: OutputNotifyConfig
  format?: string
}

// ============================================
// Requires Block
// ============================================

export interface Requires {
  mcps?: McpDependency[]
  skills?: string[]
}

// ============================================
// Escalation Config
// ============================================

export interface EscalationConfig {
  enabled?: boolean
  timeout_hours?: number
}

// ============================================
// Full App Spec
// ============================================

export interface AppSpec {
  spec_version: string
  name: string
  version: string
  author: string
  description: string
  type: AppType
  icon?: string
  system_prompt?: string
  requires?: Requires
  subscriptions?: SubscriptionDef[]
  filters?: FilterRule[]
  memory_schema?: MemorySchema
  config_schema?: InputDef[]
  output?: OutputConfig
  permissions?: string[]
  mcp_server?: McpServerConfig
  escalation?: EscalationConfig
  /** Optional model recommendation from the spec author (informational only, not used at runtime) */
  recommended_model?: string
}

// ============================================
// Validation Issue (for error display in UI)
// ============================================

export interface ValidationIssue {
  path: string
  message: string
  received?: unknown
}
