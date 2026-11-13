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

  it('shows % left per model, and a full window once the reset time has passed', async () => {
    const now = new Date('2026-11-13T12:00:00Z');
    await recordRateLimits('openai/gpt-oss-120b', groqHeaders(250), now);
    await recordRateLimits('openai/gpt-oss-20b', groqHeaders(10, '1s'), new Date(now.getTime() - 60_000)); // reset long passed

    const result = await aiLimits(AI, {}, now);
    const big = result.models.find((m) => m.model === 'openai/gpt-oss-120b')!;
    const small = result.models.find((m) => m.model === 'openai/gpt-oss-20b')!;
    expect(big.requestsToday).toMatchObject({ limit: 1000, remaining: 250, percentLeft: 25 });
    expect(big.usedBy).toEqual(['agent']);
    expect(small.usedBy).toEqual(['bulk', 'safety']); // one entry per model, all its roles
    expect(small.requestsToday).toMatchObject({ remaining: 1000, percentLeft: 100 }); // refilled
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
