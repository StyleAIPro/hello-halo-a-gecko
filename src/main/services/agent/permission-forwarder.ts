/**
 * Permission Forwarder for Multi-Agent Teams
 *
 * When a worker agent encounters a tool that requires user approval,
 * this module routes the permission request through the mailbox system
 * to the team leader, which presents it in the UI for user approval.
 *
 * Flow:
 * 1. Worker needs permission -> forwardRequest() posts to leader's mailbox
 * 2. Leader receives permission_request via its persistent loop / injection
 * 3. Leader's orchestrator forwards to renderer via IPC
 * 4. User approves/denies via UI
 * 5. Permission response is posted back to worker's mailbox
 * 6. Worker receives response and continues
 *
 * @module permission-forwarder
 */

import { createLogger } from '../../utils/logger'
import { mailboxService } from './mailbox'

const log = createLogger('permission-forwarder')

// ============================================
// Types
// ============================================

interface PendingPermissionRequest {
  id: string
  resolve: (approved: boolean) => void
  reject: (reason?: unknown) => void
  createdAt: number
}

// ============================================
// Permission Forwarder
// ============================================

/**
 * Routes permission requests between workers and the leader/user.
 */
export class PermissionForwarder {
  /** Pending permission requests waiting for responses */
  private pendingRequests: Map<string, PendingPermissionRequest> = new Map()

  /** Default timeout for permission requests (5 minutes) */
  private defaultTimeout: number = 5 * 60 * 1000

  /**
   * Forward a permission request from a worker to the leader.
   * Posts to the leader's mailbox and waits for a response.
   *
   * @returns true if approved, false if denied or timed out
   */
  async forwardRequest(params: {
    spaceId: string
    teamId: string
    requestingAgentId: string
    requestingAgentName: string
    toolName: string
    toolInput: Record<string, unknown>
    taskId?: string
    timeout?: number
  }): Promise<boolean> {
    const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    // Create promise for the response
    const promise = new Promise<boolean>((resolve, reject) => {
      const timeout = params.timeout || this.defaultTimeout

      // Set up timeout
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        log.warn(`Permission request ${requestId} timed out after ${timeout}ms`)
        resolve(false) // Timeout = denied
      }, timeout)

      this.pendingRequests.set(requestId, {
        id: requestId,
        resolve: (approved) => {
          clearTimeout(timer)
          resolve(approved)
        },
        reject: (reason) => {
          clearTimeout(timer)
          reject(reason)
        },
        createdAt: Date.now()
      })
    })

    // Post permission request to leader's mailbox
    mailboxService.postMessage(
      params.spaceId,
      'leader', // Leader agent ID is 'leader' or the leader's actual ID
      {
        type: 'permission_request',
        senderId: params.requestingAgentId,
        senderName: params.requestingAgentName,
        content: `Worker "${params.requestingAgentName}" requests permission to use tool: ${params.toolName}`,
        payload: {
          permissionRequestId: requestId,
          toolName: params.toolName,
          toolInput: params.toolInput,
          taskId: params.taskId
        }
      }
    )

    // Also emit event for IPC forwarding to renderer
    // (The orchestrator's handleHyperSpaceToolCall will pick this up for remote workers)

    log.info(`Permission request ${requestId} forwarded: tool=${params.toolName} agent=${params.requestingAgentName}`)

    return promise
  }

  /**
   * Handle a permission response from the leader/user.
   * Resolves the pending request promise.
   */
  handleResponse(params: {
    spaceId: string
    respondingAgentId: string
    requestId: string
    approved: boolean
  }): void {
    const request = this.pendingRequests.get(params.requestId)
    if (!request) {
      log.warn(`No pending permission request found: ${params.requestId}`)
      return
    }

    request.resolve(params.approved)
    this.pendingRequests.delete(params.requestId)

    log.info(
      `Permission response ${params.requestId}: ` +
      `${params.approved ? 'APPROVED' : 'DENIED'} by ${params.respondingAgentId}`
    )
  }

  /**
   * Post a permission response to a worker's mailbox.
   * Called when the user approves/denies in the UI.
   */
  postResponse(
    spaceId: string,
    workerAgentId: string,
    requestId: string,
    approved: boolean
  ): void {
    mailboxService.postMessage(
      spaceId,
      workerAgentId,
      {
        type: 'permission_response',
        senderId: 'leader',
        senderName: 'Leader',
        content: approved ? 'Permission approved' : 'Permission denied',
        payload: {
          permissionRequestId: requestId,
          approved
        }
      }
    )
  }

  /**
   * Reject all pending permission requests (e.g., on shutdown).
   */
  rejectAll(): void {
    for (const [id, request] of this.pendingRequests) {
      request.resolve(false)
      this.pendingRequests.delete(id)
    }
    log.info(`Rejected ${this.pendingRequests.size} pending permission requests`)
  }

  /**
   * Get count of pending permission requests.
   */
  getPendingCount(): number {
    return this.pendingRequests.size
  }
}

// ============================================
// Singleton Export
// ============================================

/** Global permission forwarder instance */
export const permissionForwarder = new PermissionForwarder()
