/**
 * Finding candidates on the web (Serper), without internet: a fake fetch for the Serper
 * client, and SAMPLE mode for the full flow (search -> add new people -> AI scoring).
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAi } from '../src/ai/client.js';
import { createApp } from '../src/app.js';
import { ensureRecruiter } from '../src/auth/recruiter.js';
import { ActivityModel } from '../src/models/activity.js';
import { CandidateModel } from '../src/models/candidate.js';
import { TaskModel } from '../src/models/task.js';
import { buildSearchQuery, createSearchClient, resultToCandidate } from '../src/sourcing/search.js';
import { createMemoryEvents } from '../src/tasks/events.js';
import { buildProcessors } from '../src/tasks/processors.js';
import { createInlineQueue } from '../src/tasks/queue.js';
import { useTestDatabase } from './helpers/db.js';

useTestDatabase();

const RECRUITER = { email: 'recruiter@example.com', password: 'correct-horse-battery', name: 'Rina' };
const JOB = {
  title: 'Senior React Developer (Frontend)',
  description: 'We need a senior React developer with TypeScript and Next.js in Dhaka.',
  mustHaveSkills: ['React', 'TypeScript', 'Next.js', 'Jest'],
  location: 'Dhaka, Bangladesh',
  remotePolicy: 'hybrid',
};

beforeEach(async () => {
  await ensureRecruiter(RECRUITER, 'create-if-missing');
});

describe('the search query', () => {
  it('is built from the job: 3 quoted skills, the role without level words, the location unquoted', () => {
    expect(buildSearchQuery(JOB)).toBe('site:linkedin.com/in "React" "TypeScript" "Next.js" Developer Frontend Dhaka Bangladesh');
    expect(buildSearchQuery({ title: 'Data Engineer', mustHaveSkills: [], location: null })).toBe('site:linkedin.com/in Data Engineer');
  });
});

describe('turning a search result into a candidate', () => {
  it('reads name, headline and link from what Google shows (no email invented)', () => {
    expect(
      resultToCandidate({
        title: 'Jasim Uddin - Senior Software Engineer | Frontend Team Lead | LinkedIn',
        link: 'https://bd.linkedin.com/in/devjasim?trk=public',
        snippet: 'React, Next.js, TypeScript ... Dhaka, Bangladesh.',
      }),
    ).toEqual({
      name: 'Jasim Uddin',
      email: null,
      profileUrl: 'https://bd.linkedin.com/in/devjasim',
      headline: 'Senior Software Engineer · Frontend Team Lead',
      location: null,
      profileText: 'Senior Software Engineer · Frontend Team Lead\nReact, Next.js, TypeScript ... Dhaka, Bangladesh.',
    });
  });

  it('cleans up decorated titles', () => {
    expect(resultToCandidate({ title: 'Md. Ruhul Amin - Software Developer || React || Next.js | LinkedIn', link: 'https://linkedin.com/in/ruhulamin77', snippet: '' })?.headline).toBe(
      'Software Developer · React · Next.js',
    );
    expect(resultToCandidate({ title: 'S M S. - | Full-Stack Software Engineer | LinkedIn', link: 'https://bd.linkedin.com/in/sadif50', snippet: '' })?.headline).toBe(
      'Full-Stack Software Engineer',
    );
  });

  it('skips results that are not a person\'s profile', () => {
    expect(resultToCandidate({ title: 'React Developer Jobs in Dhaka | LinkedIn', link: 'https://www.linkedin.com/jobs/view/123', snippet: '' })).toBeNull();
    expect(resultToCandidate({ title: 'Top 10 React developers', link: 'https://medium.com/x', snippet: '' })).toBeNull();
  });
});

describe('the Serper client', () => {
  const fakeFetch = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('returns the organic results', async () => {
    let sent: { q: string; num: number; page: number } | null = null;
    const client = createSearchClient('k'.repeat(40), (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ organic: [{ title: 'A B - Dev | LinkedIn', link: 'https://www.linkedin.com/in/ab', snippet: 'React' }] }), { status: 200 });
    }) as unknown as typeof fetch);
    expect(client.mode).toBe('serper');
    expect(await client.search('q', 2)).toEqual([{ title: 'A B - Dev | LinkedIn', link: 'https://www.linkedin.com/in/ab', snippet: 'React' }]);
    expect(sent).toEqual({ q: 'q', num: 10, page: 2 });
  });

  it('explains a wrong key and used-up credits', async () => {
    await expect(createSearchClient('k'.repeat(40), fakeFetch(403, {})).search('q', 1)).rejects.toMatchObject({ code: 'SEARCH_KEY_INVALID' });
    await expect(createSearchClient('k'.repeat(40), fakeFetch(400, { message: 'Not enough credits' })).search('q', 1)).rejects.toMatchObject({ code: 'SEARCH_CREDITS' });
  });

  it('uses sample mode without a key', () => {
    expect(createSearchClient().mode).toBe('sample');
  });
});

describe('Find candidates (sample mode, full flow)', () => {
  function makeApp() {
    const ai = createAi({ models: { agent: 'mock', bulk: 'mock', safety: 'mock' } });
    const events = createMemoryEvents();
    const queue = createInlineQueue(() => buildProcessors({ ai, events, queue: () => queue }));
    return { app: createApp({ corsOrigins: ['http://localhost:5173'], ai, events, queue }), queue };
  }

  it('suggests a query, searches, adds only new people, then scores them', async () => {
    const { app, queue } = makeApp();
    const agent = request.agent(app);
    await agent.post('/auth/login').send(RECRUITER).expect(200);
    const job = (await agent.post('/jobs').send(JOB).expect(201)).body.job;

    const suggestion = (await agent.get(`/jobs/${job.id}/source`).expect(200)).body;
    expect(suggestion).toMatchObject({ mode: 'sample', maxPages: 3, query: buildSearchQuery(JOB) });

    await agent.post(`/jobs/${job.id}/source`).send({ pages: 2 }).expect(202);
    await queue.idle();
    expect(await CandidateModel.countDocuments({ jobId: job.id, source: 'web' })).toBe(15); // 10 + 5 sample results
    expect(await CandidateModel.countDocuments({ jobId: job.id, score: null, scoreReason: null })).toBe(0); // all scored
    const search = await TaskModel.findOne({ jobId: job.id, type: 'source_candidates' }).lean();
    expect(search?.message).toBe('Done: 15 profiles found, 15 new. AI scoring has started. (sample results: no SERPER_API_KEY set)');

    // The same search again: everyone is already in the job, nothing added.
    await agent.post(`/jobs/${job.id}/source`).send({ pages: 2, query: 'my own query' }).expect(202);
    await queue.idle();
    expect(await CandidateModel.countDocuments({ jobId: job.id })).toBe(15);
    const log = await ActivityModel.find({ jobId: job.id, message: /^Web search/ }).sort({ createdAt: 1 }).lean();
    expect(log.map((a) => a.message)).toEqual([
      expect.stringMatching(/: 15 profiles found, 15 new, 0 already in this job$/),
      'Web search (sample) "my own query": 15 profiles found, 0 new, 15 already in this job',
    ]);
  });
});
