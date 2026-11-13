/**
 * "Will this AI call fit in this minute's token budget?" check, BEFORE calling Groq.
 *
 * Groq's free tier allows a fixed number of tokens per minute per model (8,000 for the
 * chat model). The budget refills continuously: 8,000 a minute = about 133 a second.
 * After every Groq call we save what Groq said was left (see rateLimits.ts), so we can work
 * out what's available now:
 *
 *   available now = what was left at the last call + what refilled since (capped at the limit)
 *
 * If the next call needs more than that, we know how long until it fits:
 *   - a short wait (up to 25 s): just wait, then call (the recruiter sees the typing dots)
 *   - longer: stop and say clearly how long to wait, instead of failing halfway through
 *
 * Token counts are estimated from the text length (about 3.5 characters per token for
 * this mix of prose and JSON, slightly cautious) plus room for the AI's answer.
 */
import { RateLimitSnapshotModel } from './rateLimits.js';

/** Room for the AI's own answer (gpt-oss also "thinks" a little before answering). */
export const ANSWER_RESERVE_TOKENS = 400;
/** Waits up to this long are done quietly; longer ones become a clear message. */
export const MAX_QUIET_WAIT_MS = 25_000;

/** A cautious token estimate for a piece of text. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 3.5);
}

/**
 * How long until `needed` tokens fit in this minute's budget for `modelName`.
 * Returns null when we don't know yet (no call made so far), so the call just goes ahead.
 */
export async function tokenBudgetWait(modelName: string, needed: number, now = Date.now()): Promise<{ waitMs: number; limit: number } | null> {
  const snap = await RateLimitSnapshotModel.findById(modelName).lean();
  if (!snap?.limitTokens || snap.remainingTokens === undefined || snap.remainingTokens === null || !snap.updatedAt) return null;
  const limit = snap.limitTokens;
  const perMs = limit / 60_000;
  const elapsed = Math.max(0, now - new Date(snap.updatedAt).getTime());
  const available = Math.min(limit, snap.remainingTokens + elapsed * perMs);
  // Bigger than a whole minute's budget: waiting won't help; let Groq answer (it will say so).
  if (needed >= limit || available >= needed) return { waitMs: 0, limit };
  return { waitMs: Math.ceil((needed - available) / perMs), limit };
}
