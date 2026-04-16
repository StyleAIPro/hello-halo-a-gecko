/**
 * Provider Adapters
 *
 * Handles provider-specific request/response transformations.
 * Each adapter encapsulates the quirks and requirements of a specific LLM provider.
 *
 * Design principles:
 * - Single Responsibility: Each adapter handles one provider
 * - Open/Closed: Easy to add new adapters without modifying existing code
 * - URL-based detection: Consistent with the rest of the codebase
 */

// ============================================================================
// Types
// ============================================================================

export interface ProviderAdapter {
  /** Unique identifier for this adapter */
  readonly id: string;

  /** Human-readable name */
  readonly name: string;

  /** Check if this adapter should handle the given URL */
  match(url: string): boolean;

  /**
   * Transform request body before sending to provider
   * Mutates the body in place for efficiency
   */
  transformRequest?(body: Record<string, unknown>): void;

  /**
   * Get additional headers to include in the request
   * These headers are merged with existing headers (adapter headers take precedence)
   */
  getExtraHeaders?(): Record<string, string>;
}

// ============================================================================
// Groq Adapter
// ============================================================================

/**
 * Groq requires temperature > 0
 *
 * When temperature is exactly 0, Groq API returns an error.
 * We convert 0 to 0.01 which is effectively deterministic but valid.
 *
 * @see https://console.groq.com/docs/api-reference#chat-create
 */
const groqAdapter: ProviderAdapter = {
  id: 'groq',
  name: 'Groq',

  match(url: string): boolean {
    return url.includes('api.groq.com');
  },

  transformRequest(body: Record<string, unknown>): void {
    if (body.temperature === 0) {
      body.temperature = 0.01;
    }
  },
};

// ============================================================================
// OpenRouter Adapter
// ============================================================================

/**
 * OpenRouter recommends app attribution headers
 *
 * These headers are optional but provide:
 * - App appears in OpenRouter leaderboard
 * - Request analytics show app name instead of "Unknown"
 *
 * @see https://openrouter.ai/docs/app-attribution
 */
const openRouterAdapter: ProviderAdapter = {
  id: 'openrouter',
  name: 'OpenRouter',

  match(url: string): boolean {
    return url.includes('openrouter.ai');
  },

  getExtraHeaders(): Record<string, string> {
    return {
      'HTTP-Referer': 'https://hello-halo.cc/',
      'X-Title': 'AICO-Bot',
    };
  },
};

// ============================================================================
// DeepSeek Adapter
// ============================================================================

/**
 * DeepSeek R1 models return reasoning in `reasoning_content` field
 *
 * Note: The actual reasoning_content handling is done in the stream handler
 * (openai-chat-stream.ts) since it's a response transformation.
 * This adapter is here for documentation and potential future request transforms.
 *
 * @see https://api-docs.deepseek.com/
 */
const deepSeekAdapter: ProviderAdapter = {
  id: 'deepseek',
  name: 'DeepSeek',

  match(url: string): boolean {
    return url.includes('api.deepseek.com');
  },

  // No request transformation needed
  // Response handling is in openai-chat-stream.ts (delta.reasoning_content)
};

// ============================================================================
// Registry
// ============================================================================

/**
 * All registered provider adapters
 * Order matters: first matching adapter wins
 */
const adapters: readonly ProviderAdapter[] = [groqAdapter, openRouterAdapter, deepSeekAdapter];

/**
 * Find the adapter that matches the given URL
 */
export function findAdapter(url: string): ProviderAdapter | undefined {
  return adapters.find((adapter) => adapter.match(url));
}

/**
 * Apply provider-specific transformations to request
 *
 * @param url - Target API URL
 * @param body - Request body (will be mutated if adapter has transformRequest)
 * @param headers - Request headers (adapter headers will be merged)
 * @returns The adapter that was applied, or undefined if none matched
 */
export function applyProviderAdapter(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
): ProviderAdapter | undefined {
  const adapter = findAdapter(url);

  if (!adapter) {
    return undefined;
  }

  // Apply request transformation
  if (adapter.transformRequest) {
    adapter.transformRequest(body);
  }

  // Merge extra headers (adapter headers take precedence)
  const extraHeaders = adapter.getExtraHeaders?.();
  if (extraHeaders) {
    Object.assign(headers, extraHeaders);
  }

  return adapter;
}

// ============================================================================
// Exports
// ============================================================================

export { groqAdapter, openRouterAdapter, deepSeekAdapter };
