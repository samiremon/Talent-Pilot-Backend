/**
 * Account management: sign up, profile changes, and "forgot password".
 * The HTTP side is in auth/routes.ts; this file holds the rules.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { Types } from 'mongoose';
import { z } from 'zod';
import { escapeHtml, type Mailer } from '../email/mailer.js';
import { AppError } from '../errors.js';
import { PasswordResetModel } from '../models/passwordReset.js';
import { UserModel, toPublicUser } from '../models/user.js';
import type { EmailChecker } from './emailCheck.js';
import { hashPassword, verifyPassword } from './password.js';
import { deleteUserSessions } from './sessions.js';

/** Password rules, shared by sign-up, change and reset. */
export const passwordRule = z
  .string()
  .min(8, 'must be at least 8 characters')
  .max(200, 'is too long')
  .refine((p) => p.trim().length > 0, 'cannot be only spaces');

const nameRule = z.string().trim().min(1, 'is required').max(100, 'is too long (max 100 characters)');

export const signupInput = z.object({
  name: nameRule,
  email: z.string().trim().toLowerCase(),
  password: passwordRule,
});

const UNVERIFIED_HOURS = 24;
const CODE_MINUTES = 15;
const MAX_CODE_ATTEMPTS = 5;

/** The code is hashed together with the user id, so equal codes never look equal in the DB. */
function hashCode(userId: unknown, code: string): string {
  return createHash('sha256').update(`${String(userId)}:${code}`).digest('hex');
}

/**
 * Creates a password account.
 *
 * Throws a 400 with a clear message if the email is invalid (bad format or a domain that
 * doesn't exist), or 409 if a VERIFIED account already uses it.
 *
 * With `mailer` (normal case) the account starts UNVERIFIED and a 6-digit code is emailed;
 * the caller must not log the user in until verifyEmail() succeeds. Signing up again with
 * the same unverified email (e.g. after a typo in the name) just updates it and sends a
 * fresh code. Without a mailer there's no way to send a code, so the account is verified
 * straight away.
 */
export async function signUp(input: z.infer<typeof signupInput>, checkEmail: EmailChecker, mailer?: Mailer) {
  const problem = await checkEmail(input.email);
  if (problem) throw new AppError(400, 'INVALID_EMAIL', problem, [{ path: 'email', message: problem }]);

  const existing = await UserModel.findOne({ email: input.email });
  if (existing && existing.emailVerified !== false) {
    throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists. Try logging in instead.', [
      { path: 'email', message: 'is already registered' },
    ]);
  }

  const fields = {
    name: input.name,
    passwordHash: await hashPassword(input.password),
    emailVerified: !mailer,
    unverifiedExpiresAt: mailer ? new Date(Date.now() + UNVERIFIED_HOURS * 60 * 60 * 1000) : undefined,
  };

  let user;
  try {
    user = existing
      ? Object.assign(existing, fields)
      : new UserModel({ email: input.email, ...fields });
    await user.save();
  } catch (err) {
    // Two sign-ups with the same email at the same moment: the database's unique index wins.
    if ((err as { code?: number }).code === 11000) {
      throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists. Try logging in instead.');
    }
    throw err;
  }

  // If the email server is down, the account still exists: the code screen tells the
  // person to press "Send a new code" in a moment instead of failing the whole sign-up.
  let emailSent = false;
  if (mailer) {
    try {
      await sendVerificationCode(user._id, mailer);
      emailSent = true;
    } catch {
      emailSent = false;
    }
  }
  return { user, needsVerification: Boolean(mailer), emailSent };
}

/** Makes a new 6-digit code for an unverified account and emails it. */
export async function sendVerificationCode(userId: unknown, mailer: Mailer): Promise<void> {
  const user = await UserModel.findById(userId);
  if (!user || user.emailVerified !== false) return;

  // randomInt is cryptographically secure; padStart keeps leading zeros ("004213").
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await UserModel.updateOne(
    { _id: user._id },
    {
      $set: {
        verifyCodeHash: hashCode(user._id, code),
        verifyCodeExpiresAt: new Date(Date.now() + CODE_MINUTES * 60 * 1000),
        verifyAttempts: 0,
      },
    },
  );

  await mailer.send({
    to: user.email,
    subject: `${code} is your TalentPilot verification code`,
    text: [
      `Hi ${user.name},`,
      '',
      `Your TalentPilot verification code is: ${code}`,
      '',
      `Enter it on the sign-up page to finish creating your account. It works for ${CODE_MINUTES} minutes.`,
      "If you didn't sign up for TalentPilot, ignore this email; the account will be removed automatically.",
    ].join('\n'),
    html: `<p>Hi ${escapeHtml(user.name)},</p>
<p>Your TalentPilot verification code is:</p>
<p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p>
<p>Enter it on the sign-up page to finish creating your account. It works for ${CODE_MINUTES} minutes.</p>
<p>If you didn't sign up for TalentPilot, ignore this email; the account will be removed automatically.</p>`,
  });
}

/** "Send me a new code": does nothing (silently) unless an unverified account exists. */
export async function resendVerification(email: string, mailer: Mailer): Promise<void> {
  const user = await UserModel.findOne({ email: email.trim().toLowerCase(), emailVerified: false }).lean();
  if (user) await sendVerificationCode(user._id, mailer);
}

/**
 * Checks the 6-digit code. On success the account becomes verified (and stops expiring)
 * and is returned so the caller can log the person in.
 */
