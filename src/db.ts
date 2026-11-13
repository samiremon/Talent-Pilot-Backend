import mongoose from 'mongoose';
import type { Logger } from 'pino';

/** True only while Mongoose has a live connection. */
export function isDatabaseReady(): boolean {
  return mongoose.connection.readyState === mongoose.ConnectionStates.connected;
}

/**
 * Connects to MongoDB. Rejects if the server can't be reached within a few seconds,
 * so a wrong URI or a stopped database fails fast instead of hanging.
 * The URI is never logged: it contains the password.
 */
export async function connectDatabase(uri: string, logger: Logger): Promise<void> {
  mongoose.set('strictQuery', true);

  const { connection } = mongoose;
  connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  connection.on('error', (err) => logger.error({ err }, 'MongoDB error'));

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  logger.info({ db: connection.name }, 'MongoDB connected');
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}
