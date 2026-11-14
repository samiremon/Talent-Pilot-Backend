/**
 * The booking link in the AI's response (public: the candidate isn't logged in). A mock
 * "time-slot picker", as the brief allows instead of Calendly:
 *
 *   GET  /book/:token   "Pick a time for a short call about <role>": the team calendar's FREE
 *                       hours (Sunday-Thursday, 9 AM-6 PM Dhaka time, next 2 weeks), grouped
 *                       by day. Hours the recruiter blocked as busy, or that someone else
 *                       already booked, are not shown (see src/calendar/slots.ts).
 *   POST /book/:token   { slot }  books it -> the candidate becomes "Meeting booked" (normal
 *                       status rules + activity log), the recruiter gets a notification and a
 *                       chat message, and the hour shows as booked on the Calendar page
 *
 * Opening the link changes nothing; only choosing a time does. Booking twice just shows the
 * time already booked. Two people can't get the same hour: the time is checked again when
 * they click, and the database refuses a second booking of the same hour. The token is
 * random per offer, so links can't be guessed.
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
import { dhakaDateKey, freeSlots, whyNotBookable } from '../calendar/slots.js';

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
        `main{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px 32px;max-width:560px;width:100%}h1{font-size:22px;margin:0 0 8px}` +
        `.day{margin-top:18px}.day h2{font-size:15px;margin:0 0 8px;color:#374151}.slots{display:grid;grid-template-columns:repeat(auto-fill,minmax(86px,1fr));gap:8px}button{background:#4f46e5;color:#fff;border:0;border-radius:8px;padding:10px 8px;font-size:15px;cursor:pointer}` +
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
      // The free hours, live from the team calendar, grouped by day.
      const free = await freeSlots();
      if (free.length === 0) return page(res, 'No times left', `<h1>No free times</h1><p>There are no free times in the next two weeks. Just reply to the email and we'll find a time.</p>`);
      const days = new Map<string, Date[]>();
      for (const slot of free) days.set(dhakaDateKey(slot), [...(days.get(dhakaDateKey(slot)) ?? []), slot]);
      const dayLabel = (d: Date) => d.toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', weekday: 'long', day: 'numeric', month: 'long' });
      const time = (d: Date) => d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', hour12: false });
      page(
        res,
        'Pick a time',
        `<h1>Pick a time</h1><p>Choose a time for a 1-hour call about ${about}. All times are Dhaka time (GMT+6).</p>` +
          `<form method="post" action="">` +
          [...days.values()]
            .map((slots) => `<section class="day"><h2>${escapeHtml(dayLabel(slots[0]!))}</h2><div class="slots">${slots.map((sl) => `<button type="submit" name="slot" value="${sl.toISOString()}" aria-label="${escapeHtml(slotLabel(sl))}">${time(sl)}</button>`).join('')}</div></section>`)
            .join('') +
          `</form>`,
      );
    }),
  );

  router.post(
    '/:token',
    asyncHandler(async (req, res) => {
      const meeting = /^[A-Za-z0-9_-]{20,64}$/.test(req.params.token as string) ? await MeetingModel.findOne({ token: req.params.token }) : null;
      if (!meeting) return invalid(res);
      if (meeting.status === 'booked' && meeting.slot) {
        return page(res, 'Booked', `<h1>You're booked</h1><p>Your call is on <strong>${escapeHtml(slotLabel(new Date(meeting.slot)))}</strong>.</p>`);
      }
      // The chosen hour, checked again now (someone may have taken it since the page loaded).
      const raw = String((req.body as { slot?: string }).slot ?? '');
      const slot = new Date(raw);
      const problem = /^\d{4}-\d{2}-\d{2}T/.test(raw) ? await whyNotBookable(slot) : 'That is not one of the offered times.';
      if (problem) {
        return page(res, 'Pick a time', `<h1>That time isn't available</h1><p>${escapeHtml(problem)} Please <a href="">go back and pick another time</a>.</p>`, 409);
      }
      // Book it (only once, even with a double click). The unique index on booked hours
      // stops two candidates getting the same hour at the same moment.
      let booked;
      try {
        booked = await MeetingModel.findOneAndUpdate({ _id: meeting._id, status: 'offered' }, { $set: { status: 'booked', slot, bookedAt: new Date() } }, { new: true });
      } catch (err) {
        if ((err as { code?: number }).code === 11000) {
          return page(res, 'Pick a time', `<h1>That time was just taken</h1><p>Someone booked it a moment ago. Please <a href="">pick another time</a>.</p>`, 409);
        }
        throw err;
      }
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
