/**
 * Tests for jobs, candidates and the activity log: duplicate protection, status changes
 * that follow the rules, the history log, and Undo. Uses an in-memory MongoDB.
 */
import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { addCandidates } from '../src/candidates/addCandidates.js';
import { normalizeEmail, normalizeProfileUrl } from '../src/candidates/normalize.js';
import { changeCandidateStatus, undoStatusChange } from '../src/candidates/statusChange.js';
import { AppError } from '../src/errors.js';
import { ActivityModel } from '../src/models/activity.js';
import { CandidateModel } from '../src/models/candidate.js';
import { JobModel } from '../src/models/job.js';
import { useTestDatabase } from './helpers/db.js';

useTestDatabase();

async function makeJob() {
  return JobModel.create({
    title: 'Senior React Developer',
    description: 'We are hiring a Senior React Developer...',
    mustHaveSkills: ['React', 'TypeScript'],
    createdBy: new Types.ObjectId(),
  });
}

describe('normalizing', () => {
  it('cleans emails and rejects non-emails', () => {
    expect(normalizeEmail('  Sara.Ahmed@Example.COM ')).toBe('sara.ahmed@example.com');
    expect(normalizeEmail('not an email')).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
  });

  it('turns different spellings of the same profile link into one', () => {
    const forms = [
      'https://www.linkedin.com/in/Sara-Ahmed/',
      'http://linkedin.com/in/sara-ahmed?utm_source=x#about',
      'linkedin.com/in/sara-ahmed',
    ];
    expect(new Set(forms.map(normalizeProfileUrl))).toEqual(new Set(['https://linkedin.com/in/sara-ahmed']));
    expect(normalizeProfileUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeProfileUrl('')).toBeNull();
  });
});

describe('a new job', () => {
  it('fills safe defaults and never invents missing details', async () => {
    const job = await makeJob();
    expect(job.status).toBe('active');
    expect(job.remotePolicy).toBe('unknown');
    expect(job.salary).toBeNull();
    expect(job.aiUsage).toMatchObject({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
  });
});

describe('adding candidates', () => {
  it('skips duplicates inside the batch, against the job, and invalid rows', async () => {
    const job = await makeJob();

    const first = await addCandidates(job._id, 'web', [
      { name: 'Sara Ahmed', profileUrl: 'https://www.linkedin.com/in/sara-ahmed/' },
      { name: 'Rahim Uddin', email: 'rahim@example.com' },
      { name: 'Rahim again', email: 'RAHIM@example.com' }, // same email, other case
      { name: 'No contact' }, // no email or link: unusable
    ]);
    expect(first).toEqual({ added: 2, duplicates: 1, invalid: 1 });

    // CSV brings Sara again (other spelling of her link) plus one new person.
    const second = await addCandidates(job._id, 'csv', [
      { name: 'Sara A.', profileUrl: 'linkedin.com/in/Sara-Ahmed?ref=csv' },
      { name: 'Nadia Islam', email: 'nadia@example.com' },
    ]);
    expect(second).toEqual({ added: 1, duplicates: 1, invalid: 0 });
    expect(await CandidateModel.countDocuments({ jobId: job._id })).toBe(3);

    // Each successful import is written to the history.
    const log = await ActivityModel.find({ jobId: job._id, type: 'candidates_added' }).sort({ createdAt: 1 });
    expect(log.map((a) => a.message)).toEqual([
      'Added 2 candidates from web search (1 duplicate skipped)',
      'Added 1 candidate from CSV upload (1 duplicate skipped)',
    ]);
  });

  it('lets the database itself block a duplicate that slips past the checks', async () => {
    const job = await makeJob();
    await CandidateModel.create({ jobId: job._id, name: 'Sara', email: 'sara@example.com', source: 'web' });
    await expect(
      CandidateModel.create({ jobId: job._id, name: 'Sara 2', email: 'sara@example.com', source: 'csv' }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('allows the same person in two different jobs, and many people without email', async () => {
    const [jobA, jobB] = await Promise.all([makeJob(), makeJob()]);
    await addCandidates(jobA._id, 'web', [{ name: 'Sara', email: 'sara@example.com' }]);
    expect((await addCandidates(jobB._id, 'web', [{ name: 'Sara', email: 'sara@example.com' }])).added).toBe(1);
    const noEmail = await addCandidates(jobA._id, 'web', [
      { name: 'A', profileUrl: 'linkedin.com/in/a' },
      { name: 'B', profileUrl: 'linkedin.com/in/b' },
    ]);
    expect(noEmail.added).toBe(2);
  });
});

describe('status changes', () => {
  async function makeCandidate() {
    const job = await makeJob();
    return CandidateModel.create({ jobId: job._id, name: 'Rahim Uddin', email: 'rahim@example.com', source: 'web' });
  }

  it('applies an allowed move and records who did it', async () => {
    const candidate = await makeCandidate();
    const userId = new Types.ObjectId();
    const { candidate: updated, activity } = await changeCandidateStatus({
      candidateId: candidate._id,
      to: 'accepted',
      actor: 'recruiter',
      userId,
    });
    expect(updated.status).toBe('accepted');
    expect(activity).toMatchObject({
      type: 'status_changed',
      actor: 'recruiter',
      fromStatus: 'sourced',
      toStatus: 'accepted',
      message: 'Rahim Uddin: Sourced → Accepted',
    });
    expect(String(activity.userId)).toBe(String(userId));
  });

  it('refuses a move that breaks the rules, explains why, and changes nothing', async () => {
    const candidate = await makeCandidate();
    const attempt = changeCandidateStatus({ candidateId: candidate._id, to: 'hired', actor: 'ai' });
    await expect(attempt).rejects.toBeInstanceOf(AppError);
    await expect(attempt).rejects.toMatchObject({ status: 409, code: 'STATUS_NOT_ALLOWED' });
    await expect(attempt).rejects.toThrow(/Can't mark Rahim Uddin as Hired yet/);

    expect((await CandidateModel.findById(candidate._id))?.status).toBe('sourced');
    expect(await ActivityModel.countDocuments({ type: 'status_changed' })).toBe(0);
  });

  it('can undo a change once, back to the previous status', async () => {
    const candidate = await makeCandidate();
    const { activity } = await changeCandidateStatus({ candidateId: candidate._id, to: 'rejected', actor: 'recruiter' });

    const undo = await undoStatusChange({ activityId: activity._id, actor: 'recruiter' });
    expect(undo.candidate.status).toBe('sourced');
    expect(undo.activity).toMatchObject({ type: 'status_undone', fromStatus: 'rejected', toStatus: 'sourced' });
    expect((await ActivityModel.findById(activity._id))?.undone).toBe(true);

    await expect(undoStatusChange({ activityId: activity._id, actor: 'recruiter' })).rejects.toThrow(/already been undone/);
  });

  it('will not undo an older change after the candidate has moved on', async () => {
    const candidate = await makeCandidate();
    const first = await changeCandidateStatus({ candidateId: candidate._id, to: 'accepted', actor: 'recruiter' });
    await changeCandidateStatus({ candidateId: candidate._id, to: 'contacted', actor: 'system' });

    await expect(undoStatusChange({ activityId: first.activity._id, actor: 'recruiter' })).rejects.toThrow(
      /Undo the newer change first/,
    );
    expect((await CandidateModel.findById(candidate._id))?.status).toBe('contacted');
  });
});
