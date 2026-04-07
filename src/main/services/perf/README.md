# Performance Monitoring

Real-time performance monitoring for main and renderer processes.

## Usage

```javascript
// In renderer DevTools Console
await window.aicoBot.perfStart()   // Start monitoring
await window.aicoBot.perfStop()    // Stop monitoring
```

## Output

```
[Perf] Main: Heap 12.3MB | RSS 143.0MB | CPU 0.2% | Views 1 | IPC 5 (slow: 0) || Renderer: FPS 60 | Frame 16.7ms | Renders 0 | DOM 1228 | Heap 33.2MB | LongTasks 0
```

## Metrics

| Process | Metric | Description |
|---------|--------|-------------|
| Main | Heap | V8 heap memory |
| Main | RSS | Process total memory |
| Main | CPU | CPU usage % |
| Main | Views | BrowserView count |
| Main | IPC | IPC call count |
| Renderer | FPS | Frame rate |
| Renderer | Frame | Avg frame time |
| Renderer | DOM | DOM node count |
| Renderer | Heap | JS heap memory |
| Renderer | LongTasks | Tasks > 50ms |

## Options

```javascript
await window.aicoBot.perfStart({
  sampleInterval: 2000,    // Sample interval (ms)
  warnOnThreshold: true    // Warn when threshold exceeded
})
```

## Other APIs

```javascript
await window.aicoBot.perfGetState()     // Get current state
await window.aicoBot.perfClearHistory() // Clear history
await window.aicoBot.perfExport()       // Export as JSON
```
