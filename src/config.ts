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

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  CORS_ORIGINS: originList.default(['http://localhost:5173']),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Config = {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  corsOrigins: string[];
  logLevel: LogLevel;
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
  const { NODE_ENV, PORT, CORS_ORIGINS, LOG_LEVEL } = result.data;
  return { nodeEnv: NODE_ENV, port: PORT, corsOrigins: CORS_ORIGINS, logLevel: LOG_LEVEL };
}

/** Loads `.env` (if present, outside production) and returns checked settings. */
export function loadConfig(): Config {
  if (process.env.NODE_ENV !== 'production' && existsSync('.env')) {
    process.loadEnvFile('.env');
  }
  return parseConfig(process.env);
}
