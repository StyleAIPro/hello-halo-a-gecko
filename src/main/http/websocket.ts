/**
 * WebSocket Manager - Handles real-time communication with remote clients
 * Replaces IPC events for remote access
 */

import { WebSocket, WebSocketServer } from 'ws'
import { IncomingMessage } from 'http'
import { v4 as uuidv4 } from 'uuid'
import { validateToken } from './auth'

interface WebSocketClient {
  id: string
  ws: WebSocket
  authenticated: boolean
  subscriptions: Set<string> // conversationIds this client is subscribed to
}

// Store all connected clients
const clients = new Map<string, WebSocketClient>()

// WebSocket server instance
let wss: WebSocketServer | null = null

// Event buffer: for events that arrived before any client subscribed to a conversationId.
// When a client subscribes, buffered events are flushed immediately.
// Each entry is a list of { channel, data } objects.
const eventBuffer = new Map<string, Array<{ channel: string; data: Record<string, unknown> }>>()

// Maximum buffered events per conversationId to prevent memory leaks
const MAX_BUFFER_SIZE = 200
// Buffer entries older than this are discarded (ms)
const BUFFER_TTL_MS = 60_000

interface BufferedEvent {
  channel: string
  data: Record<string, unknown>
  timestamp: number
}

/**
 * Initialize WebSocket server
 */
export function initWebSocket(server: any): WebSocketServer {
  wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const clientId = uuidv4()
    const client: WebSocketClient = {
      id: clientId,
      ws,
      authenticated: false,
      subscriptions: new Set()
    }

    clients.set(clientId, client)
    console.log(`[WS] Client connected: ${clientId}`)

    // Handle messages from client
    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString())
        handleClientMessage(client, message)
      } catch (error) {
        console.error('[WS] Invalid message:', error)
      }
    })

    // Handle disconnection
    ws.on('close', () => {
      clients.delete(clientId)
      console.log(`[WS] Client disconnected: ${clientId}`)
    })

    // Handle errors
    ws.on('error', (error) => {
      console.error(`[WS] Client error ${clientId}:`, error)
      clients.delete(clientId)
    })
  })

  console.log('[WS] WebSocket server initialized')
  return wss
}

/**
 * Flush buffered events for a conversationId to a newly subscribed client.
 * Events are sent in order and then removed from the buffer.
 */
function flushBufferedEvents(client: WebSocketClient, conversationId: string): void {
  const buffered = eventBuffer.get(conversationId)
  if (!buffered || buffered.length === 0) return

  // Filter out expired events
  const now = Date.now()
  const valid = buffered.filter(e => now - e.timestamp < BUFFER_TTL_MS)

  // Update buffer (keep expired ones will be cleaned up later)
  if (valid.length < buffered.length) {
    eventBuffer.set(conversationId, valid)
  } else {
    // All events are still valid
  }

  // Send valid buffered events to the newly subscribed client
  for (const event of valid) {
    sendToClient(client, {
      type: 'event',
      channel: event.channel,
      data: event.data
    })
  }

  if (valid.length > 0) {
    console.log(`[WS] Flushed ${valid.length} buffered events for ${conversationId}`)
  }
}

/**
 * Handle incoming message from client
 */
