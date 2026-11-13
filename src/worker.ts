/**
 * The background WORKER: a separate process that runs the slow jobs (scoring, searching,
 * sending emails) taken from the BullMQ queue.
 *
 *   npm run worker              (development)
 *   node dist/worker.js         (Docker: the "worker" service)
 *
 * Why separate from the API: slow AI work never slows down the website, a crash here
 * doesn't take the API down, and you could run several workers for more throughput.
 * Progress is written to MongoDB and announced through Redis, so the API can stream it to
 * the browser live.
 */
import { createAi } from './ai/client.js';
import { createSearchClient } from './sourcing/search.js';
import { createOutreachMailer } from './email/mailer.js';
import { loadConfig, type Config } from './config.js';
import { connectDatabase, disconnectDatabase } from './db.js';
import { createLogger } from './logger.js';
import { createRedisEvents } from './tasks/events.js';
import { buildProcessors } from './tasks/processors.js';
import { createBullQueue, startWorker } from './tasks/queue.js';

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const logger = createLogger({ level: config.logLevel, pretty: config.nodeEnv === 'development' }).child({ process: 'worker' });

if (!config.redisUrl) {
  logger.fatal('REDIS_URL is not set: the worker needs Redis. (Without Redis, the API runs tasks itself.)');
  process.exit(1);
}

await connectDatabase(config.mongodbUri, logger);
const ai = createAi(config.ai);
const events = createRedisEvents(config.redisUrl);
const search = createSearchClient(config.search.serperKey);
// The worker also ADDS tasks (a finished web search queues scoring), so it needs the queue too.
const queue = createBullQueue(config.redisUrl);
const worker = startWorker(
  config.redisUrl,
  buildProcessors({ ai, events, search, queue: () => queue, outreachMailer: createOutreachMailer(config.outreach, config.smtp), outreach: config.outreach }),
  logger,
);
logger.info({ ai: ai.mode, search: search.mode }, 'Worker ready, waiting for tasks');

// Graceful stop: finish the task in progress (BullMQ waits for it), then close everything.
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'Worker shutting down');
  setTimeout(() => process.exit(1), 30_000).unref(); // never hang forever
  await worker.close();
  await events.close();
  await queue.close();
  await disconnectDatabase();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
