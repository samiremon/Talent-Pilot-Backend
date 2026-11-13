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
 *
 * EMAIL VERIFICATION: a sign-up with email + password starts UNVERIFIED. We email a
 * 6-digit code; the account can't log in until the code is entered. That's the only way to
 * be sure the mailbox is real and belongs to the person (a fake address never gets the
 * code). Unverified sign-ups delete themselves after 24 hours (TTL index below).
 * Google accounts are verified by Google; the seeded demo account is verified by default.
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

    // --- Email verification ---
    // Missing on older accounts = treated as verified.
    emailVerified: { type: Boolean, default: true },
    // Only set while unverified: MongoDB deletes the account at this time if still unverified.
    unverifiedExpiresAt: { type: Date, default: undefined },
    // The current 6-digit code, hashed (never stored as-is), when it expires, and how many
    // wrong guesses were made (max 5, then a new code is needed).
    verifyCodeHash: { type: String, default: null, select: false },
    verifyCodeExpiresAt: { type: Date, default: null, select: false },
    verifyAttempts: { type: Number, default: 0, select: false },
  },
  // Adds createdAt / updatedAt automatically.
  { timestamps: true },
);

// Unverified sign-ups clean themselves up (rows without the field are never deleted).
userSchema.index({ unverifiedExpiresAt: 1 }, { expireAfterSeconds: 0 });

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
