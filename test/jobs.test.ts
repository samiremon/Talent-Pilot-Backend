/**
 * Job endpoint tests: login required, creating a job (with validation), listing with
 * candidate counts, candidates best-first, activity, and the dashboard overview.
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { addCandidates } from '../src/candidates/addCandidates.js';
import { ensureRecruiter } from '../src/auth/recruiter.js';
import { proposeAction } from '../src/chat/actions.js';
import { ensureJobNumbers } from '../src/jobs/service.js';
import { ActivityModel } from '../src/models/activity.js';
import { CandidateModel } from '../src/models/candidate.js';
import { JobModel } from '../src/models/job.js';
import { UserModel } from '../src/models/user.js';
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

describe('job numbers, edit and delete', () => {
  it('numbers jobs JOB-0001, JOB-0002, ... and finds them by that id', async () => {
    const agent = await loggedIn();
    const first = (await agent.post('/jobs').send(JD).expect(201)).body.job;
    const second = (await agent.post('/jobs').send({ ...JD, title: 'Backend Engineer' }).expect(201)).body.job;
    expect([first.jobCode, second.jobCode]).toEqual(['JOB-0001', 'JOB-0002']);

    // PATCH accepts the short id too.
    const edited = await agent.patch('/jobs/JOB-0002').send({ salary: '$100k', location: 'Remote' }).expect(200);
    expect(edited.body.job).toMatchObject({ salary: '$100k', location: 'Remote', jobCode: 'JOB-0002' });
  });

  it('gives numbers to older jobs that had none, oldest first', async () => {
    const user = await UserModel.findOne({ email: RECRUITER.email });
    await JobModel.insertMany([
      { title: 'Old A', description: 'x'.repeat(30), createdBy: user!._id, createdAt: new Date(2026, 0, 1) },
      { title: 'Old B', description: 'x'.repeat(30), createdBy: user!._id, createdAt: new Date(2026, 0, 2) },
    ]);
    expect(await ensureJobNumbers()).toBe(2);
    const jobs = await JobModel.find().sort({ jobNumber: 1 }).lean();
    expect(jobs.map((j) => [j.title, j.jobNumber])).toEqual([['Old A', 1], ['Old B', 2]]);
    expect(await ensureJobNumbers()).toBe(0); // nothing left to do
  });

  it('logs only the fields that really changed, and rejects bad edits', async () => {
    const agent = await loggedIn();
    const job = (await agent.post('/jobs').send(JD).expect(201)).body.job;
    await agent.patch(`/jobs/${job.id}`).send({ salary: '$95k', location: 'Dhaka' }).expect(200); // location unchanged
    const log = await ActivityModel.findOne({ jobId: job.id, type: 'job_updated' }).lean();
    expect(log).toMatchObject({ actor: 'recruiter', message: 'Job edited: salary' });

    await agent.patch(`/jobs/${job.id}`).send({}).expect(400); // nothing to change
    await agent.patch(`/jobs/${job.id}`).send({ title: '' }).expect(400);
    await agent.patch('/jobs/JOB-9999').send({ salary: '1' }).expect(404);
  });

  it('deletes a job with its candidates, keeps the history, and cancels its pending cards', async () => {
    const agent = await loggedIn();
    const job = (await agent.post('/jobs').send(JD).expect(201)).body.job;
    await addCandidates(job.id, 'csv', [{ name: 'A', email: 'a@example.com' }, { name: 'B', email: 'b@example.com' }]);
    const user = await UserModel.findOne({ email: RECRUITER.email });
    const card = await proposeAction(String(user!._id), 'update_job', { jobId: job.id, changes: { salary: '1' } });

    const res = await agent.delete(`/jobs/${job.jobCode}`).expect(200);
    expect(res.body).toMatchObject({ jobCode: 'JOB-0001', deletedCandidates: 2 });
    expect(await JobModel.countDocuments()).toBe(0);
    expect(await CandidateModel.countDocuments()).toBe(0);
    // History is kept, now with a "deleted" entry.
    const log = await ActivityModel.find({ jobId: job.id }).lean();
    expect(log.map((a) => a.type)).toEqual(expect.arrayContaining(['job_created', 'candidates_added', 'job_deleted']));
    // The pending edit card can no longer be confirmed.
    await agent.post(`/chat/actions/${card._id}/confirm`).send({}).expect(409);
  });
});

describe('the AI edits and deletes only after Confirm', () => {
  it('applies an edit card (with the recruiter\'s adjustment) and a delete card', async () => {
    const agent = await loggedIn();
    const job = (await agent.post('/jobs').send(JD).expect(201)).body.job;
    const user = await UserModel.findOne({ email: RECRUITER.email });

    // What the AI's propose_job_edit tool creates:
    const editCard = await proposeAction(String(user!._id), 'update_job', {
      jobId: job.id,
      jobCode: job.jobCode,
      title: job.title,
      changes: { salary: '$120k', location: 'Chattogram' },
      before: { salary: null, location: 'Dhaka' },
    });
    // Not applied yet.
    expect((await JobModel.findById(job.id).lean())?.salary).toBeNull();

    const edited = await agent.post(`/chat/actions/${editCard._id}/confirm`).send({ fields: { salary: '$125k' } }).expect(200);
    expect(edited.body.message.text).toBe('Done: the job "Senior React Developer" (JOB-0001) was updated.');
    expect(await JobModel.findById(job.id).lean()).toMatchObject({ salary: '$125k', location: 'Chattogram' });
    const editLog = await ActivityModel.findOne({ jobId: job.id, type: 'job_updated' }).lean();
    expect(editLog).toMatchObject({ actor: 'ai', message: 'Job edited by the AI (confirmed in chat): salary, location' });

    const deleteCard = await proposeAction(String(user!._id), 'delete_job', { jobId: job.id, jobCode: job.jobCode, title: job.title });
    expect(await JobModel.countDocuments()).toBe(1);
    const deleted = await agent.post(`/chat/actions/${deleteCard._id}/confirm`).send({}).expect(200);
    expect(deleted.body.message.text).toBe('Done: the job "Senior React Developer" (JOB-0001) was deleted, with 0 candidate(s).');
    expect(await JobModel.countDocuments()).toBe(0);
  });
});
