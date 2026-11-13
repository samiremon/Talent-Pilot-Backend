/**
 * "Find candidates on the web" for a job. Shared by:
 *   - the Find candidates button on the job page (POST /jobs/:id/source)
 *   - the AI's "Find candidates" card in the chat (after the recruiter presses Confirm)
 * so both behave and log exactly the same.
 *
 * startSourcing() queues a background task ("source_candidates"); the worker then:
 *   1. searches 1-3 pages (10 results each = 1 Serper credit each), showing live progress
 *      ("Searching page 2 of 3… 17 found")
 *   2. turns the results into candidates (see search.ts) and adds the NEW ones in one go
 *      (people already in the job are skipped, same check as a CSV upload)
 *   3. queues AI scoring for them, like after a CSV upload
 *
 * No AI tokens are used for the search itself: the query is built from the job's fields.
 */
import { Types } from 'mongoose';
import { addCandidates, planCandidates, type NewCandidate } from '../candidates/addCandidates.js';
import { AppError } from '../errors.js';
import { ActivityModel, type Actor } from '../models/activity.js';
import { JobModel } from '../models/job.js';
import { TaskModel } from '../models/task.js';
import type { TaskEvents } from '../tasks/events.js';
import type { Processor, TaskQueue } from '../tasks/queue.js';
import { createTask, presentTask, updateTask } from '../tasks/service.js';
import { MAX_PAGES, RESULTS_PER_PAGE, resultToCandidate, type SearchClient } from './search.js';
import { startScoring, type SourcingDeps } from './service.js';

export interface SourcingOptions {
  /** The Google query (the recruiter may have edited the suggested one). */
  query: string;
  /** 1-3 pages of 10 results. */
  pages: number;
  /** Who started it: the recruiter's button, or the AI's confirmed card. */
  actor?: Actor;
}

/** Queues a web search for the job, unless one is already queued/running for it. */
export async function startSourcing(deps: SourcingDeps, jobId: string, userId: string, options: SourcingOptions) {
  const query = options.query.trim();
  if (query.length < 3 || query.length > 300) throw new AppError(400, 'VALIDATION_ERROR', 'The search query must be 3-300 characters.');
  const pages = Math.min(MAX_PAGES, Math.max(1, Math.round(options.pages)));

  const busy = await TaskModel.findOne({ jobId, type: 'source_candidates', status: { $in: ['queued', 'running'] } }).lean();
  if (busy) return presentTask(busy);

  const task = await createTask(deps.events, {
    jobId,
    type: 'source_candidates',
    userId,
    total: pages,
    message: `Waiting to search the web (${pages} page${pages === 1 ? '' : 's'})…`,
  });
  await deps.queue.enqueue('source_candidates', { taskId: task.id, jobId, userId, query, pages, actor: options.actor ?? 'recruiter' });
  return task;
}

export function sourceCandidatesProcessor({ events, search, queue }: { events: TaskEvents; search: SearchClient; queue: () => TaskQueue }): Processor {
  return async (message, attempt) => {
    const { taskId, jobId, userId } = message;
    const { query, pages, actor } = message as typeof message & { query: string; pages: number; actor?: Actor };
    const job = await JobModel.findById(jobId).lean();
    if (!job) {
      await updateTask(events, taskId, { status: 'failed', message: 'The job no longer exists.', error: 'job_deleted' });
      return;
    }
    const sample = search.mode === 'sample' ? ' (sample results: no SERPER_API_KEY set)' : '';

    try {
      // 1. Search page by page; keep each person once (same profile link = same person).
      const people = new Map<string, NewCandidate>();
      let skipped = 0; // results that aren't a person's profile
      await updateTask(events, taskId, { status: 'running', attempts: attempt.number, progress: { total: pages, done: 0 }, message: `Searching the web${sample}…` });
      for (let page = 1; page <= pages; page++) {
        const results = await search.search(query, page);
        for (const result of results) {
          const person = resultToCandidate(result);
          if (!person) skipped++;
          else if (!people.has(person.profileUrl!)) people.set(person.profileUrl!, person);
        }
        await updateTask(events, taskId, {
          progress: { done: page, found: people.size },
          message: `Searched page ${page} of ${pages}: ${people.size} profile${people.size === 1 ? '' : 's'} found${sample}…`,
        });
        if (results.length < RESULTS_PER_PAGE) break; // Google has no more results
      }

      // 2. Add the new ones in one go (one activity line), skipping people already in the job.
      const found = [...people.values()];
      const plan = await planCandidates(job._id, found);
      const added = await addCandidates(job._id, 'web', found, actor ?? 'recruiter', userId ?? null);
      await ActivityModel.create({
        jobId: job._id,
        type: 'candidates_added',
        actor: actor ?? 'recruiter',
        userId: userId ? new Types.ObjectId(userId) : null,
        message: `Web search${sample ? ' (sample)' : ''} "${query.slice(0, 120)}": ${found.length} profile${found.length === 1 ? '' : 's'} found, ${added.added} new, ${plan.duplicates} already in this job`,
      });

      // 3. Score the new people (same background scoring as after a CSV upload).
      if (added.added > 0) await startScoring({ queue: queue(), events }, String(job._id), userId ?? null);

      const parts = [`${found.length} profile${found.length === 1 ? '' : 's'} found`, `${added.added} new`];
      if (plan.duplicates) parts.push(`${plan.duplicates} already in this job`);
      if (skipped) parts.push(`${skipped} result${skipped === 1 ? '' : 's'} weren't profiles`);
      await updateTask(events, taskId, {
        status: 'done',
        progress: { done: pages, found: found.length, duplicates: plan.duplicates },
        message: `Done: ${parts.join(', ')}.${added.added ? ' AI scoring has started.' : ''}${sample}`,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // A wrong key or used-up credits won't fix themselves: don't retry those.
      const final = attempt.isLast || (err instanceof AppError && ['SEARCH_KEY_INVALID', 'SEARCH_CREDITS'].includes(err.code));
      await updateTask(events, taskId, {
        status: final ? 'failed' : 'queued',
        error: reason,
        message: final ? `Web search failed: ${reason}` : `Hit a problem (${reason}). Retrying shortly…`,
      });
      if (!final) throw err;
    }
  };
}
