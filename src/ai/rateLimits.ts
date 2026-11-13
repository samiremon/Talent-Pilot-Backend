/**
 * Groq's free-tier limits, read live from Groq's own answers.
 *
 * Every reply from Groq carries headers like:
 *   x-ratelimit-limit-requests: 1000      requests allowed per DAY (for this model)
 *   x-ratelimit-remaining-requests: 992   requests left today
 *   x-ratelimit-reset-requests: 11m31.2s  when one more request frees up
 *   x-ratelimit-limit-tokens: 8000        tokens allowed per MINUTE
 *   x-ratelimit-remaining-tokens: 7923    tokens left this minute
 *   x-ratelimit-reset-tokens: 577ms       when the minute window refills
 *
 * We hand ChatGroq our own `fetch` (rateLimitFetch below) that passes every request
 * through unchanged and just notes these headers per model. Costs nothing extra.
 * The latest numbers are saved in MongoDB, so they survive restarts and any process
 * (API or background worker) sees the same picture.
 *
 * Groq has NO weekly or monthly limit on the free tier, and doesn't report the daily
 * TOKEN limit in headers: the dashboard handles those with optional budgets from .env.
 */
import { Schema, model } from 'mongoose';

const snapshotSchema = new Schema({
  _id: { type: String, required: true }, // the model name, e.g. "openai/gpt-oss-120b"
  limitRequests: Number,
  remainingRequests: Number,
  resetRequestsAt: Date,
  limitTokens: Number,
  remainingTokens: Number,
  resetTokensAt: Date,
  updatedAt: Date,
});
export const RateLimitSnapshotModel = model('RateLimitSnapshot', snapshotSchema);

/** "11m31.2s" -> 691200, "577ms" -> 577, "2h3m" -> 7380000. Unknown -> 0. */
export function parseDuration(text: string | null): number {
  if (!text) return 0;
  let ms = 0;
  for (const [, num, unit] of text.matchAll(/([\d.]+)(ms|h|m|s)/g)) {
    const n = Number(num);
    ms += unit === 'h' ? n * 3_600_000 : unit === 'm' ? n * 60_000 : unit === 's' ? n * 1000 : n;
  }
  return Math.round(ms);
}

/** Saves the limit headers of one Groq response (ignored if they're missing). */
export async function recordRateLimits(modelName: string, headers: Headers, now = new Date()): Promise<void> {
  const num = (name: string) => {
    const v = headers.get(name);
    return v === null || v === '' || Number.isNaN(Number(v)) ? undefined : Number(v);
  };
  const limitRequests = num('x-ratelimit-limit-requests');
  const limitTokens = num('x-ratelimit-limit-tokens');
  if (limitRequests === undefined && limitTokens === undefined) return;

  await RateLimitSnapshotModel.updateOne(
    { _id: modelName },
    {
      $set: {
        limitRequests,
        remainingRequests: num('x-ratelimit-remaining-requests'),
        resetRequestsAt: new Date(now.getTime() + parseDuration(headers.get('x-ratelimit-reset-requests'))),
        limitTokens,
        remainingTokens: num('x-ratelimit-remaining-tokens'),
        resetTokensAt: new Date(now.getTime() + parseDuration(headers.get('x-ratelimit-reset-tokens'))),
        updatedAt: now,
      },
    },
    { upsert: true },
  );
}

/**
 * A drop-in `fetch` for ChatGroq: does the real request, then notes the limit headers.
 * Recording problems never break the AI call.
 */
export function rateLimitFetch(baseFetch: typeof fetch = fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await baseFetch(input, init);
    try {
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { model?: string }) : undefined;
      if (body?.model) void recordRateLimits(body.model, res.headers).catch(() => undefined);
    } catch {
      // Not JSON / no model: nothing to record.
    }
    return res;
  }) as typeof fetch;
}
