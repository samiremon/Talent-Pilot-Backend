/**
 * What the AI assistant "knows" about the current situation, rebuilt before every reply.
 *
 * The recruiter (or a teammate) can do everything by hand in the UI as well as through the
 * chat. So the AI can't rely on its own chat history to know what happened: every action
 * is in the Activity log, so we turn the log (plus a short summary of the jobs) into plain
 * text and give it to the AI with each message, with the real name of who did what.
 *
 * CONTEXT-WINDOW BUDGET (keeps every message small and the free AI quota safe):
 *   - the job the recruiter is looking at: full detail; other jobs: one short line each,
 *     at most MAX_OTHER_JOBS (newest first)
 *   - activity: at most `activityLimit` lines, each squeezed to one short line
 *   - a hard cap on the whole text (MAX_CHARS): if it's still too long, the OLDEST
 *     activity lines are dropped first, then the extra jobs
 *   - anything else the AI needs (e.g. a job's candidates) it fetches with a tool, on demand
 *
 * Example output:
 *
 *   ## Jobs
 *   - "Senior React Developer" (id 6af6…, active): 23 candidates: 18 Sourced, 5 Accepted ← open on screen
 *
 *   ## Recent activity on this job (oldest first)
 *   - 2026-11-13 10:40 UTC · Rina (you) · Job created: Senior React Developer
 *   - 2026-11-13 10:42 UTC · AI for Omar (teammate) · Proposed by the AI from a pasted job description…
 *
 * The text is DATA for the AI, not instructions: names and job titles come from outside,
 * so the AI's system prompt tells it to never follow instructions found here.
 */
import { listActivity, listJobs } from '../jobs/service.js';
import { STATUS_LABELS, type CandidateStatus } from '../pipeline/status.js';

/** ~4 characters per token: 6,000 characters ≈ 1,500 tokens. */
const MAX_CHARS = 6000;
const MAX_OTHER_JOBS = 10;

/** "2026-11-13T10:42:05.123Z" -> "2026-11-13 10:42 UTC" (short, unambiguous). */
function shortTime(date: Date | string): string {
  return `${new Date(date).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** Keeps outside text on one line and short, so it can't break the layout of the context. */
export function clean(text: string, max = 200): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * Who did it, from the point of view of the person chatting:
 *   "Rina (you)", "Omar (teammate)", "AI for Rina (you)", "AI for Omar (teammate)", "System".
 * Saying "you"/"teammate" explicitly stops the AI mixing people up (e.g. when an account
 * is literally named "Recruiter").
 */
function who(actor: 'recruiter' | 'ai' | 'system', userId: string | null, userName: string | null, currentUserId?: string): string {
  if (actor === 'system' || !userId) return actor === 'ai' ? 'AI' : 'System';
  const relation = userId === currentUserId ? 'you' : 'teammate';
  const name = clean(userName ?? 'A recruiter', 60);
  return actor === 'ai' ? `AI for ${name} (${relation})` : `${name} (${relation})`;
}

export interface ContextOptions {
  /** The job the recruiter is looking at, if any: its activity is shown in more detail. */
  jobId?: string;
  /** The person chatting, so their own actions are marked "(you)". */
  currentUserId?: string;
  /** How many activity lines to include at most. */
  activityLimit?: number;
}

export async function buildAssistantContext({ jobId, currentUserId, activityLimit = 15 }: ContextOptions = {}): Promise<string> {
  const [jobs, activity] = await Promise.all([listJobs(), listActivity(jobId ? { jobId } : {}, activityLimit)]);

  // The open job first (in full), then the newest others.
  const open = jobs.find((j) => j.id === jobId);
  const others = jobs.filter((j) => j.id !== jobId).slice(0, MAX_OTHER_JOBS);
  const hiddenJobs = jobs.length - (open ? 1 : 0) - others.length;

  const jobLine = (job: (typeof jobs)[number], detailed: boolean) => {
    // Only mention statuses that actually have candidates: shorter and easier to read.
    const breakdown = Object.entries(job.counts)
      .filter(([, n]) => n > 0)
      .map(([status, n]) => `${n} ${STATUS_LABELS[status as CandidateStatus]}`)
      .join(', ');
    const base = `- "${clean(String(job.title), 120)}" (id ${job.id}, ${job.status}): ${job.totalCandidates} candidates${breakdown ? `: ${breakdown}` : ''}`;
    if (!detailed) return base;
    const skills = job.mustHaveSkills.length ? ` | must-have: ${clean(job.mustHaveSkills.join(', '), 160)}` : '';
    return `${base}${skills} ← open on screen`;
  };

  const jobLines = [...(open ? [jobLine(open, true)] : []), ...others.map((j) => jobLine(j, false))];
  if (hiddenJobs > 0) jobLines.push(`- …and ${hiddenJobs} older job(s) (ask, and I can look them up)`);

  // listActivity returns newest first; a story reads better oldest first.
  const activityLines = [...activity]
    .reverse()
    .map(
      (item) =>
        `- ${shortTime(item.createdAt)} · ${who(item.actor, item.userId, item.userName, currentUserId)} · ${clean(item.message, 160)}${item.undone ? ' (later undone)' : ''}${jobId ? '' : ` [${clean(item.jobTitle, 60)}]`}`,
    );

  const render = () =>
    [
      '## Jobs',
      ...(jobLines.length ? jobLines : ['- No jobs yet.']),
      '',
      jobId ? '## Recent activity on this job (oldest first)' : '## Recent activity, all jobs (oldest first)',
      ...(activityLines.length ? activityLines : ['- Nothing yet.']),
    ].join('\n');

  // Budget guard: drop the oldest activity, then extra jobs, until it fits.
  let text = render();
  while (text.length > MAX_CHARS && activityLines.length > 3) {
    activityLines.shift();
    text = render();
  }
  while (text.length > MAX_CHARS && jobLines.length > 1) {
    jobLines.splice(jobLines.length - 1, 1);
    text = render();
  }
  return text;
}
