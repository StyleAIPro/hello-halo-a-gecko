#!/usr/bin/env node
/**
 * Remote Agent Proxy - Test Client
 *
 * Usage: node test-client.js [ws_url] [auth_token]
 * Example: node test-client.js ws://localhost:8080/agent my-token
 */

const WebSocket = require('ws')

const WS_URL = process.argv[2] || 'ws://localhost:8080/agent'
const AUTH_TOKEN = process.argv[3] || process.env.AUTH_TOKEN || ''

console.log('========================================')
console.log('Remote Agent Proxy - Test Client')
console.log('========================================')
console.log(`URL: ${WS_URL}`)
console.log(`Auth Token: ${AUTH_TOKEN ? AUTH_TOKEN.substring(0, 10) + '...' : 'none'}`)
console.log('')

// Connect to WebSocket server
const ws = new WebSocket(WS_URL, {
  headers: AUTH_TOKEN ? { 'Authorization': `Bearer ${AUTH_TOKEN}` } : {}
})

let sessionId = `test-${Date.now()}`

ws.on('open', () => {
  console.log('[✓] Connected to server')
  console.log('')

  // Start ping interval
  const pingInterval = setInterval(() => {
    ws.send(JSON.stringify({ type: 'ping', sessionId }))
    console.log('[→] Sent ping')
  }, 30000)

  // Send a test chat message
  const testMessage = {
    type: 'claude:chat',
    sessionId,
    payload: {
      messages: [
        { role: 'user', content: 'Hello! Please respond with a short greeting.' }
      ],
      options: {
        model: 'claude-sonnet-4-6'
      },
      stream: true
    }
  }

  console.log('[→] Sending chat request...')
  console.log(JSON.stringify(testMessage, null, 2))
  console.log('')
  ws.send(JSON.stringify(testMessage))

  // Handle cleanup on close
  ws.on('close', () => {
    clearInterval(pingInterval)
  })
})

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString())
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0]

    switch (msg.type) {
      case 'auth:success':
        console.log(`[${timestamp}] [✓] Authenticated successfully`)
        break

      case 'auth:failed':
        console.error(`[${timestamp}] [✗] Authentication failed:`, msg.data)
        ws.close()
        break

      case 'claude:stream':
        const text = msg.data?.text || msg.data?.content || ''
        if (text) {
          process.stdout.write(text)
        }
        break

      case 'claude:complete':
        console.log('')
        console.log(`[${timestamp}] [✓] Chat completed`)
        console.log('')
        console.log('========================================')
        console.log('Test completed successfully!')
        console.log('========================================')
        ws.close()
        break

      case 'claude:error':
        console.error('')
        console.error(`[${timestamp}] [✗] Claude error:`, msg.data?.error || msg.data)
        ws.close()
        break

      case 'tool:call':
        console.log(`[${timestamp}] [🔧] Tool call: ${msg.data?.name || 'unknown'}`)
        break

      case 'terminal:output':
        console.log(`[${timestamp}] [💻] Terminal: ${msg.data?.content || ''}`)
        break

      case 'pong':
        console.log(`[${timestamp}] [←] Received pong`)
        break

      default:
        console.log(`[${timestamp}] [?] Unknown message:`, msg.type, msg.data || '')
    }
  } catch (e) {
    console.error('[✗] Failed to parse message:', data.toString())
  }
})

ws.on('error', (err) => {
  console.error('[✗] WebSocket error:', err.message)
  console.error('    Code:', err.code)
  console.error('    This could be:')
  console.error('    - Server not running')
  console.error('    - Wrong URL')
  console.error('    - Auth token mismatch')
  console.error('    - Network/firewall issue')
})

ws.on('close', (code, reason) => {
  console.log(`[i] Connection closed - code: ${code}, reason: ${reason || 'none'}`)
})

// Handle process exit
process.on('SIGINT', () => {
  console.log('\n[i] Closing connection...')
  ws.close()
  process.exit(0)
})