function handleClientMessage(
  client: WebSocketClient,
  message: { type: string; payload?: any }
): void {
  switch (message.type) {
    case 'auth':
      // Validate the token before marking as authenticated
      if (message.payload?.token && validateToken(message.payload.token)) {
        client.authenticated = true
        sendToClient(client, { type: 'auth:success' })
        console.log(`[WS] Client ${client.id} authenticated successfully`)
      } else {
        sendToClient(client, { type: 'auth:failed', error: 'Invalid token' })
        console.log(`[WS] Client ${client.id} authentication failed`)
        // Close connection after failed auth
        setTimeout(() => client.ws.close(), 100)
      }
      break

    case 'subscribe':
      // Subscribe to conversation events (requires authentication)
      if (!client.authenticated) {
        sendToClient(client, { type: 'error', error: 'Not authenticated' })
        break
      }
      if (message.payload?.conversationId) {
        client.subscriptions.add(message.payload.conversationId)
        console.log(`[WS] Client ${client.id} subscribed to ${message.payload.conversationId}`)
        // Acknowledge subscription so the client can await it before sending messages
        sendToClient(client, {
          type: 'subscribe:success',
          payload: { conversationId: message.payload.conversationId }
        })
        // Flush any events that arrived before this subscription
        flushBufferedEvents(client, message.payload.conversationId)
      }
      break

    case 'unsubscribe':
      // Unsubscribe from conversation events
      if (message.payload?.conversationId) {
        client.subscriptions.delete(message.payload.conversationId)
      }
      break

    case 'ping':
      sendToClient(client, { type: 'pong' })
      break

    default:
      console.log(`[WS] Unknown message type: ${message.type}`)
  }
}

/**
 * Send message to a specific client
 */
function sendToClient(client: WebSocketClient, message: object): void {
  if (client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(message))
  }
}

/**
 * Broadcast event to all subscribed clients.
 * If no client is subscribed yet, buffer the event for later delivery.
 * This prevents event loss when events are emitted before the client's
 * WebSocket subscription is processed (race condition between HTTP POST and
 * WebSocket subscribe frame ordering).
 */
export function broadcastToWebSocket(
  channel: string,
  data: Record<string, unknown>
): void {
  const conversationId = data.conversationId
  if (typeof conversationId !== 'string' || conversationId.length === 0) {
    // This function is strictly conversation-scoped. Missing conversationId would otherwise
    // silently drop events (no client can be subscribed to "undefined").
    console.warn(`[WS] broadcastToWebSocket called without conversationId for channel: ${channel}`)
    return
  }

  let hasSubscribers = false
  for (const client of Array.from(clients.values())) {
    if (client.authenticated && client.subscriptions.has(conversationId)) {
      hasSubscribers = true
      sendToClient(client, {
        type: 'event',
        channel,
        data
      })
    }
  }

  // No subscribers — buffer the event for later delivery when a client subscribes
  if (!hasSubscribers) {
    let buffer = eventBuffer.get(conversationId)
    if (!buffer) {
      buffer = []
      eventBuffer.set(conversationId, buffer)
    }
    // Enforce max buffer size (discard oldest if exceeded)
    if (buffer.length >= MAX_BUFFER_SIZE) {
      buffer.shift()
    }
    buffer.push({ channel, data, timestamp: Date.now() })

    // Periodically clean up expired buffers
    if (buffer.length === 1) {
      // Schedule cleanup on first buffer entry
      setTimeout(() => {
        const buf = eventBuffer.get(conversationId)
        if (buf) {
          const now = Date.now()
          const valid = buf.filter(e => now - e.timestamp < BUFFER_TTL_MS)
          if (valid.length === 0) {
            eventBuffer.delete(conversationId)
          } else {
            eventBuffer.set(conversationId, valid)
          }
        }
      }, BUFFER_TTL_MS + 1000)
    }
  }
}

/**
 * Broadcast to all authenticated clients (for global events)
 */
export function broadcastToAll(channel: string, data: Record<string, unknown>): void {
  for (const client of Array.from(clients.values())) {
    if (client.authenticated) {
      sendToClient(client, {
        type: 'event',
        channel,
        data
      })
    }
  }
}

/**
 * Get connected client count
 */
export function getClientCount(): number {
  return clients.size
}

/**
 * Get authenticated client count
 */
export function getAuthenticatedClientCount(): number {
  let count = 0
  for (const client of Array.from(clients.values())) {
    if (client.authenticated) count++
  }
  return count
}

/**
 * Shutdown WebSocket server
 */
export function shutdownWebSocket(): void {
  if (wss) {
    for (const client of Array.from(clients.values())) {
      client.ws.close()
    }
    clients.clear()
    wss.close()
    wss = null
    eventBuffer.clear()
    console.log('[WS] WebSocket server shutdown')
  }
}
