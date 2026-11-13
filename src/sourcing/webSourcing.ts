/**
 * "Find candidates on the web" for a job. Shared by:
 *   - the Find candidates button on the job page (POST /jobs/:id/source)
 *   - the AI's "Find candidates" card in the chat (after the recruiter presses Confirm)
 * so both behave and log exactly the same.
 *
 * startSourcing() queues a background task ("source_candidates"); the worker then:
 *   1. searches each chosen source (LinkedIn, GitHub, ...) for 1-3 pages (10 results each
 *      = 1 Serper credit each), showing live progress ("LinkedIn page 2 of 2: 17 found")
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
import { MAX_PAGES, RESULTS_PER_PAGE, resultToCandidate, SEARCH_SOURCES, SOURCE_LABELS, type SearchClient, type SearchSource } from './search.js';
import { startScoring, type SourcingDeps } from './service.js';

export interface SourceSearch {
  source: SearchSource;
  /** The Google query (the recruiter may have edited the suggested one). */
  query: string;
}

export interface SourcingOptions {
  /** One query per chosen source. */
  searches: SourceSearch[];
  /** 1-3 pages of 10 results, per source. */
  pages: number;
  /** Who started it: the recruiter's button, or the AI's confirmed card. */
  actor?: Actor;
}

/** Queues a web search for the job, unless one is already queued/running for it. */
export async function startSourcing(deps: SourcingDeps, jobId: string, userId: string, options: SourcingOptions) {
  const searches = options.searches
    .map((s) => ({ source: s.source, query: s.query.trim() }))
    .filter((s) => SEARCH_SOURCES.includes(s.source));
  if (searches.length === 0) throw new AppError(400, 'VALIDATION_ERROR', 'Choose at least one source to search.');
  if (new Set(searches.map((s) => s.source)).size !== searches.length) throw new AppError(400, 'VALIDATION_ERROR', 'Each source can be searched once.');
  for (const s of searches) {
    if (s.query.length < 3 || s.query.length > 300) throw new AppError(400, 'VALIDATION_ERROR', `The ${SOURCE_LABELS[s.source]} query must be 3-300 characters.`);
  }
  const pages = Math.min(MAX_PAGES, Math.max(1, Math.round(options.pages)));

  const busy = await TaskModel.findOne({ jobId, type: 'source_candidates', status: { $in: ['queued', 'running'] } }).lean();
  if (busy) return presentTask(busy);

  const steps = searches.length * pages;
  const task = await createTask(deps.events, {
    jobId,
    type: 'source_candidates',
    userId,
    total: steps,
    message: `Waiting to search ${searches.map((s) => SOURCE_LABELS[s.source]).join(', ')}…`,
  });
  await deps.queue.enqueue('source_candidates', { taskId: task.id, jobId, userId, searches, pages, actor: options.actor ?? 'recruiter' });
  return task;
}

export function sourceCandidatesProcessor({ events, search, queue }: { events: TaskEvents; search: SearchClient; queue: () => TaskQueue }): Processor {
  return async (message, attempt) => {
    const { taskId, jobId, userId } = message;
    const { searches, pages, actor } = message as typeof message & { searches: SourceSearch[]; pages: number; actor?: Actor };
    const job = await JobModel.findById(jobId).lean();
    if (!job) {
      await updateTask(events, taskId, { status: 'failed', message: 'The job no longer exists.', error: 'job_deleted' });
      return;
    }
    const sample = search.mode === 'sample' ? ' (sample results: no SERPER_API_KEY set)' : '';
    const labels = searches.map((s) => SOURCE_LABELS[s.source]).join(', ');
    const steps = searches.length * pages;

    try {
      // 1. Search source by source, page by page; keep each person once (same link = same person).
      const people = new Map<string, NewCandidate>();
      let skipped = 0; // results that aren't a person's profile
      let step = 0;
      await updateTask(events, taskId, { status: 'running', attempts: attempt.number, progress: { total: steps, done: 0 }, message: `Searching ${labels}${sample}…` });
      for (const { source, query } of searches) {
        for (let page = 1; page <= pages; page++) {
          const results = await search.search(query, page);
          for (const result of results) {
            const person = resultToCandidate(result);
            if (!person) skipped++;
            else if (!people.has(person.profileUrl!)) people.set(person.profileUrl!, person);
          }
          step++;
          await updateTask(events, taskId, {
            progress: { done: step, found: people.size },
            message: `${SOURCE_LABELS[source]} page ${page} of ${pages}: ${people.size} profile${people.size === 1 ? '' : 's'} found so far${sample}…`,
          });
          if (results.length < RESULTS_PER_PAGE) {
            step += pages - page; // Google has no more results for this query
            break;
          }
        }
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
        message: `Web search${sample ? ' (sample)' : ''} on ${labels}: ${found.length} profile${found.length === 1 ? '' : 's'} found, ${added.added} new, ${plan.duplicates} already in this job`,
      });

      // 3. Score the new people (same background scoring as after a CSV upload).
      if (added.added > 0) await startScoring({ queue: queue(), events }, String(job._id), userId ?? null);

      const parts = [`${found.length} profile${found.length === 1 ? '' : 's'} found`, `${added.added} new`];
      if (plan.duplicates) parts.push(`${plan.duplicates} already in this job`);
      if (skipped) parts.push(`${skipped} result${skipped === 1 ? '' : 's'} weren't profiles`);
      // Remember who was added (the chat reports how they scored).
      await TaskModel.updateOne({ _id: taskId }, { $set: { result: { candidateIds: added.candidateIds, found: found.length, duplicates: plan.duplicates } } });
      await updateTask(events, taskId, {
        status: 'done',
        progress: { done: steps, found: found.length, duplicates: plan.duplicates },
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
