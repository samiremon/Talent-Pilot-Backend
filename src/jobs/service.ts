/**
 * Reading and creating jobs, plus the numbers the pages show (candidate counts per
 * status, dashboard totals). Routes in jobs/routes.ts call these.
 */
import { Types } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { ActivityModel } from '../models/activity.js';
import { CandidateModel } from '../models/candidate.js';
import { JobModel, REMOTE_POLICIES } from '../models/job.js';
import { CANDIDATE_STATUSES, type CandidateStatus } from '../pipeline/status.js';

/** { sourced: 3, accepted: 1, ... } with every status present (0 if none). */
export type StatusCounts = Record<CandidateStatus, number>;

function emptyCounts(): StatusCounts {
  return Object.fromEntries(CANDIDATE_STATUSES.map((s) => [s, 0])) as StatusCounts;
}

/**
 * Counts candidates per status, grouped by job, in ONE database query
 * (instead of one query per job per status).
 */
async function countByJob(jobIds?: Types.ObjectId[]): Promise<Map<string, StatusCounts>> {
  const rows = await CandidateModel.aggregate<{ _id: { jobId: Types.ObjectId; status: CandidateStatus }; n: number }>([
    ...(jobIds ? [{ $match: { jobId: { $in: jobIds } } }] : []),
    { $group: { _id: { jobId: '$jobId', status: '$status' }, n: { $sum: 1 } } },
  ]);
  const byJob = new Map<string, StatusCounts>();
  for (const row of rows) {
    const key = String(row._id.jobId);
    const counts = byJob.get(key) ?? emptyCounts();
    counts[row._id.status] = row.n;
    byJob.set(key, counts);
  }
  return byJob;
}

function total(counts: StatusCounts): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

/** Turns a URL id into a MongoDB id, or answers 404 for anything malformed. */
export function parseId(id: string, what = 'Job'): Types.ObjectId {
  if (!Types.ObjectId.isValid(id)) throw AppError.notFound(`${what} not found`);
  return new Types.ObjectId(id);
}

/** The shape of a job sent to the browser. */
function present<T extends { _id: unknown; description: string; __v?: unknown }>(job: T, counts: StatusCounts) {
  // Generic <T> keeps the real field types (title, status, ...) for whoever calls this.
  const { _id, __v, description, ...rest } = job;
  void __v;
  return {
    id: String(_id),
    ...rest,
    // The full JD can be long; lists only need a preview. GET /jobs/:id returns it all.
    descriptionPreview: typeof description === 'string' ? description.slice(0, 280) : '',
    counts,
    totalCandidates: total(counts),
  };
}

export async function listJobs() {
  const jobs = await JobModel.find().sort({ createdAt: -1 }).lean();
  const counts = await countByJob(jobs.map((j) => j._id));
  return jobs.map((job) => present(job, counts.get(String(job._id)) ?? emptyCounts()));
}

export async function getJob(id: string) {
  const job = await JobModel.findById(parseId(id)).lean();
  if (!job) throw AppError.notFound('Job not found');
  const counts = (await countByJob([job._id])).get(String(job._id)) ?? emptyCounts();
  return { ...present(job, counts), description: job.description };
}

export async function listCandidates(jobId: string) {
  const id = parseId(jobId);
  if (!(await JobModel.exists({ _id: id }))) throw AppError.notFound('Job not found');
  // Best score first; unscored candidates (null) after the scored ones.
  const rows = await CandidateModel.find({ jobId: id }).sort({ score: -1, createdAt: 1 }).lean();
  return rows.map(({ _id, __v, jobId: job, ...rest }) => {
    void __v;
    return { id: String(_id), jobId: String(job), ...rest };
  });
}

export async function listActivity(filter: { jobId?: string }, limit = 100) {
  const query = filter.jobId ? { jobId: parseId(filter.jobId) } : {};
  const rows = await ActivityModel.find(query).sort({ createdAt: -1 }).limit(limit).lean();
  return rows.map(({ _id, __v, jobId, candidateId, userId, undoOf, ...rest }) => {
    void __v;
    void userId;
    return {
      id: String(_id),
      jobId: String(jobId),
      candidateId: candidateId ? String(candidateId) : null,
      undoOf: undoOf ? String(undoOf) : null,
      ...rest,
    };
  });
}

/** What the recruiter confirms on the job card. Empty strings become null ("Unknown"). */
const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const skills = z.array(z.string().trim().min(1).max(60)).max(30).default([]);

export const createJobInput = z.object({
  title: z.string().trim().min(1, 'is required').max(200),
  company: z.preprocess(blankToNull, z.string().trim().max(200).nullable().default(null)),
  description: z.string().trim().min(20, 'must be at least 20 characters').max(50_000),
  sourceUrl: z.preprocess(blankToNull, z.url({ protocol: /^https?$/ }).nullable().default(null)),
  mustHaveSkills: skills,
  niceToHaveSkills: skills,
  seniority: z.preprocess(blankToNull, z.string().trim().max(60).nullable().default(null)),
  location: z.preprocess(blankToNull, z.string().trim().max(200).nullable().default(null)),
  salary: z.preprocess(blankToNull, z.string().trim().max(100).nullable().default(null)),
  remotePolicy: z.enum(REMOTE_POLICIES).default('unknown'),
});
export type CreateJobInput = z.infer<typeof createJobInput>;

/**
 * Saves a job the recruiter has confirmed, and logs it.
 * `actor` says who pressed the button: normally the recruiter confirming the AI's card.
 */
export async function createJob(input: CreateJobInput, userId: string) {
  const job = await JobModel.create({ ...input, createdBy: new Types.ObjectId(userId) });
  await ActivityModel.create({
    jobId: job._id,
    type: 'job_created',
    actor: 'recruiter',
    userId: new Types.ObjectId(userId),
    message: `Job created: ${job.title}`,
  });
  return getJob(String(job._id));
}

/**
 * Dashboard numbers across all jobs.
 * Reply rate = candidates who replied (or got further) ÷ candidates we contacted.
 * Based on current statuses for now; becomes exact once emails are tracked.
 */
export async function overview() {
  const [jobs, perJob, recent] = await Promise.all([
    JobModel.find({}, { title: 1, status: 1, aiUsage: 1, createdAt: 1 }).sort({ createdAt: -1 }).lean(),
    countByJob(),
    listActivity({}, 10),
  ]);

  const counts = emptyCounts();
  for (const jobCounts of perJob.values()) {
    for (const status of CANDIDATE_STATUSES) counts[status] += jobCounts[status];
  }

  const repliedOrLater = ['replied', 'interested', 'not_interested', 'meeting_booked', 'interviewed', 'shortlisted', 'hired'] as const;
  const contactedOrLater = [...repliedOrLater, 'contacted', 'unsubscribed'] as const;
  const replied = repliedOrLater.reduce((n, s) => n + counts[s], 0);
  const contacted = contactedOrLater.reduce((n, s) => n + counts[s], 0);

  return {
    activeJobs: jobs.filter((j) => j.status === 'active').length,
    totalCandidates: total(counts),
    hires: counts.hired,
    replyRate: contacted > 0 ? replied / contacted : null,
    aiCostUsd: jobs.reduce((sum, j) => sum + (j.aiUsage?.costUsd ?? 0), 0),
    counts,
    recentActivity: recent,
    jobs: jobs.slice(0, 5).map((j) => {
      const c = perJob.get(String(j._id)) ?? emptyCounts();
      return { id: String(j._id), title: j.title, status: j.status, totalCandidates: total(c), hired: c.hired };
    }),
  };
}
