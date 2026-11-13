/**
 * Activity module endpoints (need a logged-in recruiter; see app.ts):
 *
 *   GET /activity?before=&limit=                  tab 1: everything that happened, with names
 *   GET /activity/token-usage?before=&limit=      tab 2: every AI call with who/task/tokens
 *   GET /activity/token-dashboard?days=7          tab 3: tokens per recruiter, all-time + last N days
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../errors.js';
import { activityPage, tokenDashboard, tokenUsagePage } from './service.js';

const pageQuery = z.object({
  before: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const dashboardQuery = z.object({
  // How many days back "recent" means. 1 = today-ish (last 24 hours), up to a year.
  days: z.coerce.number().int().min(1, 'must be at least 1').max(365, 'can be at most 365').default(7),
});

export function activityRouter(): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { before, limit } = pageQuery.parse(req.query);
      res.json(await activityPage(before, limit));
    }),
  );

  router.get(
    '/token-usage',
    asyncHandler(async (req, res) => {
      const { before, limit } = pageQuery.parse(req.query);
      res.json(await tokenUsagePage(before, limit));
    }),
  );

  router.get(
    '/token-dashboard',
    asyncHandler(async (req, res) => {
      const { days } = dashboardQuery.parse(req.query);
      res.json(await tokenDashboard(days));
    }),
  );

  return router;
}
