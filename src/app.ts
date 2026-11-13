import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { pino, type Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { isDatabaseReady } from './db.js';
import { errorHandler, notFoundHandler } from './errors.js';

export interface AppOptions {
  corsOrigins: string[];
  /** Defaults to a silent logger (handy for tests). */
  logger?: Logger;
  /** Reports whether MongoDB is connected. Defaults to the real Mongoose connection. */
  isDatabaseReady?: () => boolean;
}

/** Accept a caller's request id only if it looks safe; otherwise make a new one. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function createApp({
  corsOrigins,
  logger = pino({ level: 'silent' }),
  isDatabaseReady: databaseReady = isDatabaseReady,
}: AppOptions): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      // Health checks run every few seconds; logging them would drown out real traffic.
      autoLogging: { ignore: (req) => req.url === '/health' },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      // Keep each line short: just what's needed to trace a request.
      serializers: {
        req: (req: { id: string; method: string; url: string; headers: Record<string, unknown> }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
          userAgent: req.headers['user-agent'],
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(helmet());
  app.use(cors({ origin: corsOrigins, exposedHeaders: ['X-Request-Id'] }));
  app.use(express.json({ limit: '100kb' }));

  // 200 when everything works, 503 when a dependency is down (Docker marks the container unhealthy).
  app.get('/health', (_req, res) => {
    const database = databaseReady() ? 'up' : 'down';
    const healthy = database === 'up';
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      service: 'talent-pilot-backend',
      checks: { database },
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
