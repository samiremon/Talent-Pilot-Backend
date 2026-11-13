/**
 * Job endpoints (all need a logged-in recruiter; see app.ts):
 *
 *   GET  /jobs                      all jobs, newest first, with candidate counts
 *   POST /jobs                      create a job (what "Confirm" on the AI's job card calls)
 *   GET  /jobs/:id                  one job, full description included
 *   GET  /jobs/:id/candidates       its candidates, best score first
 *   GET  /jobs/:id/activity         its history, newest first
 *   PATCH  /jobs/:id                any job fields -> edited job (logged: who changed what)
 *   DELETE /jobs/:id                deletes the job and its candidates (history is kept)
 *   GET  /stats/overview            dashboard numbers across all jobs (mounted separately)
 * (For PATCH/DELETE, ":id" can be the long id or the short one, e.g. JOB-0007.)
 */
import { Router } from 'express';
import { deleteAllCandidates, deleteCandidate } from '../candidates/deleteCandidate.js';
import { asyncHandler } from '../errors.js';
import {
  createJob,
  createJobInput,
  deleteJob,
  getJob,
  listActivity,
  listCandidates,
  listJobs,
  overview,
  updateJob,
  updateJobInput,
} from './service.js';

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

  router.patch(
    '/:id',
    asyncHandler(async (req, res) => {
      const changes = updateJobInput.parse(req.body);
      res.json({ job: await updateJob(req.params.id as string, changes, { userId: req.user!.id }) });
    }),
  );

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const result = await deleteJob(req.params.id as string, { userId: req.user!.id });
      req.log.info({ jobId: result.id }, 'Job deleted');
      res.json(result);
    }),
  );

  // Remove ALL candidates of the job ("Delete all" on the Candidates tab; asks first in the UI).
  router.delete(
    '/:id/candidates',
    asyncHandler(async (req, res) => {
      const result = await deleteAllCandidates(req.params.id as string, { userId: req.user!.id });
      req.log.info(result, 'All candidates removed');
      res.json(result);
    }),
  );

  // Remove one candidate (the trash button). Same function as the AI's confirmed card.
  router.delete(
    '/:id/candidates/:candidateId',
    asyncHandler(async (req, res) => {
      res.json(await deleteCandidate(req.params.id as string, req.params.candidateId as string, { userId: req.user!.id }));
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
