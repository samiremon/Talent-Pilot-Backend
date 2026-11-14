/**
 * Reply endpoints (login required):
 *
 *   GET   /jobs/:id/replies                                  the Replies tab
 *   POST  /jobs/:id/candidates/:candidateId/simulate-reply   { body, subject? }  "they answered"
 *   POST  /simulate-reply                                    { candidateId, body, subject? }
 *                                                            (the same, as named in the brief)
 *   PATCH /jobs/:id/replies/:replyId                         { subject?, body? }  edit the response
 *   POST  /jobs/:id/replies/:replyId/send                    approve and send the response
 *   POST  /jobs/:id/replies/:replyId/discard                 don't answer
 */
import { Router } from 'express';
import { z } from 'zod';
import { AppError, asyncHandler } from '../errors.js';
import { CandidateModel } from '../models/candidate.js';
import { discardResponse, listReplies, sendResponse, simulateReply, updateResponse, type ReplyDeps } from './service.js';

const editBody = z.object({ subject: z.string().max(300).optional(), body: z.string().max(5000).optional() });

export function repliesRouter(deps: ReplyDeps): Router {
  const router = Router();
  router.get(
    '/:id/replies',
    asyncHandler(async (req, res) => {
      res.json(await listReplies(req.params.id as string));
    }),
  );
  router.post(
    '/:id/candidates/:candidateId/simulate-reply',
    asyncHandler(async (req, res) => {
      res.status(202).json(await simulateReply(deps, req.params.id as string, req.params.candidateId as string, req.body, req.user!.id));
    }),
  );
  router.patch(
    '/:id/replies/:replyId',
    asyncHandler(async (req, res) => {
      res.json(await updateResponse(req.params.id as string, req.params.replyId as string, editBody.parse(req.body)));
    }),
  );
  router.post(
    '/:id/replies/:replyId/send',
    asyncHandler(async (req, res) => {
      res.json(await sendResponse(deps, req.params.id as string, req.params.replyId as string, req.user!.id, editBody.parse(req.body ?? {})));
    }),
  );
  router.post(
    '/:id/replies/:replyId/discard',
    asyncHandler(async (req, res) => {
      res.json(await discardResponse(req.params.id as string, req.params.replyId as string));
    }),
  );
  return router;
}

/** POST /simulate-reply { candidateId, body, subject? }: the endpoint named in the brief. */
export function simulateReplyRouter(deps: ReplyDeps): Router {
  const router = Router();
  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const { candidateId } = z.object({ candidateId: z.string() }).parse(req.body);
      const candidate = /^[0-9a-f]{24}$/i.test(candidateId) ? await CandidateModel.findById(candidateId, { jobId: 1 }).lean() : null;
      if (!candidate) throw AppError.notFound('Candidate not found');
      res.status(202).json(await simulateReply(deps, String(candidate.jobId), candidateId, req.body, req.user!.id));
    }),
  );
  return router;
}
