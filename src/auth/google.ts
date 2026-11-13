/**
 * "Continue with Google" (OAuth 2.0 / OpenID Connect, authorization-code flow + PKCE).
 *
 * The dance, in plain words:
 *   1. GET /auth/google: we send the browser to Google's sign-in page, with a random
 *      `state` (anti-forgery) and a PKCE "code challenge". Both secrets are kept in a
 *      short-lived cookie in the user's browser.
 *   2. The user signs in at Google, which sends the browser back to
 *      GET /auth/google/callback?code=...&state=...
 *   3. We check `state` matches the cookie, swap the one-time `code` (+ PKCE verifier)
 *      for an access token directly with Google, then ask Google who the user is.
 *   4. We only accept a VERIFIED Google email. We find the account by Google id, or by
 *      email (linking it), or create a new one; then log them in and go to the app.
 *
 * Setup (needs a free Google Cloud project, see README):
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and APP_URL (where the app is opened).
 *   Authorized redirect URI in Google Cloud: {APP_URL}/api/auth/google/callback
 * If the id/secret aren't set, the feature is off and the button is hidden.
 */
import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '../errors.js';
import { UserModel } from '../models/user.js';

export interface GoogleSettings {
  clientId: string;
  clientSecret: string;
  /** Public address of the app, e.g. http://localhost:8080 */
  appUrl: string;
}

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

export function googleRedirectUri(appUrl: string): string {
  return `${appUrl.replace(/\/$/, '')}/api/auth/google/callback`;
}

/** Step 1: where to send the browser, plus the secrets to remember in a cookie. */
export function startGoogleSignIn(settings: GoogleSettings) {
  const state = randomBytes(24).toString('base64url');
  // PKCE: we keep `verifier` secret; Google gets only its hash. At step 3 we prove we
  // started this sign-in by revealing the verifier, so a stolen `code` is useless.
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: settings.clientId,
    redirect_uri: googleRedirectUri(settings.appUrl),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return { url: url.toString(), state, verifier };
}

interface GoogleProfile {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

/** Steps 3–4: turn Google's code into our user (found, linked, or created). */
export async function finishGoogleSignIn(
  settings: GoogleSettings,
  code: string,
  verifier: string,
  fetchImpl: typeof fetch = fetch,
) {
  const tokenRes = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      redirect_uri: googleRedirectUri(settings.appUrl),
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  if (!tokenRes.ok) throw new AppError(401, 'GOOGLE_FAILED', 'Google sign-in failed. Please try again.');
  const { access_token: accessToken } = (await tokenRes.json()) as { access_token?: string };
  if (!accessToken) throw new AppError(401, 'GOOGLE_FAILED', 'Google sign-in failed. Please try again.');

  const profileRes = await fetchImpl(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!profileRes.ok) throw new AppError(401, 'GOOGLE_FAILED', 'Google sign-in failed. Please try again.');
  const profile = (await profileRes.json()) as GoogleProfile;

  // Only trust emails Google has verified; otherwise someone could claim any address.
  if (!profile.sub || !profile.email || profile.email_verified !== true) {
    throw new AppError(401, 'GOOGLE_EMAIL_UNVERIFIED', 'Your Google email address is not verified.');
  }
  const email = profile.email.toLowerCase();

  // Already signed in with Google before?
  const byGoogle = await UserModel.findOne({ googleId: profile.sub });
  if (byGoogle) return byGoogle;

  // Same email as an existing account: link Google to it.
  const byEmail = await UserModel.findOne({ email });
  if (byEmail) {
    byEmail.googleId = profile.sub;
    // Google has verified this email, so an unverified sign-up becomes verified too.
    byEmail.emailVerified = true;
    byEmail.unverifiedExpiresAt = undefined;
    await byEmail.save();
    return byEmail;
  }

  // New person: create the account (no password; they can set one in Profile).
  return UserModel.create({ email, name: profile.name?.trim() || email.split('@')[0]!, googleId: profile.sub });
}
