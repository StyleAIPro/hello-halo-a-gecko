/**
 * apps/spec Error Types
 *
 * Custom error classes for YAML parsing and spec validation failures.
 * Provides structured error information for consumers (apps/manager UI, CLI).
 */

/**
 * Thrown when the YAML string itself is malformed (syntax error).
 */
export class AppSpecParseError extends Error {
  readonly code = 'APP_SPEC_PARSE_ERROR' as const

  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(`YAML parse error: ${message}`)
    this.name = 'AppSpecParseError'
  }
}

/**
 * Represents a single field-level validation issue.
 */
export interface ValidationIssue {
  /** Dot-path to the offending field, e.g. "subscriptions.0.source.type" */
  path: string
  /** Human-readable description of the problem */
  message: string
  /** The invalid value received (if available) */
  received?: unknown
}

/**
 * Thrown when the parsed YAML object fails Zod schema validation.
 * Contains structured issue list for UI rendering.
 */
export class AppSpecValidationError extends Error {
  readonly code = 'APP_SPEC_VALIDATION_ERROR' as const

  constructor(
    message: string,
    public readonly issues: ValidationIssue[]
  ) {
    super(message)
    this.name = 'AppSpecValidationError'
  }
}
