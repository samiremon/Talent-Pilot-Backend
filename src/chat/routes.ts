/**
 * Chat endpoints (need a logged-in recruiter; see app.ts):
 *
 *   GET  /chat/messages                    the conversation (last 100 messages)
 *   POST /chat/messages                    { text, jobId? } -> the AI's answer (+ any cards)
 *   POST /chat/actions/:id/confirm         { fields? } -> do what the card proposed
 *   POST /chat/actions/:id/cancel          -> drop it
 *   POST /chat/attachments/csv             (form: file, jobId) -> an "Import CSV?" card
 */
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { Ai } from '../ai/client.js';
import { AppError, asyncHandler } from '../errors.js';
import multer from 'multer';
import type { SourcingDeps } from '../sourcing/service.js';
import { cancelAction, confirmAction } from './actions.js';
import { attachCsv } from './attachments.js';
import { postScoringFollowUp } from './followUp.js';
import { addSystemNote, listMessages, sendMessage } from './service.js';

// 12,000 characters ≈ 3,000 tokens: plenty for a long job description (usually 2,000-5,000),
// and small enough to fit in one minute of Groq's free-tier token limit with everything else.
export const MAX_MESSAGE_CHARS = 12_000;

const sendBody = z.object({
  text: z.string().trim().min(1, 'is empty'),
  jobId: z.string().optional(),
});
const confirmBody = z.object({ fields: z.record(z.string(), z.unknown()).optional() });

export function chatRouter(ai: Ai, deps: SourcingDeps): Router {
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
      if (text.length > MAX_MESSAGE_CHARS) {
        throw new AppError(
          400,
          'MESSAGE_TOO_LONG',
          `This message is too long for the AI (${text.length.toLocaleString('en-US')} characters, max ${MAX_MESSAGE_CHARS.toLocaleString('en-US')}: about 4 pages). Please shorten it, e.g. paste only the job description itself.`,
        );
      }
      const result = await sendMessage(ai, req.user!.id, text, jobId);
      req.log.info({ tokens: result.usage.inputTokens + result.usage.outputTokens }, 'Chat answered');
      res.json(result);
    }),
  );

  router.post(
    '/actions/:id/confirm',
    asyncHandler(async (req, res) => {
      const { fields } = confirmBody.parse(req.body ?? {});
      const card = await confirmAction(req.params.id as string, req.user!.id, fields, deps);
      const result = card.result as { jobId?: string; title?: string; jobCode?: string; deletedCandidates?: number } | null;
      const name = result?.title ? `"${result.title}"${result.jobCode ? ` (${result.jobCode})` : ''}` : 'the job';
      const imported = card.result as { added?: number; duplicates?: number; taskId?: string | null } | null;
      const text =
        card.type === 'create_job'
          ? `Done: the job ${name} was created.`
          : card.type === 'update_job'
            ? `Done: the job ${name} was updated.`
            : card.type === 'add_candidate'
              ? `Done: added ${(card.result as { name?: string } | null)?.name ?? 'the candidate'} to ${(card.payload as { jobCode?: string }).jobCode ?? 'the job'}. AI scoring has started; I'll post their score and rank here as soon as it's done.`
              : card.type === 'delete_candidate'
              ? `Done: removed ${(card.result as { name?: string } | null)?.name ?? 'the candidate'} from ${(card.result as { jobCode?: string } | null)?.jobCode ?? 'the job'}.`
            : card.type === 'import_csv'
              ? `Done: imported ${imported?.added ?? 0} candidate(s)${imported?.duplicates ? `, skipped ${imported.duplicates} duplicate(s)` : ''}.${imported?.taskId ? ' AI scoring has started: you can follow it on the card above or on the job page.' : ''}`
              : `Done: the job ${name} was deleted, with ${result?.deletedCandidates ?? 0} candidate(s).`;
      const note = await addSystemNote(req.user!.id, text, card.type === 'delete_job' ? null : result?.jobId);
      res.json({ card, message: note });
    }),
  );

  // Files stay in memory, max 2 MB. The CSV is read and previewed; nothing is imported until
  // the recruiter presses Confirm on the card.
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
  router.post(
    '/attachments/csv',
    chatLimiter,
    (req, res, next) =>
      upload.single('file')(req, res, (err: unknown) =>
        err
          ? next(
              new AppError(400, 'UPLOAD_FAILED', (err as { code?: string }).code === 'LIMIT_FILE_SIZE' ? 'The file is too big (max 2 MB).' : 'The upload failed.'),
            )
          : next(),
      ),
    asyncHandler(async (req, res) => {
      if (!req.file) throw new AppError(400, 'NO_FILE', 'Attach a CSV file.');
      if (!/\.csv$/i.test(req.file.originalname)) throw new AppError(400, 'NOT_A_CSV', 'Please attach a .csv file.');
      const jobId = typeof req.body?.jobId === 'string' ? req.body.jobId : '';
      if (!jobId) throw new AppError(400, 'NO_JOB', 'Which job is this CSV for? Pick a job first.');
      const messages = await attachCsv(req.user!.id, jobId, req.file.originalname, req.file.buffer.toString('utf8'));
      res.json({ messages });
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

  // After an "Add candidate" / "Import CSV" card's scoring finishes, the card calls this:
  // the AI posts the score and rank (posted once; asking again returns the same message).
  // 409 SCORING_NOT_DONE = still scoring, ask again a bit later.
  router.post(
    '/actions/:id/follow-up',
    asyncHandler(async (req, res) => {
      res.json({ message: await postScoringFollowUp(req.params.id as string, req.user!.id) });
    }),
  );

  return router;
}
