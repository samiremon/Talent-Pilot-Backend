/**
 * Login endpoints:
 *   POST /auth/login   { email, password }  -> sets the session cookie, returns the user
 *   POST /auth/logout                       -> deletes the session, clears the cookie
 *   GET  /auth/me                           -> the logged-in user, or 401
 */
import { Router, type CookieOptions } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { AppError, asyncHandler } from '../errors.js';
import { UserModel, toPublicUser } from '../models/user.js';
import { hashPassword, verifyPassword } from './password.js';
import { SESSION_COOKIE, readSessionToken, requireAuth } from './requireAuth.js';
import { createSession, deleteSession } from './sessions.js';

export interface AuthOptions {
  /** Send the cookie only over HTTPS. Turn off for plain-http local Docker. */
  cookieSecure: boolean;
  /** How long a login lasts. */
  sessionTtlHours: number;
  /** Max login attempts per IP address per 15 minutes. */
  loginAttemptsPerWindow?: number;
}

// What a login request must look like. Anything else gets a 400 VALIDATION_ERROR.
const loginBody = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('must be a valid email')),
  // Upper bound stops someone sending a 10 MB "password" to make hashing slow.
  password: z.string().min(1, 'is required').max(200),
});

// When the email doesn't exist we still check the password against this dummy hash.
// That way "wrong email" and "wrong password" take the same time, so an attacker
// can't discover which emails have accounts by timing the response.
const dummyHashPromise = hashPassword('not-a-real-password');

export function authRouter({ cookieSecure, sessionTtlHours, loginAttemptsPerWindow = 10 }: AuthOptions): Router {
  const router = Router();

  // Cookie settings, explained:
  //  httpOnly: page JavaScript can't read it, so an XSS bug can't steal the session
  //  sameSite strict: the browser never sends it on requests started by other sites (blocks CSRF)
  //  secure: HTTPS only (when enabled)
  //  path '/': sent with every request to our API
  const cookieOptions: CookieOptions = { httpOnly: true, sameSite: 'strict', secure: cookieSecure, path: '/' };

  // Slow down password guessing: after N failed-or-not attempts from one IP within
  // 15 minutes, further attempts get a 429 until the window resets.
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: loginAttemptsPerWindow,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // Successful logins don't count, so a recruiter who logs in normally is never blocked.
    skipSuccessfulRequests: true,
    handler: (_req, _res, next) =>
      next(new AppError(429, 'TOO_MANY_ATTEMPTS', 'Too many login attempts. Please wait 15 minutes and try again.')),
  });

  router.post(
    '/login',
    loginLimiter,
    asyncHandler(async (req, res) => {
      const { email, password } = loginBody.parse(req.body);

      // passwordHash is hidden by default (see models/user.ts); ask for it explicitly here.
      const user = await UserModel.findOne({ email }).select('+passwordHash').lean();
      const passwordOk = await verifyPassword(password, user?.passwordHash ?? (await dummyHashPromise));

      // Same message for "no such user" and "wrong password", on purpose.
      if (!user || !passwordOk) throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');

      const { token, expiresAt } = await createSession(user._id, sessionTtlHours);
      res.cookie(SESSION_COOKIE, token, { ...cookieOptions, expires: expiresAt });
      req.log.info({ userId: String(user._id) }, 'Recruiter logged in');
      res.json({ user: toPublicUser(user) });
    }),
  );

  router.post(
    '/logout',
    asyncHandler(async (req, res) => {
      const token = readSessionToken(req.cookies);
      if (token) await deleteSession(token);
      // Clearing needs the same options the cookie was set with.
      res.clearCookie(SESSION_COOKIE, cookieOptions);
      res.status(204).end();
    }),
  );

  // requireAuth does all the work; if we get here the user is logged in.
  router.get('/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  return router;
}
