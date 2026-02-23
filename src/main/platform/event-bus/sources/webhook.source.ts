/**
 * platform/event-bus -- WebhookSource
 *
 * Event source adapter that mounts a `POST /hooks/:path*` route on the
 * existing Express server to receive inbound webhook events.
 *
 * Integration approach:
 * - Accepts an Express Application or Router in the constructor.
 * - On start(), mounts `POST /hooks/*` route handler.
 * - Incoming POST requests are converted to HaloEvent with:
 *   - type: "webhook.received"
 *   - source: "webhook"
 *   - payload: { path, body, headers, query, method, ip }
 * - dedupKey: from request body's `dedupKey` field if present, or
 *   `"wh:{path}:{body-hash}"` for idempotency against retries.
 *
 * Security:
 * - The /hooks/* endpoint is NOT behind the Halo auth middleware because
 *   external services (GitHub, Stripe, etc.) need to POST without an
 *   auth token.
 * - Per-hook HMAC signature verification is performed when a secret is
 *   configured for the hook path. Secrets are resolved via a callback
 *   function injected at construction time.
 * - Supports standard signature headers:
 *   - `x-hub-signature-256`: GitHub-style (sha256=<hex>)
 *   - `x-signature-256`: Generic HMAC-SHA256 (<hex>)
 *   - `x-webhook-signature`: Alternative header (<hex>)
 * - Request body is limited to 256KB to prevent abuse.
 *
 * Lifecycle:
 * - start(): registers Express route
 * - stop(): marks the source as inactive (Express does not support
 *   runtime route removal, so the handler becomes a no-op)
 */

import { createHash, createHmac, timingSafeEqual } from 'crypto'
import type { Express, Request, Response, NextFunction } from 'express'
import type { EventSourceAdapter, EventEmitFn } from '../types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Callback to resolve the HMAC secret for a given webhook path.
 *
 * Returns the secret string if the path has a configured secret,
 * or null/undefined if no verification is required for that path.
 *
 * The implementation typically looks up installed Apps' webhook
 * subscription configs (WebhookSourceConfig.secret) where
 * WebhookSourceConfig.path matches the incoming hookPath.
 */
export type WebhookSecretResolver = (hookPath: string) => string | null | undefined

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 256 * 1024 // 256KB
const HOOKS_BASE_PATH = '/hooks'

/**
 * Ordered list of headers to check for HMAC signatures.
 * Each entry has the header name and an optional prefix that the
 * signature value uses (e.g., GitHub sends "sha256=<hex>").
 */
const SIGNATURE_HEADERS: Array<{ header: string; prefix: string }> = [
  { header: 'x-hub-signature-256', prefix: 'sha256=' },    // GitHub
  { header: 'x-signature-256', prefix: '' },                // Generic
  { header: 'x-webhook-signature', prefix: '' },            // Alternative
]

// ---------------------------------------------------------------------------
// Source Implementation
// ---------------------------------------------------------------------------

export class WebhookSource implements EventSourceAdapter {
  readonly id = 'webhook'
  readonly type = 'webhook' as const

  private emitFn: EventEmitFn | null = null
  private app: Express | null
  private active = false
  private secretResolver: WebhookSecretResolver | null

  /**
   * @param app - The Express application to mount the webhook route on.
   *   If null, the source will not mount any routes (useful for testing
   *   or when the HTTP server is not available).
   * @param secretResolver - Optional callback to resolve HMAC secrets
   *   for incoming webhook paths. If null, no signature verification
   *   is performed (all webhooks are accepted).
   */
  constructor(app: Express | null, secretResolver?: WebhookSecretResolver | null) {
    this.app = app
    this.secretResolver = secretResolver ?? null
  }

  start(emit: EventEmitFn): void {
    this.emitFn = emit
    this.active = true

    if (this.app) {
      this.mountRoute(this.app)
      console.log(`[WebhookSource] Started -- mounted POST ${HOOKS_BASE_PATH}/*`)
    } else {
      console.log('[WebhookSource] Started (no Express app -- dry run mode)')
    }
  }

  stop(): void {
    this.emitFn = null
    this.active = false
    // Express does not support runtime route removal.
    // The mounted handler checks `this.active` and returns 503 when stopped.
    console.log('[WebhookSource] Stopped')
  }

  // -------------------------------------------------------------------------
  // Route Handler
  // -------------------------------------------------------------------------

  private mountRoute(app: Express): void {
    // Mount BEFORE the auth middleware and wildcard routes.
    // We use a path pattern that captures everything after /hooks/
    // Express 5 syntax: /hooks/{*hookPath}
    // Express 4 syntax: /hooks/*
    // We use both-compatible approach with a single handler.
    app.post(`${HOOKS_BASE_PATH}/:hookPath(*)`, (req: Request, res: Response, _next: NextFunction) => {
      this.handleWebhook(req, res)
    })
  }

