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
import { updateCandidateContact } from '../candidates/updateCandidate.js';
import { changeStatuses, undoStatusChange } from '../candidates/statusChange.js';
import { CANDIDATE_STATUSES } from '../pipeline/status.js';
import { ActivityModel } from '../models/activity.js';
import { Types } from 'mongoose';
import { z } from 'zod';
import { AppError, asyncHandler } from '../errors.js';
import {
  createJob,
  createJobInput,
  deleteJob,
  getJob,
  listActivity,
  listCandidates,
  listJobs,
  overview,
  resolveJob,
  updateJob,
  updateJobInput,
} from './service.js';

const statusBody = z.object({
  candidateIds: z.array(z.string()).min(1, 'choose at least one candidate').max(500),
  to: z.enum(CANDIDATE_STATUSES),
});

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

  // Status changes (Review: Accept / Reject, and every later step: Contacted ... Hired).
  // One body for one or many: { candidateIds: [...], to: "accepted" }. The pipeline rules
  // decide what's allowed; people who can't move are skipped with the reason.
  router.post(
    '/:id/candidates/status',
    asyncHandler(async (req, res) => {
      const job = await resolveJob(req.params.id as string);
      const body = statusBody.parse(req.body);
      res.json(await changeStatuses(job._id, body.candidateIds, body.to, { actor: 'recruiter', userId: req.user!.id }));
    }),
  );

  // Undo a status change (puts the candidate back; only if nothing changed since).
  router.post(
    '/:id/activity/:activityId/undo',
    asyncHandler(async (req, res) => {
      const job = await resolveJob(req.params.id as string);
      const activity = Types.ObjectId.isValid(req.params.activityId as string) ? await ActivityModel.findOne({ _id: req.params.activityId, jobId: job._id }).lean() : null;
      if (!activity) throw AppError.notFound('Status change not found');
      const { candidate } = await undoStatusChange({ activityId: activity._id, actor: 'recruiter', userId: req.user!.id });
      res.json({ candidateId: String(candidate._id), status: candidate.status });
    }),
  );

  // Change a candidate's email / profile link (the Edit button). Same function as the AI's card.
  router.patch(
    '/:id/candidates/:candidateId',
    asyncHandler(async (req, res) => {
      res.json(await updateCandidateContact(req.params.id as string, req.params.candidateId as string, req.body, { userId: req.user!.id }));
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
