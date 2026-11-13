/**
 * Chat tests (mock mode: no key, no internet). The key promise:
 * the AI can only PROPOSE; nothing is created until the recruiter presses Confirm.
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { CARD_FOOTER, withCardFooter } from '../src/chat/agent.js';
import { ensureRecruiter } from '../src/auth/recruiter.js';
import { ActivityModel } from '../src/models/activity.js';
import { JobModel } from '../src/models/job.js';
import { useTestDatabase } from './helpers/db.js';

useTestDatabase();

const RECRUITER = { email: 'recruiter@example.com', password: 'correct-horse-battery', name: 'Rina' };
const OTHER = { email: 'other@example.com', password: 'another-long-password', name: 'Omar' };
const JD = `Senior React Developer
We are hiring a Senior React Developer in Dhaka (hybrid). You need React and TypeScript.
Nice to have: GraphQL. Salary: $90k - $110k. You will build our customer dashboard.`;

const app = createApp({ corsOrigins: ['http://localhost:5173'] });

async function loggedIn(who = RECRUITER) {
  const agent = request.agent(app);
  await agent.post('/auth/login').send(who).expect(200);
  return agent;
}

beforeEach(async () => {
  await ensureRecruiter(RECRUITER, 'create-if-missing');
  await ensureRecruiter(OTHER, 'create-if-missing');
});

describe('chat', () => {
  it('needs login', async () => {
    await request(app).get('/chat/messages').expect(401);
    await request(app).post('/chat/messages').send({ text: 'hi' }).expect(401);
  });

  it('answers a short message without proposing anything', async () => {
    const agent = await loggedIn();
    const res = await agent.post('/chat/messages').send({ text: 'hello' }).expect(200);
    expect(res.body.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    expect(res.body.messages[1].card).toBeNull();
    expect(res.body.messages[1].text).not.toContain('Please verify the details');
  });

  it('turns a pasted job description into a card, and creates NOTHING yet', async () => {
    const agent = await loggedIn();
    const res = await agent.post('/chat/messages').send({ text: JD }).expect(200);
    const card = res.body.messages[1].card;
    expect(card).toMatchObject({ type: 'create_job', status: 'pending' });
    // A reply with a card always ends with the instruction to verify it.
    expect(res.body.messages[1].text).toMatch(/Please verify the details in the card below, add anything that's missing, then press \*\*Confirm\*\*\.$/);
    expect(card.payload).toMatchObject({ title: 'Senior React Developer', location: 'Dhaka', remotePolicy: 'hybrid' });
    expect(await JobModel.countDocuments()).toBe(0); // the AI did not create the job
  });

  it('creates the job only on Confirm, with the recruiter\'s edits, and only once', async () => {
    const agent = await loggedIn();
    const { body } = await agent.post('/chat/messages').send({ text: JD }).expect(200);
    const cardId = body.messages[1].card.id;

    const confirmed = await agent
      .post(`/chat/actions/${cardId}/confirm`)
      .send({ fields: { salary: '$95k - $110k', title: 'Senior React Engineer' } })
      .expect(200);
    expect(confirmed.body.card.status).toBe('confirmed');
    expect(confirmed.body.message.text).toBe('Done: the job "Senior React Engineer" (JOB-0001) was created.');

    const job = await JobModel.findById(confirmed.body.card.result.jobId).lean();
    expect(job).toMatchObject({ title: 'Senior React Engineer', salary: '$95k - $110k' });
    expect(job?.aiUsage?.calls).toBe(1); // the extraction's tokens moved onto the job

    // The log shows the recruiter created it and the AI proposed it.
    const log = await ActivityModel.find({ jobId: job!._id }).lean();
    expect(log.map((a) => a.actor).sort()).toEqual(['ai', 'recruiter']);

    // Pressing Confirm again (double-click) does nothing.
    await agent.post(`/chat/actions/${cardId}/confirm`).send({}).expect(409);
    expect(await JobModel.countDocuments()).toBe(1);
  });

  it('keeps the card pending if the edits are invalid, so it can be fixed', async () => {
    const agent = await loggedIn();
    const { body } = await agent.post('/chat/messages').send({ text: JD }).expect(200);
    const cardId = body.messages[1].card.id;
    await agent.post(`/chat/actions/${cardId}/confirm`).send({ fields: { title: '' } }).expect(400);
    const after = await agent.get('/chat/messages').expect(200);
    expect(after.body.messages.find((m: { card?: { id: string } }) => m.card?.id === cardId).card.status).toBe('pending');
    expect(await JobModel.countDocuments()).toBe(0);
  });

  it('cancels without creating anything', async () => {
    const agent = await loggedIn();
    const { body } = await agent.post('/chat/messages').send({ text: JD }).expect(200);
    const res = await agent.post(`/chat/actions/${body.messages[1].card.id}/cancel`).expect(200);
    expect(res.body.card.status).toBe('cancelled');
    expect(await JobModel.countDocuments()).toBe(0);
  });

  it("keeps the conversation after a refresh, and nobody else can see or confirm your cards", async () => {
    const agent = await loggedIn();
    const { body } = await agent.post('/chat/messages').send({ text: JD }).expect(200);

    const history = await agent.get('/chat/messages').expect(200);
    expect(history.body.messages).toHaveLength(2);
    expect(history.body.ai.mode).toBe('mock');

    const other = await loggedIn(OTHER);
    expect((await other.get('/chat/messages').expect(200)).body.messages).toHaveLength(0);
    await other.post(`/chat/actions/${body.messages[1].card.id}/confirm`).send({}).expect(404);
    expect(await JobModel.countDocuments()).toBe(0);
  });
});

describe('card footer', () => {
  it('replaces the AI\'s own "review the card" ending with the standard sentence', () => {
    const reply = 'I made a job card for Senior React Developer.\n\nYou can review the card and confirm when ready.';
    expect(withCardFooter(reply, true)).toBe(`I made a job card for Senior React Developer.\n\n${CARD_FOOTER}`);
  });

  it('keeps useful last paragraphs, and does nothing without a card', () => {
    const reply = 'I made a job card.\n\nNote: the salary was not in the description.';
    expect(withCardFooter(reply, true)).toBe(`${reply}\n\n${CARD_FOOTER}`);
    expect(withCardFooter('Hello!', false)).toBe('Hello!');
  });
});
