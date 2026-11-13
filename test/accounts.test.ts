/**
 * Account tests: sign-up (with the "wrong email" check), profile, change password,
 * forgot/reset password, and Continue with Google.
 * No network: DNS, email and Google are all replaced by fakes.
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createEmailChecker } from '../src/auth/emailCheck.js';
import { createMemoryMailer } from '../src/email/mailer.js';
import { PasswordResetModel } from '../src/models/passwordReset.js';
import { UserModel } from '../src/models/user.js';
import { useTestDatabase } from './helpers/db.js';

useTestDatabase();

// ---------- Fakes ----------

/** Fake DNS: gmail.com and acme.io exist; noemail.com refuses mail; everything else doesn't exist. */
const notFound = () => Promise.reject(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));
const fakeDns = {
  resolveMx: (d: string) =>
    d === 'gmail.com'
      ? Promise.resolve([{ exchange: 'gmail-smtp-in.l.google.com', priority: 5 }])
      : d === 'noemail.com'
        ? Promise.resolve([{ exchange: '.', priority: 0 }])
        : d === 'slowdns.com'
          ? Promise.reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }))
          : notFound(),
  resolve4: (d: string) => (d === 'acme.io' ? Promise.resolve(['93.184.216.34']) : notFound()),
  resolve6: () => notFound(),
} as unknown as Parameters<typeof createEmailChecker>[0];

