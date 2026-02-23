/**
 * apps/spec Validation
 *
 * Wraps Zod schema parsing with Halo-specific error formatting.
 * Converts ZodError into AppSpecValidationError with structured issues.
 */

import { ZodError } from 'zod'
import { AppSpecSchema } from './schema'
import type { AppSpec } from './schema'
import { AppSpecValidationError } from './errors'
import type { ValidationIssue } from './errors'

/**
 * Validate a parsed (and normalized) JS object against the AppSpec Zod schema.
 *
 * @param parsed - Raw JS object (output of normalizeRawSpec)
 * @returns Validated and typed AppSpec
 * @throws AppSpecValidationError with structured issues on failure
 */
export function validateAppSpec(parsed: unknown): AppSpec {
  try {
    return AppSpecSchema.parse(parsed)
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = formatZodIssues(err)
      const summary = buildErrorSummary(issues)
      throw new AppSpecValidationError(summary, issues)
    }
    // Unexpected error -- re-throw as-is
    throw err
  }
}

/**
 * Same as validateAppSpec but returns a result object instead of throwing.
 * Useful for UI contexts where you want to display all errors at once.
 */
export function validateAppSpecSafe(parsed: unknown):
  | { success: true; data: AppSpec }
  | { success: false; error: AppSpecValidationError } {
  try {
    const data = validateAppSpec(parsed)
    return { success: true, data }
  } catch (err) {
    if (err instanceof AppSpecValidationError) {
      return { success: false, error: err }
    }
    // Wrap unexpected errors
    return {
      success: false,
      error: new AppSpecValidationError(
        err instanceof Error ? err.message : String(err),
        [{ path: '', message: String(err) }]
      )
    }
  }
}

/**
 * Convert Zod issues into our ValidationIssue format.
 */
function formatZodIssues(zodError: ZodError): ValidationIssue[] {
  return zodError.issues.map((issue) => {
    const path = issue.path.map(String).join('.')
    let message = issue.message

    // Enrich message for common cases
    if (issue.code === 'invalid_type') {
      message = `Expected ${issue.expected}, received ${issue.received}`
    } else if (issue.code === 'invalid_enum_value') {
      message = `Invalid value. Expected one of: ${issue.options.join(', ')}`
    }

    return {
      path,
      message,
      received: 'received' in issue ? (issue as unknown as Record<string, unknown>).received : undefined
    }
  })
}

/**
 * Build a human-readable error summary from validation issues.
 */
function buildErrorSummary(issues: ValidationIssue[]): string {
  if (issues.length === 0) {
    return 'App spec validation failed'
  }

  if (issues.length === 1) {
    const issue = issues[0]
    const location = issue.path ? ` at "${issue.path}"` : ''
    return `App spec validation failed${location}: ${issue.message}`
  }

  const lines = issues.map((issue) => {
    const location = issue.path ? `  [${issue.path}]` : ''
    return `${location} ${issue.message}`
  })

  return `App spec validation failed with ${issues.length} issues:\n${lines.join('\n')}`
}
