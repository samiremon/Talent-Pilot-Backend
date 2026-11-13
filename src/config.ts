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
  sessionTtlHours: number;
  cookieSecure: boolean;
  trustProxy: number;
  /** Present only when both the email and the password are set. */
  seedRecruiter?: { email: string; password: string; name: string };
  /** Show the "Use demo account" button (only possible when seedRecruiter is set). */
  demoLoginEnabled: boolean;
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
    sessionTtlHours: e.SESSION_TTL_HOURS,
    cookieSecure: e.COOKIE_SECURE ?? e.NODE_ENV === 'production',
    trustProxy: e.TRUST_PROXY,
    // The button needs credentials to fill in, so it's off when no seed account is set.
    demoLoginEnabled: (e.DEMO_LOGIN_ENABLED ?? false) && Boolean(e.SEED_RECRUITER_EMAIL && e.SEED_RECRUITER_PASSWORD),
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
