/**
 * API Type Resolution
 *
 * Determines which OpenAI wire API format to use based on URL suffix.
 * No inference, no override - URL is the single source of truth.
 */

import type { OpenAIWireApiType } from '../types'

/**
 * Valid endpoint suffixes
 */
const VALID_ENDPOINTS = {
  chat_completions: '/chat/completions',
  responses: '/responses'
} as const

/**
 * Get API type from URL suffix
 * Defaults to 'chat_completions' for URLs without a known suffix,
 * since most OpenAI-compatible backends use the Chat Completions format.
 */
export function getApiTypeFromUrl(url: string): 'chat_completions' | 'responses' {
  if (url.endsWith('/chat/completions')) return 'chat_completions'
  if (url.endsWith('/responses')) return 'responses'
  return 'chat_completions'
}

/**
 * Validate that URL is a valid HTTPS endpoint
 */
export function isValidEndpointUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * Get validation error message for invalid URL
 */
export function getEndpointUrlError(url: string): string {
  return `Invalid endpoint URL: ${url}

Please provide a valid HTTP(S) URL. Examples:
  - https://api.openai.com/v1/chat/completions
  - https://api.openai.com/v1/responses
  - https://your-proxy.example.com/anthropic`
}

/**
 * Check if stream should be forced on (from environment variable)
 */
export function shouldForceStream(): boolean {
  const envValue = process.env.HALO_OPENAI_FORCE_STREAM
  return envValue === '1' || envValue === 'true' || envValue === 'yes'
}
