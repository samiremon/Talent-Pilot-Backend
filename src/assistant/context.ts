/**
 * What the AI assistant "knows" about the current situation, rebuilt before every reply.
 *
 * The recruiter can do everything by hand in the UI as well as through the chat. So the
 * AI can't rely on its own chat history to know what happened: someone may have created
 * a job, rejected a candidate or undone a change with a button. Every one of those
 * actions is in the Activity log, so we turn the log (plus a short summary of the jobs)
 * into plain text and give it to the AI with each message.
 *
 * Example output:
 *
 *   ## Jobs
 *   - "Senior React Developer" (id 6af6…, active): 23 candidates: 18 Sourced, 5 Accepted
 *
 *   ## Recent activity (oldest first)
 *   - 2026-11-13 10:40 UTC · Recruiter (in the UI) · Job created: Senior React Developer
 *   - 2026-11-13 10:42 UTC · AI · Sara Ahmed: Sourced → Accepted
 *
 * The text is DATA for the AI, not instructions: candidate names and job titles come
 * from outside, so the AI's system prompt tells it to never follow instructions found here.
 */
import { listActivity, listJobs } from '../jobs/service.js';
import { STATUS_LABELS, type CandidateStatus } from '../pipeline/status.js';

const ACTOR_LABELS = { recruiter: 'Recruiter (in the UI)', ai: 'AI', system: 'System' } as const;

/** "2026-11-13T10:42:05.123Z" -> "2026-11-13 10:42 UTC" (short, unambiguous). */
function shortTime(date: Date | string): string {
  return `${new Date(date).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** Keeps outside text on one line and short, so it can't break the layout of the context. */
function clean(text: string, max = 200): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

export interface ContextOptions {
  /** The job the recruiter is looking at, if any: its activity is shown in more detail. */
  jobId?: string;
  /** How many activity lines to include. */
  activityLimit?: number;
}

export async function buildAssistantContext({ jobId, activityLimit = 30 }: ContextOptions = {}): Promise<string> {
  const [jobs, activity] = await Promise.all([listJobs(), listActivity(jobId ? { jobId } : {}, activityLimit)]);

  const lines: string[] = ['## Jobs'];
  if (jobs.length === 0) {
    lines.push('- No jobs yet.');
  } else {
    for (const job of jobs.slice(0, 20)) {
      // Only mention statuses that actually have candidates: shorter and easier to read.
      const breakdown = Object.entries(job.counts)
        .filter(([, n]) => n > 0)
        .map(([status, n]) => `${n} ${STATUS_LABELS[status as CandidateStatus]}`)
        .join(', ');
      const marker = job.id === jobId ? ' ← the recruiter is looking at this job' : '';
      lines.push(
        `- "${clean(String(job.title), 120)}" (id ${job.id}, ${job.status}): ${job.totalCandidates} candidates${breakdown ? `: ${breakdown}` : ''}${marker}`,
      );
    }
  }

  lines.push('', jobId ? '## Recent activity on this job (oldest first)' : '## Recent activity (oldest first)');
  if (activity.length === 0) {
    lines.push('- Nothing yet.');
  } else {
    // listActivity returns newest first; a story reads better oldest first.
    for (const item of [...activity].reverse()) {
      const undone = item.undone ? ' (later undone)' : '';
      lines.push(`- ${shortTime(item.createdAt)} · ${ACTOR_LABELS[item.actor]} · ${clean(item.message)}${undone}`);
    }
  }

  return lines.join('\n');
}
