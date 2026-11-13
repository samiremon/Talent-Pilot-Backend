/**
 * Sourcing actions shared by the job page, the chat cards and (later) the AI tools:
 *   startScoring()  queue AI scoring for the job's unscored candidates
 *   importCsv()     CSV text -> candidates added (duplicates skipped) -> scoring started
 */
import { addCandidates } from '../candidates/addCandidates.js';
import { CandidateModel } from '../models/candidate.js';
import { TaskModel } from '../models/task.js';
import type { TaskEvents } from '../tasks/events.js';
import type { TaskQueue } from '../tasks/queue.js';
import { createTask, presentTask } from '../tasks/service.js';
import { parseCandidatesCsv } from './csv.js';

export interface SourcingDeps {
  queue: TaskQueue;
  events: TaskEvents;
}

/**
 * Starts scoring the job's unscored candidates in the background, unless a scoring task
 * is already queued/running for this job (then that one is returned instead).
 */
export async function startScoring({ queue, events }: SourcingDeps, jobId: string, userId: string | null) {
  const busy = await TaskModel.findOne({ jobId, type: 'score_candidates', status: { $in: ['queued', 'running'] } }).lean();
  if (busy) return presentTask(busy);
  const pending = await CandidateModel.countDocuments({ jobId, score: null, scoreReason: null });
  const task = await createTask(events, {
    jobId,
    type: 'score_candidates',
    userId,
    total: pending,
    message: pending ? `Waiting to score ${pending} candidate${pending === 1 ? '' : 's'}…` : 'Nothing to score.',
  });
  await queue.enqueue('score_candidates', { taskId: task.id, jobId, userId });
  return task;
}

/** CSV text -> candidates added (duplicates skipped) -> scoring started if anyone new. */
export async function importCsv(deps: SourcingDeps, jobId: string, csvText: string, userId: string) {
  const people = parseCandidatesCsv(csvText);
  const result = await addCandidates(jobId, 'csv', people, 'recruiter', userId);
  const task = result.added > 0 ? await startScoring(deps, jobId, userId) : null;
  return { ...result, rows: people.length, task };
}
