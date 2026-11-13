/**
 * Outreach endpoints (all under /jobs/:id, login required):
 *
 *   GET   /jobs/:id/campaigns                          campaigns + emails + settings
 *   POST  /jobs/:id/campaigns                          { candidateIds?, sequence: "single" | "sequence" }
 *   PATCH /jobs/:id/campaigns/messages/:messageId      { subject?, body? }  edit a draft
 *   POST  /jobs/:id/campaigns/:campaignId/approve      start sending (nothing is sent before this)
 *   POST  /jobs/:id/campaigns/:campaignId/pause        stop sending
 *   POST  /jobs/:id/campaigns/:campaignId/resume       continue
 *   POST  /jobs/:id/campaigns/:campaignId/remove       { candidateId }  take someone out
 *
 * The AI's chat cards call the same functions (outreach/service.ts).
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../errors.js';
import {
  approveCampaign,
  createCampaign,
  listCampaigns,
  pauseCampaign,
  removeCandidate,
  resumeCampaign,
  SEQUENCES,
  updateMessage,
  type OutreachDeps,
} from './service.js';

const createBody = z.object({
  candidateIds: z.array(z.string()).max(500).optional(),
  sequence: z.enum(['single', 'sequence']).default('single'),
});
const editBody = z.object({ subject: z.string().max(300).optional(), body: z.string().max(5000).optional() });

export function outreachRouter(deps: OutreachDeps): Router {
  const router = Router();
  router.get(
    '/:id/campaigns',
    asyncHandler(async (req, res) => {
      res.json(await listCampaigns(deps, req.params.id as string));
    }),
  );
  router.post(
    '/:id/campaigns',
    asyncHandler(async (req, res) => {
      const body = createBody.parse(req.body);
      res.status(201).json(await createCampaign(deps, req.params.id as string, req.user!.id, { candidateIds: body.candidateIds, stepDays: SEQUENCES[body.sequence] }));
    }),
  );
  router.patch(
    '/:id/campaigns/messages/:messageId',
    asyncHandler(async (req, res) => {
      res.json({ message: await updateMessage(req.params.id as string, req.params.messageId as string, editBody.parse(req.body)) });
    }),
  );
  router.post(
    '/:id/campaigns/:campaignId/approve',
    asyncHandler(async (req, res) => {
      res.json(await approveCampaign(deps, req.params.id as string, req.params.campaignId as string, req.user!.id));
    }),
  );
  router.post(
    '/:id/campaigns/:campaignId/pause',
    asyncHandler(async (req, res) => {
      res.json(await pauseCampaign(req.params.id as string, req.params.campaignId as string));
    }),
  );
  router.post(
    '/:id/campaigns/:campaignId/resume',
    asyncHandler(async (req, res) => {
      res.json(await resumeCampaign(deps, req.params.id as string, req.params.campaignId as string, req.user!.id));
    }),
  );
  router.post(
    '/:id/campaigns/:campaignId/remove',
    asyncHandler(async (req, res) => {
      const { candidateId } = z.object({ candidateId: z.string() }).parse(req.body);
      res.json(await removeCandidate(req.params.id as string, req.params.campaignId as string, candidateId));
    }),
  );
  return router;
}
