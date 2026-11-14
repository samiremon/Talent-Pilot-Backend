/**
 * The bell: create notifications, list them, mark them read.
 *
 *   GET  /notifications            the latest 30 for the logged-in recruiter + how many unread
 *   POST /notifications/:id/read   one read (when it's clicked)
 *   POST /notifications/read-all   all read
 */
import { Router } from 'express';
import { Types } from 'mongoose';
import { AppError, asyncHandler } from '../errors.js';
import { jobCode } from '../models/counter.js';
import { JobModel } from '../models/job.js';
import { NotificationModel } from '../models/notification.js';

export async function notify(input: {
  userId: Types.ObjectId | string | null | undefined;
  type: 'reply' | 'meeting';
  jobId: Types.ObjectId;
  candidateId: Types.ObjectId;
  replyId?: Types.ObjectId | null;
  text: string;
}) {
  if (!input.userId) return null;
  return NotificationModel.create({ ...input, userId: new Types.ObjectId(String(input.userId)), text: input.text.slice(0, 300) });
}

export function notificationsRouter(): Router {
  const router = Router();
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const user = new Types.ObjectId(req.user!.id);
      const [rows, unread] = await Promise.all([
        NotificationModel.find({ userId: user }).sort({ createdAt: -1 }).limit(30).lean(),
        NotificationModel.countDocuments({ userId: user, readAt: null }),
      ]);
      const jobs = new Map((await JobModel.find({ _id: { $in: rows.map((r) => r.jobId) } }, { jobNumber: 1, title: 1 }).lean()).map((j) => [String(j._id), j]));
      res.json({
        unread,
        notifications: rows.map((n) => ({
          id: String(n._id),
          type: n.type,
          text: n.text,
          jobId: String(n.jobId),
          jobCode: jobCode(jobs.get(String(n.jobId))?.jobNumber ?? null),
          jobTitle: jobs.get(String(n.jobId))?.title ?? null,
          candidateId: String(n.candidateId),
          read: Boolean(n.readAt),
          createdAt: n.createdAt,
        })),
      });
    }),
  );
  router.post(
    '/read-all',
    asyncHandler(async (req, res) => {
      await NotificationModel.updateMany({ userId: new Types.ObjectId(req.user!.id), readAt: null }, { $set: { readAt: new Date() } });
      res.json({ ok: true });
    }),
  );
  router.post(
    '/:id/read',
    asyncHandler(async (req, res) => {
      if (!Types.ObjectId.isValid(req.params.id as string)) throw AppError.notFound('Notification not found');
      await NotificationModel.updateOne({ _id: req.params.id, userId: new Types.ObjectId(req.user!.id) }, { $set: { readAt: new Date() } });
      res.json({ ok: true });
    }),
  );
  return router;
}
