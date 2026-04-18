/**
 * AI Source Providers
 *
 * This module exports built-in provider implementations.
 * External OAuth providers are loaded dynamically via auth-loader.ts from product.json configuration.
 */

export { CustomAISourceProvider, getCustomProvider } from './custom.provider';
