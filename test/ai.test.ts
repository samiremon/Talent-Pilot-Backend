/**
 * AI layer tests. All run in MOCK mode (no key, no internet, no quota used):
 *   - the "never invent" check removes anything not in the job description
 *   - extracting a job through the endpoint (login required)
 *   - the token meter: extraction tokens end up on the job created from them
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { describeRateLimit, rateLimitMessage, retryAfterMs } from '../src/ai/client.js';
import { groundInText } from '../src/ai/extractJob.js';
import { ensureRecruiter } from '../src/auth/recruiter.js';
import { AiUsageModel } from '../src/models/aiUsage.js';
import { useTestDatabase } from './helpers/db.js';

useTestDatabase();

const RECRUITER = { email: 'recruiter@example.com', password: 'correct-horse-battery', name: 'Rina' };
const JD = `Senior React Developer
Acme Labs is hiring in Dhaka (hybrid). Salary: $90k - $110k.
You need React, TypeScript and Node.js.
Nice to have: GraphQL.`;

const app = createApp({ corsOrigins: ['http://localhost:5173'] });

async function loggedIn() {
  const agent = request.agent(app);
  await agent.post('/auth/login').send(RECRUITER).expect(200);
  return agent;
}

beforeEach(async () => {
  await ensureRecruiter(RECRUITER, 'create-if-missing');
});

describe('never invent: groundInText', () => {
  it('keeps what the text says and removes what it does not', () => {
    const { fields, removed } = groundInText(JD, {
      title: 'Senior React Developer',
      company: 'Acme Labs',
      mustHaveSkills: ['React', 'typescript', 'NodeJS', 'Kubernetes'], // Kubernetes isn't in the JD
      niceToHaveSkills: ['GraphQL', 'React'], // React is already a must-have
      seniority: 'Senior',
      location: 'Dhaka',
      salary: '$90k - $150k', // 150 isn't in the JD
      remotePolicy: 'hybrid',
    });
    expect(fields.mustHaveSkills).toEqual(['React', 'typescript', 'NodeJS']); // "NodeJS" matches "Node.js"
    expect(fields.niceToHaveSkills).toEqual(['GraphQL']);
    expect(fields.salary).toBeNull();
    expect(fields.company).toBe('Acme Labs');
    expect(removed).toEqual(expect.arrayContaining(['skill "Kubernetes"', 'salary "$90k - $150k"']));
    expect(removed).toHaveLength(2);
  });

  it('removes a made-up location, company or seniority', () => {
    const { fields, removed } = groundInText('We need a React developer.', {
      title: 'React Developer',
      company: 'Google',
      mustHaveSkills: ['React'],
      niceToHaveSkills: [],
      seniority: 'Senior',
      location: 'Berlin',
      salary: null,
      remotePolicy: 'unknown',
    });
    expect(fields).toMatchObject({ company: null, seniority: null, location: null, mustHaveSkills: ['React'] });
    expect(removed).toHaveLength(3);
  });
});

describe('POST /ai/extract-job (mock mode)', () => {
  it('needs login', async () => {
    await request(app).post('/ai/extract-job').send({ description: JD }).expect(401);
  });

  it('reads the job description into fields and reports its tokens', async () => {
    const agent = await loggedIn();
    const status = await agent.get('/ai/status').expect(200);
    expect(status.body.mode).toBe('mock');

    const res = await agent.post('/ai/extract-job').send({ description: JD }).expect(200);
    expect(res.body.mode).toBe('mock');
    expect(res.body.fields).toMatchObject({
      title: 'Senior React Developer',
      seniority: 'Senior',
      location: 'Dhaka',
      remotePolicy: 'hybrid',
      salary: '$90k - $110k',
    });
    expect(res.body.fields.mustHaveSkills).toEqual(expect.arrayContaining(['React', 'TypeScript', 'Node.js']));
    expect(res.body.fields.niceToHaveSkills).toEqual(['GraphQL']);
    expect(res.body.usage.inputTokens).toBeGreaterThan(0);
    expect(res.body.extractionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects a too-short description', async () => {
    const agent = await loggedIn();
    const res = await agent.post('/ai/extract-job').send({ description: 'short' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('token meter', () => {
  it('counts the extraction tokens on the job created from it, only once', async () => {
    const agent = await loggedIn();
    const extraction = await agent.post('/ai/extract-job').send({ description: JD }).expect(200);
    const { inputTokens, outputTokens } = extraction.body.usage;

    const body = { ...extraction.body.fields, description: JD, extractionId: extraction.body.extractionId };
    const created = await agent.post('/jobs').send(body).expect(201);
    expect(created.body.job.aiUsage).toEqual({ inputTokens, outputTokens, calls: 1 });

    // Using the same extraction for a second job doesn't count the tokens again.
    const second = await agent.post('/jobs').send(body).expect(201);
    expect(second.body.job.aiUsage).toEqual({ inputTokens: 0, outputTokens: 0, calls: 0 });

    const overview = await agent.get('/stats/overview').expect(200);
    expect(overview.body.aiTokens).toEqual({ inputTokens, outputTokens });
    expect(await AiUsageModel.countDocuments({ jobId: created.body.job.id })).toBe(1);
  });
});

describe('Groq rate limits', () => {
  it('reads how long Groq asks us to wait', () => {
    const groq429 = (text: string) => Object.assign(new Error(text), { status: 429 });
    expect(retryAfterMs(groq429('Rate limit reached ... Please try again in 15.495s. Need more tokens?'))).toBe(15_495);
    expect(retryAfterMs(groq429('Please try again in 750ms.'))).toBe(750);
    expect(retryAfterMs(groq429('Please try again in 1m2.5s.'))).toBe(62_500);
    expect(retryAfterMs(groq429('Too many requests'))).toBe(5000); // no hint: a sensible default
    expect(retryAfterMs(Object.assign(new Error('Bad request'), { status: 400 }))).toBeNull();
  });
});

describe('clear messages for Groq limits', () => {
  const groq429 = (text: string) => Object.assign(new Error(text), { status: 429 });

  it('says which limit was hit and how long to wait', () => {
    const tpm = describeRateLimit(
      groq429('Rate limit reached for model `openai/gpt-oss-120b` ... on tokens per minute (TPM): Limit 8000, Used 7036, Requested 3314. Please try again in 17.625s.'),
    )!;
    expect(tpm).toEqual({ kind: 'TPM', limit: 8000, waitMs: 17_625 });
    expect(rateLimitMessage(tpm)).toBe(
      "You've used this minute's AI token limit (8,000 tokens a minute on Groq's free tier). Please wait about 18 seconds and try again. You can check your AI usage in Activity → Remaining usage.",
    );

    const rpd = describeRateLimit(groq429('... on requests per day (RPD): Limit 1000, Used 1000. Please try again in 1m26.4s.'))!;
    expect(rateLimitMessage(rpd)).toMatch(/^The AI's daily request limit is used up \(1,000 requests a day\)\. It frees up again in about 87 seconds\./);
  });

  it('ignores errors that are not rate limits', () => {
    expect(describeRateLimit(Object.assign(new Error('Bad request'), { status: 400 }))).toBeNull();
  });
});
