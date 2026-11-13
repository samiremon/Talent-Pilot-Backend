import type { Server } from 'node:http';
import { createApp } from './app.js';
import { loadConfig, type Config } from './config.js';
import { connectDatabase, disconnectDatabase } from './db.js';
import { createLogger } from './logger.js';

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  // No logger yet: settings decide how to log, and they just failed.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const logger = createLogger({ level: config.logLevel, pretty: config.nodeEnv === 'development' });
let server: Server | undefined;

async function start(): Promise<void> {
  // Don't accept traffic until the database is reachable.
  await connectDatabase(config.mongodbUri, logger);

  const app = createApp({ corsOrigins: config.corsOrigins, logger });
  server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.nodeEnv }, `TalentPilot API listening on http://localhost:${config.port}`);
  });
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');

  // Force-exit if something hangs, so Docker never waits forever.
  setTimeout(() => {
    logger.error('Shutdown took too long, forcing exit');
    process.exit(1);
  }, 10_000).unref();

  // Stop taking new requests, let in-flight ones finish, then close the database.
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await disconnectDatabase();
  logger.info('Shutdown complete');
  process.exit(0);
}

// Last-resort safety net: a bug escaped every handler. Log it and exit so Docker restarts us clean.
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

start().catch((err: unknown) => {
  // Only the message: driver errors carry ~100 lines of internals that hide the real cause.
  const reason = err instanceof Error ? err.message : String(err);
  logger.fatal({ reason }, 'Could not start: is MongoDB running and is MONGODB_URI correct?');
  process.exit(1);
});
