import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createLogger, maskEmail } from '../src/logger.js';
import { createApp } from '../src/app.js';

/** Logger that writes JSON lines into an array we can inspect. */
function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk, _encoding, done) {
      lines.push(JSON.parse(chunk.toString()));
      done();
    },
  });
  return { logger: createLogger({ level: 'info', destination }), lines };
}

describe('maskEmail', () => {
  it('keeps only the first letter and the domain', () => {
    expect(maskEmail('rahim.uddin@example.com')).toBe('r***@example.com');
  });

  it('fully hides values that are not emails', () => {
    expect(maskEmail('nope')).toBe('[REDACTED]');
    expect(maskEmail(42)).toBe('[REDACTED]');
  });
});

describe('logger redaction', () => {
  it('never writes passwords, tokens or API keys, and masks emails', () => {
    const { logger, lines } = captureLogger();
    logger.info({ user: { email: 'rahim@example.com', password: 'hunter2', apiKey: 'gsk_secret' }, token: 't0k' }, 'login');

    const raw = JSON.stringify(lines);
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('gsk_secret');
    expect(raw).not.toContain('t0k');
    expect(raw).not.toContain('rahim@example.com');
    expect(lines[0]).toMatchObject({ user: { email: 'r***@example.com', password: '[REDACTED]' } });
  });
});

describe('request logging', () => {
  it('logs requests with a request id and hides auth headers', async () => {
    const { logger, lines } = captureLogger();
    const app = createApp({ corsOrigins: ['http://localhost:5173'], logger });

    const res = await request(app).get('/nope').set('Authorization', 'Bearer super-secret').set('Cookie', 'sid=abc');

    const id = res.headers['x-request-id'];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const entry = lines.find((line) => line.req);
    expect(entry).toMatchObject({ level: 40, req: { id } }); // 40 = warn, used for 4xx
    expect(JSON.stringify(lines)).not.toContain('super-secret');
    expect(JSON.stringify(lines)).not.toContain('sid=abc');
  });

  it('reuses a safe incoming request id and replaces an unsafe one', async () => {
    const app = createApp({ corsOrigins: ['http://localhost:5173'] });
    const ok = await request(app).get('/health').set('X-Request-Id', 'abc-123');
    expect(ok.headers['x-request-id']).toBe('abc-123');
    const bad = await request(app).get('/health').set('X-Request-Id', 'evil <script>alert(1)</script>');
    expect(bad.headers['x-request-id']).not.toContain('evil');
  });

  it('does not log health checks', async () => {
    const { logger, lines } = captureLogger();
    await request(createApp({ corsOrigins: ['http://localhost:5173'], logger })).get('/health');
    expect(lines).toHaveLength(0);
  });
});
