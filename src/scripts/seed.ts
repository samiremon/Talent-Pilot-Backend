/**
 * `npm run seed`: creates the recruiter account from .env, or resets its password.
 *
 * In Docker:  docker compose exec api node dist/scripts/seed.js
 *
 * You usually don't need this: the server creates the account on first start.
 * Use it when you've changed SEED_RECRUITER_PASSWORD and want the new one to apply.
 */
import { ensureRecruiter } from '../auth/recruiter.js';
import { loadConfig } from '../config.js';
import { connectDatabase, disconnectDatabase } from '../db.js';
import { createLogger } from '../logger.js';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, pretty: config.nodeEnv === 'development' });

if (!config.seedRecruiter) {
  logger.error('Set SEED_RECRUITER_EMAIL and SEED_RECRUITER_PASSWORD in .env first');
  process.exit(1);
}

try {
  await connectDatabase(config.mongodbUri, logger);
  const result = await ensureRecruiter(config.seedRecruiter, 'create-or-reset');
  // Log the email masked (the logger does that for `email` fields), never the password.
  logger.info({ email: config.seedRecruiter.email, result }, 'Recruiter account ready');
} catch (err) {
  logger.error({ reason: err instanceof Error ? err.message : String(err) }, 'Seeding failed');
  process.exitCode = 1;
} finally {
  await disconnectDatabase();
}
