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
import { activityRouter } from './activity/routes.js';
import { requireAuth } from './auth/requireAuth.js';
import { chatRouter } from './chat/routes.js';
import { authRouter, type AuthOptions } from './auth/routes.js';
import { jobsRouter, statsRouter } from './jobs/routes.js';
import { sourcingRouter } from './sourcing/routes.js';
import { outreachRouter } from './outreach/routes.js';
import { unsubscribeRouter } from './outreach/unsubscribe.js';
import { bookingRouter } from './replies/booking.js';
import type { ReplySettings } from './replies/processing.js';
import { repliesRouter, simulateReplyRouter } from './replies/routes.js';
import { createMemoryMailer, type Mailer } from './email/mailer.js';
import type { OutreachSettings } from './outreach/sending.js';
import { createMemoryEvents, type TaskEvents } from './tasks/events.js';
import { createInlineQueue, type TaskQueue } from './tasks/queue.js';
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
  /** The background-job queue + live progress events. Tests default to in-process ones. */
  queue?: TaskQueue;
  events?: TaskEvents;
  /** Outreach sending rules (sandbox/live, daily limit, day length). Default: sandbox. */
  outreach?: OutreachSettings;
  /** Candidate replies (auto-send setting, app address for booking links). Default: approve each. */
  replies?: ReplySettings;
  /** Sends approved answers to replies (sandbox = Mailpit). Default (tests): in memory. */
  outreachMailer?: Mailer;
  /** Web search mode, shown in the Find candidates dialog. Default: sample. */
  searchMode?: 'serper' | 'sample';
  /** Optional token limits/budgets for the token dashboard (see config.ts). */
  aiLimits?: { dailyTokens?: number; weekBudget?: number; monthBudget?: number };
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
  aiLimits = {},
  events = createMemoryEvents(),
  queue = createInlineQueue(() => ({})),
  searchMode = 'sample',
  outreach = { mode: 'sandbox', dailyLimit: 50, daySeconds: 86_400 },
  replies = { autoSend: false, appUrl: 'http://localhost:8080' },
  outreachMailer = createMemoryMailer(),
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
    const queueState = queue.isReady() ? 'up' : 'down';
    const healthy = database === 'up' && queueState === 'up';
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      service: 'talent-pilot-backend',
      checks: { database, queue: queueState },
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  app.use('/auth', authRouter(auth));
  // Public: candidates' unsubscribe links (no login; the link's random token is the key).
  // The one-click POST from mail apps sends a form body, so urlencoded bodies are read here.
  app.use('/unsubscribe', express.urlencoded({ extended: false, limit: '2kb' }), unsubscribeRouter());
  // Public: the booking link in the AI's answer (pick a time -> Meeting booked).
  app.use('/book', express.urlencoded({ extended: false, limit: '2kb' }), bookingRouter());
  // Everything below needs a logged-in recruiter: requireAuth answers 401 otherwise.
  // Sourcing first (CSV upload, scoring, live events), then the rest of /jobs.
  app.use('/jobs', requireAuth, sourcingRouter({ queue, events, searchMode }));
  app.use('/jobs', requireAuth, outreachRouter({ queue, events, outreach }));
  app.use('/jobs', requireAuth, repliesRouter({ queue, events, mailer: outreachMailer, replies }));
  app.use('/simulate-reply', requireAuth, simulateReplyRouter({ queue, events, mailer: outreachMailer, replies }));
  app.use('/jobs', requireAuth, jobsRouter());
  app.use('/stats', requireAuth, statsRouter());
  app.use('/ai', requireAuth, aiRouter(ai));
  app.use('/chat', requireAuth, chatRouter(ai, { queue, events, searchMode, outreach, replies, mailer: outreachMailer }));
  app.use('/activity', requireAuth, activityRouter(ai, aiLimits));

  // 5. Nothing matched -> 404. Any error thrown above -> one consistent JSON error.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
