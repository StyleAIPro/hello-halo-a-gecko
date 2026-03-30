import { register } from 'node:module';

// Use a loader hook to trace which modules are loaded
const originalLoad = globalThis[Symbol.for('nodejs.util.inspect.custom')];

// Simpler approach: just try importing the entry and catch
try {
  await import('./out/main/index.mjs');
} catch (e) {
  console.error('CAUGHT:', e.message);
  console.error('Stack:', e.stack);
}
