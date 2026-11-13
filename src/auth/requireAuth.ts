/**
 * "Bouncer" middleware: put it in front of any route that needs a logged-in recruiter.
 *
 *   router.get('/jobs', requireAuth, handler)
 *
 * If the session cookie is valid, the user is attached as `req.user` and the request
 * continues. Otherwise the client gets a 401 "Please log in".
 */
import type { RequestHandler } from 'express';
import { AppError, asyncHandler } from '../errors.js';
import type { PublicUser } from '../models/user.js';
import { findUserBySessionToken } from './sessions.js';

/** Name of the cookie that holds the session token. */
export const SESSION_COOKIE = 'tp_session';

// Teach TypeScript that `req.user` exists (it's added by the middleware below).
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: PublicUser;
    }
  }
}

/** Reads the session cookie (if any). cookie-parser fills in `req.cookies`. */
export function readSessionToken(cookies: unknown): string | undefined {
  const value = (cookies as Record<string, unknown> | undefined)?.[SESSION_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export const requireAuth: RequestHandler = asyncHandler(async (req, _res, next) => {
  const token = readSessionToken(req.cookies);
  const user = token ? await findUserBySessionToken(token) : null;
  if (!user) throw AppError.unauthorized();

  req.user = user;
  next();
});
