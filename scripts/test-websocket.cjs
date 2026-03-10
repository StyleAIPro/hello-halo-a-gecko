#!/usr/bin/env node

/**
 * WebSocket connection test for remote agent
 */

const WebSocket = require('ws');
const https = require('https');

const config = {
  host: '124.71.177.25',
  port: 8080,
  path: '/agent',
  authToken: 'MTc3MjE3MTQ2NzEwNC0wLjQ1NjAyOTEz', // From config.json
};

console.log('========================================');
console.log('Remote Agent WebSocket Test');
console.log('========================================');
console.log(`Host: ${config.host}`);
console.log(`Port: ${config.port}`);
console.log(`Path: ${config.path}`);
console.log(`Auth Token: ${config.authToken.substring(0, 10)}...`);
console.log('========================================\n');

const wsUrl = `ws://${config.host}:${config.port}${config.path}`;
console.log(`Connecting to: ${wsUrl}\n`);

const ws = new WebSocket(wsUrl, {
  headers: {
    'Authorization': `Bearer ${config.authToken}`,
  },
  handshakeTimeout: 10000,
});

let connectionTime = null;
let authenticated = false;

ws.on('open', () => {
  connectionTime = Date.now();
  console.log('✓ WebSocket connection established!');
  console.log(`  Connection time: ${connectionTime - startTime}ms\n`);

  // Send authentication
  const authMessage = {
    type: 'auth',
    payload: { token: config.authToken },
  };
  console.log('Sending authentication...');
  ws.send(JSON.stringify(authMessage));
});

ws.on('message', (data) => {
  const message = JSON.parse(data.toString());

  if (!authenticated && message.type === 'auth:success') {
    authenticated = true;
    console.log('✓ Authentication successful!\n');

    // Send a test chat message
    const testMessage = {
      type: 'claude:chat',
      sessionId: 'test-session-' + Date.now(),
      payload: {
        messages: [{ role: 'user', content: 'hello, respond with just OK' }],
        stream: true,
      },
    };
    console.log('Sending test message...');
    ws.send(JSON.stringify(testMessage));
  } else if (message.type === 'auth:failed') {
    console.error('✗ Authentication failed:', message.data);
    process.exit(1);
  } else if (message.type === 'claude:stream') {
    process.stdout.write(message.data.content || '');
  } else if (message.type === 'claude:complete') {
    console.log('\n✓ Test message completed successfully!\n');
    ws.close(1000, 'Test complete');
  } else if (message.type === 'claude:error') {
    console.error('\n✗ Claude error:', message.data.error);
    process.exit(1);
  }
});

ws.on('close', (code, reason) => {
  const duration = connectionTime ? Date.now() - connectionTime : Date.now() - startTime;
  console.log('\n========================================');
  console.log('WebSocket closed');
  console.log('========================================');
  console.log(`Code: ${code}`);
  console.log(`Reason: ${reason || 'No reason provided'}`);
  console.log(`Duration: ${duration}ms`);
  console.log(`Authenticated: ${authenticated ? 'Yes' : 'No'}`);

  // Analyze close code
  if (code === 1000) {
    console.log('\n✓ Normal closure');
  } else if (code === 1006) {
    console.log('\n✗ Abnormal closure (ECONNRESET)');
    console.log('This usually means:');
    console.log('  1. The remote service is not running');
    console.log('  2. A firewall is blocking the connection');
    console.log('  3. The service is crashing');
  } else if (code === 1008) {
    console.log('\n✗ Policy violation (authentication failed)');
  } else {
    console.log(`\n! Unexpected close code: ${code}`);
  }

  process.exit(code === 1000 ? 0 : 1);
});

ws.on('error', (error) => {
  console.error('✗ WebSocket error:', error.message);

  if (error.code === 'ECONNRESET') {
    console.error('\n  This is a connection reset error.');
    console.error('  Possible causes:');
    console.error('  - Remote service is not running');
    console.error('  - Firewall blocking the connection');
    console.error('  - Network routing issue');
  }

  process.exit(1);
});

const startTime = Date.now();

// Timeout after 30 seconds
setTimeout(() => {
  console.error('\n✗ Connection timeout (30s)');
  console.error('The server did not respond in time.');
  ws.close(1000, 'Timeout');
}, 30000);
