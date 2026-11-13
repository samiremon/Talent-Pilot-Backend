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
import { buildSearchQuery, createSearchClient, resultToCandidate, suggestedSources } from '../src/sourcing/search.js';
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

describe('the search queries', () => {
  it('are built from the job: quoted skills, the role without level words, the location unquoted', () => {
    expect(buildSearchQuery(JOB)).toBe('site:linkedin.com/in "React" "TypeScript" "Next.js" Developer Frontend Dhaka Bangladesh');
    expect(buildSearchQuery(JOB, 'github')).toBe('site:github.com "React" "TypeScript" Dhaka Bangladesh');
    expect(buildSearchQuery(JOB, 'stackoverflow')).toBe('site:stackoverflow.com/users "React" "TypeScript" Dhaka Bangladesh');
    expect(buildSearchQuery({ title: 'Data Engineer', mustHaveSkills: [], location: null })).toBe('site:linkedin.com/in Data Engineer');
  });

  it('suggest the sources that fit the job title', () => {
    expect(suggestedSources('Senior React Developer (Frontend)')).toEqual(['linkedin', 'github', 'stackoverflow']);
    expect(suggestedSources('AI Engineer')).toEqual(['linkedin', 'github', 'kaggle']);
    expect(suggestedSources('HR Manager')).toEqual(['linkedin']);
  });
});

