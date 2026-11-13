/**
 * Token dashboard limits: reading Groq's rate-limit headers, treating a passed reset time
 * as a refilled window, and our own daily/weekly/monthly budgets.
 */
import { describe, expect, it } from 'vitest';
import { aiLimits } from '../src/activity/service.js';
import { parseDuration, rateLimitFetch, recordRateLimits, RateLimitSnapshotModel } from '../src/ai/rateLimits.js';
import { AiUsageModel } from '../src/models/aiUsage.js';
import { useTestDatabase } from './helpers/db.js';

useTestDatabase();

const MODELS = { agent: 'openai/gpt-oss-120b', bulk: 'openai/gpt-oss-20b', safety: 'openai/gpt-oss-20b' };
const AI = { mode: 'groq' as const, models: MODELS };

/** Headers exactly like Groq sends them. */
function groqHeaders(remainingRequests: number, resetRequests = '11m31.2s') {
  return new Headers({
    'x-ratelimit-limit-requests': '1000',
    'x-ratelimit-remaining-requests': String(remainingRequests),
    'x-ratelimit-reset-requests': resetRequests,
    'x-ratelimit-limit-tokens': '8000',
    'x-ratelimit-remaining-tokens': '7923',
    'x-ratelimit-reset-tokens': '577ms',
  });
}

describe('Groq rate limits', () => {
  it('reads Groq duration strings', () => {
    expect(parseDuration('11m31.2s')).toBe(691_200);
    expect(parseDuration('577ms')).toBe(577);
    expect(parseDuration('2h3m')).toBe(7_380_000);
    expect(parseDuration(null)).toBe(0);
  });

  it('notes the headers of every Groq answer passing through our fetch, per model', async () => {
    const fakeGroq = (async () => new Response('{}', { status: 200, headers: groqHeaders(992) })) as typeof fetch;
    await rateLimitFetch(fakeGroq)('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'openai/gpt-oss-120b', messages: [] }),
    });
    await new Promise((r) => setTimeout(r, 50)); // recording happens in the background
    const snap = await RateLimitSnapshotModel.findById('openai/gpt-oss-120b').lean();
    expect(snap).toMatchObject({ limitRequests: 1000, remainingRequests: 992, limitTokens: 8000, remainingTokens: 7923 });
  });

  it('shows % left per model, rounded down, and refills the bucket over time', async () => {
    const now = new Date('2026-11-13T12:00:00Z');
    await recordRateLimits('openai/gpt-oss-120b', groqHeaders(997), now);
    // 20b: 990 left, as Groq said 10 minutes ago -> about 7 requests have come back since.
    await recordRateLimits('openai/gpt-oss-20b', groqHeaders(990), new Date(now.getTime() - 10 * 60_000));
    await AiUsageModel.insertMany(
      Array.from({ length: 25 }, () => ({ task: 'chat', role: 'agent', model: 'openai/gpt-oss-120b', inputTokens: 1, outputTokens: 1, createdAt: new Date(now.getTime() - 3_600_000) })),
    );

    const result = await aiLimits(AI, {}, now);
    const big = result.models.find((m) => m.model === 'openai/gpt-oss-120b')!;
    const small = result.models.find((m) => m.model === 'openai/gpt-oss-20b')!;
    // 997 of 1000 is 99.7%: shown as 99%, never "100%" while something is used.
    expect(big.requestsToday).toMatchObject({ limit: 1000, remaining: 997, percentLeft: 99, refillSeconds: 86 });
    expect(big.callsLast24h).toBe(25);
    expect(big.usedBy).toEqual(['agent']);
    expect(small.usedBy).toEqual(['bulk', 'safety']); // one entry per model, all its roles
    // 10 minutes = 600 s / 86.4 s per request = 6 requests refilled.
    expect(small.requestsToday.remaining).toBe(996);
    // Tokens per minute: a minute later the bucket is full again.
    expect(small.tokensPerMinute).toMatchObject({ remaining: 8000, percentLeft: 100 });
  });

  it('counts tokens left today and in your own week/month budgets', async () => {
    const now = new Date('2026-11-13T12:00:00Z');
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
    await AiUsageModel.insertMany([
      { task: 'chat', role: 'agent', model: 'openai/gpt-oss-120b', inputTokens: 1500, outputTokens: 500, createdAt: hoursAgo(2) },
      { task: 'chat', role: 'agent', model: 'openai/gpt-oss-120b', inputTokens: 3000, outputTokens: 1000, createdAt: hoursAgo(72) },
      { task: 'chat', role: 'agent', model: 'openai/gpt-oss-120b', inputTokens: 9000, outputTokens: 1000, createdAt: hoursAgo(24 * 20) },
    ]);
    const result = await aiLimits(AI, { dailyTokens: 10_000, weekBudget: 12_000 }, now);
    const big = result.models.find((m) => m.model === 'openai/gpt-oss-120b')!;
    expect(big.tokensToday).toEqual({ used: 2000, limit: 10_000, remaining: 8000, percentLeft: 80 });
    expect(result.week).toEqual({ used: 6000, limit: 12_000, remaining: 6000, percentLeft: 50 });
    // No monthly budget set: usage only, no "% left" (Groq has no monthly limit).
    expect(result.month).toEqual({ used: 16_000, limit: null, remaining: null, percentLeft: null });
  });
});

describe("Groq's daily token limit: shown exactly as Groq reports it", () => {
  it('reads the refusal, and says available again after Groq accepts a call', async () => {
    const { parseDailyTokenLimit, recordDailyTokenLimit, RateLimitSnapshotModel } = await import('../src/ai/rateLimits.js');
    const info = parseDailyTokenLimit(
      'Rate limit reached for model `openai/gpt-oss-120b` on tokens per day (TPD): Limit 200000, Used 199135, Requested 2214. Please try again in 15m56s.',
    );
    expect(info).toEqual({ limit: 200_000, used: 199_135, waitMs: 956_000 });

    const now = new Date('2026-11-13T12:00:00Z');
    await RateLimitSnapshotModel.create({ _id: 'openai/gpt-oss-120b', lastOkAt: new Date(now.getTime() - 60_000) });
    await recordDailyTokenLimit('openai/gpt-oss-120b', info!, now);
    let big = (await aiLimits(AI, {}, now)).models.find((m) => m.model === 'openai/gpt-oss-120b')!;
    expect(big.dailyTokens).toMatchObject({ status: 'used_up', limit: 200_000, used: 199_135, freesAt: new Date(now.getTime() + 956_000) });

    // Later Groq answers normally again: available (no guessing about how much).
    await RateLimitSnapshotModel.updateOne({ _id: 'openai/gpt-oss-120b' }, { $set: { lastOkAt: new Date(now.getTime() + 20 * 60_000) } });
    big = (await aiLimits(AI, {}, new Date(now.getTime() + 21 * 60_000))).models.find((m) => m.model === 'openai/gpt-oss-120b')!;
    expect(big.dailyTokens).toMatchObject({ status: 'available', limit: 200_000, used: null, freesAt: null });

    // A model Groq hasn't answered for yet: unknown.
    const small = (await aiLimits(AI, {}, now)).models.find((m) => m.model !== 'openai/gpt-oss-120b')!;
    expect(small.dailyTokens.status).toBe('unknown');
  });
});