export async function verifyEmail(email: string, code: string) {
  const invalid = () =>
    new AppError(400, 'CODE_INVALID', 'That code is not right. Check the email and try again.', [
      { path: 'code', message: 'is not right' },
    ]);
  const user = await UserModel.findOne({ email: email.trim().toLowerCase() }).select(
    '+verifyCodeHash +verifyCodeExpiresAt +verifyAttempts +passwordHash',
  );
  if (!user) throw invalid();
  if (user.emailVerified !== false) {
    throw new AppError(409, 'ALREADY_VERIFIED', 'This email is already verified. Please log in.');
  }
  if (!user.verifyCodeHash || !user.verifyCodeExpiresAt || user.verifyCodeExpiresAt < new Date()) {
    throw new AppError(400, 'CODE_EXPIRED', 'This code has expired. Ask for a new one.');
  }
  if ((user.verifyAttempts ?? 0) >= MAX_CODE_ATTEMPTS) {
    throw new AppError(429, 'TOO_MANY_ATTEMPTS', 'Too many wrong codes. Ask for a new one.');
  }

  const expected = Buffer.from(user.verifyCodeHash, 'hex');
  const actual = Buffer.from(hashCode(user._id, code.trim()), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    await UserModel.updateOne({ _id: user._id }, { $inc: { verifyAttempts: 1 } });
    throw invalid();
  }

  await UserModel.updateOne(
    { _id: user._id },
    {
      $set: { emailVerified: true },
      $unset: { unverifiedExpiresAt: 1, verifyCodeHash: 1, verifyCodeExpiresAt: 1, verifyAttempts: 1 },
    },
  );
  user.emailVerified = true;
  return user;
}

export async function updateName(userId: string, name: string) {
  const clean = nameRule.parse(name);
  const user = await UserModel.findByIdAndUpdate(userId, { $set: { name: clean } }, { new: true }).select('+passwordHash').lean();
  if (!user) throw AppError.notFound('Account not found');
  return toPublicUser(user);
}

/**
 * Change password from the Profile page. If the account already has a password, the
 * current one must be given (so someone at an unlocked computer can't take over the
 * account). Google-only accounts can set a first password without it.
 * All OTHER browsers are logged out; this one stays logged in.
 */
export async function changePassword(
  userId: string,
  { currentPassword, newPassword }: { currentPassword?: string; newPassword: string },
  keepSessionToken?: string,
) {
  const user = await UserModel.findById(userId).select('+passwordHash');
  if (!user) throw AppError.notFound('Account not found');

  if (user.passwordHash) {
    if (!currentPassword || !(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new AppError(400, 'WRONG_PASSWORD', 'Your current password is not correct.', [
        { path: 'currentPassword', message: 'is not correct' },
      ]);
    }
  }
  user.passwordHash = await hashPassword(passwordRule.parse(newPassword));
  await user.save();
  await deleteUserSessions(user._id, keepSessionToken);
}

// ---------- Forgot password ----------

const RESET_MINUTES = 30;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Emails a reset link IF an account with this email exists. The caller always shows the
 * same "If an account exists, we've sent a link" message, so this can't be used to find
 * out who has an account.
 */
export async function requestPasswordReset(email: string, mailer: Mailer, appUrl: string): Promise<void> {
  const user = await UserModel.findOne({ email: email.trim().toLowerCase() }).lean();
  if (!user) return;

  // Only the newest link should work: remove older unused ones.
  await PasswordResetModel.deleteMany({ userId: user._id, usedAt: null });

  const token = randomBytes(32).toString('base64url');
  await PasswordResetModel.create({
    userId: user._id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + RESET_MINUTES * 60 * 1000),
  });

  const link = `${appUrl.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
  await mailer.send({
    to: user.email,
    subject: 'Reset your TalentPilot password',
    text: [
      `Hi ${user.name},`,
      '',
      'Someone (hopefully you) asked to reset the password for your TalentPilot account.',
      `Open this link to choose a new password (it works once, for ${RESET_MINUTES} minutes):`,
      link,
      '',
      "If you didn't ask for this, you can ignore this email. Your password won't change.",
    ].join('\n'),
    html: `<p>Hi ${escapeHtml(user.name)},</p>
<p>Someone (hopefully you) asked to reset the password for your TalentPilot account.</p>
<p><a href="${escapeHtml(link)}">Choose a new password</a> (the link works once, for ${RESET_MINUTES} minutes).</p>
<p>If you didn't ask for this, you can ignore this email. Your password won't change.</p>`,
  });
}

/** Finds a reset link that is still usable, or null. */
async function findUsableReset(token: string) {
  return PasswordResetModel.findOne({ tokenHash: hashToken(token), usedAt: null, expiresAt: { $gt: new Date() } });
}

export async function isResetTokenValid(token: string): Promise<boolean> {
  return Boolean(await findUsableReset(token));
}

/** Sets the new password, burns the link, and logs the account out everywhere. */
export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const password = passwordRule.parse(newPassword);
  // Mark the link used first, atomically, so two clicks can't both use it.
  const reset = await PasswordResetModel.findOneAndUpdate(
    { tokenHash: hashToken(token), usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
    { new: true },
  );
  if (!reset) {
    throw new AppError(400, 'RESET_LINK_INVALID', 'This reset link is invalid or has expired. Please request a new one.');
  }
  // Opening the emailed link also proves the person owns the email: mark it verified.
  await UserModel.updateOne(
    { _id: reset.userId },
    { $set: { passwordHash: await hashPassword(password), emailVerified: true }, $unset: { unverifiedExpiresAt: 1 } },
  );
  await deleteUserSessions(new Types.ObjectId(String(reset.userId)));
}
