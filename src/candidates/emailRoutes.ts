/**
 * Emailing one candidate (login required):
 *
 *   POST /jobs/:id/candidates/:candidateId/email/draft   { purpose, notes? }  -> AI draft
 *   POST /jobs/:id/candidates/:candidateId/email         { subject, body, purpose? } -> send
 *
 * The same functions as the AI's "Send email" card (candidates/email.ts).
 */
import { Router } from 'express';
import { z } from 'zod';
import type { Ai } from '../ai/client.js';
import type { Mailer } from '../email/mailer.js';
import { asyncHandler } from '../errors.js';
import { draftCandidateEmail, EMAIL_PURPOSES, sendCandidateEmail } from './email.js';

const draftBody = z.object({ purpose: z.enum(EMAIL_PURPOSES).default('custom'), notes: z.string().max(1000).optional() });
const sendBody = z.object({ subject: z.string().min(1).max(300), body: z.string().min(1).max(5000), purpose: z.enum(EMAIL_PURPOSES).optional() });

export function candidateEmailRouter({ ai, mailer, appUrl }: { ai: Ai; mailer: Mailer; appUrl: string }): Router {
  const router = Router();
  router.post(
    '/:id/candidates/:candidateId/email/draft',
    asyncHandler(async (req, res) => {
      const { purpose, notes } = draftBody.parse(req.body);
      res.json(await draftCandidateEmail(ai, req.params.id as string, req.params.candidateId as string, purpose, notes, req.user!.id));
    }),
  );
  router.post(
    '/:id/candidates/:candidateId/email',
    asyncHandler(async (req, res) => {
      const input = sendBody.parse(req.body);
      res.status(201).json(await sendCandidateEmail(mailer, appUrl, req.params.id as string, req.params.candidateId as string, input, { userId: req.user!.id }));
    }),
  );
  return router;
}
