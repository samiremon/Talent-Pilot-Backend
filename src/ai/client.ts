/**
 * The AI layer's front door. Everything that talks to an AI model goes through here.
 *
 *   const ai = createAi(config.ai);          // once, at startup
 *   const { data, usage } = await ai.structured({ ...task details... });
 *
 * Two modes:
 *   - "groq": real models on Groq (when GROQ_API_KEY is set)
 *   - "mock": no key. Each task supplies a `mock()` function with a sensible sample
 *     answer, so the whole app (and the tests) work without any API key or internet.
 *
 * Three model roles (set in .env), so each job uses a model that fits it:
 *   agent   the big model: chat, reading job descriptions, writing emails
 *   bulk    a smaller, faster model: scoring many candidates, sorting replies
 *   safety  a safety model: spotting prompt-injection tricks in candidate messages
 *
 * Every call's token usage is recorded (see ai/usage.ts) for the token meter.
 */
import { ChatGroq } from '@langchain/groq';
import type { z } from 'zod';
import { AppError } from '../errors.js';
import type { AiRole } from '../models/aiUsage.js';
import { rateLimitFetch } from './rateLimits.js';
import { recordUsage, type UsageTarget } from './usage.js';

export interface AiSettings {
  apiKey?: string;
  models: Record<AiRole, string>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface StructuredRequest<T> {
  /** Short name for the token log, e.g. "extract_job". */
  task: string;
  role: AiRole;
  /** Our instructions to the model. */
  system: string;
  /** The material to work on. Untrusted text must be wrapped and labelled as data by the caller. */
  user: string;
  /** The exact shape the answer must have. Groq is forced to follow it, and we check it again. */
  schema: z.ZodType<T>;
  /** The answer to use in mock mode. */
  mock: () => T;
  /** Which job (or pending extraction) to charge the tokens to. */
  target?: UsageTarget;
  /** The recruiter who triggered this call (for the token dashboard). */
  userId?: string | null;
}

export interface Ai {
  mode: 'groq' | 'mock';
  models: Record<AiRole, string>;
  structured<T>(request: StructuredRequest<T>): Promise<{ data: T; usage: TokenUsage }>;
  /** The LangChain chat model for a role (null in mock mode). The chat agent uses this. */
  chatModel(role: AiRole): ChatGroq | null;
  /** "Check now" on the token dashboard: one tiny (1-token) call per model to refresh the
   *  rate-limit numbers. Costs 1 request per model. Does nothing in mock mode. */
  checkLimits(): Promise<void>;
}

/**
 * For a Groq "rate limit" (429) error: how long Groq asks us to wait, in ms.
 * Reads "Please try again in 15.495s" / "in 750ms" / "in 1m2.5s" from the message.
 * Returns null if this isn't a rate-limit error.
 */
export function retryAfterMs(err: unknown): number | null {
  const status = (err as { status?: number }).status ?? (err as { response?: { status?: number } }).response?.status;
  const text = err instanceof Error ? err.message : String(err);
  if (status !== 429 && !/rate limit reached/i.test(text)) return null;
  const match = /try again in ((?:\d+(?:\.\d+)?(?:ms|h|m|s))+)/i.exec(text);
  if (!match) return 5000;
  let ms = 0;
  for (const [, num, unit] of match[1]!.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    const n = Number(num);
    ms += unit === 'h' ? n * 3_600_000 : unit === 'm' ? n * 60_000 : unit === 's' ? n * 1000 : n;
  }
  return Math.round(ms);
}

/** Roughly how many tokens a text is (≈4 characters per token). Only used in mock mode. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Turns Groq failures into clear messages for the recruiter. The original error is kept as
 * `cause` (standard JavaScript), so logs can show the real reason without users seeing it.
 */
export function toAppError(err: unknown): AppError {
  const friendly = toFriendlyError(err);
  (friendly as { cause?: unknown }).cause = err;
  return friendly;
}

/** "about 18 seconds" / "about 3 minutes" / "about 2 hours" */
function roughly(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 90) return `about ${s} second${s === 1 ? '' : 's'}`;
  const m = Math.ceil(s / 60);
  if (m < 90) return `about ${m} minute${m === 1 ? '' : 's'}`;
  return `about ${Math.ceil(m / 60)} hours`;
}

/**
 * Which Groq limit was hit, from its 429 message, e.g. "... on tokens per minute (TPM):
 * Limit 8000, Used 7036, Requested 3314. Please try again in 17.625s."
 */
export function describeRateLimit(err: unknown): { kind: 'TPM' | 'TPD' | 'RPM' | 'RPD' | 'unknown'; limit: number | null; waitMs: number } | null {
  const waitMs = retryAfterMs(err);
  if (waitMs === null) return null;
  const text = err instanceof Error ? err.message : String(err);
  const kind = (/\((TPM|TPD|RPM|RPD)\)/.exec(text)?.[1] ?? 'unknown') as 'TPM' | 'TPD' | 'RPM' | 'RPD' | 'unknown';
  const limit = Number(/Limit (\d+)/.exec(text)?.[1]) || null;
  return { kind, limit, waitMs };
}

