import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';

describe('parseConfig', () => {
  it('uses safe defaults when nothing is set', () => {
    expect(parseConfig({})).toEqual({
      nodeEnv: 'development',
      port: 4000,
      corsOrigins: ['http://localhost:5173'],
      logLevel: 'info',
    });
  });

  it('reads and converts values', () => {
    const config = parseConfig({
      NODE_ENV: 'production',
      PORT: '8000',
      CORS_ORIGINS: ' http://localhost:8080 , https://app.example.com ',
    });
    expect(config.port).toBe(8000);
    expect(config.nodeEnv).toBe('production');
    expect(config.corsOrigins).toEqual(['http://localhost:8080', 'https://app.example.com']);
  });

  it('rejects a port that is not a number', () => {
    expect(() => parseConfig({ PORT: 'abc' })).toThrow(/PORT/);
  });

  it('rejects an origin that is not an http(s) URL', () => {
    expect(() => parseConfig({ CORS_ORIGINS: 'not-a-url' })).toThrow(/CORS_ORIGINS/);
  });

  it('rejects an unknown log level', () => {
    expect(() => parseConfig({ LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });

  it('lists every problem at once', () => {
    expect(() => parseConfig({ PORT: '0', NODE_ENV: 'staging' })).toThrow(/NODE_ENV[\s\S]*PORT|PORT[\s\S]*NODE_ENV/);
  });
});
