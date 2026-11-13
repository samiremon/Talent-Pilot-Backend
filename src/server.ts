import { createApp } from './app.js';
import { loadConfig, type Config } from './config.js';
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
const app = createApp({ corsOrigins: config.corsOrigins, logger });

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, env: config.nodeEnv }, `TalentPilot API listening on http://localhost:${config.port}`);
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'Shutting down');
  server.close(() => process.exit(0));
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

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
