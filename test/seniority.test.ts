/**
 * Seniority rule: more senior than the job asks is fine, less senior is not.
 */
import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import type { Ai } from '../src/ai/client.js';
import { addCandidates } from '../src/candidates/addCandidates.js';
import { CandidateModel } from '../src/models/candidate.js';
import { JobModel } from '../src/models/job.js';
import { scoreCandidatesProcessor } from '../src/sourcing/scoring.js';
import { applySeniorityCap, jobLevel, parseLevel } from '../src/sourcing/seniority.js';
import { createMemoryEvents } from '../src/tasks/events.js';
import { createTask } from '../src/tasks/service.js';
import { useTestDatabase } from './helpers/db.js';

useTestDatabase();

describe('reading the level', () => {
  it('from a job\'s seniority field or its title', () => {
    expect(parseLevel('Senior')).toBe('senior');
    expect(parseLevel('Mid-level')).toBe('mid');
    expect(parseLevel('Tech Lead')).toBe('lead');
    expect(parseLevel('Junior')).toBe('junior');
    expect(parseLevel('React Developer')).toBeNull();
    expect(jobLevel({ seniority: null, title: 'Senior React Developer (Frontend)' })).toBe('senior');
    expect(jobLevel({ seniority: 'Mid-level', title: 'Senior React Developer' })).toBe('mid'); // the field wins
  });
});

describe('the score cap', () => {
  it('never lowers someone at or above the job level, and caps those below', () => {
    expect(applySeniorityCap(95, 'mid', 'senior')).toEqual({ score: 95, note: null }); // senior for a mid job: fine
    expect(applySeniorityCap(90, 'senior', 'senior')).toEqual({ score: 90, note: null });
    expect(applySeniorityCap(90, 'senior', 'mid')).toEqual({ score: 55, note: 'Mid-level profile for a Senior role: score capped at 55.' });
    expect(applySeniorityCap(90, 'senior', 'junior')).toEqual({ score: 30, note: 'Junior profile for a Senior role: score capped at 30.' });
    expect(applySeniorityCap(20, 'senior', 'junior')).toEqual({ score: 20, note: null }); // already low
    expect(applySeniorityCap(90, 'senior', 'unknown')).toEqual({ score: 90, note: null }); // the AI says "unclear" itself
    expect(applySeniorityCap(90, null, 'junior')).toEqual({ score: 90, note: null }); // job doesn't say
  });

  it('is applied to the AI\'s scores during scoring', async () => {
    const job = await JobModel.create({ title: 'Senior React Developer', description: 'x'.repeat(30), createdBy: new Types.ObjectId(), mustHaveSkills: ['React'] });
    await addCandidates(job._id, 'csv', [
      { name: 'Sam Senior', email: 's@example.com', profileText: 'Senior engineer, 8 years of React' },
      { name: 'Jo Junior', email: 'j@example.com', profileText: 'Junior developer, 1 year of React' },
    ]);
    // The AI (fake here) gives both 90 but reports their levels.
    const ai = {
      mode: 'live',
      async structured<T>(req: { user: string }) {
        const { job: sent, candidates } = JSON.parse(req.user) as { job: { seniority: string }; candidates: { id: string; text: string }[] };
        expect(sent.seniority).toBe('Senior'); // the job's level is sent to the AI
        return {
          data: { results: candidates.map((c) => ({ id: c.id, level: c.text.startsWith('Junior') ? 'junior' : 'senior', score: 90, reason: 'Strong React.', evidence: [] })) } as T,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    } as unknown as Ai;
    const events = createMemoryEvents();
    const task = await createTask(events, { jobId: String(job._id), type: 'score_candidates', total: 2 });
    await scoreCandidatesProcessor({ ai, events })({ taskId: task.id, jobId: String(job._id) }, { number: 1, isLast: true });

    const sam = await CandidateModel.findOne({ name: 'Sam Senior' }).lean();
    const jo = await CandidateModel.findOne({ name: 'Jo Junior' }).lean();
    expect(sam).toMatchObject({ score: 90, level: 'senior', scoreReason: 'Strong React.' });
    expect(jo).toMatchObject({ score: 30, level: 'junior', scoreReason: 'Strong React. Junior profile for a Senior role: score capped at 30.' });
  });
});
