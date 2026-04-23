/**
 * AI Source Provider Interface
 *
 * This interface defines the contract that all AI source providers must implement.
 * Following the Open/Closed Principle - open for extension, closed for modification.
 *
 * Each provider handles:
 * - Authentication (if needed)
 * - Configuration management
 * - Backend request configuration generation
 *
 * Design Notes:
 * - Providers are stateless services
 * - Configuration is stored externally (config service)
 * - Providers generate BackendRequestConfig for the OpenAI compat router
 */
/**
 * Type guard to check if provider supports OAuth
 */
export function isOAuthProvider(provider) {
  return 'startLogin' in provider && 'completeLogin' in provider;
}