describe('GitHub, Stack Overflow and Kaggle results (real titles from Google)', () => {
  const person = (title: string, link: string) => resultToCandidate({ title, link, snippet: 'React TypeScript' });

  it('reads people from GitHub and skips repositories and site pages', () => {
    expect(person('Tahsin Zaman Tahsin0909', 'https://github.com/Tahsin0909')).toMatchObject({ name: 'Tahsin Zaman', profileUrl: 'https://github.com/Tahsin0909' });
    expect(person('MANISH DHAKA Manishbhai9350', 'https://github.com/Manishbhai9350')?.name).toBe('MANISH DHAKA');
    expect(person('Md-Kais', 'https://github.com/Md-Kais')?.name).toBe('Md-Kais');
    expect(person('Ujjal Kumar Roy - Full-Stack Software Engineer', 'https://github.com/ujjal-kumar-roy/ujjal-kumar-roy')).toMatchObject({
      name: 'Ujjal Kumar Roy',
      headline: 'Full-Stack Software Engineer',
      profileUrl: 'https://github.com/ujjal-kumar-roy',
    });
    expect(person('imran-binhasan/bangladesh-tech-companies', 'https://github.com/imran-binhasan/bangladesh-tech-companies')).toBeNull();
    expect(person('Where software is built', 'https://github.com/orgs/Learn-with-Sumit/followers')).toBeNull();
  });

  it('reads people from Stack Overflow, not the "story" pages', () => {
    expect(person('User Mohammad Faisal', 'https://stackoverflow.com/users/5379437/mohammad-faisal')).toMatchObject({
      name: 'Mohammad Faisal',
      profileUrl: 'https://stackoverflow.com/users/5379437/mohammad-faisal',
    });
    expect(person('User Mushfiq - Meta Stack Overflow', 'https://meta.stackoverflow.com/users/1421285/mushfiq')?.name).toBe('Mushfiq');
    expect(person('Stack Overflow Dev Story', 'https://stackoverflow.com/users/story/13574278?embed=profile')).toBeNull();
  });

  it('reads people from Kaggle and skips datasets and competitions', () => {
    expect(person('Arif Miah', 'https://www.kaggle.com/miadul')).toMatchObject({ name: 'Arif Miah', profileUrl: 'https://www.kaggle.com/miadul' });
    expect(person('Rakibul Alam', 'https://www.kaggle.com/ludocielbeckett/followers')?.profileUrl).toBe('https://www.kaggle.com/ludocielbeckett');
    expect(person('ESG with Machine Learning: Bangladesh', 'https://www.kaggle.com/datasets/drtawfikrrahman/esg-with-machine-learning-bangladesh')).toBeNull();
    expect(person('Build With Gemma @Bangladesh', 'https://www.kaggle.com/competitions/build-with-gemma-bangladesh/')).toBeNull();
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
      profileUrl: 'https://www.linkedin.com/in/devjasim', // country subdomains -> one link, so duplicates match
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

  it('rejects a search with no source', async () => {
    const { app } = makeApp();
    const agent = request.agent(app);
    await agent.post('/auth/login').send(RECRUITER).expect(200);
    const job = (await agent.post('/jobs').send(JOB).expect(201)).body.job;
    await agent.post(`/jobs/${job.id}/source`).send({ searches: [] }).expect(400);
  });

  it('suggests queries, searches, adds only new people, then scores them', async () => {
    const { app, queue } = makeApp();
    const agent = request.agent(app);
    await agent.post('/auth/login').send(RECRUITER).expect(200);
    const job = (await agent.post('/jobs').send(JOB).expect(201)).body.job;

    const suggestion = (await agent.get(`/jobs/${job.id}/source`).expect(200)).body;
    expect(suggestion).toMatchObject({ mode: 'sample', maxPages: 3 });
    expect(suggestion.sources.map((s: { source: string; suggested: boolean }) => [s.source, s.suggested])).toEqual([
      ['linkedin', true],
      ['github', true],
      ['stackoverflow', true],
      ['kaggle', false],
    ]);

    await agent.post(`/jobs/${job.id}/source`).send({ pages: 2 }).expect(202);
    await queue.idle();
    expect(await CandidateModel.countDocuments({ jobId: job.id, source: 'web' })).toBe(15); // 10 + 5 sample results
    expect(await CandidateModel.countDocuments({ jobId: job.id, score: null, scoreReason: null })).toBe(0); // all scored
    const search = await TaskModel.findOne({ jobId: job.id, type: 'source_candidates' }).lean();
    expect(search?.message).toBe('Done: 15 profiles found, 15 new. AI scoring has started. (sample results: no SERPER_API_KEY set)');

    // Who was added is kept on the task (the chat reports how they scored).
    expect((search?.result as { candidateIds: string[] }).candidateIds).toHaveLength(15);

    // The same search again: everyone is already in the job, nothing added.
    await agent.post(`/jobs/${job.id}/source`).send({ pages: 2, searches: [{ source: 'linkedin', query: 'my own query' }] }).expect(202);
    await queue.idle();
    expect(await CandidateModel.countDocuments({ jobId: job.id })).toBe(15);
    const log = await ActivityModel.find({ jobId: job.id, message: /^Web search/ }).sort({ createdAt: 1 }).lean();
    expect(log.map((a) => a.message)).toEqual([
      'Web search (sample) on LinkedIn, GitHub, Stack Overflow: 15 profiles found, 15 new, 0 already in this job',
      'Web search (sample) on LinkedIn: 15 profiles found, 0 new, 15 already in this job',
    ]);
  });

  it('works from the AI card: Confirm with the sites the recruiter ticked, then posts the best matches', async () => {
    const { app, queue } = makeApp();
    const agent = request.agent(app);
    await agent.post('/auth/login').send(RECRUITER).expect(200);
    const job = (await agent.post('/jobs').send(JOB).expect(201)).body.job;
    const user = await (await import('../src/models/user.js')).UserModel.findOne({ email: RECRUITER.email });
    const { proposeAction } = await import('../src/chat/actions.js');
    const { suggestSearches } = await import('../src/sourcing/search.js');
    const searches = suggestSearches(JOB).map((s) => ({ ...s, checked: s.suggested }));
    const card = await proposeAction(String(user!._id), 'find_candidates', { jobId: job.id, jobCode: job.jobCode, title: job.title, searches, pages: 1 });
    expect(await TaskModel.countDocuments({ jobId: job.id })).toBe(0); // nothing until Confirm

    // The recruiter unticks everything but GitHub before confirming.
    const edited = searches.map((s) => ({ ...s, checked: s.source === 'github' }));
    const res = await agent.post(`/chat/actions/${card._id}/confirm`).send({ fields: { searches: edited, pages: 1 } }).expect(200);
    expect(res.body.message.text).toMatch(/^Done: searching GitHub for JOB-0001\./);
    await queue.idle();

    const follow = await agent.post(`/chat/actions/${card._id}/follow-up`).send({}).expect(200);
    expect(follow.body.message.text).toMatch(/^The web search on GitHub found 10 profiles for JOB-0001: 10 new \(10 scored in this job now\)\.\n\nBest new matches:\n- \*\*/);
    const log = await ActivityModel.findOne({ jobId: job.id, message: /^Web search/ }).lean();
    expect(log?.message).toBe('Web search (sample) on GitHub: 10 profiles found, 10 new, 0 already in this job');
    expect(log?.actor).toBe('ai');
  });
});
