/**
 * User = a recruiter who can log in.
 *
 * Ways to have an account:
 *   - sign up with name + email + password (or the seeded demo account)
 *   - "Continue with Google": no password stored, linked by Google's user id
 *   - both: a Google user can set a password later on the Profile page
 *
 * All recruiters share one team workspace (jobs, candidates, activity); each has their
 * own private chat. Their name is shown on everything they do.
 */
import { Schema, model, type InferSchemaType } from 'mongoose';

const userSchema = new Schema(
  {
    // Stored lowercase and trimmed so "Rahim@X.com " and "rahim@x.com" are the same account.
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    // The scrypt hash from auth/password.ts, never the real password. Null for accounts
    // that only use Google. `select: false` means normal queries leave it out; code must
    // ask for it explicitly, so it can't leak into an API response by accident.
    passwordHash: { type: String, default: null, select: false },
    // Google's permanent id for this person ("sub"), when they use Continue with Google.
    googleId: { type: String, default: null },
  },
  // Adds createdAt / updatedAt automatically.
  { timestamps: true },
);

// One account per Google id (only rows that have one).
userSchema.index({ googleId: 1 }, { unique: true, partialFilterExpression: { googleId: { $type: 'string' } } });

export type User = InferSchemaType<typeof userSchema>;
export const UserModel = model('User', userSchema);

/** The safe, public view of a user that we send to the browser. */
export interface PublicUser {
  id: string;
  email: string;
  name: string;
  /** Can log in with a password (Profile then asks for the current one to change it). */
  hasPassword: boolean;
  /** Linked to a Google account. */
  hasGoogle: boolean;
}

export function toPublicUser(user: {
  _id: unknown;
  email: string;
  name: string;
  passwordHash?: string | null;
  googleId?: string | null;
}): PublicUser {
  return {
    id: String(user._id),
    email: user.email,
    name: user.name,
    hasPassword: Boolean(user.passwordHash),
    hasGoogle: Boolean(user.googleId),
  };
}
