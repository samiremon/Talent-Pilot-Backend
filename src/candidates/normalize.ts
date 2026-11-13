/**
 * Cleaning up emails and profile links so duplicates can be spotted.
 *
 * The same person often shows up twice: once from the web search, once from a CSV,
 * with tiny differences like "HTTPS://www.LinkedIn.com/in/sara-ahmed/?utm=x" vs
 * "linkedin.com/in/sara-ahmed". We turn both into the same "normal" form before saving,
 * and the database refuses a second candidate with the same normal email or link.
 */

/** "  Sara.Ahmed@Example.COM " -> "sara.ahmed@example.com". Returns null if it isn't an email. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  // Deliberately simple check: something@something.something, no spaces.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/**
 * Turns a profile link into one standard form:
 *   - always https, no "www."
 *   - host in lowercase
 *   - no ?tracking=params or #anchors
 *   - no trailing slash
 *   - LinkedIn paths in lowercase (LinkedIn treats them case-insensitively)
 * Returns null if the value isn't a usable http(s) link.
 */
export function normalizeProfileUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  let text = value.trim();
  // People often paste links without the scheme: "linkedin.com/in/x".
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  let path = url.pathname.replace(/\/+$/, '');
  if (host.endsWith('linkedin.com')) path = path.toLowerCase();

  return `https://${host}${path}`;
}
