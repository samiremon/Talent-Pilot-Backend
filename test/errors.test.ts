import express from 'express';
import { pinoHttp } from 'pino-http';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError, asyncHandler, errorHandler, notFoundHandler } from '../src/errors.js';
import { createApp } from '../src/app.js';

/** A tiny app with routes that fail in different ways. */
function appWithFailingRoutes() {
  const app = express();
  app.use(pinoHttp({ logger: pino({ level: 'silent' }) }));
  app.use(express.json({ limit: '1kb' }));
  app.get('/known', () => {
    throw AppError.conflict('Candidate already exists', { email: 'taken' });
  });
  app.get('/bug', () => {
    throw new Error('db password is hunter2');
  });
  app.get(
    '/async-bug',
    asyncHandler(async () => {
      throw new Error('async internals');
    }),
  );
  app.post('/validate', (req, res) => {
    const body = z.object({ name: z.string().min(1), score: z.number().max(100) }).parse(req.body);
    res.json(body);
  });
  app.post('/echo', (req, res) => {
    res.json(req.body);
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('error handling', () => {
  const app = appWithFailingRoutes();

  it('returns expected errors with their status, code and details', async () => {
    const res = await request(app).get('/known');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'CONFLICT',
      message: 'Candidate already exists',
      details: { email: 'taken' },
    });
    expect(res.body.error.requestId).toBeDefined();
  });

  it('hides the details of unexpected errors', async () => {
    const res = await request(app).get('/bug');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(JSON.stringify(res.body)).not.toContain('stack');
  });

  it('catches errors from async handlers', async () => {
    const res = await request(app).get('/async-bug');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('async internals');
  });

  it('turns zod failures into a 400 listing each bad field', async () => {
    const res = await request(app).post('/validate').send({ name: '', score: 150 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['name', 'score']));
  });

  it('rejects broken JSON with a clear 400', async () => {
    const res = await request(app).post('/echo').set('Content-Type', 'application/json').send('{"name": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('rejects bodies over the size limit with a 413', async () => {
    const res = await request(app).post('/echo').send({ text: 'x'.repeat(2000) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('uses the same format for unknown routes in the real app', async () => {
    const res = await request(createApp({ corsOrigins: ['http://localhost:5173'] })).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', message: 'Route not found' });
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });
});
