/**
 * Dashboard numbers (stats/dashboard.ts): the CUMULATIVE funnel, reply rate, interested
 * rate, meetings and hires, per job and for all jobs, plus GET /stats/overview.
 *
 * Status changes go through the real changeCandidateStatus(), so the activity log holds the
 * same history the app writes; that history is what keeps rejected people in the funnel.
 */
import { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { addCandidates } from '../src/candidates/addCandidates.js';
import { ensureRecruiter } from '../src/auth/recruiter.js';
import { changeCandidateStatus, undoStatusChange } from '../src/candidates/statusChange.js';
import { CandidateModel } from '../src/models/candidate.js';
import { JobModel } from '../src/models/job.js';
import { UserModel } from '../src/models/user.js';
import { type CandidateStatus } from '../src/pipeline/status.js';
import { describeStats, hiringStats } from '../src/stats/dashboard.js';
import { useTestDatabase } from './helpers/db.js';

useTestDatabase();

const RECRUITER = { email: 'recruiter@example.com', password: 'correct-horse-battery', name: 'Rina' };
const app = createApp({ corsOrigins: ['http://localhost:5173'] });

beforeEach(async () => {
  await ensureRecruiter(RECRUITER, 'create-if-missing');
});

async function makeJob(title: string) {
  const user = await UserModel.findOne({ email: RECRUITER.email });
  return JobModel.create({ title, description: `${title} job description long enough to be a JD.`, createdBy: user!._id });
}

/** Adds people to a job and walks each one through the given statuses, in order. */
async function walk(jobId: Types.ObjectId, paths: Record<string, CandidateStatus[]>) {
  const names = Object.keys(paths);
  await addCandidates(jobId, 'manual', names.map((name) => ({ name, email: `${name.toLowerCase()}@example.com` })));
  const ids: Record<string, Types.ObjectId> = {};
  for (const name of names) {
    const c = await CandidateModel.findOne({ jobId, name });
    ids[name] = c!._id;
    for (const to of paths[name]!) await changeCandidateStatus({ candidateId: c!._id, to, actor: 'recruiter' });
  }
  return ids;
}

describe('hiring stats', () => {
  it('counts how far each candidate EVER got, so a later rejection keeps them in the funnel', async () => {
    const job = await makeJob('Backend Engineer');
    await walk(job._id, {
      Ana: ['accepted', 'contacted'], // contacted, no reply
      Ben: ['accepted', 'contacted', 'replied', 'not_interested'], // replied, said no
      Cy: ['accepted', 'contacted', 'replied', 'interested', 'meeting_booked', 'interviewed', 'rejected'], // rejected after interview
      Di: ['accepted', 'contacted', 'replied', 'interested', 'meeting_booked', 'interviewed', 'shortlisted', 'hired'],
      Ed: ['not_accepted'], // review said no
    });

    const { overall, jobs } = await hiringStats();
    expect(overall.funnel).toEqual({
      sourced: 5,
      accepted: 4,
      contacted: 4,
      replied: 3,
      interested: 2,
      meeting_booked: 2,
      interviewed: 2,
      shortlisted: 1,
      hired: 1,
    });
    expect(overall.replyRate).toBeCloseTo(3 / 4);
    expect(overall.interestedRate).toBeCloseTo(2 / 3);
    expect(overall).toMatchObject({ meetings: 2, hires: 1, totalCandidates: 5 });
    // Today's statuses are kept too (Cy is Rejected now).
    expect(overall.current).toMatchObject({ rejected: 1, hired: 1, not_interested: 1, contacted: 1, not_accepted: 1 });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ title: 'Backend Engineer', meetings: 2, hires: 1 });
  });

  it('ignores status changes that were undone (they were mistakes)', async () => {
    const job = await makeJob('Designer');
    const { Fay } = await walk(job._id, { Fay: ['accepted', 'contacted', 'replied'] });
    const change = await changeCandidateStatus({ candidateId: Fay!, to: 'interested', actor: 'recruiter' });
    await undoStatusChange({ activityId: change.activity._id, actor: 'recruiter' });

    const { overall } = await hiringStats();
    expect(overall.funnel.replied).toBe(1);
    expect(overall.funnel.interested).toBe(0);
  });

  it('splits the numbers per job, and gives "no rate" (null) when nobody was contacted', async () => {
    const a = await makeJob('Job A');
    const b = await makeJob('Job B');
    await walk(a._id, { Gus: ['accepted', 'contacted', 'replied'] });
    await walk(b._id, { Hal: [] });

    const { jobs, overall } = await hiringStats();
    const byTitle = Object.fromEntries(jobs.map((j) => [j.title, j]));
    expect(byTitle['Job A']).toMatchObject({ totalCandidates: 1, replyRate: 1, interestedRate: 0 });
    expect(byTitle['Job B']).toMatchObject({ totalCandidates: 1, replyRate: null, interestedRate: null, meetings: 0, hires: 0 });
    expect(overall.totalCandidates).toBe(2);

    // One job only (what the chat tool asks for).
    const onlyA = await hiringStats([a._id]);
    expect(onlyA.jobs.map((j) => j.title)).toEqual(['Job A']);
    expect(describeStats(onlyA, 'Job A')).toMatch(/Reply rate 100%, interested rate 0%, meetings 0, hires 0/);
  });

  it('GET /stats/overview sends the funnel, rates and the per-job table', async () => {
    const job = await makeJob('QA Engineer');
    await walk(job._id, {
      Ivy: ['accepted', 'contacted', 'replied', 'interested', 'meeting_booked'],
      Jon: ['accepted', 'contacted'],
    });
    const agent = request.agent(app);
    await agent.post('/auth/login').send(RECRUITER).expect(200);

    const { body } = await agent.get('/stats/overview').expect(200);
    expect(body).toMatchObject({ totalCandidates: 2, meetings: 1, hires: 0, replyRate: 0.5, interestedRate: 1 });
    expect(body.funnel).toMatchObject({ sourced: 2, contacted: 2, replied: 1, meeting_booked: 1 });
    expect(body.perJob[0]).toMatchObject({ title: 'QA Engineer', meetings: 1, replyRate: 0.5 });
  });
});
