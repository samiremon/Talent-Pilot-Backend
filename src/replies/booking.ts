/**
 * The booking link in the AI's response (public: the candidate isn't logged in). A mock
 * "time-slot picker", as the brief allows instead of Calendly:
 *
 *   GET  /book/:token   "Pick a time for a short call about <role>": the offered times as buttons
 *   POST /book/:token   { slot }  books it -> the candidate becomes "Meeting booked" (normal
 *                       status rules + activity log), the recruiter gets a chat message
 *
 * Opening the link changes nothing; only choosing a time does. Booking twice just shows the
 * time already booked. The token is random per offer, so links can't be guessed.
 */
import { Router, type Response } from 'express';
import { Types } from 'mongoose';
import { escapeHtml } from '../email/mailer.js';
import { asyncHandler } from '../errors.js';
import { ActivityModel } from '../models/activity.js';
import { CandidateModel } from '../models/candidate.js';
import { ChatMessageModel } from '../models/chat.js';
import { jobCode } from '../models/counter.js';
import { JobModel } from '../models/job.js';
import { MeetingModel, ReplyModel } from '../models/reply.js';
import { moveCandidate } from './processing.js';
import { notify } from '../notifications/service.js';

/** "Thu 19 Nov, 10:00 (Dhaka time)" */
export function slotLabel(date: Date): string {
  return `${date.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })} (Dhaka time)`;
}

function page(res: Response, title: string, body: string, status = 200) {
  res
    .status(status)
    .type('html')
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>` +
        `<style>body{font-family:system-ui,sans-serif;background:#f5f6fa;color:#111827;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}` +
        `main{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px 32px;max-width:460px;width:100%}h1{font-size:22px;margin:0 0 8px}` +
        `.slots{display:grid;gap:8px;margin-top:16px}button{background:#4f46e5;color:#fff;border:0;border-radius:8px;padding:11px 14px;font-size:15px;cursor:pointer;text-align:left}` +
        `button:hover{background:#4338ca}p{line-height:1.5;color:#374151}</style></head><body><main>${body}</main></body></html>`,
    );
}

const invalid = (res: Response) => page(res, 'Link not valid', '<h1>Link not valid</h1><p>This booking link is not valid or has expired.</p>', 404);

export function bookingRouter(): Router {
  const router = Router();

  router.get(
    '/:token',
    asyncHandler(async (req, res) => {
      const meeting = /^[A-Za-z0-9_-]{20,64}$/.test(req.params.token as string) ? await MeetingModel.findOne({ token: req.params.token }).lean() : null;
      if (!meeting) return invalid(res);
      const job = await JobModel.findById(meeting.jobId, { title: 1, company: 1 }).lean();
      const about = job ? `the ${escapeHtml(job.title)} role${job.company ? ` at ${escapeHtml(job.company)}` : ''}` : 'the role';
      if (meeting.status === 'booked' && meeting.slot) {
        return page(res, 'Booked', `<h1>You're booked</h1><p>Your call about ${about} is on <strong>${escapeHtml(slotLabel(meeting.slot))}</strong>. See you then!</p>`);
      }
      const upcoming = (meeting.slots as unknown as Date[]).map((s, i) => ({ s: new Date(s), i })).filter(({ s }) => s.getTime() > Date.now());
      if (upcoming.length === 0) return page(res, 'No times left', `<h1>No times left</h1><p>These times have passed. Just reply to the email and we'll find a new one.</p>`);
      page(
        res,
        'Pick a time',
        `<h1>Pick a time</h1><p>Choose a time for a short call about ${about}.</p>` +
          `<form method="post" action="" class="slots">${upcoming.map(({ s, i }) => `<button type="submit" name="slot" value="${i}">${escapeHtml(slotLabel(s))}</button>`).join('')}</form>`,
      );
    }),
  );

  router.post(
    '/:token',
    asyncHandler(async (req, res) => {
      const meeting = /^[A-Za-z0-9_-]{20,64}$/.test(req.params.token as string) ? await MeetingModel.findOne({ token: req.params.token }) : null;
      if (!meeting) return invalid(res);
      const index = Number((req.body as { slot?: string }).slot);
      const offered = (meeting.slots as unknown as Date[]).map((d) => new Date(d));
      const slot = Number.isInteger(index) ? offered[index] : undefined;
      if (meeting.status === 'booked' && meeting.slot) {
        return page(res, 'Booked', `<h1>You're booked</h1><p>Your call is on <strong>${escapeHtml(slotLabel(new Date(meeting.slot)))}</strong>.</p>`);
      }
      if (!slot || slot.getTime() <= Date.now()) {
        return page(res, 'Pick a time', '<h1>That time isn\'t available</h1><p>Please go back and pick another time.</p>', 400);
      }
      // Book it (only once, even with a double click).
      const booked = await MeetingModel.findOneAndUpdate({ _id: meeting._id, status: 'offered' }, { $set: { status: 'booked', slot, bookedAt: new Date() } }, { new: true });
      if (!booked) return page(res, 'Booked', '<h1>Already booked</h1><p>This call was already booked.</p>');

      const [candidate, job, reply] = await Promise.all([
        CandidateModel.findById(meeting.candidateId).lean(),
        JobModel.findById(meeting.jobId).lean(),
        meeting.replyId ? ReplyModel.findById(meeting.replyId, { userId: 1 }).lean() : null,
      ]);
      const recruiterId = (reply?.userId as Types.ObjectId | null) ?? null;
      if (candidate) {
        await moveCandidate(candidate._id, 'meeting_booked', recruiterId);
        await ActivityModel.create({
          jobId: meeting.jobId,
          candidateId: candidate._id,
          type: 'meeting_booked',
          actor: 'system',
          userId: recruiterId,
          message: `${candidate.name} booked a call: ${slotLabel(slot)}`,
        });
        await notify({
          userId: recruiterId,
          type: 'meeting',
          jobId: meeting.jobId as Types.ObjectId,
          candidateId: candidate._id,
          replyId: meeting.replyId as Types.ObjectId | null,
          text: `${candidate.name} booked a call: ${slotLabel(slot)}`,
        }).catch(() => undefined);
        // Tell the recruiter in the chat.
        if (recruiterId && job) {
          await ChatMessageModel.create({
            userId: recruiterId,
            role: 'assistant',
            text: `📅 **${candidate.name}** booked a call for ${jobCode(job.jobNumber)}: **${slotLabel(slot)}**. They're now Meeting booked.`,
            jobId: job._id,
          });
        }
      }
      page(res, 'Booked', `<h1>You're booked</h1><p>Your call is on <strong>${escapeHtml(slotLabel(slot))}</strong>. We'll be in touch with the details.</p>`);
    }),
  );
  return router;
}
