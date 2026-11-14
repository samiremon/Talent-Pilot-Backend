/**
 * The team calendar (the Calendar page). Logged-in recruiters only.
 *
 *   GET    /calendar?week=2026-11-15   one week, Sunday to Thursday, 9 AM-6 PM Dhaka time:
 *                                     every hour with its state (free / busy / booked / past),
 *                                     plus the upcoming booked calls
 *   POST   /calendar/busy  { start }   block an hour ("I'm busy then"): candidates can't book it
 *   DELETE /calendar/busy/:id          free it again
 *
 * Booked hours come from Meeting (the candidate picked them on the booking page), busy ones
 * from BusySlot. A booked hour can't be blocked: the call is already there.
 */
import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { AppError, asyncHandler } from '../errors.js';
import { CandidateModel } from '../models/candidate.js';
import { BusySlotModel } from '../models/busySlot.js';
import { jobCode } from '../models/counter.js';
import { JobModel } from '../models/job.js';
import { MeetingModel } from '../models/reply.js';
import { UserModel } from '../models/user.js';
import { daySlots, dhakaDateKey, earliestBookable, isWorkSlot, takenSlots, workWeekStart, WORK_DAYS } from './slots.js';

const DAY = 24 * 3600_000;

/** Names for the booked calls: who, which job. */
async function describeMeetings(meetings: { candidateId: unknown; jobId: unknown }[]) {
  const [people, jobs] = await Promise.all([
    CandidateModel.find({ _id: { $in: meetings.map((m) => m.candidateId) } }, { name: 1 }).lean(),
    JobModel.find({ _id: { $in: meetings.map((m) => m.jobId) } }, { jobNumber: 1, title: 1 }).lean(),
  ]);
  const names = new Map(people.map((p) => [String(p._id), p.name]));
  const jobById = new Map(jobs.map((j) => [String(j._id), j]));
  return (m: { _id: unknown; candidateId: unknown; jobId: unknown; slot?: Date | null }) => {
    const job = jobById.get(String(m.jobId));
    return {
      id: String(m._id),
      start: m.slot,
      candidateId: String(m.candidateId),
      candidateName: names.get(String(m.candidateId)) ?? 'A candidate',
      jobId: String(m.jobId),
      jobCode: job ? jobCode(job.jobNumber) : null,
      jobTitle: job?.title ?? null,
    };
  };
}

/** The upcoming booked calls (soonest first), for the Calendar page and the AI. */
export async function upcomingMeetings(limit = 20) {
  const meetings = await MeetingModel.find({ status: 'booked', slot: { $gte: new Date() } }).sort({ slot: 1 }).limit(limit).lean();
  const describe = await describeMeetings(meetings);
  return meetings.map(describe);
}

/** One week of the calendar: each working day with its hours and their state. */
export async function calendarWeek(anyDayInWeek: Date) {
  const start = workWeekStart(anyDayInWeek); // on Friday / Saturday: the coming week
  const end = new Date(start.getTime() + 7 * DAY);
  const { busy, booked } = await takenSlots(start, end);
  const describe = await describeMeetings([...booked.values()]);
  const blockers = new Map(
    (await UserModel.find({ _id: { $in: [...busy.values()].map((b) => b.userId).filter(Boolean) } }, { name: 1 }).lean()).map((u) => [String(u._id), u.name]),
  );
  const soonest = earliestBookable();
  const days = WORK_DAYS.map((weekday) => {
    const day = new Date(start.getTime() + weekday * DAY);
    return {
      date: dhakaDateKey(day),
      slots: daySlots(day).map((slot) => {
        const meeting = booked.get(slot.getTime());
        const block = busy.get(slot.getTime());
        // A booked call stays visible even after its time (so the week shows what happened).
        if (meeting) return { start: slot, state: 'booked' as const, meeting: describe(meeting) };
        if (block) return { start: slot, state: 'busy' as const, busyId: String(block._id), blockedBy: blockers.get(String(block.userId)) ?? null, note: block.note || null };
        return { start: slot, state: slot < soonest ? ('past' as const) : ('free' as const) };
      }),
    };
  });
  return { weekStart: dhakaDateKey(start), timeZone: 'Asia/Dhaka', days };
}

export function calendarRouter(): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const week = typeof req.query.week === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.week) ? new Date(`${req.query.week}T12:00:00+06:00`) : new Date();
      if (Number.isNaN(week.getTime())) throw AppError.badRequest('Invalid week');
      const [calendar, upcoming] = await Promise.all([calendarWeek(week), upcomingMeetings()]);
      res.json({ ...calendar, upcoming });
    }),
  );

  router.post(
    '/busy',
    asyncHandler(async (req, res) => {
      const { start, note } = z.object({ start: z.string().datetime({ offset: true }), note: z.string().max(120).optional() }).parse(req.body);
      const slot = new Date(start);
      if (!isWorkSlot(slot)) throw AppError.badRequest('Only working hours (Sunday to Thursday, 9 AM to 6 PM) can be blocked.');
      if (slot < new Date()) throw AppError.badRequest('That time has already passed.');
      if (await MeetingModel.exists({ status: 'booked', slot })) throw AppError.conflict('A call is already booked then.');
      // Blocking an hour that's already blocked is fine (nothing changes).
      const block = await BusySlotModel.findOneAndUpdate(
        { start: slot },
        { $setOnInsert: { start: slot, userId: new Types.ObjectId(req.user!.id), note: note ?? '' } },
        { upsert: true, new: true },
      );
      res.status(201).json({ id: String(block._id) });
    }),
  );

  router.delete(
    '/busy/:id',
    asyncHandler(async (req, res) => {
      if (!Types.ObjectId.isValid(req.params.id as string)) throw AppError.notFound('That busy time was not found.');
      await BusySlotModel.deleteOne({ _id: req.params.id });
      res.status(204).end();
    }),
  );
  return router;
}
