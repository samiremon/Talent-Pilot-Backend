/**
 * PasswordReset = one "forgot password" link that was emailed.
 *
 * Same safety idea as login sessions: the email contains a long random token; the
 * database keeps only its SHA-256 hash. A link works once, for 30 minutes.
 */
import { Schema, model, Types } from 'mongoose';

const passwordResetSchema = new Schema({
  userId: { type: Types.ObjectId, ref: 'User', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  // MongoDB deletes the row by itself after this time (TTL index).
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  usedAt: { type: Date, default: null },
  createdAt: { type: Date, default: () => new Date() },
});

export const PasswordResetModel = model('PasswordReset', passwordResetSchema);
