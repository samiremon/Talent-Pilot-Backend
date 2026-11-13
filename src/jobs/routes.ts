/**
 * Job endpoints (all need a logged-in recruiter; see app.ts):
 *
 *   GET  /jobs                      all jobs, newest first, with candidate counts
 *   POST /jobs                      create a job (what "Confirm" on the AI's job card calls)
 *   GET  /jobs/:id                  one job, full description included
 *   GET  /jobs/:id/candidates       its candidates, best score first
 *   GET  /jobs/:id/activity         its history, newest first
 *   GET  /stats/overview            dashboard numbers across all jobs (mounted separately)
 */
import { Router } from 'express';
import { asyncHandler } from '../errors.js';
import { createJob, createJobInput, getJob, listActivity, listCandidates, listJobs, overview } from './service.js';

export function jobsRouter(): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      res.json({ jobs: await listJobs() });
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      // zod throws on bad input -> the error handler answers 400 with each bad field.
      const input = createJobInput.parse(req.body);
      const job = await createJob(input, req.user!.id);
      req.log.info({ jobId: job.id }, 'Job created');
      res.status(201).json({ job });
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      res.json({ job: await getJob(req.params.id as string) });
    }),
  );

  router.get(
    '/:id/candidates',
    asyncHandler(async (req, res) => {
      res.json({ candidates: await listCandidates(req.params.id as string) });
    }),
  );

  router.get(
    '/:id/activity',
    asyncHandler(async (req, res) => {
      res.json({ activity: await listActivity({ jobId: req.params.id as string }) });
    }),
  );

  return router;
}

export function statsRouter(): Router {
  const router = Router();
  router.get(
    '/overview',
    asyncHandler(async (_req, res) => {
      res.json(await overview());
    }),
  );
  return router;
}
