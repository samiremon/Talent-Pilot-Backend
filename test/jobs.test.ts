/**
 * Job endpoint tests: login required, creating a job (with validation), listing with
 * candidate counts, candidates best-first, activity, and the dashboard overview.
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { addCandidates } from '../src/candidates/addCandidates.js';
import { ensureRecruiter } from '../src/auth/recruiter.js';
import { CandidateModel } from '../src/models/candidate.js';
import { useTestDatabase } from './helpers/db.js';

useTestDatabase();

const RECRUITER = { email: 'recruiter@example.com', password: 'correct-horse-battery', name: 'Rina' };
const JD = {
  title: 'Senior React Developer',
  description: 'We are hiring a Senior React Developer with 5+ years of React and TypeScript.',
  mustHaveSkills: ['React', 'TypeScript'],
  niceToHaveSkills: ['GraphQL'],
  seniority: 'Senior',
  location: 'Dhaka',
  salary: '', // left blank on the card -> stored as unknown
  remotePolicy: 'hybrid',
};

const app = createApp({ corsOrigins: ['http://localhost:5173'] });

/** A logged-in "browser" that keeps the session cookie. */
async function loggedIn() {
  const agent = request.agent(app);
  await agent.post('/auth/login').send(RECRUITER).expect(200);
  return agent;
}

beforeEach(async () => {
  await ensureRecruiter(RECRUITER, 'create-if-missing');
});

describe('job endpoints', () => {
  it('need a logged-in recruiter', async () => {
    for (const path of ['/jobs', '/stats/overview']) {
      expect((await request(app).get(path)).status).toBe(401);
    }
    expect((await request(app).post('/jobs').send(JD)).status).toBe(401);
  });

  it('create a job, turn blanks into unknown, and log it', async () => {
    const agent = await loggedIn();
    const res = await agent.post('/jobs').send(JD).expect(201);

    expect(res.body.job).toMatchObject({
      title: 'Senior React Developer',
      mustHaveSkills: ['React', 'TypeScript'],
      salary: null,
      remotePolicy: 'hybrid',
      totalCandidates: 0,
    });
    const activity = await agent.get(`/jobs/${res.body.job.id}/activity`).expect(200);
    expect(activity.body.activity[0]).toMatchObject({ type: 'job_created', actor: 'recruiter' });
  });

  it('reject a job with missing or bad fields, listing each problem', async () => {
    const agent = await loggedIn();
    const res = await agent.post('/jobs').send({ title: '', description: 'short', remotePolicy: 'moon' }).expect(400);
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['title', 'description', 'remotePolicy']));
  });

  it('answer 404 for unknown or malformed job ids', async () => {
    const agent = await loggedIn();
    await agent.get('/jobs/not-an-id').expect(404);
    await agent.get('/jobs/64b7f0000000000000000000').expect(404);
    await agent.get('/jobs/64b7f0000000000000000000/candidates').expect(404);
  });

  it('list jobs with candidate counts, and candidates best score first', async () => {
    const agent = await loggedIn();
    const { body } = await agent.post('/jobs').send(JD).expect(201);
    const jobId = body.job.id;

    await addCandidates(jobId, 'web', [
      { name: 'Low', email: 'low@example.com' },
      { name: 'High', email: 'high@example.com' },
      { name: 'Unscored', email: 'none@example.com' },
    ]);
    await CandidateModel.updateOne({ email: 'high@example.com' }, { score: 92, status: 'accepted' });
    await CandidateModel.updateOne({ email: 'low@example.com' }, { score: 40 });

    const list = await agent.get('/jobs').expect(200);
    expect(list.body.jobs[0]).toMatchObject({ id: jobId, totalCandidates: 3 });
    expect(list.body.jobs[0].counts).toMatchObject({ sourced: 2, accepted: 1, hired: 0 });
    expect(list.body.jobs[0].description).toBeUndefined(); // lists only get a preview

    const candidates = await agent.get(`/jobs/${jobId}/candidates`).expect(200);
    expect(candidates.body.candidates.map((c: { name: string }) => c.name)).toEqual(['High', 'Low', 'Unscored']);
  });

  it('give the dashboard its totals', async () => {
    const agent = await loggedIn();
    const { body } = await agent.post('/jobs').send(JD).expect(201);
    await addCandidates(body.job.id, 'csv', [
      { name: 'A', email: 'a@example.com' },
      { name: 'B', email: 'b@example.com' },
      { name: 'C', email: 'c@example.com' },
      { name: 'D', email: 'd@example.com' },
    ]);
    await CandidateModel.updateOne({ email: 'a@example.com' }, { status: 'contacted' });
    await CandidateModel.updateOne({ email: 'b@example.com' }, { status: 'contacted' });
    await CandidateModel.updateOne({ email: 'c@example.com' }, { status: 'replied' });
    await CandidateModel.updateOne({ email: 'd@example.com' }, { status: 'hired' });

    const res = await agent.get('/stats/overview').expect(200);
    expect(res.body).toMatchObject({ activeJobs: 1, totalCandidates: 4, hires: 1 });
    // 2 of the 4 contacted candidates replied (replied + hired).
    expect(res.body.replyRate).toBeCloseTo(0.5);
    expect(res.body.recentActivity.length).toBeGreaterThan(0);
    expect(res.body.jobs[0]).toMatchObject({ title: 'Senior React Developer', totalCandidates: 4, hired: 1 });
  });
});
