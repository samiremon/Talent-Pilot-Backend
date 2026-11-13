/**
 * The Express app: every request passes through the steps below, top to bottom.
 *
 * Kept separate from server.ts (which starts listening and connects to the database)
 * so tests can create an app and send it fake requests without opening a real port.
 */
import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pino, type Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { createAi, type Ai } from './ai/client.js';
import { aiRouter } from './ai/routes.js';
import { requireAuth } from './auth/requireAuth.js';
import { chatRouter } from './chat/routes.js';
import { authRouter, type AuthOptions } from './auth/routes.js';
import { jobsRouter, statsRouter } from './jobs/routes.js';
import { isDatabaseReady } from './db.js';
import { errorHandler, notFoundHandler } from './errors.js';

export interface AppOptions {
  corsOrigins: string[];
  /** Defaults to a silent logger (handy for tests). */
  logger?: Logger;
  /** Reports whether MongoDB is connected. Defaults to the real Mongoose connection. */
  isDatabaseReady?: () => boolean;
  /** Login settings (cookie security, session length, rate limit). */
  auth?: AuthOptions;
  /** Number of proxies in front of us (nginx in Docker = 1); see TRUST_PROXY in config.ts. */
  trustProxy?: number;
  /** The AI client. Defaults to mock mode (no key), which is what tests use. */
  ai?: Ai;
}

const MOCK_AI_MODELS = { agent: 'mock', bulk: 'mock', safety: 'mock' };

/** Accept a caller's request id only if it looks safe; otherwise make a new one. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function createApp({
  corsOrigins,
  logger = pino({ level: 'silent' }),
  isDatabaseReady: databaseReady = isDatabaseReady,
  auth = { cookieSecure: false, sessionTtlHours: 12 },
  trustProxy = 0,
  ai = createAi({ models: MOCK_AI_MODELS }),
}: AppOptions): Express {
  const app = express();

  // Don't advertise that we run Express (one less hint for attackers).
  app.disable('x-powered-by');
  // Behind nginx, trust its X-Forwarded-For header so req.ip is the visitor's real IP.
  app.set('trust proxy', trustProxy);

  // 1. Logging: give each request an id and log one line when it finishes.
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

  // 2. Security headers (helmet) and which websites may call us from a browser (CORS).
  //    `credentials: true` lets the allowed sites send the login cookie.
  app.use(helmet());
  app.use(cors({ origin: corsOrigins, credentials: true, exposedHeaders: ['X-Request-Id'] }));

  // 3. Read request bodies (JSON, max 100kb) and cookies.
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  // 4. Routes.
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

  app.use('/auth', authRouter(auth));
  // Everything below needs a logged-in recruiter: requireAuth answers 401 otherwise.
  app.use('/jobs', requireAuth, jobsRouter());
  app.use('/stats', requireAuth, statsRouter());
  app.use('/ai', requireAuth, aiRouter(ai));
  app.use('/chat', requireAuth, chatRouter(ai));

  // 5. Nothing matched -> 404. Any error thrown above -> one consistent JSON error.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
