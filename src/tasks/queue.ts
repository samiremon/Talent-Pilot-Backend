/**
 * The background-job queue (BullMQ on Redis), as the assignment requires.
 *
 *   API process:     queue.enqueue('score_candidates', { taskId, jobId })
 *   Worker process:  startWorker(...) picks it up and runs the matching processor
 *
 * Why a queue: scoring 50 candidates takes a while and can hit the AI's rate limit. The
 * recruiter shouldn't wait on a spinning request; the work runs elsewhere, survives an API
 * restart, and failed attempts are retried automatically with growing waits
 * (3 attempts: after 5 s, then 10 s).
 *
 * For tests there's an "inline" queue that runs the processor in the same process.
 */
import { Queue, Worker, type Job as BullJob } from 'bullmq';
import type { Logger } from 'pino';

export const QUEUE_NAME = 'talentpilot-tasks';

export interface TaskMessage {
  taskId: string;
  jobId: string;
  userId?: string | null;
  // Task-specific settings, e.g. the search query for "source_candidates".
  [extra: string]: unknown;
}

export interface TaskQueue {
  enqueue(type: string, message: TaskMessage): Promise<void>;
  /** True if the queue's backend (Redis) is reachable: shown in /health. */
  isReady(): boolean;
  close(): Promise<void>;
}

/** What a processor gets: the message, plus which attempt this is (1 = first). */
export type Processor = (message: TaskMessage, attempt: { number: number; isLast: boolean }) => Promise<void>;

const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: 200, // keep a little history in Redis, not forever
  removeOnFail: 500,
};

/** BullMQ wants a connection description, not a URL: turn redis://:pass@host:port into one. */
export function redisConnection(redisUrl: string) {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    maxRetriesPerRequest: null, // required by BullMQ workers
  };
}

export function createBullQueue(redisUrl: string): TaskQueue {
  const queue = new Queue(QUEUE_NAME, { connection: redisConnection(redisUrl), defaultJobOptions: DEFAULT_JOB_OPTIONS });
  let ready = false;
  void queue.waitUntilReady().then(() => (ready = true)).catch(() => (ready = false));
  queue.on('error', () => (ready = false));
  return {
    async enqueue(type, message) {
      // jobId = our task id: if the same task were enqueued twice, BullMQ keeps only one.
      await queue.add(type, message, { jobId: message.taskId });
    },
    isReady: () => ready,
    close: () => queue.close(),
  };
}

/** Runs in the WORKER process: takes tasks off the queue and runs the right processor. */
export function startWorker(redisUrl: string, processors: Record<string, Processor>, logger: Logger) {
  const worker = new Worker(
    QUEUE_NAME,
    async (job: BullJob<TaskMessage>) => {
      const processor = processors[job.name];
      if (!processor) throw new Error(`No processor for task type "${job.name}"`);
      const maxAttempts = job.opts.attempts ?? 1;
      const number = job.attemptsMade + 1;
      logger.info({ type: job.name, taskId: job.data.taskId, attempt: number }, 'Task started');
      await processor(job.data, { number, isLast: number >= maxAttempts });
    },
    {
      connection: redisConnection(redisUrl),
      // One task at a time per worker: the AI's free-tier limits are the bottleneck anyway.
      concurrency: 1,
    },
  );
  worker.on('completed', (job) => logger.info({ type: job.name, taskId: job.data.taskId }, 'Task finished'));
  worker.on('failed', (job, err) => {
    // The real cause (e.g. what Groq said), if a friendly error wrapped it.
    const cause = (err as { cause?: unknown }).cause;
    const detail = cause instanceof Error ? cause.message.slice(0, 300) : undefined;
    logger.warn({ type: job?.name, taskId: job?.data.taskId, attempt: job?.attemptsMade, reason: err.message, detail }, 'Task attempt failed');
  });
  return worker;
}

/**
 * Tests only: runs tasks in this process, right after the request returns, with the
 * same retry rule (3 attempts). `idle()` waits until everything queued has finished.
 */
export function createInlineQueue(processors: () => Record<string, Processor>): TaskQueue & { idle(): Promise<void> } {
  const running = new Set<Promise<void>>();
  return {
    async enqueue(type, message) {
      const run = (async () => {
        await new Promise((r) => setImmediate(r));
        const processor = processors()[type];
        if (!processor) return;
        for (let number = 1; number <= DEFAULT_JOB_OPTIONS.attempts; number++) {
          try {
            await processor(message, { number, isLast: number === DEFAULT_JOB_OPTIONS.attempts });
            return;
          } catch {
            // try again (no waiting in tests)
          }
        }
      })();
      running.add(run);
      void run.finally(() => running.delete(run));
    },
    isReady: () => true,
    async close() {},
    async idle() {
      while (running.size) await Promise.all([...running]);
    },
  };
}
