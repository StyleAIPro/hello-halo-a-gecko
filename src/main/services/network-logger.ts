import log from 'electron-log/main.js';

const API_URL_PATTERNS = [
  /^https?:\/\/api\.anthropic\.com/,
  /^https?:\/\/api\.openai\.com/,
  /^https?:\/\/gitcode\.com\/api/,
  /^https?:\/\/api\.github\.com/,
  /^https?:\/\/localhost/,
  /\/api\//,
];

const STATIC_EXT = /\.(js|css|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|map)$/i;

function isApiRequest(url: string): boolean {
  if (STATIC_EXT.test(new URL(url).pathname)) return false;
  return API_URL_PATTERNS.some((p) => p.test(url));
}

const requestTimings = new Map<string, number>();

export function setupNetworkLogger(session: Electron.Session): void {
  session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details) => {
    if (!isApiRequest(details.url)) return;
    requestTimings.set(details.id.toString(), Date.now());
  });

  session.webRequest.onCompleted({ urls: ['<all_urls>'] }, (details) => {
    if (!isApiRequest(details.url)) return;
    const startTime = requestTimings.get(details.id.toString());
    requestTimings.delete(details.id.toString());
    const duration = startTime ? Date.now() - startTime : -1;

    const timing = duration >= 0 ? ` (${duration}ms)` : '';
    log.info(`[Network] ${details.method} ${details.url} → ${details.statusCode}${timing}`);
  });

  session.webRequest.onErrorOccurred({ urls: ['<all_urls>'] }, (details) => {
    if (!isApiRequest(details.url)) return;
    requestTimings.delete(details.id.toString());
    log.warn(`[Network] ${details.method} ${details.url} FAILED ${details.error}`);
  });
}
