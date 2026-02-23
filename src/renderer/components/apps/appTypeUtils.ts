/**
 * appTypeUtils
 *
 * Centralized mapping from the internal AppType value (automation, mcp, skill, extension)
 * to user-facing display labels.
 *
 * NAMING CONVENTION
 * -----------------
 * Internally, the spec type remains `'automation'` throughout the codebase, database,
 * and YAML format — this is intentional and must not change.
 *
 * In the UI, `automation` is presented as "Digital Human" (Halo 数字人) to convey
 * that these are autonomous AI entities, not scripts. MCP and Skill keep their
 * industry-standard names as they are already well understood in the ecosystem.
 *
 * Usage in components:
 *   import { appTypeLabel } from './appTypeUtils'
 *   <span>{t(appTypeLabel(app.spec.type))}</span>
 *
 * The returned string is the English i18n key — always wrap with t() so that
 * the automated translation pipeline can handle other locales.
 */

import type { AppType } from '../../../shared/apps/spec-types'

/**
 * Returns the English i18n key for the given app type's display label.
 * Always pass the result through t() in the component.
 */
export function appTypeLabel(type: AppType | string): string {
  switch (type) {
    case 'automation': return 'Digital Human'
    case 'mcp':        return 'MCP'
    case 'skill':      return 'Skill'
    case 'extension':  return 'Extension'
    default:           return type
  }
}
