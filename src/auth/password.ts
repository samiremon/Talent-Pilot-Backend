/**
 * Password hashing.
 *
 * We never store a recruiter's real password. Instead we store a "hash": a scrambled
 * version that can't be turned back into the password. At login we scramble what the
 * user typed the same way and compare the two results.
 *
 * We use scrypt, which is built into Node.js (no extra package). It is deliberately
 * slow and memory-hungry, so an attacker who steals the database can only try a few
 * guesses per second instead of billions.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// Node's scrypt uses callbacks; this wraps it so we can use `await`.
function scrypt(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

// Cost settings. N = how much work each hash takes (higher = slower = safer).
// 2^15 takes roughly 50-100 ms, slow for attackers but unnoticeable at login.
const N = 2 ** 15;
const r = 8;
const p = 1;
const KEY_LENGTH = 64;
// scrypt needs about 128 * N * r bytes of memory; give it a little headroom.
const MAX_MEMORY = 128 * N * r * 2;

/**
 * Turns a password into a storable string like:
 *   scrypt$32768$8$1$<salt>$<hash>
 * The settings and the random "salt" are saved alongside the hash, so we can still
 * check old passwords even if we raise the cost settings later.
 */
export async function hashPassword(password: string): Promise<string> {
  // A random salt makes two identical passwords produce different hashes.
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH, { N, r, p, maxmem: MAX_MEMORY });
  return ['scrypt', N, r, p, salt.toString('base64'), hash.toString('base64')].join('$');
}

/** Returns true if `password` matches the stored hash. Never throws on bad input. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, nText, rText, pText, saltText, hashText] = parts as [string, string, string, string, string, string];
  const cost = { N: Number(nText), r: Number(rText), p: Number(pText) };
  const salt = Buffer.from(saltText, 'base64');
  const expected = Buffer.from(hashText, 'base64');

  const actual = await scrypt(password, salt, expected.length, { ...cost, maxmem: 128 * cost.N * cost.r * 2 });

  // timingSafeEqual takes the same time whether the first or last byte differs,
  // so an attacker can't learn anything from how long the comparison took.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
