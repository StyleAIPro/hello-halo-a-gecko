/**
 * Protocol Converters
 *
 * Handles conversion between:
 * - Anthropic Claude Messages API
 * - OpenAI Chat Completions API
 * - OpenAI Responses API
 */

// Request converters
export {
  convertAnthropicToOpenAIChat,
} from './request/anthropic-to-openai-chat'

export {
  convertAnthropicToOpenAIResponses,
} from './request/anthropic-to-openai-responses'

// Response converters
export {
  convertOpenAIChatToAnthropic,
  createAnthropicErrorResponse,
  mapFinishReasonToStopReason
} from './response/openai-chat-to-anthropic'

export {
  convertOpenAIResponsesToAnthropic,
  mapStatusToStopReason
} from './response/openai-responses-to-anthropic'

// Content block converters
export * from './content-blocks'

// Message converters
export * from './messages'

// Tool converters
export * from './tools'

// ============================================================================
// Backward Compatibility Aliases
// ============================================================================

import { convertAnthropicToOpenAIChat } from './request/anthropic-to-openai-chat'
import { convertOpenAIChatToAnthropic } from './response/openai-chat-to-anthropic'

import type { AnthropicRequest, OpenAIChatRequest } from '../types'

/**
 * @deprecated Use convertAnthropicToOpenAIChat instead
 */
export function convertAnthropicToOpenAI(request: AnthropicRequest): OpenAIChatRequest {
  return convertAnthropicToOpenAIChat(request).request
}

/**
 * @deprecated Use convertOpenAIChatToAnthropic instead
 */
export function convertOpenAIToAnthropic(response: any, requestModel?: string) {
  return convertOpenAIChatToAnthropic(response, requestModel)
}
