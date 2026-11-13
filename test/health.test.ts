import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

const app = createApp({ corsOrigins: ['http://localhost:5173'], isDatabaseReady: () => true });

describe('GET /health', () => {
  it('returns ok status', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('talent-pilot-backend');
    expect(res.body.checks).toEqual({ database: 'up', queue: 'up' });
  });

  it('returns 503 when the database is down', async () => {
    const down = createApp({ corsOrigins: ['http://localhost:5173'], isDatabaseReady: () => false });
    const res = await request(down).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks).toEqual({ database: 'down', queue: 'up' });
  });

  it('sets security headers and hides Express', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('unknown routes', () => {
  it('return a JSON 404', async () => {
    const res = await request(app).get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
