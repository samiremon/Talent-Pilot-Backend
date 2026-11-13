/**
 * Activity module tests: the three tabs show real names; the token dashboard adds up
 * tokens per recruiter for all time and for the last N days.
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ensureRecruiter } from '../src/auth/recruiter.js';
import { AiUsageModel } from '../src/models/aiUsage.js';
import { UserModel } from '../src/models/user.js';
import { useTestDatabase } from './helpers/db.js';

useTestDatabase();

const RINA = { email: 'rina@example.com', password: 'correct-horse-battery', name: 'Rina Recruiter' };
const OMAR = { email: 'omar@example.com', password: 'another-long-password', name: 'Omar Hiring' };
const JD = `Senior React Developer
We are hiring a Senior React Developer in Dhaka (hybrid). You need React and TypeScript.
Nice to have: GraphQL. Salary: $90k - $110k. You will build our customer dashboard.`;

const app = createApp({ corsOrigins: ['http://localhost:5173'] });

async function loggedIn(who: typeof RINA) {
  const agent = request.agent(app);
  await agent.post('/auth/login').send(who).expect(200);
  return agent;
}

beforeEach(async () => {
  await ensureRecruiter(RINA, 'create-if-missing');
  await ensureRecruiter(OMAR, 'create-if-missing');
});

describe('activity module', () => {
  it('needs login', async () => {
    for (const path of ['/activity', '/activity/token-usage', '/activity/token-dashboard']) {
      await request(app).get(path).expect(401);
    }
  });

  it("shows each recruiter's actions and AI calls under their own name", async () => {
    const rina = await loggedIn(RINA);
    const omar = await loggedIn(OMAR);

    // Rina: chat proposes a job (AI tokens), she confirms it.
    const { body } = await rina.post('/chat/messages').send({ text: JD }).expect(200);
    await rina.post(`/chat/actions/${body.messages[1].card.id}/confirm`).send({}).expect(200);
    // Omar: uses "Fill from description" (AI tokens) but never creates the job.
    await omar.post('/ai/extract-job').send({ description: JD }).expect(200);

    const activity = await omar.get('/activity').expect(200);
    const created = activity.body.items.find((i: { type: string }) => i.type === 'job_created');
    expect(created).toMatchObject({ actor: 'recruiter', userName: 'Rina Recruiter', jobTitle: 'Senior React Developer' });
    const proposed = activity.body.items.find((i: { actor: string }) => i.actor === 'ai');
    expect(proposed.userName).toBe('Rina Recruiter'); // the AI acted for Rina

    const usage = await omar.get('/activity/token-usage').expect(200);
    const byUser = usage.body.items.map((i: { userName: string; taskLabel: string; jobTitle: string | null }) => [
      i.userName,
      i.taskLabel,
      i.jobTitle,
    ]);
    expect(byUser).toEqual(
      expect.arrayContaining([
        ['Rina Recruiter', 'Read a job description', 'Senior React Developer'],
        ['Omar Hiring', 'Read a job description', null], // never became a job
      ]),
    );
  });

  it('adds up tokens per recruiter for all time and for the last N days', async () => {
    const [rina, omar] = await Promise.all([UserModel.findOne({ email: RINA.email }), UserModel.findOne({ email: OMAR.email })]);
    const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
    await AiUsageModel.insertMany([
      { userId: rina!._id, task: 'chat', role: 'agent', model: 'm', inputTokens: 100, outputTokens: 50, createdAt: daysAgo(1) },
      { userId: rina!._id, task: 'chat', role: 'agent', model: 'm', inputTokens: 1000, outputTokens: 500, createdAt: daysAgo(20) },
      { userId: omar!._id, task: 'extract_job', role: 'agent', model: 'm', inputTokens: 300, outputTokens: 100, createdAt: daysAgo(2) },
      { userId: null, task: 'score_candidates', role: 'bulk', model: 'm', inputTokens: 40, outputTokens: 10, createdAt: daysAgo(3) },
    ]);
    const agent = await loggedIn(RINA);

    const week = (await agent.get('/activity/token-dashboard?days=7').expect(200)).body;
    expect(week.days).toBe(7);
    const row = (name: string) => week.users.find((u: { name: string }) => u.name === name);
    expect(row('Rina Recruiter').lastDays).toEqual({ inputTokens: 100, outputTokens: 50, calls: 1 });
    expect(row('Rina Recruiter').allTime).toEqual({ inputTokens: 1100, outputTokens: 550, calls: 2 });
    expect(row('Omar Hiring').lastDays).toEqual({ inputTokens: 300, outputTokens: 100, calls: 1 });
    expect(row('System').allTime).toEqual({ inputTokens: 40, outputTokens: 10, calls: 1 });
    // Biggest user in the chosen period first.
    expect(week.users[0].name).toBe('Omar Hiring');
    expect(week.totals.lastDays).toEqual({ inputTokens: 440, outputTokens: 160, calls: 3 });

    const month = (await agent.get('/activity/token-dashboard?days=30').expect(200)).body;
    expect(month.users[0].name).toBe('Rina Recruiter');
    expect(month.totals.lastDays).toEqual(month.totals.allTime);

    await agent.get('/activity/token-dashboard?days=0').expect(400);
    await agent.get('/activity/token-dashboard?days=400').expect(400);
  });

  it('pages through long lists with "before"', async () => {
    const rina = await UserModel.findOne({ email: RINA.email });
    await AiUsageModel.insertMany(
      Array.from({ length: 5 }, (_, i) => ({
        userId: rina!._id,
        task: 'chat',
        role: 'agent',
        model: 'm',
        inputTokens: i,
        outputTokens: 0,
        createdAt: new Date(2026, 0, 1, 0, i),
      })),
    );
    const agent = await loggedIn(RINA);
    const first = (await agent.get('/activity/token-usage?limit=3').expect(200)).body;
    expect(first.items.map((i: { inputTokens: number }) => i.inputTokens)).toEqual([4, 3, 2]);
    const second = (await agent.get(`/activity/token-usage?limit=3&before=${encodeURIComponent(first.nextBefore)}`).expect(200)).body;
    expect(second.items.map((i: { inputTokens: number }) => i.inputTokens)).toEqual([1, 0]);
    expect(second.nextBefore).toBeNull();
  });
});
