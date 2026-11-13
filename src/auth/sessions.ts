/**
 * Creating, finding and deleting login sessions.
 * See models/session.ts for the overall idea.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Types } from 'mongoose';
import { SessionModel } from '../models/session.js';
import { UserModel, toPublicUser, type PublicUser } from '../models/user.js';

/** We store only this hash of the token, never the token itself. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Starts a session for a user and returns the raw token for the cookie.
 * 32 random bytes = 256 bits: impossible to guess.
 */
export async function createSession(userId: Types.ObjectId, ttlHours: number): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
  await SessionModel.create({ tokenHash: hashToken(token), userId, expiresAt });
  return { token, expiresAt };
}

/**
 * Looks up the user behind a cookie token.
 * Returns null if the token is unknown or expired (MongoDB's automatic cleanup can lag
 * up to a minute, so we also check the expiry time ourselves).
 */
export async function findUserBySessionToken(token: string): Promise<PublicUser | null> {
  const session = await SessionModel.findOne({ tokenHash: hashToken(token), expiresAt: { $gt: new Date() } }).lean();
  if (!session) return null;

  const user = await UserModel.findById(session.userId).lean();
  return user ? toPublicUser(user) : null;
}

/** Logout: delete the session so the token stops working right away. */
export async function deleteSession(token: string): Promise<void> {
  await SessionModel.deleteOne({ tokenHash: hashToken(token) });
}
