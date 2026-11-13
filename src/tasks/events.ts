/**
 * Live task updates: the worker announces "task X is now 15/23", the API passes it on to
 * every browser watching that job (through Server-Sent Events, see sourcing/routes.ts).
 *
 * The worker and the API are separate processes, so they talk through Redis "pub/sub"
 * (a broadcast channel). In tests (and if Redis isn't configured) an in-memory version
 * does the same inside one process.
 */
import { EventEmitter } from 'node:events';
import { Redis } from 'ioredis';

export interface TaskEvent {
  jobId: string;
  task: unknown; // the presented task (see tasks/service.ts)
}

export interface TaskEvents {
  publish(event: TaskEvent): Promise<void>;
  /** Calls `listener` for every event of this job (or of ALL jobs with ALL_JOBS); returns a
   *  function that stops listening. */
  subscribe(jobId: string, listener: (event: TaskEvent) => void): () => void;
  close(): Promise<void>;
}

const CHANNEL = 'talentpilot:task-events';
/** Subscribe to this "job id" to get the events of every job (the app's single live stream). */
export const ALL_JOBS = '*';

/** One process only (tests, or no Redis). */
export function createMemoryEvents(): TaskEvents {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0); // many browser tabs may watch at once
  return {
    async publish(event) {
      emitter.emit(event.jobId, event);
      emitter.emit(ALL_JOBS, event);
    },
    subscribe(jobId, listener) {
      emitter.on(jobId, listener);
      return () => emitter.off(jobId, listener);
    },
    async close() {
      emitter.removeAllListeners();
    },
  };
}

/** Across processes, via Redis pub/sub. One shared subscriber connection for all browsers. */
export function createRedisEvents(redisUrl: string): TaskEvents {
  const publisher = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const subscriber = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const local = createMemoryEvents();

  void subscriber.subscribe(CHANNEL);
  subscriber.on('message', (_channel, raw) => {
    try {
      const event = JSON.parse(raw) as TaskEvent;
      void local.publish(event); // hand it to the browsers watching in THIS process
    } catch {
      // Ignore anything that isn't ours.
    }
  });

  return {
    async publish(event) {
      await publisher.publish(CHANNEL, JSON.stringify(event));
    },
    subscribe: local.subscribe,
    async close() {
      await Promise.allSettled([publisher.quit(), subscriber.quit(), local.close()]);
    },
  };
}
