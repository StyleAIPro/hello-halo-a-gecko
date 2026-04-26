/**
 * Proxy Agent Manager
 *
 * Provides proxy configuration for all outgoing HTTP requests.
 * Reads proxy configuration from user settings (config.network),
 * falls back to environment variables (HTTPS_PROXY / HTTP_PROXY).
 *
 * Note: Does NOT use undici.ProxyAgent — it requires node:sqlite which
 * is unavailable in Electron's bundled Node.js. Proxy tunneling is
 * handled by proxy-fetch.ts using native http/https modules instead.
 */

import { getConfig } from '../config.service';

/**
 * Get the effective proxy URL from config or environment variables.
 * Priority: user config > env var > undefined (direct).
 */
function getEffectiveProxyUrl(): string | undefined {
  const config = getConfig();

  // 1. User-configured proxy (highest priority)
  if (config.network?.enabled && config.network.proxyUrl) {
    return config.network.proxyUrl.trim();
  }

  // 2. Environment variable fallback
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    undefined
  );
}

/**
 * Invalidate cached proxy state (called when config changes).
 * No-op since we read config directly each time.
 */
export function invalidateProxyCache(): void {
  // Config is read on each call, no cache to invalidate
}

/**
 * Get current proxy configuration info (for UI display).
 */
export function getProxyConfig(): { enabled: boolean; proxyUrl: string } {
  const config = getConfig();
  return {
    enabled: config.network?.enabled ?? false,
    proxyUrl: config.network?.proxyUrl ?? '',
  };
}
