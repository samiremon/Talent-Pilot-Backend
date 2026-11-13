/**
 * Sourcing endpoints for one job (need a logged-in recruiter; see app.ts):
 *
 *   POST /jobs/:id/candidates/csv    upload a CSV (form field "file") -> candidates added,
 *                                    duplicates skipped, and a scoring task started
 *   POST /jobs/:id/candidates        add ONE candidate by hand -> scoring started
 *   POST /jobs/:id/score             score every candidate that has no score yet
 *   GET  /jobs/:id/tasks             the job's latest background tasks
 *   GET  /jobs/:id/events            LIVE task updates (Server-Sent Events): the page stays
 *                                    connected and gets "Scored 15 of 23" as it happens
 *
 * The AI chat will call the same functions (startScoring / importCsv), per our rule that
 * the AI and the UI share one code path.
 */
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { AppError, asyncHandler } from '../errors.js';
import { resolveJob } from '../jobs/service.js';
import { listTasks } from '../tasks/service.js';
import { manualCandidateInput, addManualCandidate } from './manual.js';
import { importCsv, startScoring as startScoringFn, type SourcingDeps } from './service.js';

export type { SourcingDeps } from './service.js';
export { startScoring, importCsv } from './service.js';

// Uploads stay in memory (never written to disk), max 2 MB, one file.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, done) => {
    const ok = /\.csv$/i.test(file.originalname) || ['text/csv', 'application/vnd.ms-excel', 'text/plain'].includes(file.mimetype);
    if (ok) done(null, true);
    else done(new AppError(400, 'NOT_A_CSV', 'Please upload a .csv file.'));
  },
});

export function sourcingRouter(deps: SourcingDeps): Router {
  const router = Router();

  router.post(
    '/:id/candidates/csv',
    // multer reads the file; its own errors (too big, wrong type) become our error format.
    (req, res, next) =>
      upload.single('file')(req, res, (err: unknown) => {
        if (!err) return next();
        if (err instanceof AppError) return next(err);
        const code = (err as { code?: string }).code;
        next(new AppError(400, 'UPLOAD_FAILED', code === 'LIMIT_FILE_SIZE' ? 'The file is too big (max 2 MB).' : 'The upload failed.'));
      }),
    asyncHandler(async (req, res) => {
      const job = await resolveJob(req.params.id as string);
      if (!req.file) throw new AppError(400, 'NO_FILE', 'Choose a CSV file to upload (form field "file").');
      const result = await importCsv(deps, String(job._id), req.file.buffer.toString('utf8'), req.user!.id);
      req.log.info({ jobId: String(job._id), added: result.added, duplicates: result.duplicates }, 'CSV imported');
      res.status(201).json(result);
    }),
  );

  router.post(
    '/:id/candidates',
    asyncHandler(async (req, res) => {
      const job = await resolveJob(req.params.id as string);
      const input = manualCandidateInput.parse(req.body);
      res.status(201).json(await addManualCandidate(deps, String(job._id), input, req.user!.id));
    }),
  );

  router.post(
    '/:id/score',
    asyncHandler(async (req, res) => {
      const job = await resolveJob(req.params.id as string);
      res.status(202).json({ task: await startScoringFn(deps, String(job._id), req.user!.id) });
    }),
  );

  router.get(
    '/:id/tasks',
    asyncHandler(async (req, res) => {
      const job = await resolveJob(req.params.id as string);
      res.json({ tasks: await listTasks(String(job._id)) });
    }),
  );

  // Live updates. The browser opens this once (EventSource) and keeps it open.
  router.get(
    '/:id/events',
    asyncHandler(async (req: Request, res: Response) => {
      const job = await resolveJob(req.params.id as string);
      const jobId = String(job._id);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // tell nginx not to hold the stream back
      });
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      // Start with the current state, so a page opened mid-task shows it straight away.
      for (const task of (await listTasks(jobId, 3)).reverse()) send('task', task);
      const stop = deps.events.subscribe(jobId, (event) => send('task', event.task));
      // A comment line every 25 s keeps proxies from closing an idle connection.
      const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);

      req.on('close', () => {
        clearInterval(heartbeat);
        stop();
      });
    }),
  );

  return router;
}
