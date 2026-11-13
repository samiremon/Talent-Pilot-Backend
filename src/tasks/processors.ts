/**
 * The list of background task types and the code that runs each one.
 * Used by the worker process (and by the API itself when there's no Redis).
 */
import type { Ai } from '../ai/client.js';
import { scoreCandidatesProcessor } from '../sourcing/scoring.js';
import type { TaskEvents } from './events.js';
import type { Processor } from './queue.js';

export function buildProcessors(deps: { ai: Ai; events: TaskEvents }): Record<string, Processor> {
  return {
    score_candidates: scoreCandidatesProcessor(deps),
  };
}
