/**
 * The team calendar and the mock time-slot picker:
 *   - meeting hours are Sunday to Thursday, 9 AM to 6 PM Dhaka time, in 1-hour slots
 *   - the booking page offers only FREE hours: busy (blocked) and booked hours are hidden
 *   - two candidates can't book the same hour; a booked hour can't be blocked
 *   - the Calendar page's week view shows free / busy / booked hours
 */
import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ensureRecruiter } from '../src/auth/recruiter.js';
import { daySlots, isWorkSlot, weekStart, workWeekStart } from '../src/calendar/slots.js';
import { CandidateModel } from '../src/models/candidate.js';
import { MeetingModel } from '../src/models/reply.js';
import { useTestDatabase } from './helpers/db.js';

useTestDatabase();

const RECRUITER = { email: 'recruiter@example.com', password: 'correct-horse-battery', name: 'Rina' };
const at = (dhakaTime: string) => new Date(`${dhakaTime}+06:00`);
const time = (d: Date) => d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', hour12: false });

beforeEach(async () => {
  await ensureRecruiter(RECRUITER, 'create-if-missing');
});

describe('meeting hours', () => {
  it('Sunday to Thursday, 09:00 to 17:00 starts (the last call ends at 18:00)', () => {
    const sunday = daySlots(at('2026-11-15T12:00:00'));
    expect(sunday.map(time)).toEqual(['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00']);
    expect(daySlots(at('2026-11-19T12:00:00'))).toHaveLength(9); // Thursday
    expect(daySlots(at('2026-11-20T12:00:00'))).toEqual([]); // Friday
    expect(daySlots(at('2026-11-21T12:00:00'))).toEqual([]); // Saturday
  });

  it('knows an exact slot start from anything else', () => {
    expect(isWorkSlot(at('2026-11-16T17:00:00'))).toBe(true);
    expect(isWorkSlot(at('2026-11-16T18:00:00'))).toBe(false); // the day is over
    expect(isWorkSlot(at('2026-11-16T08:00:00'))).toBe(false);
    expect(isWorkSlot(at('2026-11-16T10:30:00'))).toBe(false);
    expect(isWorkSlot(at('2026-11-20T10:00:00'))).toBe(false); // Friday
  });

  it('weeks start on Sunday (Dhaka time)', () => {
    expect(weekStart(at('2026-11-19T23:30:00'))).toEqual(at('2026-11-15T00:00:00'));
    expect(weekStart(at('2026-11-15T00:10:00'))).toEqual(at('2026-11-15T00:00:00'));
  });

  it('on Friday / Saturday the Calendar shows the coming work week', () => {
    expect(workWeekStart(at('2026-11-19T15:00:00'))).toEqual(at('2026-11-15T00:00:00')); // Thursday: this week
    expect(workWeekStart(at('2026-11-20T10:00:00'))).toEqual(at('2026-11-22T00:00:00')); // Friday: next week
    expect(workWeekStart(at('2026-11-21T23:00:00'))).toEqual(at('2026-11-22T00:00:00')); // Saturday: next week
  });
});

/** A job with two candidates who each got a booking link. */
async function setup() {
  const app = createApp({ corsOrigins: ['http://localhost:5173'] });
  const agent = request.agent(app);
  await agent.post('/auth/login').send(RECRUITER).expect(200);
  const job = (await agent.post('/jobs').send({ title: 'React Developer', company: 'Acme', description: 'We need a React developer with TypeScript.', mustHaveSkills: ['React'], remotePolicy: 'remote' }).expect(201)).body.job;
  const [ana, ben] = await CandidateModel.insertMany([
    { jobId: job.id, source: 'csv', name: 'Ana Book', email: 'ana@example.com', status: 'interested' },
    { jobId: job.id, source: 'csv', name: 'Ben Book', email: 'ben@example.com', status: 'interested' },
  ]);
  const link = async (candidateId: Types.ObjectId) => (await MeetingModel.create({ jobId: job.id, candidateId, token: randomBytes(24).toString('base64url') })).token;
  return { app, agent, job, ana: ana!, ben: ben!, anaToken: await link(ana!._id), benToken: await link(ben!._id) };
}

