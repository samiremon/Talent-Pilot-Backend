/**
 * Account endpoints:
 *
 *   GET   /auth/providers          which sign-in options are on (Google? sign-up?)
 *   POST  /auth/signup             { name, email, password } -> account created, code emailed
 *   POST  /auth/verify-email       { email, code } -> account verified, logged in
 *   POST  /auth/resend-verification { email } -> a new code (same answer either way)
 *   POST  /auth/login              { email, password } -> sets the session cookie
 *   POST  /auth/logout             deletes the session, clears the cookie
 *   GET   /auth/me                 the logged-in user, or 401
 *   PATCH /auth/me                 { name } -> change your name
 *   POST  /auth/change-password    { currentPassword?, newPassword }
 *   POST  /auth/forgot-password    { email } -> emails a reset link (same answer either way)
 *   GET   /auth/reset-password/:token   is this reset link still usable?
 *   POST  /auth/reset-password     { token, password } -> sets the new password
 *   GET   /auth/google             start "Continue with Google"
 *   GET   /auth/google/callback    Google sends the user back here
 *   GET   /auth/demo               DEMO ONLY: the demo account (when switched on)
 */
import { Router, type CookieOptions, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Types } from 'mongoose';
import { z } from 'zod';
import type { Mailer } from '../email/mailer.js';
import { AppError, asyncHandler } from '../errors.js';
import { UserModel, toPublicUser } from '../models/user.js';
import {
  changePassword,
  isResetTokenValid,
  resendVerification,
  verifyEmail,
  passwordRule,
  requestPasswordReset,
  resetPassword,
  signUp,
  signupInput,
  updateName,
} from './accounts.js';
import { createEmailChecker, type EmailChecker } from './emailCheck.js';
import { finishGoogleSignIn, startGoogleSignIn, type GoogleSettings } from './google.js';
import { hashPassword, verifyPassword } from './password.js';
import { SESSION_COOKIE, readSessionToken, requireAuth } from './requireAuth.js';
import { createSession, deleteSession } from './sessions.js';

export interface AuthOptions {
  /** Send the cookie only over HTTPS. Turn off for plain-http local Docker. */
  cookieSecure: boolean;
  /** How long a login lasts. */
  sessionTtlHours: number;
  /** Max FAILED login attempts per IP address per 15 minutes. */
  loginAttemptsPerWindow?: number;
  /**
   * DEMO ONLY: when set, GET /auth/demo returns these credentials so the login page can
   * offer a "Use demo account" button. Leave undefined to switch the endpoint off (404).
   */
  demoCredentials?: { email: string; password: string };
  /** Public address of the app (for links in emails and the Google redirect). */
  appUrl?: string;
  /** Allow new people to create accounts. */
  allowSignup?: boolean;
  /** "Continue with Google" settings; undefined = feature off. */
  google?: GoogleSettings;
  /** Sends emails (reset links). Tests pass a fake one. */
  mailer?: Mailer;
  /** Checks emails at sign-up (format + domain). Tests pass a fake one (no network). */
  checkEmail?: EmailChecker;
  /** For tests of the Google flow: a fake `fetch`. */
  fetchImpl?: typeof fetch;
}

// What a login request must look like. Anything else gets a 400 VALIDATION_ERROR.
const loginBody = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('must be a valid email')),
  // Upper bound stops someone sending a 10 MB "password" to make hashing slow.
  password: z.string().min(1, 'is required').max(200),
});
const nameBody = z.object({ name: z.string() });
const changePasswordBody = z.object({ currentPassword: z.string().max(200).optional(), newPassword: passwordRule });
const forgotBody = z.object({ email: z.string().trim().toLowerCase().max(320) });
const resetBody = z.object({ token: z.string().min(10).max(200), password: passwordRule });
const verifyBody = z.object({
  email: z.string().trim().toLowerCase().max(320),
  code: z.string().trim().regex(/^\d{6}$/, 'must be the 6 digits from the email'),
});

// When the email doesn't exist we still check the password against this dummy hash.
// That way "wrong email" and "wrong password" take the same time, so an attacker
// can't discover which emails have accounts by timing the response.
const dummyHashPromise = hashPassword('not-a-real-password');

/** Cookie holding the Google sign-in secrets between step 1 and the callback. */
const GOOGLE_COOKIE = 'tp_google';

/** Reusable "max N requests per window per IP" limiter that answers in our error format. */
function limiter(windowMinutes: number, limit: number, message: string, skipSuccessfulRequests = false) {
  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests,
    handler: (_req, _res, next) => next(new AppError(429, 'TOO_MANY_ATTEMPTS', message)),
  });
}