/** Fake Google: hands out a fixed profile for the code "good-code". */
function fakeGoogle(profile: Record<string, unknown>) {
  return (async (url: string | URL) => {
    const href = String(url);
    if (href.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'fake-access' }), { status: 200 });
    }
    if (href.includes('openidconnect.googleapis.com/v1/userinfo')) {
      return new Response(JSON.stringify(profile), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
}

const APP_URL = 'http://localhost:8080';

function makeApp(googleProfile: Record<string, unknown> = {}) {
  const mailer = createMemoryMailer();
  const app = createApp({
    corsOrigins: ['http://localhost:5173'],
    auth: {
      cookieSecure: false,
      sessionTtlHours: 12,
      appUrl: APP_URL,
      mailer,
      checkEmail: createEmailChecker(fakeDns),
      google: { clientId: 'client-id-123', clientSecret: 'client-secret-123', appUrl: APP_URL },
      fetchImpl: fakeGoogle(googleProfile),
    },
  });
  return { app, mailer };
}

const NEW_USER = { name: 'Nadia Islam', email: 'Nadia.Islam@gmail.com', password: 'a-good-long-password' };

/** Pulls the 6-digit code out of the newest verification email. */
function codeFrom(mailer: ReturnType<typeof createMemoryMailer>): string {
  const mail = [...mailer.sent].reverse().find((m) => m.subject.includes('verification code'));
  return /(\d{6}) is your TalentPilot verification code/.exec(mail?.subject ?? '')?.[1] ?? '';
}

/** Signs up AND enters the emailed code, leaving `agent` logged in. */
async function signUpVerified(
  agent: ReturnType<typeof request.agent>,
  mailer: ReturnType<typeof createMemoryMailer>,
  user = NEW_USER,
) {
  await agent.post('/auth/signup').send(user).expect(202);
  await agent.post('/auth/verify-email').send({ email: user.email, code: codeFrom(mailer) }).expect(200);
}

beforeEach(() => {
  // Each test builds its own app (fresh rate limits).
});

// ---------- Sign up ----------

describe('sign up', () => {
  it('creates an UNVERIFIED account, emails a code, and logs in only with the right code', async () => {
    const { app, mailer } = makeApp();
    const agent = request.agent(app);
    const res = await agent.post('/auth/signup').send(NEW_USER).expect(202);
    expect(res.body).toEqual({ needsVerification: true, email: 'nadia.islam@gmail.com', emailSent: true });
    await agent.get('/auth/me').expect(401); // not logged in yet

    // The account exists but can't log in until verified, and will expire if never verified.
    const stored = await UserModel.findOne({ email: 'nadia.islam@gmail.com' }).lean();
    expect(stored).toMatchObject({ emailVerified: false });
    expect(stored?.unverifiedExpiresAt).toBeInstanceOf(Date);
    const login = await request(app).post('/auth/login').send({ email: NEW_USER.email, password: NEW_USER.password }).expect(403);
    expect(login.body.error).toMatchObject({ code: 'EMAIL_NOT_VERIFIED', details: { email: 'nadia.islam@gmail.com' } });

    // The email went to the right address, with a 6-digit code.
    expect(mailer.sent[0]).toMatchObject({ to: 'nadia.islam@gmail.com' });
    const code = codeFrom(mailer);
    expect(code).toMatch(/^\d{6}$/);

    const wrong = code === '000000' ? '000001' : '000000';
    expect((await agent.post('/auth/verify-email').send({ email: NEW_USER.email, code: wrong }).expect(400)).body.error.code).toBe('CODE_INVALID');

    const ok = await agent.post('/auth/verify-email').send({ email: NEW_USER.email, code }).expect(200);
    expect(ok.body.user).toMatchObject({ name: 'Nadia Islam', email: 'nadia.islam@gmail.com', hasPassword: true, hasGoogle: false });
    expect((await agent.get('/auth/me').expect(200)).body.user.name).toBe('Nadia Islam');
    // Verified accounts never expire.
    expect((await UserModel.findOne({ email: 'nadia.islam@gmail.com' }).lean())?.unverifiedExpiresAt).toBeUndefined();
  });

  it('refuses an expired code and locks after 5 wrong codes until a new one is sent', async () => {
    const { app, mailer } = makeApp();
    await request(app).post('/auth/signup').send(NEW_USER).expect(202);
    const code = codeFrom(mailer);
    const wrong = code === '111111' ? '222222' : '111111';
    for (let i = 0; i < 5; i++) await request(app).post('/auth/verify-email').send({ email: NEW_USER.email, code: wrong }).expect(400);
    // Even the right code is refused now: too many guesses.
    await request(app).post('/auth/verify-email').send({ email: NEW_USER.email, code }).expect(429);

    // "Send a new code" -> the new code works.
    await request(app).post('/auth/resend-verification').send({ email: NEW_USER.email }).expect(200);
    const fresh = codeFrom(mailer);
    await UserModel.updateOne({ email: 'nadia.islam@gmail.com' }, { $set: { verifyCodeExpiresAt: new Date(Date.now() - 1000) } });
    expect((await request(app).post('/auth/verify-email').send({ email: NEW_USER.email, code: fresh }).expect(400)).body.error.code).toBe('CODE_EXPIRED');

    await request(app).post('/auth/resend-verification').send({ email: NEW_USER.email }).expect(200);
    await request(app).post('/auth/verify-email').send({ email: NEW_USER.email, code: codeFrom(mailer) }).expect(200);
  });

  it('answers "resend" the same way for unknown emails and sends nothing', async () => {
    const { app, mailer } = makeApp();
    const res = await request(app).post('/auth/resend-verification').send({ email: 'nobody@gmail.com' }).expect(200);
    expect(res.body.message).toContain('If that email is waiting for verification');
    expect(mailer.sent).toHaveLength(0);
  });

  it.each([
    ['not-an-email', 'This email address is not valid'],
    ['nadia@gmial.com', 'Did you mean gmail.com?'],
    ['nadia@this-domain-does-not-exist.com', 'We couldn\'t find the email domain "this-domain-does-not-exist.com"'],
    ['nadia@noemail.com', 'does not accept email'],
  ])('rejects the wrong email %s with a clear message', async (email, message) => {
    const { app } = makeApp();
    const res = await request(app).post('/auth/signup').send({ ...NEW_USER, email }).expect(400);
    expect(res.body.error.code).toBe('INVALID_EMAIL');
    expect(res.body.error.message).toContain(message);
    expect(await UserModel.countDocuments()).toBe(0);
  });

  it('accepts a domain with only an address record, and does not block when DNS is down', async () => {
    const { app } = makeApp();
    await request(app).post('/auth/signup').send({ ...NEW_USER, email: 'a@acme.io' }).expect(202);
    await request(app).post('/auth/signup').send({ ...NEW_USER, email: 'b@slowdns.com' }).expect(202);
  });

  it('lets an unverified sign-up be redone, but refuses a verified email, and a short password', async () => {
    const { app, mailer } = makeApp();
    await request(app).post('/auth/signup').send(NEW_USER).expect(202);
    // Signing up again before verifying just updates it and sends a new code.
    await request(app).post('/auth/signup').send({ ...NEW_USER, name: 'Nadia I.' }).expect(202);
    expect(await UserModel.countDocuments()).toBe(1);
    await request(app).post('/auth/verify-email').send({ email: NEW_USER.email, code: codeFrom(mailer) }).expect(200);
    const again = await request(app).post('/auth/signup').send({ ...NEW_USER, email: 'nadia.islam@GMAIL.com' }).expect(409);
    expect(again.body.error.code).toBe('EMAIL_TAKEN');
    const short = await request(app).post('/auth/signup').send({ ...NEW_USER, email: 'x@gmail.com', password: 'short' }).expect(400);
    expect(short.body.error.details[0]).toMatchObject({ path: 'password' });
  });

  it('tells the login page which options exist', async () => {
    const { app } = makeApp();
    expect((await request(app).get('/auth/providers').expect(200)).body).toEqual({
      google: true,
      signup: true,
      passwordReset: true,
      emailVerification: true,
    });
  });
});

// ---------- Profile ----------

describe('profile', () => {
  it('changes the name', async () => {
    const { app, mailer } = makeApp();
    const agent = request.agent(app);
    await signUpVerified(agent, mailer);
    const res = await agent.patch('/auth/me').send({ name: '  Nadia I.  ' }).expect(200);
    expect(res.body.user.name).toBe('Nadia I.');
    await agent.patch('/auth/me').send({ name: '   ' }).expect(400);
  });

  it('changes the password only with the right current one, and logs out other browsers', async () => {
    const { app, mailer } = makeApp();
    const laptop = request.agent(app);
    const phone = request.agent(app);
    await signUpVerified(laptop, mailer);
    await phone.post('/auth/login').send({ email: NEW_USER.email, password: NEW_USER.password }).expect(200);

    const wrong = await laptop
      .post('/auth/change-password')
      .send({ currentPassword: 'nope', newPassword: 'brand-new-password' })
      .expect(400);
    expect(wrong.body.error.code).toBe('WRONG_PASSWORD');

    await laptop.post('/auth/change-password').send({ currentPassword: NEW_USER.password, newPassword: 'brand-new-password' }).expect(204);
    await laptop.get('/auth/me').expect(200); // this browser stays logged in
    await phone.get('/auth/me').expect(401); // the other one is logged out
    await request(app).post('/auth/login').send({ email: NEW_USER.email, password: NEW_USER.password }).expect(401);
    await request(app).post('/auth/login').send({ email: NEW_USER.email, password: 'brand-new-password' }).expect(200);
  });
});

// ---------- Forgot password ----------

describe('forgot password', () => {
  /** Pulls the reset token out of the newest reset email. */
  const resetMail = (mailer: ReturnType<typeof createMemoryMailer>) =>
    [...mailer.sent].reverse().find((m) => m.subject === 'Reset your TalentPilot password')!;
  const tokenFrom = (text: string) => /reset-password\?token=([^\s]+)/.exec(text)?.[1] ?? '';

  it('gives the same answer for unknown emails and sends nothing', async () => {
    const { app, mailer } = makeApp();
    const res = await request(app).post('/auth/forgot-password').send({ email: 'nobody@gmail.com' }).expect(200);
    expect(res.body.message).toContain('If an account exists');
    expect(mailer.sent).toHaveLength(0);
  });

  it('emails a one-time link that sets a new password and logs out everywhere', async () => {
    const { app, mailer } = makeApp();
    const agent = request.agent(app);
    await signUpVerified(agent, mailer);

    await request(app).post('/auth/forgot-password').send({ email: 'NADIA.islam@gmail.com' }).expect(200);
    const mail = resetMail(mailer);
    expect(mail).toMatchObject({ to: 'nadia.islam@gmail.com', subject: 'Reset your TalentPilot password' });
    expect(mail.text).toContain(`${APP_URL}/reset-password?token=`);

    const token = decodeURIComponent(tokenFrom(mail.text));
    expect((await request(app).get(`/auth/reset-password/${token}`).expect(200)).body.valid).toBe(true);
    // Only a hash is stored, not the token from the email.
    expect(await PasswordResetModel.countDocuments({ tokenHash: token })).toBe(0);

    await request(app).post('/auth/reset-password').send({ token, password: 'my-new-password-1' }).expect(200);
    await agent.get('/auth/me').expect(401); // old sessions are gone
    await request(app).post('/auth/login').send({ email: NEW_USER.email, password: 'my-new-password-1' }).expect(200);

    // The link works only once.
    const reuse = await request(app).post('/auth/reset-password').send({ token, password: 'another-password-2' }).expect(400);
    expect(reuse.body.error.code).toBe('RESET_LINK_INVALID');
  });

  it('refuses an expired link', async () => {
    const { app, mailer } = makeApp();
    await signUpVerified(request.agent(app), mailer);
    await request(app).post('/auth/forgot-password').send({ email: NEW_USER.email }).expect(200);
    await PasswordResetModel.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const token = decodeURIComponent(tokenFrom(resetMail(mailer).text));
    await request(app).post('/auth/reset-password').send({ token, password: 'my-new-password-1' }).expect(400);
  });
});

// ---------- Google ----------

describe('Continue with Google', () => {
  /** Step 1 + 2: start the flow, then come back from "Google" with the right state. */
  async function signInWithGoogle(app: ReturnType<typeof makeApp>['app']) {
    const agent = request.agent(app);
    const start = await agent.get('/auth/google').expect(302);
    const googleUrl = new URL(start.headers.location as string);
    expect(googleUrl.origin).toBe('https://accounts.google.com');
    expect(googleUrl.searchParams.get('client_id')).toBe('client-id-123');
    expect(googleUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(googleUrl.searchParams.get('redirect_uri')).toBe(`${APP_URL}/api/auth/google/callback`);
    const state = googleUrl.searchParams.get('state');
    const back = await agent.get(`/auth/google/callback?code=good-code&state=${state}`).expect(302);
    return { agent, location: back.headers.location as string };
  }

  it('creates an account for a new verified Google user and logs them in', async () => {
    const { app } = makeApp({ sub: 'google-1', email: 'Tanvir@gmail.com', email_verified: true, name: 'Tanvir Hasan' });
    const { agent, location } = await signInWithGoogle(app);
    expect(location).toBe(`${APP_URL}/`);
    const me = await agent.get('/auth/me').expect(200);
    expect(me.body.user).toMatchObject({ name: 'Tanvir Hasan', email: 'tanvir@gmail.com', hasGoogle: true, hasPassword: false });

    // Signing in again finds the same account.
    await signInWithGoogle(app);
    expect(await UserModel.countDocuments()).toBe(1);
  });

  it('links Google to an existing account with the same email', async () => {
    const { app } = makeApp({ sub: 'google-2', email: 'nadia.islam@gmail.com', email_verified: true, name: 'N' });
    // Signed up but never verified: Google's verified email verifies it.
    await request(app).post('/auth/signup').send(NEW_USER).expect(202);
    const { agent } = await signInWithGoogle(app);
    const me = (await agent.get('/auth/me').expect(200)).body.user;
    expect(me).toMatchObject({ name: 'Nadia Islam', hasGoogle: true, hasPassword: true });
  });

  it('refuses an unverified Google email', async () => {
    const { app } = makeApp({ sub: 'google-3', email: 'x@gmail.com', email_verified: false });
    const { location } = await signInWithGoogle(app);
    expect(location).toBe(`${APP_URL}/login?error=google_unverified`);
    expect(await UserModel.countDocuments()).toBe(0);
  });

  it('refuses a callback whose state does not match (forged request)', async () => {
    const { app } = makeApp({ sub: 'g', email: 'x@gmail.com', email_verified: true });
    const agent = request.agent(app);
    await agent.get('/auth/google').expect(302);
    const res = await agent.get('/auth/google/callback?code=good-code&state=forged').expect(302);
    expect(res.headers.location).toBe(`${APP_URL}/login?error=google_state`);
  });

  it('lets a Google-only user set a first password without a current one', async () => {
    const { app } = makeApp({ sub: 'google-4', email: 'mitu@gmail.com', email_verified: true, name: 'Mitu' });
    const { agent } = await signInWithGoogle(app);
    await agent.post('/auth/change-password').send({ newPassword: 'first-password-1' }).expect(204);
    await request(app).post('/auth/login').send({ email: 'mitu@gmail.com', password: 'first-password-1' }).expect(200);
  });
});
