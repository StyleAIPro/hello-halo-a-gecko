interface RendererLogger {
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
}

export function createRendererLogger(scope: string): RendererLogger {
  const isElectronMode = typeof window !== 'undefined' && 'aicoBot' in window;

  function write(level: 'info' | 'warn' | 'error', message: string, args: unknown[]): void {
    const formatted = args.length > 0 ? `${message} ${args.map(String).join(' ')}` : message;

    switch (level) {
      case 'warn':
        console.warn(`[${scope}]`, message, ...args);
        break;
      case 'error':
        console.error(`[${scope}]`, message, ...args);
        break;
      default:
        console.log(`[${scope}]`, message, ...args);
    }

    if (isElectronMode) {
      (window as Record<string, unknown>).aicoBot =
        (window as Record<string, unknown>).aicoBot ?? {};
      const api = (window as Record<string, unknown>).aicoBot as Record<string, unknown>;
      const logWrite = api.logWrite as
        | ((l: string, s: string, m: string) => Promise<void>)
        | undefined;
      logWrite?.(level, scope, formatted).catch(() => {});
    }
  }

  return {
    info: (msg, ...args) => write('info', msg, args),
    warn: (msg, ...args) => write('warn', msg, args),
    error: (msg, ...args) => write('error', msg, args),
  };
}
