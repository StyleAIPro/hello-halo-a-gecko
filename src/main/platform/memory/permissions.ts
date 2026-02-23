/**
 * platform/memory -- Permission Enforcement
 *
 * Implements the memory isolation matrix from the architecture doc (section 3.4).
 * Each function validates that a caller is allowed to perform a specific operation
 * on a specific scope, and throws a descriptive error if not.
 *
 * Permission Matrix:
 *
 *   Caller    Scope     Read     Write(replace)   Write(append)
 *   ------    -----     ----     --------------   -------------
 *   user      user      YES      YES              YES
 *   user      space     YES      YES              YES
 *   user      app       NO       NO               NO
 *   app(A)    user      YES      NO               NO
 *   app(A)    space     YES      NO               YES
 *   app(A)    app(A)    YES      YES              YES
 *   app(A)    app(B)    NO       NO               NO
 */

import type { MemoryCallerScope, MemoryScopeType } from './types'

/**
 * Check if a caller can read from a given scope.
 *
 * @throws Error with descriptive message if permission denied
 */
export function assertReadPermission(caller: MemoryCallerScope, scope: MemoryScopeType): void {
  if (caller.type === 'user') {
    // User sessions can read user and space memory, but NOT app memory
    if (scope === 'app') {
      throw new MemoryPermissionError(
        `User sessions cannot read app memory. Only the owning app can access its private memory.`
      )
    }
    return // user + space: OK
  }

  // App caller
  if (scope === 'user') {
    return // Apps can read user memory (read-only)
  }
  if (scope === 'space') {
    return // Apps can read space memory
  }
  if (scope === 'app') {
    // Apps can only read their OWN app memory (caller.appId check done at path level)
    // Since the path resolution uses caller.appId, cross-app reads are structurally impossible
    return
  }
}

/**
 * Check if a caller can write to a given scope with a given mode.
 *
 * @throws Error with descriptive message if permission denied
 */
export function assertWritePermission(
  caller: MemoryCallerScope,
  scope: MemoryScopeType,
  mode: 'append' | 'replace'
): void {
  if (caller.type === 'user') {
    // User sessions can write to user and space memory (both modes)
    if (scope === 'app') {
      throw new MemoryPermissionError(
        `User sessions cannot write to app memory. Only the owning app can modify its private memory.`
      )
    }
    return // user + space: both modes OK
  }

  // App caller
  if (scope === 'user') {
    throw new MemoryPermissionError(
      `Apps cannot write to user memory. User memory is read-only for apps.`
    )
  }

  if (scope === 'space') {
    if (mode === 'replace') {
      throw new MemoryPermissionError(
        `Apps can only append to space memory, not replace it. ` +
        `Use mode "append" to add observations to the shared space memory.`
      )
    }
    return // append only
  }

  if (scope === 'app') {
    // Apps can read/write their own app memory (both modes)
    // Cross-app isolation is enforced at the path level (caller.appId)
    return
  }
}

/**
 * Check if a caller can list files in a given scope.
 * Same rules as read permission.
 */
export function assertListPermission(caller: MemoryCallerScope, scope: MemoryScopeType): void {
  // List permission follows the same rules as read
  assertReadPermission(caller, scope)
}

/**
 * Get the scopes available to a caller for reading.
 */
export function getReadableScopes(caller: MemoryCallerScope): MemoryScopeType[] {
  if (caller.type === 'user') {
    return ['user', 'space']
  }
  // App callers: can read user (read-only), space, and own app memory
  return ['user', 'space', 'app']
}

/**
 * Get the scopes available to a caller for writing, along with allowed modes.
 */
export function getWritableScopes(caller: MemoryCallerScope): Array<{
  scope: MemoryScopeType
  modes: Array<'append' | 'replace'>
}> {
  if (caller.type === 'user') {
    return [
      { scope: 'user', modes: ['append', 'replace'] },
      { scope: 'space', modes: ['append', 'replace'] }
    ]
  }
  // App callers
  return [
    { scope: 'space', modes: ['append'] },
    { scope: 'app', modes: ['append', 'replace'] }
  ]
}

// ============================================================================
// Custom Error
// ============================================================================

export class MemoryPermissionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryPermissionError'
  }
}
