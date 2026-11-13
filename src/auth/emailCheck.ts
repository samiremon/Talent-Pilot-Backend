/**
 * "Is this email address real?" check used at sign-up.
 *
 * Two steps:
 *   1. FORMAT: looks like name@domain.tld (no spaces, one @, a dot in the domain).
 *   2. DOMAIN: asks the internet's phone book (DNS) whether the domain can receive mail
 *      (it has an MX record, or at least an address). This catches typos like
 *      "rahim@gmial.com", and we suggest the likely fix ("Did you mean gmail.com?").
 *
 * We can't know if the MAILBOX itself exists without sending an email, so that part is
 * left to the user. If DNS itself is unreachable (offline), we don't block sign-up:
 * a broken network shouldn't lock people out.
 *
 * Returns null when OK, or a friendly error message.
 */
import { promises as dns } from 'node:dns';
import { z } from 'zod';

export type EmailChecker = (email: string) => Promise<string | null>;

// Common typos of popular email providers.
const TYPO_FIXES: Record<string, string> = {
  'gmial.com': 'gmail.com',
  'gmai.com': 'gmail.com',
  'gamil.com': 'gmail.com',
  'gmail.co': 'gmail.com',
  'gmail.con': 'gmail.com',
  'gnail.com': 'gmail.com',
  'hotmial.com': 'hotmail.com',
  'hotmai.com': 'hotmail.com',
  'yaho.com': 'yahoo.com',
  'yahoo.co': 'yahoo.com',
  'outlok.com': 'outlook.com',
  'outloo.com': 'outlook.com',
  'iclod.com': 'icloud.com',
};

/** Format check only (no network). */
export function emailFormatError(email: string): string | null {
  return z.email().safeParse(email).success ? null : 'This email address is not valid. Please check it.';
}

/** DNS error codes that mean "this domain doesn't exist / has no such record". */
const NOT_FOUND = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'ENONAME']);

/** Real check: format + DNS. Pass `resolver` in tests to avoid real network calls. */
export function createEmailChecker(resolver: Pick<typeof dns, 'resolveMx' | 'resolve4' | 'resolve6'> = dns): EmailChecker {
  return async (email) => {
    const formatError = emailFormatError(email);
    if (formatError) return formatError;

    const domain = email.split('@')[1]!.toLowerCase();
    const suggestion = TYPO_FIXES[domain];
    const notFound = `We couldn't find the email domain "${domain}".${suggestion ? ` Did you mean ${suggestion}?` : ' Please check for typos.'}`;
    if (suggestion) return notFound;

    try {
      const mx = await withTimeout(resolver.resolveMx(domain), 4000);
      // A "null MX" (exchange ".") means the domain says it never accepts email.
      if (mx.length > 0) {
        return mx.every((r) => r.exchange === '' || r.exchange === '.')
          ? `The domain "${domain}" does not accept email. Please use another address.`
          : null;
      }
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (!code || !NOT_FOUND.has(code)) return null; // DNS trouble/timeout: don't block the user
    }

    // No MX record: by the email rules, a plain address record also works.
    for (const lookup of [resolver.resolve4, resolver.resolve6]) {
      try {
        if ((await withTimeout(lookup(domain), 4000)).length > 0) return null;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (!code || !NOT_FOUND.has(code)) return null;
      }
    }
    return notFound;
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), ms)),
  ]);
}