export function authRouter({
  cookieSecure,
  sessionTtlHours,
  loginAttemptsPerWindow = 10,
  demoCredentials,
  appUrl = 'http://localhost:5173',
  allowSignup = true,
  google,
  mailer,
  checkEmail = createEmailChecker(),
  fetchImpl = fetch,
}: AuthOptions): Router {
  const router = Router();

  // Cookie settings, explained:
  //  httpOnly: page JavaScript can't read it, so an XSS bug can't steal the session
  //  sameSite strict: the browser never sends it on requests started by other sites (blocks CSRF)
  //  secure: HTTPS only (when enabled)
  //  path '/': sent with every request to our API
  const cookieOptions: CookieOptions = { httpOnly: true, sameSite: 'strict', secure: cookieSecure, path: '/' };

  /** Logs the user in: new session + cookie. */
  async function startSession(res: Response, userId: Types.ObjectId) {
    const { token, expiresAt } = await createSession(userId, sessionTtlHours);
    res.cookie(SESSION_COOKIE, token, { ...cookieOptions, expires: expiresAt });
  }

  // Slow down password guessing: after N FAILED attempts from one IP within 15 minutes,
  // further attempts get a 429 until the window resets. Successful logins don't count.
  const loginLimiter = limiter(15, loginAttemptsPerWindow, 'Too many login attempts. Please wait 15 minutes and try again.', true);
  const signupLimiter = limiter(60, 10, 'Too many sign-ups from this network. Please try again later.');
  const forgotLimiter = limiter(15, 5, 'Too many reset requests. Please wait 15 minutes and try again.');
  const verifyLimiter = limiter(15, 20, 'Too many tries. Please wait 15 minutes and try again.');
  const resendLimiter = limiter(15, 5, 'Too many new codes requested. Please wait 15 minutes and try again.');

  router.get('/providers', (_req, res) => {
    res.json({ google: Boolean(google), signup: allowSignup, passwordReset: Boolean(mailer), emailVerification: Boolean(mailer) });
  });

  // ---------- Sign up / log in / log out ----------

  router.post(
    '/signup',
    signupLimiter,
    asyncHandler(async (req, res) => {
      if (!allowSignup) throw AppError.forbidden('Sign-up is turned off. Ask an admin for an account.');
      const input = signupInput.parse(req.body);
      const { user, needsVerification, emailSent } = await signUp(input, checkEmail, mailer);
      req.log.info({ userId: String(user._id), needsVerification }, 'New account created');
      if (needsVerification) {
        // NOT logged in yet: they must enter the code from the email first.
        if (!emailSent) req.log.error('Could not send the verification email');
        res.status(202).json({ needsVerification: true, email: user.email, emailSent });
        return;
      }
      await startSession(res, user._id);
      res.status(201).json({ user: toPublicUser(user) });
    }),
  );

  router.post(
    '/login',
    loginLimiter,
    asyncHandler(async (req, res) => {
      const { email, password } = loginBody.parse(req.body);

      // passwordHash is hidden by default (see models/user.ts); ask for it explicitly here.
      const user = await UserModel.findOne({ email }).select('+passwordHash').lean();
      // Google-only accounts have no password: treated like a wrong password.
      const passwordOk = await verifyPassword(password, user?.passwordHash ?? (await dummyHashPromise));

      // Same message for "no such user" and "wrong password", on purpose.
      if (!user || !user.passwordHash || !passwordOk) {
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
      }
      // Right password, but the email was never confirmed: send them to the code screen.
      // (Only said AFTER the password matched, so it reveals nothing to strangers.)
      if (user.emailVerified === false) {
        throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Please verify your email first: enter the code we sent you.', {
          email: user.email,
        });
      }

      await startSession(res, user._id);
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

  // ---------- Email verification ----------

  router.post(
    '/verify-email',
    verifyLimiter,
    asyncHandler(async (req, res) => {
      const { email, code } = verifyBody.parse(req.body);
      const user = await verifyEmail(email, code);
      await startSession(res, user._id);
      req.log.info({ userId: String(user._id) }, 'Email verified');
      res.json({ user: toPublicUser(user) });
    }),
  );

  router.post(
    '/resend-verification',
    resendLimiter,
    asyncHandler(async (req, res) => {
      if (!mailer) throw new AppError(503, 'EMAIL_OFF', 'Email is not set up on this server.');
      const { email } = forgotBody.parse(req.body);
      try {
        await resendVerification(email, mailer);
      } catch (err) {
        req.log.error({ err }, 'Could not send verification email');
        throw new AppError(503, 'EMAIL_FAILED', "We couldn't send the email right now. Please try again in a few minutes.");
      }
      res.json({ ok: true, message: 'If that email is waiting for verification, we sent a new code.' });
    }),
  );

  // ---------- Profile ----------

  // requireAuth does all the work; if we get here the user is logged in.
  router.get('/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  router.patch(
    '/me',
    requireAuth,
    asyncHandler(async (req, res) => {
      const { name } = nameBody.parse(req.body);
      res.json({ user: await updateName(req.user!.id, name) });
    }),
  );

  router.post(
    '/change-password',
    requireAuth,
    loginLimiter, // also slows down guessing the "current password"
    asyncHandler(async (req, res) => {
      const body = changePasswordBody.parse(req.body);
      await changePassword(req.user!.id, body, readSessionToken(req.cookies));
      res.status(204).end();
    }),
  );

  // ---------- Forgot password ----------

  router.post(
    '/forgot-password',
    forgotLimiter,
    asyncHandler(async (req, res) => {
      if (!mailer) throw new AppError(503, 'EMAIL_OFF', 'Password reset by email is not set up on this server.');
      const { email } = forgotBody.parse(req.body);
      try {
        await requestPasswordReset(email, mailer, appUrl);
      } catch (err) {
        // Email server down: log it, but don't reveal anything about the account.
        req.log.error({ err }, 'Could not send password reset email');
        throw new AppError(503, 'EMAIL_FAILED', "We couldn't send the email right now. Please try again in a few minutes.");
      }
      // Same answer whether or not the account exists (prevents finding out who has one).
      res.json({ ok: true, message: "If an account exists for that email, we've sent a link to reset the password." });
    }),
  );

  router.get(
    '/reset-password/:token',
    asyncHandler(async (req, res) => {
      res.json({ valid: await isResetTokenValid(req.params.token as string) });
    }),
  );

  router.post(
    '/reset-password',
    forgotLimiter,
    asyncHandler(async (req, res) => {
      const { token, password } = resetBody.parse(req.body);
      await resetPassword(token, password);
      res.json({ ok: true, message: 'Your password was changed. Please log in with the new password.' });
    }),
  );

  // ---------- Continue with Google ----------

  router.get('/google', (_req, res) => {
    if (!google) {
      res.redirect(`${appUrl}/login?error=google_off`);
      return;
    }
    const { url, state, verifier } = startGoogleSignIn(google);
    // sameSite "lax" (not strict): the cookie must come back when GOOGLE redirects the
    // browser to our callback, which is a cross-site navigation. Lives 10 minutes.
    res.cookie(GOOGLE_COOKIE, JSON.stringify({ state, verifier }), {
      httpOnly: true,
      sameSite: 'lax',
      secure: cookieSecure,
      path: '/',
      maxAge: 10 * 60 * 1000,
    });
    res.redirect(url);
  });

  router.get('/google/callback', async (req, res) => {
    // Any problem sends the user back to the login page with a short error code.
    const fail = (code: string) => res.redirect(`${appUrl}/login?error=${code}`);
    const saved = (() => {
      try {
        return JSON.parse(String(req.cookies?.[GOOGLE_COOKIE] ?? '')) as { state?: string; verifier?: string };
      } catch {
        return {};
      }
    })();
    res.clearCookie(GOOGLE_COOKIE, { path: '/' });

    if (!google) return fail('google_off');
    if (req.query.error) return fail('google_cancelled'); // the user pressed Cancel at Google
    const { code, state } = req.query;
    if (typeof code !== 'string' || typeof state !== 'string' || !saved.state || state !== saved.state || !saved.verifier) {
      return fail('google_state'); // missing/forged state: possible CSRF, refuse
    }
    try {
      const user = await finishGoogleSignIn(google, code, saved.verifier, fetchImpl);
      await startSession(res, user._id);
      req.log.info({ userId: String(user._id) }, 'Logged in with Google');
      res.redirect(`${appUrl}/`);
    } catch (err) {
      req.log.warn({ reason: err instanceof Error ? err.message : String(err) }, 'Google sign-in failed');
      fail(err instanceof AppError && err.code === 'GOOGLE_EMAIL_UNVERIFIED' ? 'google_unverified' : 'google_failed');
    }
  });

  // ---------- Demo helper ----------

  // GET /auth/demo: the demo account for the login page's "Use demo account" button.
  // When demo login is switched off we answer 404, exactly as if the route didn't exist,
  // and the login page simply doesn't show the button.
  router.get('/demo', (_req, res, next) => {
    if (!demoCredentials) {
      next(AppError.notFound('Route not found'));
      return;
    }
    res.json(demoCredentials);
  });

  return router;
}
