/**
 * Settings.
 *
 * All settings come from environment variables (the .env file locally, docker-compose.yml
 * in Docker). This file reads them ONCE at startup, checks every value, and turns them
 * into a typed `Config` object the rest of the code uses.
 *
 * If anything is missing or wrong, the server refuses to start and prints every problem
 * at once. Failing loudly at startup beats crashing later in the middle of a request.
 */
import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { LogLevel } from './logger.js';

/** Comma-separated list of URLs, e.g. "http://a.com,http://b.com". */
const originList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.url({ protocol: /^https?$/ })).min(1, 'needs at least one origin'));

/** "true" / "false" text from .env turned into a real boolean. */
const booleanText = z.enum(['true', 'false']).transform((value) => value === 'true');

/** Treat `SOME_VAR=` (set but empty) the same as not set at all. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

// The rules for every setting. `.default(...)` = value used when the setting is absent.
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  CORS_ORIGINS: originList.default(['http://localhost:5173']),
  MONGODB_URI: z
    .string({ error: 'is required (see .env.example)' })
    .regex(/^mongodb(\+srv)?:\/\//, 'must start with mongodb:// or mongodb+srv://'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Redis, for the background-job queue (BullMQ). Docker sets this itself. Empty = no
  // Redis: background tasks then run inside the API process (fine for a quick local try).
  REDIS_URL: optional(z.string().regex(/^rediss?:\/\//, 'must start with redis:// or rediss://')),

  // --- Login ---
  // How many hours a login lasts before the recruiter must log in again.
  SESSION_TTL_HOURS: z.coerce.number().positive().max(24 * 30).default(12),
  // Send the login cookie only over HTTPS. Defaults to on in production; the Docker
  // setup turns it off because the demo runs on plain http://localhost.
  COOKIE_SECURE: optional(booleanText),
  // How many proxies sit in front of the API (nginx in Docker = 1). Needed so the
  // login rate limit sees each visitor's real IP instead of nginx's.
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),

  // --- Recruiter account created on first start (both optional) ---
  SEED_RECRUITER_EMAIL: optional(z.email('must be a valid email')),
  SEED_RECRUITER_PASSWORD: optional(z.string().min(8, 'must be at least 8 characters')),
  SEED_RECRUITER_NAME: z.string().trim().min(1).default('Recruiter'),

  // --- Accounts ---
  // Where people open the app (used in emailed links and for the Google redirect).
  // `npm run dev` = http://localhost:5173, Docker = http://localhost:8080.
  APP_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:5173'),
  // Let new people create accounts with the Sign up page.
  ALLOW_SIGNUP: booleanText.default(true),
  // "Continue with Google" (optional, both or neither). See README for the 2-minute setup.
  GOOGLE_CLIENT_ID: optional(z.string().trim().min(10)),
  GOOGLE_CLIENT_SECRET: optional(z.string().trim().min(10)),

  // --- Email ---
  // Default = Mailpit, the fake inbox in Docker (read mail at http://localhost:8025).
  // Put a real provider's SMTP details here to send real emails.
  // Left empty in .env = Mailpit (localhost:1025 for npm run dev; Docker uses its mailpit container).
  SMTP_HOST: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().min(1).default('localhost')),
  SMTP_PORT: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(1).max(65535).default(1025)),
  SMTP_SECURE: booleanText.default(false),
  SMTP_USER: optional(z.string()),
  SMTP_PASS: optional(z.string()),
  EMAIL_FROM: z.string().trim().min(3).default('TalentPilot <no-reply@talentpilot.local>'),

  // --- AI ---
  // Groq API key (free at https://console.groq.com/keys). Empty = "mock mode":
  // the app still works end to end with built-in sample answers, no key needed.
  // Outreach emails. "sandbox" (default) = every outreach email goes to Mailpit, the fake
  // inbox (http://localhost:8025): no real candidate gets mail. "live" = real sending with
  // the SMTP_* settings above. Switch only when you really mean to email candidates.
  OUTREACH_MODE: z.enum(['sandbox', 'live']).default('sandbox'),
  OUTREACH_SANDBOX_SMTP_HOST: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().min(1).default('localhost')),
  OUTREACH_SANDBOX_SMTP_PORT: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(1).max(65535).default(1025)),
  // At most this many outreach emails in any 24 hours (all jobs together).
  OUTREACH_DAILY_LIMIT: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(1).max(10_000).default(50)),
  // How long "one day" is for follow-ups (Day 3, Day 7). 86400 = a real day; set e.g. 60 in
  // a demo so the follow-ups arrive within minutes.
  OUTREACH_DAY_SECONDS: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(1).default(86_400)),
  // Serper (Google search API) for finding candidates on the web. Blank = sample mode.
  SERPER_API_KEY: optional(z.string().trim().min(20, 'looks too short (copy it from serper.dev)')),
  GROQ_API_KEY: optional(z.string().trim().startsWith('gsk_', 'must start with gsk_ (copy it from console.groq.com/keys)')),
  // Which model does which job. Change these to try other Groq models.
  AI_MODEL_AGENT: z.string().trim().min(1).default('openai/gpt-oss-120b'), // chat, reading JDs, writing emails
  AI_MODEL_BULK: z.string().trim().min(1).default('openai/gpt-oss-20b'), // scoring many candidates, sorting replies
  AI_MODEL_SAFETY: z.string().trim().min(1).default('openai/gpt-oss-safeguard-20b'), // spotting prompt-injection tricks
  // --- Token dashboard limits (all optional) ---
  // Groq's daily TOKEN limit per model isn't sent in its replies; copy it from
  // https://console.groq.com/settings/limits ("TPD") to see "tokens left today".
  AI_DAILY_TOKEN_LIMIT: optional(z.coerce.number().int().positive()),
  // Groq has no weekly/monthly limit; set your own team budgets to see "% left".
  AI_TOKEN_BUDGET_WEEK: optional(z.coerce.number().int().positive()),
  AI_TOKEN_BUDGET_MONTH: optional(z.coerce.number().int().positive()),
  // DEMO ONLY: lets the login page show a "Use demo account" button that fills in the
  // recruiter email and password above. Anyone who can open the site can then log in,
  // so keep this off for anything real.
  DEMO_LOGIN_ENABLED: optional(booleanText),
});

/** The checked settings, in the shape the rest of the code uses. */
export type Config = {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  corsOrigins: string[];
  logLevel: LogLevel;
  mongodbUri: string;
  /** undefined = run background tasks inside the API process. */
  redisUrl?: string;
  sessionTtlHours: number;
  cookieSecure: boolean;
  trustProxy: number;
  /** Present only when both the email and the password are set. */
  seedRecruiter?: { email: string; password: string; name: string };
  /** Show the "Use demo account" button (only possible when seedRecruiter is set). */
  demoLoginEnabled: boolean;
  appUrl: string;
  allowSignup: boolean;
  /** "Continue with Google"; undefined = turned off. */
  google?: { clientId: string; clientSecret: string; appUrl: string };
  smtp: { host: string; port: number; secure: boolean; user?: string; pass?: string; from: string };
  /** AI settings. `apiKey` undefined = mock mode. */
  ai: { apiKey?: string; models: { agent: string; bulk: string; safety: string } };
  /** Outreach emails: where they go, how many a day, how long a "day" is. */
  outreach: { mode: 'sandbox' | 'live'; sandboxHost: string; sandboxPort: number; dailyLimit: number; daySeconds: number };
  /** Web search for candidates. `serperKey` undefined = sample mode. */
  search: { serperKey?: string };
  /** Optional limits shown on the token dashboard. */
  aiLimits: { dailyTokens?: number; weekBudget?: number; monthBudget?: number };
};

