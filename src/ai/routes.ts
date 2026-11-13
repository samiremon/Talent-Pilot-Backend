/**
 * AI endpoints (need a logged-in recruiter; see app.ts):
 *
 *   GET  /ai/status        which mode we're in (groq or mock) and which models
 *   POST /ai/extract-job   { description } -> the job's details read from the text
 */
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { AppError, asyncHandler } from '../errors.js';
import type { Ai } from './client.js';
import { extractJob } from './extractJob.js';

const extractBody = z.object({
  description: z.string().trim().min(20, 'must be at least 20 characters').max(50_000, 'is too long (max 50,000 characters)'),
});

export function aiRouter(ai: Ai): Router {
  const router = Router();

  // Protect the free AI quota (and against a stuck button): max 20 AI requests a minute.
  const aiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) =>
      next(new AppError(429, 'TOO_MANY_AI_REQUESTS', 'Too many AI requests. Please wait a minute and try again.')),
  });

  router.get('/status', (_req, res) => {
    res.json({ mode: ai.mode, models: ai.models });
  });

  router.post(
    '/extract-job',
    aiLimiter,
    asyncHandler(async (req, res) => {
      const { description } = extractBody.parse(req.body);
      const result = await extractJob(ai, description, req.user!.id);
      req.log.info(
        { mode: result.mode, tokens: result.usage.inputTokens + result.usage.outputTokens, removed: result.removed.length },
        'Job details extracted',
      );
      res.json(result);
    }),
  );

  return router;
}
