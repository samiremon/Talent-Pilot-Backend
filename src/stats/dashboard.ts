/**
 * Dashboard numbers: the hiring FUNNEL and the key rates, per job and for all jobs.
 *
 * Why not just count today's statuses?
 *   A candidate's status only shows where they are NOW. Someone who was Interviewed and
 *   then Rejected is "Rejected" today, but they still passed through Contacted, Replied,
 *   Interested, Meeting booked and Interviewed. If we only counted current statuses, every
 *   rejection would make the funnel "forget" people, and the reply rate would drop each
 *   time the recruiter said no to someone.
 *
 * So the funnel here is CUMULATIVE ("how many candidates ever REACHED this stage"):
 *   - each funnel stage has a step number (Sourced 0 ... Hired 8)
 *   - for every candidate we find the furthest step they ever reached, using
 *       1. their current status, and
 *       2. their status history in the activity log (status changes that were NOT undone;
 *          an undone change was a mistake, so it doesn't count)
 *   - "reached Replied" = furthest step >= Replied, and so on.
 *
 * Side statuses are mapped to the main stage they prove:
 *   Not interested  -> they Replied (but never became Interested)
 *   Unsubscribed    -> they were Contacted
 *   Not accepted / Rejected -> nothing on their own (the history tells how far they got)
 *
 * The rates built from that funnel:
 *   reply rate       = reached Replied    ÷ reached Contacted   (did people answer our emails?)
 *   interested rate  = reached Interested ÷ reached Replied     (of those who answered, how many wanted to talk?)
 *   meetings         = reached Meeting booked (booked via the link, or moved there by hand)
 *   hires            = reached Hired
 *
 * Used by GET /stats/overview (Dashboard page) and by the chat assistant's
 * get_hiring_stats tool, so the page and the AI always say the same numbers.
 */
import { Types } from 'mongoose';
import { ActivityModel } from '../models/activity.js';
import { CandidateModel } from '../models/candidate.js';
import { jobCode } from '../models/counter.js';
import { JobModel } from '../models/job.js';
import { CANDIDATE_STATUSES, type CandidateStatus } from '../pipeline/status.js';

/** The funnel stages, top to bottom. Their position in this list is their "step". */
export const FUNNEL_STAGES = [
  'sourced',
  'accepted',
  'contacted',
  'replied',
  'interested',
  'meeting_booked',
  'interviewed',
  'shortlisted',
  'hired',
] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

/** { sourced: 10, accepted: 6, ... } = how many candidates reached each stage. */
export type Funnel = Record<FunnelStage, number>;

/**
 * Which funnel step a status PROVES the candidate reached. -1 = proves nothing beyond
 * "they exist" (every candidate counts as Sourced anyway).
 */
const STEP_OF: Record<CandidateStatus, number> = {
  sourced: 0,
  accepted: 1,
  not_accepted: 0, // reviewed and turned down: only Sourced
  rejected: 0, // the history says how far they got before
  contacted: 2,
  unsubscribed: 2, // you can only unsubscribe from an email you got
  replied: 3,
  not_interested: 3, // they answered, but said no
  interested: 4,
  meeting_booked: 5,
  interviewed: 6,
  shortlisted: 7,
  hired: 8,
};

function emptyFunnel(): Funnel {
  return Object.fromEntries(FUNNEL_STAGES.map((s) => [s, 0])) as Funnel;
}

function emptyCounts(): Record<CandidateStatus, number> {
  return Object.fromEntries(CANDIDATE_STATUSES.map((s) => [s, 0])) as Record<CandidateStatus, number>;
}

