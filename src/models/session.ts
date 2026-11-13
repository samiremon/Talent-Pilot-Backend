/**
 * Session = one logged-in browser.
 *
 * How login works:
 *   1. The recruiter logs in. We create a long random "session token".
 *   2. The browser gets the token in a cookie. The database gets only a HASH of it.
 *   3. On every request the browser sends the cookie back; we hash it and look it up.
 *   4. Logging out deletes the row, so that token stops working immediately.
 *
 * Storing the hash (not the token) means that even someone who reads the database
 * can't use it to log in as the recruiter.
 *
 * We chose database sessions over JWTs because logout is instant and reliable:
 * a JWT stays valid until it expires, even after "logout".
 */
import { Schema, model, Types } from 'mongoose';

const sessionSchema = new Schema({
  // SHA-256 of the cookie token. Unique so a lookup returns at most one session.
  tokenHash: { type: String, required: true, unique: true },
  userId: { type: Types.ObjectId, ref: 'User', required: true, index: true },
  // MongoDB deletes the row automatically once this time passes (a "TTL index"),
  // so expired sessions clean themselves up without any cron job.
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  createdAt: { type: Date, default: () => new Date() },
});

export const SessionModel = model('Session', sessionSchema);
