/**
 * Account management: sign up, profile changes, and "forgot password".
 * The HTTP side is in auth/routes.ts; this file holds the rules.
 */
import { createHash, randomBytes } from 'node:crypto';
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

/**
 * Creates a password account. Throws a 400 with a clear message if the email is invalid
 * (bad format or a domain that doesn't exist), or 409 if it's already registered.
 */
export async function signUp(input: z.infer<typeof signupInput>, checkEmail: EmailChecker) {
  const problem = await checkEmail(input.email);
  if (problem) throw new AppError(400, 'INVALID_EMAIL', problem, [{ path: 'email', message: problem }]);

  if (await UserModel.exists({ email: input.email })) {
    throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists. Try logging in instead.', [
      { path: 'email', message: 'is already registered' },
    ]);
  }

  try {
    const user = await UserModel.create({ name: input.name, email: input.email, passwordHash: await hashPassword(input.password) });
    return user;
  } catch (err) {
    // Two sign-ups with the same email at the same moment: the database's unique index wins.
    if ((err as { code?: number }).code === 11000) {
      throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists. Try logging in instead.');
    }
    throw err;
  }
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
  await UserModel.updateOne({ _id: reset.userId }, { $set: { passwordHash: await hashPassword(password) } });
  await deleteUserSessions(new Types.ObjectId(String(reset.userId)));
}