/**
 * Checks raw environment variables and returns typed settings.
 * Throws one error listing every problem, so a bad setup fails fast with a clear message.
 */
export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid settings, the server cannot start:\n${problems}`);
  }
  const e = result.data;

  if (Boolean(e.GOOGLE_CLIENT_ID) !== Boolean(e.GOOGLE_CLIENT_SECRET)) {
    throw new Error(
      'Invalid settings, the server cannot start:\n' +
        '  - GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET: set both or neither',
    );
  }

  // Setting only one of the two seed values is almost certainly a mistake: say so.
  if (Boolean(e.SEED_RECRUITER_EMAIL) !== Boolean(e.SEED_RECRUITER_PASSWORD)) {
    throw new Error(
      'Invalid settings, the server cannot start:\n' +
        '  - SEED_RECRUITER_EMAIL / SEED_RECRUITER_PASSWORD: set both or neither',
    );
  }

  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    corsOrigins: e.CORS_ORIGINS,
    logLevel: e.LOG_LEVEL,
    mongodbUri: e.MONGODB_URI,
    redisUrl: e.REDIS_URL,
    sessionTtlHours: e.SESSION_TTL_HOURS,
    cookieSecure: e.COOKIE_SECURE ?? e.NODE_ENV === 'production',
    trustProxy: e.TRUST_PROXY,
    // The button needs credentials to fill in, so it's off when no seed account is set.
    demoLoginEnabled: (e.DEMO_LOGIN_ENABLED ?? false) && Boolean(e.SEED_RECRUITER_EMAIL && e.SEED_RECRUITER_PASSWORD),
    appUrl: e.APP_URL.replace(/\/$/, ''),
    allowSignup: e.ALLOW_SIGNUP,
    google:
      e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET
        ? { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET, appUrl: e.APP_URL.replace(/\/$/, '') }
        : undefined,
    smtp: {
      host: e.SMTP_HOST,
      port: e.SMTP_PORT,
      secure: e.SMTP_SECURE,
      user: e.SMTP_USER,
      pass: e.SMTP_PASS,
      from: e.EMAIL_FROM,
    },
    aiLimits: { dailyTokens: e.AI_DAILY_TOKEN_LIMIT, weekBudget: e.AI_TOKEN_BUDGET_WEEK, monthBudget: e.AI_TOKEN_BUDGET_MONTH },
    search: { serperKey: e.SERPER_API_KEY },
    outreach: {
      mode: e.OUTREACH_MODE,
      sandboxHost: e.OUTREACH_SANDBOX_SMTP_HOST,
      sandboxPort: e.OUTREACH_SANDBOX_SMTP_PORT,
      dailyLimit: e.OUTREACH_DAILY_LIMIT,
      daySeconds: e.OUTREACH_DAY_SECONDS,
    },
    ai: {
      apiKey: e.GROQ_API_KEY,
      models: { agent: e.AI_MODEL_AGENT, bulk: e.AI_MODEL_BULK, safety: e.AI_MODEL_SAFETY },
    },
    seedRecruiter:
      e.SEED_RECRUITER_EMAIL && e.SEED_RECRUITER_PASSWORD
        ? { email: e.SEED_RECRUITER_EMAIL, password: e.SEED_RECRUITER_PASSWORD, name: e.SEED_RECRUITER_NAME }
        : undefined,
  };
}

/** Loads `.env` (if present, outside production) and returns checked settings. */
export function loadConfig(): Config {
  // Variables already set in the terminal win over .env (loadEnvFile never overwrites).
  if (process.env.NODE_ENV !== 'production' && existsSync('.env')) {
    process.loadEnvFile('.env');
  }
  return parseConfig(process.env);
}
