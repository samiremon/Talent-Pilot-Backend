import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';

/**
 * An error we expect and can explain to the client (bad input, not found, not allowed...).
 * Anything that is NOT an AppError is treated as a bug: logged in full, but the client
 * only sees a generic message so internals never leak.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(message: string, details?: unknown) {
    return new AppError(400, 'BAD_REQUEST', message, details);
  }
  static unauthorized(message = 'Please log in') {
    return new AppError(401, 'UNAUTHORIZED', message);
  }
  static forbidden(message = 'You are not allowed to do this') {
    return new AppError(403, 'FORBIDDEN', message);
  }
  static notFound(message = 'Not found') {
    return new AppError(404, 'NOT_FOUND', message);
  }
  static conflict(message: string, details?: unknown) {
    return new AppError(409, 'CONFLICT', message, details);
  }
}

/** Shape of every error response: { error: { code, message, details?, requestId } } */
export interface ErrorBody {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

/**
 * Express 4 does not catch errors from async handlers; this passes them to the error handler.
 * Usage: router.get('/jobs', asyncHandler(async (req, res) => { ... }))
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(AppError.notFound('Route not found'));
};

/** Errors thrown by express.json() carry a `type` field. */
function bodyParserError(err: unknown): AppError | undefined {
  const type = (err as { type?: unknown } | null)?.type;
  if (type === 'entity.parse.failed') return new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  if (type === 'entity.too.large') return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  return undefined;
}

function toAppError(err: unknown): AppError | undefined {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    const details = err.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    return new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid', details);
  }
  return bodyParserError(err);
}

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  // Headers already sent (e.g. mid-stream): let Express close the connection.
  if (res.headersSent) {
    next(err);
    return;
  }

  const known = toAppError(err);
  const requestId = req.id === undefined ? undefined : String(req.id);

  if (known) {
    const body: ErrorBody = {
      error: { code: known.code, message: known.message, details: known.details, requestId },
    };
    res.status(known.status).json(body);
    return;
  }

  // Unexpected: log everything for us, tell the client nothing internal.
  req.log?.error({ err }, 'Unhandled error');
  const body: ErrorBody = {
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.', requestId },
  };
  res.status(500).json(body);
};
