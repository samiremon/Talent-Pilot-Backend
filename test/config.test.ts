import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';

const MONGODB_URI = 'mongodb://localhost:27017/talentpilot';

describe('parseConfig', () => {
  it('uses safe defaults when nothing is set', () => {
    expect(parseConfig({ MONGODB_URI })).toEqual({
      nodeEnv: 'development',
      port: 4000,
      corsOrigins: ['http://localhost:5173'],
      logLevel: 'info',
      mongodbUri: MONGODB_URI,
      sessionTtlHours: 12,
      cookieSecure: false,
      trustProxy: 0,
      seedRecruiter: undefined,
      demoLoginEnabled: false,
      // No key = mock mode; default models per role.
      ai: {
        apiKey: undefined,
        models: { agent: 'openai/gpt-oss-120b', bulk: 'openai/gpt-oss-20b', safety: 'openai/gpt-oss-safeguard-20b' },
      },
    });
  });

  it('reads and converts values', () => {
    const config = parseConfig({
      MONGODB_URI,
      NODE_ENV: 'production',
      PORT: '8000',
      CORS_ORIGINS: ' http://localhost:8080 , https://app.example.com ',
    });
    expect(config.port).toBe(8000);
    expect(config.nodeEnv).toBe('production');
    expect(config.corsOrigins).toEqual(['http://localhost:8080', 'https://app.example.com']);
  });

  it('rejects a port that is not a number', () => {
    expect(() => parseConfig({ MONGODB_URI, PORT: 'abc' })).toThrow(/PORT/);
  });

  it('rejects an origin that is not an http(s) URL', () => {
    expect(() => parseConfig({ MONGODB_URI, CORS_ORIGINS: 'not-a-url' })).toThrow(/CORS_ORIGINS/);
  });

  it('rejects an unknown log level', () => {
    expect(() => parseConfig({ MONGODB_URI, LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });

  it('requires MONGODB_URI', () => {
    expect(() => parseConfig({})).toThrow(/MONGODB_URI: is required/);
  });

  it('rejects a MONGODB_URI that is not a MongoDB URL', () => {
    expect(() => parseConfig({ MONGODB_URI: 'postgres://x' })).toThrow(/MONGODB_URI/);
  });

  it('turns on secure cookies in production unless told otherwise', () => {
    expect(parseConfig({ MONGODB_URI, NODE_ENV: 'production' }).cookieSecure).toBe(true);
    expect(parseConfig({ MONGODB_URI, NODE_ENV: 'production', COOKIE_SECURE: 'false' }).cookieSecure).toBe(false);
  });

  it('builds the recruiter seed only when both email and password are set', () => {
    const config = parseConfig({ MONGODB_URI, SEED_RECRUITER_EMAIL: 'r@example.com', SEED_RECRUITER_PASSWORD: 'long-enough' });
    expect(config.seedRecruiter).toEqual({ email: 'r@example.com', password: 'long-enough', name: 'Recruiter' });
    expect(() => parseConfig({ MONGODB_URI, SEED_RECRUITER_EMAIL: 'r@example.com' })).toThrow(/set both or neither/);
  });

  it('enables demo login only when asked and a seed account exists', () => {
    const seed = { SEED_RECRUITER_EMAIL: 'r@example.com', SEED_RECRUITER_PASSWORD: 'long-enough' };
    expect(parseConfig({ MONGODB_URI, ...seed }).demoLoginEnabled).toBe(false);
    expect(parseConfig({ MONGODB_URI, ...seed, DEMO_LOGIN_ENABLED: 'true' }).demoLoginEnabled).toBe(true);
    expect(parseConfig({ MONGODB_URI, DEMO_LOGIN_ENABLED: 'true' }).demoLoginEnabled).toBe(false);
  });

  it('accepts a Groq key and rejects something that is not one', () => {
    expect(parseConfig({ MONGODB_URI, GROQ_API_KEY: 'gsk_test123' }).ai.apiKey).toBe('gsk_test123');
    expect(parseConfig({ MONGODB_URI, GROQ_API_KEY: '' }).ai.apiKey).toBeUndefined();
    expect(() => parseConfig({ MONGODB_URI, GROQ_API_KEY: 'sk-openai' })).toThrow(/GROQ_API_KEY/);
  });

  it('rejects a short recruiter password', () => {
    expect(() => parseConfig({ MONGODB_URI, SEED_RECRUITER_EMAIL: 'r@example.com', SEED_RECRUITER_PASSWORD: 'short' })).toThrow(
      /SEED_RECRUITER_PASSWORD/,
    );
  });

  it('lists every problem at once', () => {
    expect(() => parseConfig({ PORT: '0', NODE_ENV: 'staging' })).toThrow(/NODE_ENV[\s\S]*PORT|PORT[\s\S]*NODE_ENV/);
  });
});
