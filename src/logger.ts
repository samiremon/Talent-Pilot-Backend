import { pino, type DestinationStream, type Logger } from 'pino';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

/** Fields that must never reach the logs. `*` matches one level of nesting. */
const SECRET_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'token',
  '*.token',
  'apiKey',
  '*.apiKey',
  'email',
  '*.email',
];

/** "rahim.uddin@example.com" -> "r***@example.com", so logs stay useful without exposing the address. */
export function maskEmail(value: unknown): string {
  if (typeof value !== 'string') return '[REDACTED]';
  const at = value.lastIndexOf('@');
  if (at < 1) return '[REDACTED]';
  return `${value[0]}***${value.slice(at)}`;
}

function censor(value: unknown, path: string[]): unknown {
  return path.at(-1) === 'email' ? maskEmail(value) : '[REDACTED]';
}

export interface LoggerOptions {
  level: LogLevel;
  /** Human-readable colored output (development only). */
  pretty?: boolean;
  /** Where to write logs (defaults to stdout). Used by tests. */
  destination?: DestinationStream;
}

export function createLogger({ level, pretty = false, destination }: LoggerOptions): Logger {
  const options = {
    level,
    base: { service: 'talent-pilot-backend' },
    redact: { paths: SECRET_PATHS, censor },
    ...(pretty && !destination
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', singleLine: true, ignore: 'pid,hostname,service' } } }
      : {}),
  };
  return destination ? pino(options, destination) : pino(options);
}
