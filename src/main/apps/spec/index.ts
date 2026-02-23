/**
 * apps/spec Module — App Specification Parsing and Validation
 *
 * Public API for the App spec module. This is the only file that consumers
 * (apps/manager, apps/runtime, bootstrap) should import from.
 *
 * Responsibilities:
 * - Parse YAML strings into JS objects
 * - Normalize field aliases for backward compatibility
 * - Validate against Zod schemas with clear error messages
 * - Export TypeScript types derived from Zod schemas
 *
 * Does NOT:
 * - Execute any business logic
 * - Import Electron/Node APIs (types are renderer-safe)
 * - Depend on any other platform/ or apps/ modules
 */

import { parseYamlString, normalizeRawSpec } from './parse'
import { validateAppSpec, validateAppSpecSafe } from './validate'
import type { AppSpec } from './schema'
import { AppSpecParseError, AppSpecValidationError } from './errors'
import type { ValidationIssue } from './errors'

// ============================================
// Initialization
// ============================================

/**
 * Initialize the app spec module.
 * Currently a no-op -- exists to satisfy the bootstrap contract (8B.1).
 * Future versions may load external schema extensions here.
 */
export function initAppSpec(): void {
  // No initialization needed for V1.
  // Zod schemas are statically defined at module load time.
}

// ============================================
// Core API
// ============================================

/**
 * Parse a YAML string into a raw JS object.
 *
 * This performs YAML syntax parsing and field normalization (aliasing),
 * but does NOT validate against the AppSpec schema. Use `validateAppSpec()`
 * on the result for full validation.
 *
 * @param yamlString - Raw YAML content
 * @returns Normalized JS object ready for validation
 * @throws AppSpecParseError on malformed YAML
 */
function parseAppSpec(yamlString: string): Record<string, unknown> {
  const raw = parseYamlString(yamlString)
  return normalizeRawSpec(raw as Record<string, unknown>)
}

/**
 * Convenience: Parse YAML string AND validate in one step.
 *
 * @param yamlString - Raw YAML content
 * @returns Fully validated AppSpec object
 * @throws AppSpecParseError on malformed YAML
 * @throws AppSpecValidationError on schema validation failure
 */
function parseAndValidateAppSpec(yamlString: string): AppSpec {
  const normalized = parseAppSpec(yamlString)
  return validateAppSpec(normalized)
}

// ============================================
// Re-exports
// ============================================

// Core functions
export {
  parseAppSpec,
  parseAndValidateAppSpec,
  validateAppSpec,
  validateAppSpecSafe
}

// Error types
export { AppSpecParseError, AppSpecValidationError }
export type { ValidationIssue }

// Zod schemas (for advanced consumers who need schema introspection)
export {
  AppSpecSchema,
  AppSpecBaseSchema,
  AppTypeSchema,
  FilterRuleSchema,
  FilterOpSchema,
  InputDefSchema,
  InputTypeSchema,
  SelectOptionSchema,
  SubscriptionDefSchema,
  SubscriptionSourceSchema,
  ScheduleSourceConfigSchema,
  FileSourceConfigSchema,
  WebhookSourceConfigSchema,
  WebpageSourceConfigSchema,
  RssSourceConfigSchema,
  McpDependencySchema,
  McpServerConfigSchema,
  OutputConfigSchema,
  RequiresSchema,
  MemorySchemaSchema,
  MemoryFieldSchema,
  EscalationConfigSchema,
  FrequencyDefSchema
} from './schema'

// TypeScript types (derived from Zod via z.infer<>)
export type {
  AppType,
  AppSpec,
  FilterOp,
  FilterRule,
  InputType,
  InputDef,
  SelectOption,
  MemoryField,
  SubscriptionSource,
  FrequencyDef,
  SubscriptionDef,
  McpDependency,
  McpServerConfig,
  OutputConfig,
  Requires,
  EscalationConfig
} from './schema'