/** a ÷ b, or null when there's nothing to divide by (the UI shows "–" instead of 0%). */
function rate(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** The numbers for one job (or for all jobs together). */
export interface JobStats {
  /** Cumulative funnel: candidates who ever reached each stage. */
  funnel: Funnel;
  /** Where candidates are RIGHT NOW (includes side statuses like Rejected). */
  current: Record<CandidateStatus, number>;
  totalCandidates: number;
  replyRate: number | null;
  interestedRate: number | null;
  meetings: number;
  hires: number;
}

/** Turns a funnel + current counts into the full stats object (rates included). */
function finish(funnel: Funnel, current: Record<CandidateStatus, number>): JobStats {
  return {
    funnel,
    current,
    totalCandidates: funnel.sourced, // every candidate reached "Sourced"
    replyRate: rate(funnel.replied, funnel.contacted),
    interestedRate: rate(funnel.interested, funnel.replied),
    meetings: funnel.meeting_booked,
    hires: funnel.hired,
  };
}

/**
 * The furthest funnel step each candidate ever reached, from the activity log.
 * Only status rows count, and an undone change is ignored (it was a mistake).
 * For a status change we also use the status they came FROM: if someone was moved
 * Interviewed -> Rejected, that row alone proves they reached Interviewed.
 */
async function furthestStepFromHistory(candidateIds: Types.ObjectId[]): Promise<Map<string, number>> {
  const furthest = new Map<string, number>();
  if (candidateIds.length === 0) return furthest;
  const rows = await ActivityModel.find(
    {
      candidateId: { $in: candidateIds },
      $or: [
        { type: 'status_changed', undone: { $ne: true } },
        // An Undo puts them back to an earlier status: that status was real.
        { type: 'status_undone' },
      ],
    },
    { candidateId: 1, type: 1, fromStatus: 1, toStatus: 1 },
  ).lean();

  for (const row of rows) {
    const key = String(row.candidateId);
    // For an undo row, only the status they went back TO counts (the "from" was the mistake).
    const statuses = row.type === 'status_undone' ? [row.toStatus] : [row.fromStatus, row.toStatus];
    for (const status of statuses) {
      if (!status) continue;
      const step = STEP_OF[status as CandidateStatus] ?? 0;
      if (step > (furthest.get(key) ?? 0)) furthest.set(key, step);
    }
  }
  return furthest;
}

export interface JobStatsRow extends JobStats {
  id: string;
  jobCode: string | null;
  title: string;
  status: string;
  createdAt: Date;
}

export interface HiringStats {
  /** All jobs together. */
  overall: JobStats;
  /** One row per job, newest job first. */
  jobs: JobStatsRow[];
}

/**
 * Works out the dashboard numbers. Pass `jobIds` to limit it to some jobs (the chat
 * tool does that for "how is JOB-0003 doing?"); leave it out for every job.
 *
 * Cost: two small queries (candidates' ids+statuses, and their status history), done in
 * memory. Fine for thousands of candidates; for much more we'd keep running counters.
 */
export async function hiringStats(jobIds?: Types.ObjectId[]): Promise<HiringStats> {
  const jobFilter = jobIds ? { _id: { $in: jobIds } } : {};
  const jobs = await JobModel.find(jobFilter, { title: 1, status: 1, createdAt: 1, jobNumber: 1 }).sort({ createdAt: -1 }).lean();
  const candidates = await CandidateModel.find({ jobId: { $in: jobs.map((j) => j._id) } }, { jobId: 1, status: 1 }).lean();
  const history = await furthestStepFromHistory(candidates.map((c) => c._id));

  // Per job: the cumulative funnel and today's status counts.
  const funnels = new Map<string, Funnel>();
  const currents = new Map<string, Record<CandidateStatus, number>>();
  const overallFunnel = emptyFunnel();
  const overallCurrent = emptyCounts();

  for (const c of candidates) {
    const jobKey = String(c.jobId);
    const status = c.status as CandidateStatus;
    // The furthest they got = the best of "where they are now" and "where they've been".
    const step = Math.max(STEP_OF[status] ?? 0, history.get(String(c._id)) ?? 0);

    const funnel = funnels.get(jobKey) ?? emptyFunnel();
    const current = currents.get(jobKey) ?? emptyCounts();
    // Reaching step N means they also passed every stage before it.
    for (let i = 0; i <= step; i++) {
      funnel[FUNNEL_STAGES[i]!]++;
      overallFunnel[FUNNEL_STAGES[i]!]++;
    }
    current[status]++;
    overallCurrent[status]++;
    funnels.set(jobKey, funnel);
    currents.set(jobKey, current);
  }

  return {
    overall: finish(overallFunnel, overallCurrent),
    jobs: jobs.map((j) => ({
      id: String(j._id),
      jobCode: jobCode((j as { jobNumber?: number | null }).jobNumber),
      title: j.title,
      status: j.status,
      createdAt: j.createdAt as Date,
      ...finish(funnels.get(String(j._id)) ?? emptyFunnel(), currents.get(String(j._id)) ?? emptyCounts()),
    })),
  };
}

/** "42%" or "–" (for the chat tool's plain-text answer). */
function pct(value: number | null): string {
  return value === null ? '–' : `${Math.round(value * 100)}%`;
}

/**
 * The same numbers as short plain text, for the AI assistant (compact on purpose:
 * it's sent to the model, and the free tier counts every token).
 */
export function describeStats(stats: HiringStats, label = 'All jobs'): string {
  const line = (name: string, s: JobStats) => {
    const f = s.funnel;
    return (
      `${name}: funnel Sourced ${f.sourced} > Accepted ${f.accepted} > Contacted ${f.contacted} > Replied ${f.replied} > ` +
      `Interested ${f.interested} > Meeting booked ${f.meeting_booked} > Interviewed ${f.interviewed} > Shortlisted ${f.shortlisted} > Hired ${f.hired}. ` +
      `Reply rate ${pct(s.replyRate)}, interested rate ${pct(s.interestedRate)}, meetings ${s.meetings}, hires ${s.hires}.`
    );
  };
  return [
    '(Funnel = candidates who ever REACHED each stage, so rejected people still count for the stages they passed. Reply rate = replied ÷ contacted; interested rate = interested ÷ replied.)',
    line(label, stats.overall),
    ...(stats.jobs.length > 1 ? stats.jobs.slice(0, 15).map((j) => line(`${j.jobCode ?? 'Job'} "${j.title}"`, j)) : []),
  ].join('\n');
}
