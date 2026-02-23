/**
 * platform/background/partition -- Domain-level partition extraction
 *
 * Extracts the main domain from a URL and converts it to an Electron
 * session partition string: `persist:automation-{domain}`
 *
 * This partition naming convention is shared across modules. Other code
 * depends on this exact format for cookie/session lookups.
 */

/**
 * Known two-part TLD suffixes.
 * When the domain ends with one of these, we need three labels (e.g. "example.co.uk").
 * This list covers the most common cases for automation targets.
 * Kept intentionally small to avoid pulling in a large dependency like `psl`.
 */
const TWO_PART_TLDS = new Set([
  'co.uk', 'co.jp', 'co.kr', 'co.in', 'co.nz', 'co.za', 'co.id', 'co.th',
  'com.au', 'com.br', 'com.cn', 'com.hk', 'com.mx', 'com.my', 'com.sg',
  'com.tw', 'com.ar', 'com.tr', 'com.co', 'com.ph', 'com.pk', 'com.pe',
  'com.vn', 'com.ua', 'com.ng', 'com.eg', 'com.sa', 'com.bd',
  'net.au', 'net.br', 'net.cn', 'net.nz',
  'org.au', 'org.uk', 'org.cn', 'org.nz', 'org.hk', 'org.tw',
  'ac.uk', 'ac.jp', 'ac.kr', 'ac.in',
  'gov.uk', 'gov.au', 'gov.cn', 'gov.in',
  'edu.au', 'edu.cn', 'edu.hk',
  'ne.jp', 'or.jp', 'go.jp',
])

/**
 * IPv4 address pattern (simple check).
 */
const IPV4_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

/**
 * IPv6 address pattern (enclosed in brackets in URLs, but hostname strips them).
 */
const IPV6_REGEX = /^[\da-fA-F:]+$/

/**
 * Extract the main domain from a hostname string.
 *
 * Examples:
 *   "item.jd.com"     -> "jd.com"
 *   "www.taobao.com"  -> "taobao.com"
 *   "example.co.uk"   -> "example.co.uk"
 *   "192.168.1.1"     -> "192.168.1.1"
 *   "localhost"        -> "localhost"
 *
 * @param hostname - The hostname (no protocol, no port, no path)
 * @returns The main domain string
 */
export function extractMainDomain(hostname: string): string {
  // Strip leading www.
  const host = hostname.replace(/^www\./, '')

  // IP addresses: use as-is
  if (IPV4_REGEX.test(host) || IPV6_REGEX.test(host)) {
    return host
  }

  const parts = host.split('.')

  // Single label (e.g. "localhost") or two labels (e.g. "jd.com")
  if (parts.length <= 2) {
    return host
  }

  // Check for two-part TLD
  const lastTwo = parts.slice(-2).join('.')
  if (TWO_PART_TLDS.has(lastTwo)) {
    // Need at least 3 parts for a valid domain with two-part TLD
    if (parts.length >= 3) {
      return parts.slice(-3).join('.')
    }
    return host
  }

  // Default: last two parts
  return parts.slice(-2).join('.')
}

/**
 * Extract the Electron session partition string from a URL.
 *
 * Format: `persist:automation-{mainDomain}`
 *
 * Examples:
 *   "https://item.jd.com/12345"       -> "persist:automation-jd.com"
 *   "https://www.taobao.com/search"   -> "persist:automation-taobao.com"
 *   "http://192.168.1.1:8080/api"     -> "persist:automation-192.168.1.1"
 *   "https://shop.example.co.uk/foo"  -> "persist:automation-example.co.uk"
 *
 * @param url - The full URL string
 * @returns The partition string, or a fallback partition if the URL is invalid
 */
export function extractPartition(url: string): string {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname
    if (!hostname) {
      return 'persist:automation-unknown'
    }
    const mainDomain = extractMainDomain(hostname)
    return `persist:automation-${mainDomain}`
  } catch {
    // Invalid URL -- use a safe fallback
    console.warn(`[Background] Failed to parse URL for partition extraction: ${url}`)
    return 'persist:automation-unknown'
  }
}
