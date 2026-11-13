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
 * Groq has NO weekly or monthly limit on the free tier. The DAILY TOKEN limit (e.g. 200,000
 * a day) is NOT in the headers, but when Groq refuses a call because of it, the error says
 * exactly where we stand: "... tokens per day (TPD): Limit 200000, Used 199135, ...".
 * We save exactly that (and when Groq last ACCEPTED a call), and the Remaining usage tab
 * shows it as is. We don't estimate: Groq counts in its own way, which we can't see.
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
  // When Groq last answered a call normally (= the daily limit wasn't used up then).
  lastOkAt: Date,
  // Groq's own numbers from its last "daily token limit" refusal (empty until one happens).
  limitTokensDay: Number,
  usedTokensDay: Number,
  dayRefusedAt: Date,
  // "Please try again in 15m56s" -> when Groq said it frees up again.
  dayFreesAt: Date,
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
 * "...(TPD): Limit 200000, Used 199135, Requested 2214. Please try again in 15m56s."
 * -> { limit: 200000, used: 199135, waitMs: 956000 }, or null for any other error.
 */
export function parseDailyTokenLimit(text: string): { limit: number; used: number; waitMs: number } | null {
  const match = /\(TPD\):\s*Limit (\d+), Used (\d+)/.exec(text);
  if (!match) return null;
  const wait = /try again in ((?:[\d.]+(?:ms|h|m|s))+)/i.exec(text)?.[1] ?? null;
  return { limit: Number(match[1]), used: Number(match[2]), waitMs: parseDuration(wait) };
}

/** Saves Groq's daily-limit refusal exactly as Groq stated it. */
export async function recordDailyTokenLimit(modelName: string, info: { limit: number; used: number; waitMs: number }, now = new Date()) {
  await RateLimitSnapshotModel.updateOne(
    { _id: modelName },
    {
      $set: {
        limitTokensDay: info.limit,
        usedTokensDay: info.used,
        dayRefusedAt: now,
        dayFreesAt: new Date(now.getTime() + info.waitMs),
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
    // Saved BEFORE handing the answer back (a few ms), so a "Check now" right after
    // always reads the fresh numbers. Recording problems never break the AI call.
    try {
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { model?: string }) : undefined;
      if (body?.model) {
        const modelName = body.model;
        await recordRateLimits(modelName, res.headers).catch(() => undefined);
        // Groq answered normally: the daily limit wasn't used up at this moment.
        if (res.ok) await RateLimitSnapshotModel.updateOne({ _id: modelName }, { $set: { lastOkAt: new Date() } }, { upsert: true }).catch(() => undefined);
        // Refused because of the DAILY token limit? Groq's error text says exactly where we stand.
        if (res.status === 429) {
          const daily = parseDailyTokenLimit(await res.clone().text().catch(() => ''));
          if (daily) await recordDailyTokenLimit(modelName, daily).catch(() => undefined);
        }
      }
    } catch {
      // Not JSON / no model: nothing to record.
    }
    return res;
  }) as typeof fetch;
}