/** A clear, specific sentence for each kind of Groq limit. */
export function rateLimitMessage(info: NonNullable<ReturnType<typeof describeRateLimit>>): string {
  const wait = roughly(info.waitMs);
  const n = info.limit ? info.limit.toLocaleString('en-US') : null;
  const where = 'You can check your AI usage in Activity → Remaining usage.';
  switch (info.kind) {
    case 'TPM':
      return `You've used this minute's AI token limit${n ? ` (${n} tokens a minute on Groq's free tier)` : ''}. Please wait ${wait} and try again. ${where}`;
    case 'RPM':
      return `Too many AI requests this minute${n ? ` (limit ${n} a minute)` : ''}. Please wait ${wait} and try again. ${where}`;
    case 'TPD':
      return `The AI's daily token limit is used up${n ? ` (${n} tokens a day on Groq's free tier)` : ''}. It frees up again in ${wait}. ${where}`;
    case 'RPD':
      return `The AI's daily request limit is used up${n ? ` (${n} requests a day)` : ''}. It frees up again in ${wait}. ${where}`;
    default:
      return `The AI's usage limit was reached. Please wait ${wait} and try again. ${where}`;
  }
}

function toFriendlyError(err: unknown): AppError {
  const status = (err as { status?: number; response?: { status?: number } }).status ??
    (err as { response?: { status?: number } }).response?.status;
  const limit = describeRateLimit(err);
  if (limit) {
    return new AppError(503, 'AI_RATE_LIMIT', rateLimitMessage(limit), { kind: limit.kind, retryAfterSeconds: Math.ceil(limit.waitMs / 1000) });
  }
  if (status === 429) {
    return new AppError(503, 'AI_BUSY', 'The AI is busy right now (free-tier limit reached). Please try again in a minute.');
  }
  if (status === 401) {
    return new AppError(503, 'AI_KEY_INVALID', 'The AI key was rejected. Check GROQ_API_KEY in the backend .env file.');
  }
  return new AppError(502, 'AI_FAILED', "The AI couldn't answer this time. Please try again.");
}

export function createAi(settings: AiSettings): Ai {
  const mode = settings.apiKey ? 'groq' : 'mock';

  // One client per role, created once and reused.
  const clients = new Map<AiRole, ChatGroq>();
  function chatModel(role: AiRole): ChatGroq | null {
    if (!settings.apiKey) return null;
    let client = clients.get(role);
    if (!client) {
      client = new ChatGroq({
        apiKey: settings.apiKey,
        model: settings.models[role],
        temperature: 0, // same input -> (nearly) same answer; we want reliability, not creativity
        // Network blips / server errors: retried quickly by the SDK. Rate limits (429) are
        // handled in structured() below, waiting as long as Groq asks.
        maxRetries: 2,
        // Passes requests through unchanged, but notes Groq's rate-limit headers (see rateLimits.ts).
        fetch: rateLimitFetch(),
      });
      clients.set(role, client);
    }
    return client;
  }

  async function structured<T>(request: StructuredRequest<T>) {
    const { task, role, system, user, schema, mock, target, userId } = request;
    let data: T;
    let usage: TokenUsage;

    const model = chatModel(role);
    if (!model) {
      // Mock mode: canned answer, token counts estimated so the meter still moves.
      data = schema.parse(mock());
      usage = { inputTokens: estimateTokens(system + user), outputTokens: estimateTokens(JSON.stringify(data)) };
    } else {
      // Two Groq free-tier hiccups are handled right here, before giving up:
      //   - "json_validate_failed": the model's answer broke Groq's strict JSON check. We ask
      //     again once using Groq's other structured mode (function calling). Our own schema
      //     check below still applies, so nothing unchecked gets through.
      //   - 429 rate limit: Groq says how long to wait ("try again in 15.5s"). We wait exactly
      //     that (max 60 s) and try again, up to 3 times.
      let method: 'jsonSchema' | 'functionCalling' = 'jsonSchema';
      let rateLimitWaits = 0;
      for (;;) {
        try {
          // includeRaw = also give us the raw reply, which carries the token counts.
          const runnable = model.withStructuredOutput(schema, { method, includeRaw: true });
          const result = await runnable.invoke([
            { role: 'system', content: system },
            { role: 'user', content: user },
          ]);
          // Double-check the shape ourselves before trusting it.
          data = schema.parse(result.parsed);
          const meta = (result.raw as { usage_metadata?: { input_tokens?: number; output_tokens?: number } })
            .usage_metadata;
          usage = { inputTokens: meta?.input_tokens ?? 0, outputTokens: meta?.output_tokens ?? 0 };
          break;
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          if (method === 'jsonSchema' && text.includes('json_validate_failed')) {
            method = 'functionCalling';
            continue;
          }
          const wait = retryAfterMs(err);
          if (wait !== null && rateLimitWaits < 3) {
            rateLimitWaits++;
            await new Promise((r) => setTimeout(r, Math.min(wait + 500, 60_000)));
            continue;
          }
          throw toAppError(err);
        }
      }
    }

    await recordUsage({ task, role, model: model ? settings.models[role] : 'mock', usage, target, userId });
    return { data, usage };
  }

  async function checkLimits() {
    if (!settings.apiKey) return;
    const tracked = rateLimitFetch();
    for (const modelName of new Set(Object.values(settings.models))) {
      await tracked('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelName, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      }).catch(() => undefined); // a failing model shouldn't stop the others
    }
  }

  return { mode, models: settings.models, structured, chatModel, checkLimits };
}
