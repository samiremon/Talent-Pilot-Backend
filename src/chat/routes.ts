/**
 * Chat endpoints (need a logged-in recruiter; see app.ts):
 *
 *   GET  /chat/messages                    the conversation (last 100 messages)
 *   POST /chat/messages                    { text, jobId? } -> the AI's answer (+ any cards)
 *   POST /chat/actions/:id/confirm         { fields? } -> do what the card proposed
 *   POST /chat/actions/:id/cancel          -> drop it
 */
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { Ai } from '../ai/client.js';
import { AppError, asyncHandler } from '../errors.js';
import { cancelAction, confirmAction } from './actions.js';
import { addSystemNote, listMessages, sendMessage } from './service.js';

const sendBody = z.object({
  text: z.string().trim().min(1, 'is empty').max(50_000, 'is too long'),
  jobId: z.string().optional(),
});
const confirmBody = z.object({ fields: z.record(z.string(), z.unknown()).optional() });

export function chatRouter(ai: Ai): Router {
  const router = Router();

  // Each message can trigger several AI calls; keep the free quota (and costs) safe.
  const chatLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) =>
      next(new AppError(429, 'TOO_MANY_MESSAGES', 'Too many messages. Please wait a minute and try again.')),
  });

  router.get(
    '/messages',
    asyncHandler(async (req, res) => {
      res.json({ messages: await listMessages(req.user!.id), ai: { mode: ai.mode } });
    }),
  );

  router.post(
    '/messages',
    chatLimiter,
    asyncHandler(async (req, res) => {
      const { text, jobId } = sendBody.parse(req.body);
      const result = await sendMessage(ai, req.user!.id, text, jobId);
      req.log.info({ tokens: result.usage.inputTokens + result.usage.outputTokens }, 'Chat answered');
      res.json(result);
    }),
  );

  router.post(
    '/actions/:id/confirm',
    asyncHandler(async (req, res) => {
      const { fields } = confirmBody.parse(req.body ?? {});
      const card = await confirmAction(req.params.id as string, req.user!.id, fields);
      const result = card.result as { jobId?: string; title?: string } | null;
      const note = await addSystemNote(
        req.user!.id,
        result?.title ? `Done: the job "${result.title}" was created.` : 'Done.',
        result?.jobId,
      );
      res.json({ card, message: note });
    }),
  );

  router.post(
    '/actions/:id/cancel',
    asyncHandler(async (req, res) => {
      const card = await cancelAction(req.params.id as string, req.user!.id);
      const message = await addSystemNote(req.user!.id, 'Okay, cancelled. Nothing was changed.');
      res.json({ card, message });
    }),
  );

  return router;
}
