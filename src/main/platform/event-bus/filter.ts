/**
 * platform/event-bus -- Filter Engine
 *
 * Evaluates EventFilter + FilterRule against HaloEvent instances.
 * This is the "zero LLM cost" pre-filtering layer: pure rule matching
 * with no external calls.
 *
 * Design decisions:
 * - Field path resolution is hand-rolled (no lodash dependency).
 *   Supports dot notation and array index: "payload.items[0].name"
 * - Type glob uses simple prefix matching: "file.*" matches "file.changed"
 * - All filter criteria use AND logic. types/sources use OR within their arrays.
 */

import type { HaloEvent, EventFilter, FilterRule } from './types'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if an event matches a subscription filter.
 *
 * Returns true if ALL specified criteria match:
 * - types: event.type matches at least one pattern (OR within array)
 * - sources: event.source matches at least one source (OR within array)
 * - rules: ALL rules match (AND within array)
 *
 * Omitted criteria are treated as "match any".
 */
export function matchesFilter(event: HaloEvent, filter: EventFilter): boolean {
  // Type matching (OR logic within the array)
  if (filter.types && filter.types.length > 0) {
    const typeMatched = filter.types.some(pattern => matchTypeGlob(event.type, pattern))
    if (!typeMatched) return false
  }

  // Source matching (OR logic within the array)
  if (filter.sources && filter.sources.length > 0) {
    if (!filter.sources.includes(event.source)) return false
  }

  // Rule matching (AND logic -- every rule must pass)
  if (filter.rules && filter.rules.length > 0) {
    for (const rule of filter.rules) {
      if (!evaluateRule(event, rule)) return false
    }
  }

  return true
}

// ---------------------------------------------------------------------------
// Type Glob Matching
// ---------------------------------------------------------------------------

/**
 * Match an event type against a pattern.
 *
 * Supported patterns:
 * - `"file.changed"` -- exact match
 * - `"file.*"` -- matches any type starting with "file."
 * - `"*"` -- matches everything
 */
export function matchTypeGlob(type: string, pattern: string): boolean {
  if (pattern === '*') return true
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1) // "file." from "file.*"
    return type.startsWith(prefix)
  }
  return type === pattern
}

// ---------------------------------------------------------------------------
// FilterRule Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a single filter rule against a HaloEvent.
 *
 * Resolves the field path, then applies the operator.
 */
export function evaluateRule(event: HaloEvent, rule: FilterRule): boolean {
  const fieldValue = getByPath(event as unknown as Record<string, unknown>, rule.field)
  return applyOperator(fieldValue, rule.op, rule.value)
}

/**
 * Apply a comparison operator.
 *
 * Operators:
 * - eq: strict equality
 * - neq: strict inequality
 * - contains: string contains substring, or array includes value
 * - matches: string matches regex pattern
 * - gt: greater than (numeric)
 * - lt: less than (numeric)
 * - in: field value is in the provided array
 * - nin: field value is NOT in the provided array
 */
export function applyOperator(fieldValue: unknown, op: FilterRule['op'], ruleValue: unknown): boolean {
  switch (op) {
    case 'eq':
      return fieldValue === ruleValue

    case 'neq':
      return fieldValue !== ruleValue

    case 'contains':
      if (typeof fieldValue === 'string' && typeof ruleValue === 'string') {
        return fieldValue.includes(ruleValue)
      }
      if (Array.isArray(fieldValue)) {
        return fieldValue.includes(ruleValue)
      }
      return false

    case 'matches':
      if (typeof fieldValue === 'string' && typeof ruleValue === 'string') {
        try {
          const regex = new RegExp(ruleValue)
          return regex.test(fieldValue)
        } catch {
          // Invalid regex pattern -- treat as no match
          return false
        }
      }
      return false

    case 'gt':
      if (typeof fieldValue === 'number' && typeof ruleValue === 'number') {
        return fieldValue > ruleValue
      }
      return false

    case 'lt':
      if (typeof fieldValue === 'number' && typeof ruleValue === 'number') {
        return fieldValue < ruleValue
      }
      return false

    case 'in':
      if (Array.isArray(ruleValue)) {
        return ruleValue.includes(fieldValue)
      }
      return false

    case 'nin':
      if (Array.isArray(ruleValue)) {
        return !ruleValue.includes(fieldValue)
      }
      return false

    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// Field Path Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a dot-separated field path with optional array index notation.
 *
 * Supports:
 * - `"type"` -> event.type
 * - `"payload.extension"` -> event.payload.extension
 * - `"payload.items[0].name"` -> event.payload.items[0].name
 *
 * Returns `undefined` for any unresolvable path segment.
 */
export function getByPath(obj: Record<string, unknown>, path: string): unknown {
  if (!path) return undefined

  const parts: Array<string | number> = []
  // Parse path segments: property names and array indices
  const re = /([^.[\]]+)|\[(\d+)\]/g
  let match = re.exec(path)
  while (match) {
    if (match[1] !== undefined) {
      parts.push(match[1])
    } else if (match[2] !== undefined) {
      parts.push(Number(match[2]))
    }
    match = re.exec(path)
  }

  let current: unknown = obj
  for (const part of parts) {
    if (current === null || current === undefined) return undefined
    if (typeof part === 'number') {
      if (!Array.isArray(current)) return undefined
      current = (current as unknown[])[part]
    } else {
      if (typeof current !== 'object') return undefined
      current = (current as Record<string, unknown>)[part]
    }
  }
  return current
}
