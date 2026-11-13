import { createApp } from './app.js';
import { loadConfig, type Config } from './config.js';

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const app = createApp({ corsOrigins: config.corsOrigins });

const server = app.listen(config.port, () => {
  console.log(`TalentPilot API listening on http://localhost:${config.port} (${config.nodeEnv})`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
