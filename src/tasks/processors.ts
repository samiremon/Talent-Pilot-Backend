/**
 * The list of background task types and the code that runs each one.
 * Used by the worker process (and by the API itself when there's no Redis).
 */
import type { Ai } from '../ai/client.js';
import { scoreCandidatesProcessor } from '../sourcing/scoring.js';
import { createSearchClient, type SearchClient } from '../sourcing/search.js';
import { sourceCandidatesProcessor } from '../sourcing/webSourcing.js';
import type { TaskEvents } from './events.js';
import type { Processor, TaskQueue } from './queue.js';
import { createMemoryMailer, type Mailer } from '../email/mailer.js';
import { draftOutreachProcessor } from '../outreach/drafting.js';
import { sendOutreachProcessor, type OutreachSettings } from '../outreach/sending.js';

export interface ProcessorDeps {
  ai: Ai;
  events: TaskEvents;
  /** Web search (Serper, or sample mode). Default: sample mode. */
  search?: SearchClient;
  /** The queue, so a task can start another one (web search -> scoring). A function,
   *  because the in-process queue is created with these processors. */
  queue?: () => TaskQueue;
  /** Where outreach emails go (sandbox = Mailpit) and the sending rules. Default (tests):
   *  an in-memory mailer, sandbox mode, 50 a day, real-length days. */
  outreachMailer?: Mailer;
  outreach?: OutreachSettings;
}

export function buildProcessors(deps: ProcessorDeps): Record<string, Processor> {
  return {
    score_candidates: scoreCandidatesProcessor(deps),
    draft_outreach: draftOutreachProcessor(deps),
    send_outreach: sendOutreachProcessor({
      events: deps.events,
      mailer: deps.outreachMailer ?? createMemoryMailer(),
      settings: deps.outreach ?? { mode: 'sandbox', dailyLimit: 50, daySeconds: 86_400 },
      queue: () => {
        const queue = deps.queue?.();
        if (!queue) throw new Error('No queue to schedule follow-ups with');
        return queue;
      },
    }),
    source_candidates: sourceCandidatesProcessor({
      events: deps.events,
      search: deps.search ?? createSearchClient(),
      queue: () => {
        const queue = deps.queue?.();
        if (!queue) throw new Error('No queue to start scoring with');
        return queue;
      },
    }),
  };
}
