const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ENETUNREACH',
  'EPIPE',
  'ECONNRESET',
  'EHOSTUNREACH',
  'EAI_AGAIN',
]);

const NETWORK_ERROR_KEYWORDS = [
  'network',
  'proxy',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'SOCKS',
  'tunnel',
  'socket hang up',
  'connect ETIMEDOUT',
  'fetch failed',
  'EPROTO',
  'bad Gateway',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'certificate',
  'CERT_HAS_EXPIRED',
  'unable to verify',
  'self signed certificate',
];

export interface ClassifiedError {
  type: 'network' | 'auth' | 'config' | 'mcp' | 'unknown';
  isNetworkError: boolean;
  userMessage: string;
  technicalMessage: string;
}

export function classifyError(error: unknown): ClassifiedError {
  const err = error as Error | null;
  const message = err?.message || String(error);
  const code = (err as NodeJS.ErrnoException)?.code || '';
  const technicalMessage = message;

  // Network error classification
  if (NETWORK_ERROR_CODES.has(code) || NETWORK_ERROR_KEYWORDS.some((kw) => message.includes(kw))) {
    return {
      type: 'network',
      isNetworkError: true,
      userMessage:
        '网络连接失败，请检查网络代理配置。请前往 设置 > 网络 配置代理，或在系统环境变量中设置 HTTP_PROXY / HTTPS_PROXY。\n\nNetwork connection failed. Please check your network proxy settings. Go to Settings > Network to configure a proxy, or set HTTP_PROXY / HTTPS_PROXY in system environment variables.',
      technicalMessage,
    };
  }

  // Config error classification
  if (message.includes('No AI source configured') || message.includes('No configuration found')) {
    return { type: 'config', isNetworkError: false, userMessage: message, technicalMessage };
  }

  // Auth error classification
  if (
    message.includes('OAuth token expired') ||
    message.includes('401') ||
    message.includes('authentication_failed') ||
    message.includes('Invalid API key')
  ) {
    return { type: 'auth', isNetworkError: false, userMessage: message, technicalMessage };
  }

  // MCP error classification
  if (message.includes('Invalid MCP configuration') || message.includes('MCP server')) {
    return { type: 'mcp', isNetworkError: false, userMessage: message, technicalMessage };
  }

  return { type: 'unknown', isNetworkError: false, userMessage: message, technicalMessage };
}

export function extractNetworkErrorHint(thoughtContent: string): string | null {
  if (!thoughtContent) return null;
  const lower = thoughtContent.toLowerCase();
  if (NETWORK_ERROR_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()))) {
    return '网络连接失败，请检查网络代理配置。请前往 设置 > 网络 配置代理，或在系统环境变量中设置 HTTP_PROXY / HTTPS_PROXY。\n\nNetwork connection failed. Please check your network proxy settings. Go to Settings > Network to configure a proxy, or set HTTP_PROXY / HTTPS_PROXY in system environment variables.';
  }
  return null;
}
