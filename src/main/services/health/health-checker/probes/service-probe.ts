/**
 * Service Probe - Service responsiveness check
 *
 * Checks:
 * - OpenAI Router responsiveness
 * - HTTP Server responsiveness
 */

import type { ServiceProbeResult } from '../../types';

/**
 * Check if a local HTTP endpoint is responsive
 */
async function checkHttpEndpoint(
  url: string,
  timeout: number = 3000,
): Promise<{
  responsive: boolean;
  responseTime?: number;
  error?: string;
}> {
  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    return {
      responsive: response.ok || response.status < 500,
      responseTime: Date.now() - startTime,
    };
  } catch (error) {
    const err = error as Error;
    return {
      responsive: false,
      responseTime: Date.now() - startTime,
      error: err.name === 'AbortError' ? 'Timeout' : err.message,
    };
  }
}

/**
 * Check OpenAI Router health
 */
export async function checkOpenAIRouter(port: number): Promise<ServiceProbeResult> {
  const url = `http://127.0.0.1:${port}/health`;
  const result = await checkHttpEndpoint(url);

  return {
    name: 'service',
    healthy: result.responsive,
    severity: result.responsive ? 'info' : 'critical',
    message: result.responsive
      ? `OpenAI Router responsive (${result.responseTime}ms)`
      : `OpenAI Router not responding: ${result.error}`,
    timestamp: Date.now(),
    data: {
      serviceName: 'openai-router',
      responsive: result.responsive,
      responseTime: result.responseTime,
      error: result.error,
    },
  };
}

/**
 * Check HTTP Server health
 */
export async function checkHttpServer(port: number): Promise<ServiceProbeResult> {
  const url = `http://127.0.0.1:${port}/api/health`;
  const result = await checkHttpEndpoint(url);

  return {
    name: 'service',
    healthy: result.responsive,
    severity: result.responsive ? 'info' : 'warning',
    message: result.responsive
      ? `HTTP Server responsive (${result.responseTime}ms)`
      : `HTTP Server not responding: ${result.error}`,
    timestamp: Date.now(),
    data: {
      serviceName: 'http-server',
      responsive: result.responsive,
      responseTime: result.responseTime,
      error: result.error,
    },
  };
}
