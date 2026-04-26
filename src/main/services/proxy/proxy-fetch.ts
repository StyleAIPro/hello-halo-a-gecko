/**
 * Proxy-aware fetch wrapper
 *
 * All main-process outgoing HTTP requests should use this function
 * instead of native fetch, so proxy settings are applied automatically.
 *
 * Implementation: uses Node.js native `https`/`http` modules with manual
 * CONNECT tunnel for HTTPS proxies. This avoids undici.ProxyAgent which
 * requires node:sqlite (unavailable in Electron's bundled Node).
 */

import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';
import { getProxyConfig } from './proxy-agent';

/** Default timeout for fetch calls (ms). */
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/**
 * Make an HTTP/HTTPS request through an HTTP proxy using CONNECT tunneling.
 */
function fetchViaProxy(
  targetUrl: string,
  init?: RequestInit,
  proxyUrl: string,
  timeoutMs: number,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const proxy = new URL(proxyUrl);
    const isHttps = target.protocol === 'https:';
    const timeout = setTimeout(() => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs / 1000}s: ${targetUrl}`));
    }, timeoutMs);

    const proxyHeaders: Record<string, string> = {
      Host: `${target.hostname}:${target.port || (isHttps ? 443 : 80)}`,
    };
    if (proxy.username) {
      proxyHeaders['Proxy-Authorization'] = `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`;
    }

    const proxyReq = http.request({
      host: proxy.hostname,
      port: proxy.port || 80,
      method: 'CONNECT',
      path: `${target.hostname}:${target.port || (isHttps ? 443 : 80)}`,
      headers: proxyHeaders,
    });

    proxyReq.on('connect', (res: http.IncomingMessage, socket: any, head: Buffer) => {
      // Check CONNECT response — proxy must return 200 to establish tunnel
      if (res.statusCode !== 200) {
        clearTimeout(timeout);
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        res.on('end', () => {
          reject(new Error(`Proxy CONNECT failed (${res.statusCode}): ${body.trim() || targetUrl}`));
        });
        return;
      }

      if (isHttps) {
        // Merge any early data from the tunnel into the TLS socket
        const tlsReq = https.request(
          {
            host: target.hostname,
            port: target.port || 443,
            path: target.pathname + target.search,
            method: init?.method || 'GET',
            headers: init?.headers as Record<string, string>,
            socket,
            agent: false,
            rejectUnauthorized: false,
          },
          (tlsRes) => {
            clearTimeout(timeout);
            resolve(convertNodeResponse(tlsRes));
          },
        );
        tlsReq.on('error', (err: Error) => {
          clearTimeout(timeout);
          reject(err);
        });
        if (init?.body) {
          tlsReq.write(typeof init.body === 'string' ? init.body : String(init.body));
        }
        tlsReq.end();
      } else {
        const httpReq = http.request(
          {
            host: target.hostname,
            port: target.port || 80,
            path: target.pathname + target.search,
            method: init?.method || 'GET',
            headers: init?.headers as Record<string, string>,
            socket,
            agent: false,
          },
          (httpRes) => {
            clearTimeout(timeout);
            resolve(convertNodeResponse(httpRes));
          },
        );
        httpReq.on('error', (err: Error) => {
          clearTimeout(timeout);
          reject(err);
        });
        if (init?.body) {
          httpReq.write(typeof init.body === 'string' ? init.body : String(init.body));
        }
        httpReq.end();
      }
    });

    proxyReq.on('error', (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });

    const req = proxyReq;
    proxyReq.end();
  });
}

/**
 * Convert a Node.js http.IncomingMessage to a Web Response-like object.
 */
function convertNodeResponse(nodeRes: http.IncomingMessage): Response {
  const status = nodeRes.statusCode || 200;
  const statusText = nodeRes.statusMessage || '';
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeRes.headers)) {
    if (value) {
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v);
      } else {
        headers.append(key, value);
      }
    }
  }

  // Collect body chunks
  const chunks: Buffer[] = [];
  nodeRes.on('data', (chunk: Buffer) => chunks.push(chunk));

  return new Response(
    new ReadableStream({
      start(controller) {
        nodeRes.on('data', (chunk: Buffer) => {
          controller.enqueue(new Uint8Array(chunk));
        });
        nodeRes.on('end', () => controller.close());
        nodeRes.on('error', (err: Error) => controller.error(err));
      },
    }),
    { status, statusText, headers },
  );
}

/**
 * Fetch through a specific proxy URL (for testing).
 * Bypasses config — always routes through the given proxyUrl.
 */
export async function proxyFetchWithUrl(
  url: string,
  init: RequestInit | undefined,
  proxyUrl: string,
  timeoutMs: number,
): Promise<Response> {
  return fetchViaProxy(url, init, proxyUrl, timeoutMs);
}

/**
 * Fetch with automatic proxy support.
 * When a proxy is configured and enabled, routes through the proxy.
 * Otherwise, uses native fetch (direct connection).
 */
export async function proxyFetch(
  url: string,
  init?: RequestInit,
  timeoutMs?: number,
): Promise<Response> {
  const timeout = timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const proxyConfig = getProxyConfig();

  if (proxyConfig.enabled && proxyConfig.proxyUrl) {
    return fetchViaProxy(url, init, proxyConfig.proxyUrl, timeout);
  }

  // No proxy configured — use native fetch with timeout
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    return response;
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeout / 1000}s: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
