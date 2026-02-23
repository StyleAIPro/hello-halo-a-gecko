/**
 * apps/spec YAML Parsing and Normalization
 *
 * Handles:
 * 1. YAML string -> JS object conversion
 * 2. Field aliasing for backward compatibility:
 *    - `inputs` -> `config_schema`
 *    - `required_mcps` -> `requires.mcps`
 *    - `required_skills` -> `requires.skills`
 * 3. Shorthand expansion (e.g. subscription without explicit `source` wrapper)
 */

import { parse as parseYaml } from 'yaml'
import { AppSpecParseError } from './errors'

/**
 * Parse a YAML string into a raw JS object.
 * Throws AppSpecParseError on malformed YAML.
 */
export function parseYamlString(yamlString: string): unknown {
  if (!yamlString || typeof yamlString !== 'string') {
    throw new AppSpecParseError('Input must be a non-empty string')
  }

  try {
    const parsed = parseYaml(yamlString)
    if (parsed === null || parsed === undefined) {
      throw new AppSpecParseError('YAML parsed to null/undefined -- document is empty')
    }
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AppSpecParseError('YAML must parse to an object (mapping), not a scalar or array')
    }
    return parsed
  } catch (err) {
    if (err instanceof AppSpecParseError) {
      throw err
    }
    const message = err instanceof Error ? err.message : String(err)
    throw new AppSpecParseError(message, err)
  }
}

/**
 * Normalize a raw parsed object by applying field aliases and shorthand expansions.
 * This is applied BEFORE Zod validation so the schema only needs to understand
 * the canonical field names.
 *
 * Mutations are applied to a shallow clone -- the original object is not modified.
 */
export function normalizeRawSpec(raw: Record<string, unknown>): Record<string, unknown> {
  const spec = { ...raw }

  // ------------------------------------------------------------------
  // Alias: `inputs` -> `config_schema`
  // ------------------------------------------------------------------
  if (spec.inputs !== undefined && spec.config_schema === undefined) {
    spec.config_schema = spec.inputs
    delete spec.inputs
  }

  // ------------------------------------------------------------------
  // Alias: `required_mcps` / `required_skills` -> `requires.mcps` / `requires.skills`
  // ------------------------------------------------------------------
  const existingRequires = (spec.requires ?? {}) as Record<string, unknown>
  let requiresChanged = false

  if (spec.required_mcps !== undefined) {
    // Accept both array-of-objects and array-of-strings
    const mcps = normalizeMcpDeps(spec.required_mcps)
    if (mcps !== undefined) {
      existingRequires.mcps = mcps
      requiresChanged = true
    }
    delete spec.required_mcps
  }

  if (spec.required_skills !== undefined) {
    existingRequires.skills = spec.required_skills
    requiresChanged = true
    delete spec.required_skills
  }

  if (requiresChanged) {
    spec.requires = existingRequires
  }

  // ------------------------------------------------------------------
  // Also normalize within `requires`: accept `mcp` as alias for `mcps`,
  // and `skill` as alias for `skills`
  // ------------------------------------------------------------------
  if (spec.requires && typeof spec.requires === 'object') {
    const req = spec.requires as Record<string, unknown>
    if (req.mcp !== undefined && req.mcps === undefined) {
      req.mcps = normalizeMcpDeps(req.mcp)
      delete req.mcp
    }
    if (req.skill !== undefined && req.skills === undefined) {
      req.skills = req.skill
      delete req.skill
    }
    spec.requires = req
  }

  // ------------------------------------------------------------------
  // Subscription shorthand: if a subscription has `type` at top level
  // instead of nested `source`, normalize it.
  //
  // Shorthand:
  //   subscriptions:
  //     - type: schedule
  //       config: { every: "30m" }
  //
  // Canonical:
  //   subscriptions:
  //     - source:
  //         type: schedule
  //         config: { every: "30m" }
  // ------------------------------------------------------------------
  if (Array.isArray(spec.subscriptions)) {
    spec.subscriptions = spec.subscriptions.map((sub: unknown) => {
      if (sub && typeof sub === 'object' && !Array.isArray(sub)) {
        const s = sub as Record<string, unknown>
        // Shorthand: has `type` at top level and no `source`
        if (s.type !== undefined && s.source === undefined) {
          const { type, config, id, frequency, config_key, input, ...rest } = s
          const normalizedSub: Record<string, unknown> = {
            source: {
              type,
              config: config ?? rest ?? {}
            }
          }
          if (id !== undefined) normalizedSub.id = id
          if (frequency !== undefined) normalizedSub.frequency = frequency
          // Accept `input` as alias for `config_key`
          if (config_key !== undefined) normalizedSub.config_key = config_key
          else if (input !== undefined) normalizedSub.config_key = input
          return normalizedSub
        }
        // Also accept `input` alias at canonical level
        if (s.input !== undefined && s.config_key === undefined) {
          return { ...s, config_key: s.input, input: undefined }
        }
      }
      return sub
    })
  }

  return spec
}

/**
 * Normalize MCP dependency declarations.
 * Accepts:
 * - Array of strings: ["ai-browser"] -> [{ id: "ai-browser" }]
 * - Array of objects: [{ id: "ai-browser", reason: "..." }] -> as-is
 * - Mixed: both forms in one array
 */
function normalizeMcpDeps(raw: unknown): Array<{ id: string; reason?: string }> | undefined {
  if (!Array.isArray(raw)) return undefined

  return raw.map((item) => {
    if (typeof item === 'string') {
      return { id: item }
    }
    if (item && typeof item === 'object' && 'id' in item) {
      return item as { id: string; reason?: string }
    }
    // Pass through -- Zod will catch invalid shapes
    return item
  })
}
