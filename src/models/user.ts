/**
 * User = a recruiter who can log in.
 *
 * The assignment only needs one recruiter, but storing users in a normal collection
 * means adding more later is trivial.
 */
import { Schema, model, type InferSchemaType } from 'mongoose';

const userSchema = new Schema(
  {
    // Stored lowercase and trimmed so "Rahim@X.com " and "rahim@x.com" are the same account.
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    // The scrypt hash from auth/password.ts, never the real password.
    // `select: false` means normal queries leave it out; we must ask for it explicitly
    // (only the login code does), so it can't leak into an API response by accident.
    passwordHash: { type: String, required: true, select: false },
  },
  // Adds createdAt / updatedAt automatically.
  { timestamps: true },
);

export type User = InferSchemaType<typeof userSchema>;
export const UserModel = model('User', userSchema);

/** The safe, public view of a user that we send to the browser. */
export interface PublicUser {
  id: string;
  email: string;
  name: string;
}

export function toPublicUser(user: { _id: unknown; email: string; name: string }): PublicUser {
  return { id: String(user._id), email: user.email, name: user.name };
}
