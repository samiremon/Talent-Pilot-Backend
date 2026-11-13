/**
 * Outreach campaigns (mock AI, in-process queue, a fake mailer that keeps what was "sent"):
 *   - only Accepted candidates with an email can be added
 *   - the AI drafts every step; the recruiter can edit; NOTHING is sent before approval
 *   - a Day 0 / 3 / 7 sequence: each step sent once, the first one moves them to Contacted
 *   - a reply stops the follow-ups; the daily limit holds
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAi } from '../src/ai/client.js';
import { createApp } from '../src/app.js';
import { ensureRecruiter } from '../src/auth/recruiter.js';
import { changeCandidateStatus } from '../src/candidates/statusChange.js';
import { createMemoryMailer } from '../src/email/mailer.js';
import { CandidateModel } from '../src/models/candidate.js';
import { OutreachMessageModel } from '../src/models/outreach.js';
import { createMemoryEvents } from '../src/tasks/events.js';
import { buildProcessors } from '../src/tasks/processors.js';
import { createInlineQueue } from '../src/tasks/queue.js';
import { useTestDatabase } from './helpers/db.js';

useTestDatabase();

const RECRUITER = { email: 'recruiter@example.com', password: 'correct-horse-battery', name: 'Rina' };
const JOB = { title: 'React Developer', company: 'Acme', description: 'We need a React developer with TypeScript.', mustHaveSkills: ['React'], remotePolicy: 'remote' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  await ensureRecruiter(RECRUITER, 'create-if-missing');
});

/** daySeconds 0.05: "Day 3" = 150 ms, so the whole sequence runs inside the test. */
async function setup(settings: { dailyLimit?: number; daySeconds?: number } = {}) {
  const ai = createAi({ models: { agent: 'mock', bulk: 'mock', safety: 'mock' } });
  const events = createMemoryEvents();
  const mailer = createMemoryMailer();
  const outreach = { mode: 'sandbox' as const, dailyLimit: settings.dailyLimit ?? 50, daySeconds: settings.daySeconds ?? 0.05 };
  const queue = createInlineQueue(() => buildProcessors({ ai, events, queue: () => queue, outreachMailer: mailer, outreach }));
  const app = createApp({ corsOrigins: ['http://localhost:5173'], ai, events, queue, outreach });
  const agent = request.agent(app);
  await agent.post('/auth/login').send(RECRUITER).expect(200);
  const job = (await agent.post('/jobs').send(JOB).expect(201)).body.job;
  const [ana, bo, cy, di] = await CandidateModel.insertMany([
    { jobId: job.id, source: 'csv', name: 'Ana Accepted', email: 'ana@example.com', status: 'accepted', profileText: '5 years of React' },
    { jobId: job.id, source: 'web', name: 'Bo NoEmail', profileUrl: 'https://www.linkedin.com/in/bo', status: 'accepted' },
    { jobId: job.id, source: 'csv', name: 'Cy Sourced', email: 'cy@example.com', status: 'sourced' },
    { jobId: job.id, source: 'csv', name: 'Di Accepted', email: 'di@example.com', status: 'accepted' },
  ]);
  return { agent, job, queue, mailer, ana: ana!, bo: bo!, cy: cy!, di: di! };
}