const offeredOn = async (app: Parameters<typeof request>[0], token: string) =>
  [...(await request(app).get(`/book/${token}`).expect(200)).text.matchAll(/name="slot" value="([^"]+)"/g)].map((m) => m[1]!);

describe('the booking page and the Calendar', () => {
  it('offers only free working hours, for the next two weeks', async () => {
    const { app, anaToken } = await setup();
    const offered = (await offeredOn(app, anaToken)).map((s) => new Date(s));
    expect(offered.length).toBeGreaterThanOrEqual(9 * 9); // at least 9 working days x 9 hours
    for (const slot of offered) expect(isWorkSlot(slot)).toBe(true);
    expect(offered[0]!.getTime()).toBeGreaterThan(Date.now() + 2 * 3600_000 - 1); // 2 hours' notice
  });

  it('busy hours are hidden; booked hours are hidden for everyone else and cannot be taken twice', async () => {
    const { app, agent, ana, anaToken, benToken } = await setup();
    const [first, second, third] = await offeredOn(app, anaToken);

    // The recruiter blocks one hour on the Calendar page: candidates no longer see it.
    const block = (await agent.post('/calendar/busy').send({ start: second }).expect(201)).body;
    expect(await offeredOn(app, anaToken)).not.toContain(second);
    await request(app).post(`/book/${anaToken}`).type('form').send(`slot=${encodeURIComponent(second!)}`).expect(409);

    // Ana books the first hour: Ben can't see it or book it.
    const booked = await request(app).post(`/book/${anaToken}`).type('form').send(`slot=${encodeURIComponent(first!)}`).expect(200);
    expect(booked.text).toMatch(/You're booked/);
    expect((await CandidateModel.findById(ana._id).lean())?.status).toBe('meeting_booked');
    expect(await offeredOn(app, benToken)).not.toContain(first);
    const taken = await request(app).post(`/book/${benToken}`).type('form').send(`slot=${encodeURIComponent(first!)}`).expect(409);
    expect(taken.text).toMatch(/just taken/);
    // ...and nobody can block it either: the call is there.
    expect((await agent.post('/calendar/busy').send({ start: first }).expect(409)).body.error.message).toMatch(/already booked/);

    // The week view shows all three states.
    const weekOf = async (iso: string) => (await agent.get(`/calendar?week=${new Date(new Date(iso).getTime() + 6 * 3600_000).toISOString().slice(0, 10)}`).expect(200)).body;
    const state = async (iso: string) =>
      (await weekOf(iso)).days.flatMap((d: { slots: { start: string }[] }) => d.slots).find((s: { start: string }) => s.start === new Date(iso).toISOString());
    expect(await state(first!)).toMatchObject({ state: 'booked', meeting: { candidateName: 'Ana Book' } });
    expect(await state(second!)).toMatchObject({ state: 'busy', blockedBy: 'Rina' });
    const week = await weekOf(first!);
    expect(week.days.map((d: { date: string }) => new Date(`${d.date}T12:00:00+06:00`).getUTCDay())).toEqual([0, 1, 2, 3, 4]);
    expect(week.upcoming[0]).toMatchObject({ candidateName: 'Ana Book', start: new Date(first!).toISOString() });

    // Freeing the busy hour offers it again.
    await agent.delete(`/calendar/busy/${block.id}`).expect(204);
    expect(await offeredOn(app, benToken)).toContain(second);
    expect(third).toBeDefined();
  });

  it('only working hours can be blocked', async () => {
    const { agent } = await setup();
    const res = await agent.post('/calendar/busy').send({ start: '2030-01-04T10:00:00+06:00' }).expect(400); // a Friday
    expect(res.body.error.message).toMatch(/Sunday to Thursday/);
    await agent.post('/calendar/busy').send({ start: 'tomorrow' }).expect(400);
  });
});