  private handleWebhook(req: Request, res: Response): void {
    // Check if source is active
    if (!this.active || !this.emitFn) {
      res.status(503).json({ error: 'Webhook source is not active' })
      return
    }

    // Check body size (Express json middleware already parsed, check original)
    const contentLength = parseInt(req.headers['content-length'] || '0', 10)
    if (contentLength > MAX_BODY_BYTES) {
      res.status(413).json({ error: 'Payload too large' })
      return
    }

    // Extract hook path (everything after /hooks/)
    const hookPath = req.params.hookPath || req.params[0] || ''

    // ── HMAC signature verification ──────────────────────────
    if (this.secretResolver) {
      const secret = this.secretResolver(hookPath)
      if (secret) {
        const rawBody = getRawBody(req)
        if (!rawBody) {
          // Cannot verify without raw body -- reject
          console.warn(`[WebhookSource] Rejecting ${hookPath}: raw body not available for HMAC verification`)
          res.status(400).json({ error: 'Cannot verify signature: raw body unavailable' })
          return
        }

        if (!verifySignature(rawBody, secret, req.headers)) {
          console.warn(`[WebhookSource] Rejecting ${hookPath}: HMAC signature verification failed`)
          res.status(401).json({ error: 'Invalid webhook signature' })
          return
        }
      }
    }

    // Build payload
    const body = typeof req.body === 'object' && req.body !== null
      ? req.body as Record<string, unknown>
      : {}

    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') {
        headers[key.toLowerCase()] = value
      } else if (Array.isArray(value) && value.length > 0) {
        headers[key.toLowerCase()] = value.join(', ')
      }
    }

    // Determine dedupKey
    let dedupKey: string | undefined
    if (typeof body.dedupKey === 'string' && body.dedupKey.trim()) {
      dedupKey = `wh:${body.dedupKey.trim()}`
    } else {
      // Generate hash from path + body for idempotency
      const bodyStr = JSON.stringify(body)
      const hash = createHash('sha256').update(bodyStr).digest('hex').slice(0, 16)
      dedupKey = `wh:${hookPath}:${hash}`
    }

    // Emit event
    this.emitFn({
      type: 'webhook.received',
      source: this.id,
      payload: {
        path: hookPath,
        body,
        headers,
        query: req.query as Record<string, unknown>,
        method: req.method,
        ip: req.ip || req.socket?.remoteAddress || 'unknown'
      },
      dedupKey
    })

    // Respond immediately (webhook callers expect fast acknowledgment)
    res.status(200).json({ ok: true, received: true })
  }
}

// ---------------------------------------------------------------------------
// HMAC Verification Helpers
// ---------------------------------------------------------------------------

/**
 * Retrieve the raw request body for HMAC computation.
 *
 * Express's json middleware can be configured to keep the raw body via
 * `verify` option. If available, we use that. Otherwise we re-serialize
 * the parsed body (less ideal but functional for JSON payloads).
 */
function getRawBody(req: Request): Buffer | null {
  // Check for raw body stored by Express json middleware's `verify` callback
  const rawBody = (req as any).rawBody
  if (Buffer.isBuffer(rawBody)) {
    return rawBody
  }
  if (typeof rawBody === 'string') {
    return Buffer.from(rawBody, 'utf-8')
  }

  // Fallback: re-serialize the parsed JSON body
  if (req.body !== undefined && req.body !== null) {
    try {
      return Buffer.from(JSON.stringify(req.body), 'utf-8')
    } catch {
      return null
    }
  }

  return null
}

/**
 * Verify an HMAC-SHA256 signature from webhook request headers.
 *
 * Checks multiple well-known signature headers in priority order.
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * @param rawBody - The raw request body bytes
 * @param secret - The shared secret for HMAC computation
 * @param headers - The request headers (lowercased keys)
 * @returns true if a valid signature is found, false otherwise
 */
function verifySignature(
  rawBody: Buffer,
  secret: string,
  headers: Record<string, string | string[] | undefined>
): boolean {
  const expectedHmac = createHmac('sha256', secret).update(rawBody).digest('hex')

  for (const { header, prefix } of SIGNATURE_HEADERS) {
    const headerValue = headers[header]
    if (!headerValue || typeof headerValue !== 'string') continue

    // Strip the prefix (e.g., "sha256=" for GitHub)
    const signature = prefix && headerValue.startsWith(prefix)
      ? headerValue.slice(prefix.length)
      : headerValue

    // Validate hex format
    if (!/^[0-9a-f]{64}$/i.test(signature)) continue

    // Timing-safe comparison
    try {
      const sigBuffer = Buffer.from(signature, 'hex')
      const expectedBuffer = Buffer.from(expectedHmac, 'hex')
      if (sigBuffer.length === expectedBuffer.length && timingSafeEqual(sigBuffer, expectedBuffer)) {
        return true
      }
    } catch {
      // Buffer creation failed (invalid hex), try next header
      continue
    }
  }

  return false
}
