/**
 * Makes sure the recruiter account from .env exists.
 *
 * Used in two places:
 *  - On server start (mode "create-if-missing"): a fresh database gets the account
 *    automatically, so a reviewer can log in right after `docker compose up`.
 *  - By `npm run seed` (mode "create-or-reset"): also resets the password to the one
 *    in .env, handy if you changed it or forgot it.
 */
import { UserModel } from '../models/user.js';
import { hashPassword } from './password.js';

export interface RecruiterSeed {
  email: string;
  password: string;
  name: string;
}

export type SeedResult = 'created' | 'password-reset' | 'already-exists';

export async function ensureRecruiter(
  seed: RecruiterSeed,
  mode: 'create-if-missing' | 'create-or-reset',
): Promise<SeedResult> {
  const email = seed.email.trim().toLowerCase();
  const existing = await UserModel.exists({ email });

  if (!existing) {
    await UserModel.create({ email, name: seed.name, passwordHash: await hashPassword(seed.password) });
    return 'created';
  }

  if (mode === 'create-if-missing') return 'already-exists';

  await UserModel.updateOne({ email }, { name: seed.name, passwordHash: await hashPassword(seed.password) });
  return 'password-reset';
}
