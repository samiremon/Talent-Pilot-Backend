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
}

export interface Ai {
  mode: 'groq' | 'mock';
  models: Record<AiRole, string>;
  structured<T>(request: StructuredRequest<T>): Promise<{ data: T; usage: TokenUsage }>;
  /** The LangChain chat model for a role (null in mock mode). The chat agent uses this. */
  chatModel(role: AiRole): ChatGroq | null;
}

/** Roughly how many tokens a text is (≈4 characters per token). Only used in mock mode. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Turns Groq failures into clear messages for the recruiter. */
function toAppError(err: unknown): AppError {
  const status = (err as { status?: number; response?: { status?: number } }).status ??
    (err as { response?: { status?: number } }).response?.status;
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
        // On "too many requests" (free tier) or a network blip, wait and retry up to 4 times,
        // waiting longer each time, before giving up.
        maxRetries: 4,
      });
      clients.set(role, client);
    }
    return client;
  }

  async function structured<T>(request: StructuredRequest<T>) {
    const { task, role, system, user, schema, mock, target } = request;
    let data: T;
    let usage: TokenUsage;

    const model = chatModel(role);
    if (!model) {
      // Mock mode: canned answer, token counts estimated so the meter still moves.
      data = schema.parse(mock());
      usage = { inputTokens: estimateTokens(system + user), outputTokens: estimateTokens(JSON.stringify(data)) };
    } else {
      try {
        // jsonSchema = Groq must answer in exactly this JSON shape (tested: works with gpt-oss).
        // includeRaw = also give us the raw reply, which carries the token counts.
        const runnable = model.withStructuredOutput(schema, { method: 'jsonSchema', includeRaw: true });
        const result = await runnable.invoke([
          { role: 'system', content: system },
          { role: 'user', content: user },
        ]);
        // Double-check the shape ourselves before trusting it.
        data = schema.parse(result.parsed);
        const meta = (result.raw as { usage_metadata?: { input_tokens?: number; output_tokens?: number } })
          .usage_metadata;
        usage = { inputTokens: meta?.input_tokens ?? 0, outputTokens: meta?.output_tokens ?? 0 };
      } catch (err) {
        throw toAppError(err);
      }
    }

    await recordUsage({ task, role, model: model ? settings.models[role] : 'mock', usage, target });
    return { data, usage };
  }

  return { mode, models: settings.models, structured, chatModel };
}