describe('outreach campaigns', () => {
  it('adds only Accepted candidates with an email, drafts every step, and sends nothing before approval', async () => {
    const { agent, job, queue, mailer } = await setup();
    const res = await agent.post(`/jobs/${job.id}/campaigns`).send({ sequence: 'sequence' }).expect(201);
    expect(res.body).toMatchObject({ candidates: 2, steps: [0, 3, 7] }); // Ana + Di (not Bo: no email; not Cy: not accepted)
    await queue.idle();

    const list = (await agent.get(`/jobs/${job.id}/campaigns`).expect(200)).body;
    const campaign = list.campaigns[0];
    expect(campaign.status).toBe('draft');
    expect(campaign.messages).toHaveLength(6); // 2 people x 3 steps
    expect(campaign.messages.every((m: { subject: string; body: string }) => m.subject && m.body)).toBe(true);
    expect(mailer.sent).toHaveLength(0); // nothing sent: waiting for approval
    expect(list.settings).toMatchObject({ mode: 'sandbox', dailyLimit: 50 });
  });

  it('sends each step once after approval (with the recruiter\'s edits), and the first email marks them Contacted', async () => {
    const { agent, job, queue, mailer, ana } = await setup();
    await agent.post(`/jobs/${job.id}/campaigns`).send({ sequence: 'sequence' }).expect(201);
    await queue.idle();
    let campaign = (await agent.get(`/jobs/${job.id}/campaigns`).expect(200)).body.campaigns[0];
    const first = campaign.messages.find((m: { step: number; candidateId: string }) => m.step === 0 && m.candidateId === String(ana._id));
    await agent.patch(`/jobs/${job.id}/campaigns/messages/${first.id}`).send({ subject: 'Edited subject' }).expect(200);

    await agent.post(`/jobs/${job.id}/campaigns/${campaign.id}/approve`).send({}).expect(200);
    await agent.post(`/jobs/${job.id}/campaigns/${campaign.id}/approve`).send({}).expect(409); // only once
    await sleep(500);
    await queue.idle();

    expect(mailer.sent).toHaveLength(6); // 2 people x 3 steps, each exactly once
    expect(mailer.sent.filter((m) => m.to === 'ana@example.com').map((m) => m.subject)[0]).toBe('Edited subject');
    expect(mailer.sent[0]!.text).toMatch(/reply "unsubscribe"/);
    expect((await CandidateModel.findById(ana._id).lean())?.status).toBe('contacted');
    campaign = (await agent.get(`/jobs/${job.id}/campaigns`).expect(200)).body.campaigns[0];
    expect(campaign.status).toBe('done');
    expect(await OutreachMessageModel.countDocuments({ status: 'sent' })).toBe(6);
  });

  it('stops the follow-ups for someone who replied', { timeout: 15_000 }, async () => {
    // Day 3 = 1.5 s, Day 7 = 3.5 s: plenty of room between steps even on a busy machine.
    const { agent, job, queue, mailer, ana } = await setup({ daySeconds: 0.5 });
    await agent.post(`/jobs/${job.id}/campaigns`).send({ sequence: 'sequence', candidateIds: [String(ana._id)] }).expect(201);
    await queue.idle();
    const campaign = (await agent.get(`/jobs/${job.id}/campaigns`).expect(200)).body.campaigns[0];
    await agent.post(`/jobs/${job.id}/campaigns/${campaign.id}/approve`).send({}).expect(200);
    // Day 0 goes out, and the sender moves Ana to Contacted right after.
    const contacted = async () => (await CandidateModel.findById(ana._id).lean())?.status === 'contacted';
    for (let i = 0; i < 80 && !(await contacted()); i++) await sleep(25);
    expect(mailer.sent).toHaveLength(1);
    await changeCandidateStatus({ candidateId: ana._id, to: 'replied', actor: 'recruiter' }); // Ana answers
    await sleep(4000); // past Day 7
    await queue.idle();
    expect(mailer.sent).toHaveLength(1); // no follow-ups after the reply
    const skipped = await OutreachMessageModel.find({ candidateId: ana._id, status: 'skipped' }).lean();
    expect(skipped).toHaveLength(2);
    expect(skipped[0]!.note).toBe('Ana Accepted is Replied: no more emails');
  });

  it('respects the daily limit', async () => {
    const { agent, job, queue, mailer } = await setup({ dailyLimit: 1 });
    await agent.post(`/jobs/${job.id}/campaigns`).send({ sequence: 'single' }).expect(201); // Ana + Di
    await queue.idle();
    const campaign = (await agent.get(`/jobs/${job.id}/campaigns`).expect(200)).body.campaigns[0];
    await agent.post(`/jobs/${job.id}/campaigns/${campaign.id}/approve`).send({}).expect(200);
    for (let i = 0; i < 20 && mailer.sent.length === 0; i++) await sleep(25);
    await sleep(100);
    expect(mailer.sent).toHaveLength(1);
    expect(await OutreachMessageModel.countDocuments({ status: 'approved' })).toBe(1); // the other waits for tomorrow
    const list = (await agent.get(`/jobs/${job.id}/campaigns`).expect(200)).body;
    expect(list.campaigns[0].sendTask.message).toMatch(/^Daily limit reached \(1 emails per 24 h\)/);
  });

  it('refuses a campaign when nobody is eligible', async () => {
    const { agent, job } = await setup();
    await CandidateModel.updateMany({ jobId: job.id }, { $set: { status: 'sourced' } });
    const res = await agent.post(`/jobs/${job.id}/campaigns`).send({}).expect(400);
    expect(res.body.error.code).toBe('NO_ELIGIBLE_CANDIDATES');
  });

  it('works from the chat: create card -> drafts -> preview with an Approve card -> approve -> sent', async () => {
    const { agent, job, queue, mailer } = await setup();
    const user = await (await import('../src/models/user.js')).UserModel.findOne({ email: RECRUITER.email });
    const { proposeAction } = await import('../src/chat/actions.js');
    const card = await proposeAction(String(user!._id), 'create_campaign', { jobId: job.id, jobCode: job.jobCode, title: job.title, sequence: 'single', candidates: [] });
    // The recruiter keeps only Ana (by id) on the card.
    const ana = await CandidateModel.findOne({ name: 'Ana Accepted' }).lean();
    const res = await agent.post(`/chat/actions/${card._id}/confirm`).send({ fields: { candidateIds: [String(ana!._id)], sequence: 'single' } }).expect(200);
    expect(res.body.message.text).toMatch(/^Done: created the campaign for 1 candidate\(s\) in JOB-0001 \(single email\)/);
    await queue.idle();
    expect(mailer.sent).toHaveLength(0);

    const follow = await agent.post(`/chat/actions/${card._id}/follow-up`).send({}).expect(200);
    expect(follow.body.message.text).toMatch(/^The drafts for JOB-0001 are ready: 1 candidate, a single email\./);
    expect(follow.body.message.text).toMatch(/Here's the first one, to \*\*Ana Accepted\*\* \(ana@example\.com\)/);
    expect(follow.body.message.card).toMatchObject({ type: 'approve_campaign', status: 'pending', payload: { emails: 1, candidates: 1 } });

    const approve = await agent.post(`/chat/actions/${follow.body.message.card.id}/confirm`).send({}).expect(200);
    expect(approve.body.message.text).toMatch(/^Done: approved 1 email\(s\)\. Sending runs in the background, into the sandbox inbox/);
    await sleep(200);
    await queue.idle();
    expect(mailer.sent.map((m) => m.to)).toEqual(['ana@example.com']);
  });

  it('rolls an approval back if sending can\'t be scheduled (never "approved" with nothing to send it)', async () => {
    const ai = createAi({ models: { agent: 'mock', bulk: 'mock', safety: 'mock' } });
    const events = createMemoryEvents();
    const outreach = { mode: 'sandbox' as const, dailyLimit: 50, daySeconds: 0.05 };
    const inner = createInlineQueue(() => buildProcessors({ ai, events, queue: () => inner, outreachMailer: createMemoryMailer(), outreach }));
    // A queue that's down for sending (drafting still works).
    const queue = { ...inner, enqueue: async (type: string, ...rest: Parameters<typeof inner.enqueue> extends [unknown, ...infer R] ? R : never) => {
      if (type === 'send_outreach') throw new Error('queue down');
      return inner.enqueue(type, ...rest);
    } };
    const app = createApp({ corsOrigins: ['http://localhost:5173'], ai, events, queue, outreach });
    const agent = request.agent(app);
    await agent.post('/auth/login').send(RECRUITER).expect(200);
    const job = (await agent.post('/jobs').send(JOB).expect(201)).body.job;
    await CandidateModel.create({ jobId: job.id, source: 'csv', name: 'Ana', email: 'ana@example.com', status: 'accepted' });
    await agent.post(`/jobs/${job.id}/campaigns`).send({}).expect(201);
    await inner.idle();
    const campaign = (await agent.get(`/jobs/${job.id}/campaigns`).expect(200)).body.campaigns[0];
    await agent.post(`/jobs/${job.id}/campaigns/${campaign.id}/approve`).send({}).expect(500);
    const after = (await agent.get(`/jobs/${job.id}/campaigns`).expect(200)).body.campaigns[0];
    expect(after.status).toBe('draft'); // back to waiting for approval
    expect(after.messages.every((m: { status: string }) => m.status === 'draft')).toBe(true);
  });
});

