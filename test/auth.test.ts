/**
 * Login tests, run against a throwaway in-memory MongoDB (mongodb-memory-server),
 * so they need no Docker and never touch your real data.
 * The first run downloads a MongoDB binary (~100 MB), then it's cached.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { ensureRecruiter } from '../src/auth/recruiter.js';
import { SessionModel } from '../src/models/session.js';
import { UserModel } from '../src/models/user.js';

const RECRUITER = { email: 'recruiter@example.com', password: 'correct-horse-battery', name: 'Rina Recruiter' };

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

// Every test starts from an empty database with just the recruiter in it.
beforeEach(async () => {
  await UserModel.deleteMany({});
  await SessionModel.deleteMany({});
  await ensureRecruiter(RECRUITER, 'create-if-missing');
});

function makeApp(loginAttemptsPerWindow = 10) {
  return createApp({
    corsOrigins: ['http://localhost:5173'],
    auth: { cookieSecure: false, sessionTtlHours: 12, loginAttemptsPerWindow },
  });
}

describe('password hashing', () => {
  it('accepts the right password and rejects a wrong one', async () => {
    const stored = await hashPassword('s3cret-pass');
    expect(stored).not.toContain('s3cret-pass');
    expect(await verifyPassword('s3cret-pass', stored)).toBe(true);
    expect(await verifyPassword('wrong', stored)).toBe(false);
  });

  it('gives the same password a different hash each time (random salt)', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('returns false for garbage instead of crashing', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
  });
});

describe('recruiter seed', () => {
  it('stores only a hash, never the password', async () => {
    const user = await UserModel.findOne({ email: RECRUITER.email }).select('+passwordHash').lean();
    expect(user?.passwordHash).toMatch(/^scrypt\$/);
    expect(JSON.stringify(user)).not.toContain(RECRUITER.password);
  });

  it('does not duplicate the account, and can reset its password', async () => {
    expect(await ensureRecruiter(RECRUITER, 'create-if-missing')).toBe('already-exists');
    expect(await ensureRecruiter({ ...RECRUITER, password: 'a-brand-new-password' }, 'create-or-reset')).toBe(
      'password-reset',
    );
    expect(await UserModel.countDocuments()).toBe(1);
  });
});

describe('login flow', () => {
  it('logs in, sees who is logged in, logs out, and is then locked out', async () => {
    const agent = request.agent(makeApp()); // an "agent" keeps cookies between requests, like a browser

    const login = await agent.post('/auth/login').send({ email: 'Recruiter@Example.com ', password: RECRUITER.password });
    expect(login.status).toBe(200);
    expect(login.body.user).toMatchObject({ email: RECRUITER.email, name: RECRUITER.name });
    expect(login.body.user.passwordHash).toBeUndefined();

    // The cookie must be invisible to page scripts and never sent by other sites.
    const cookie = String(login.headers['set-cookie']);
    expect(cookie).toMatch(/tp_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);

    const me = await agent.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(RECRUITER.email);

    expect((await agent.post('/auth/logout')).status).toBe(204);
    expect(await SessionModel.countDocuments()).toBe(0);
    expect((await agent.get('/auth/me')).status).toBe(401);
  });

  it('stores only a hash of the session token', async () => {
    const login = await request(makeApp()).post('/auth/login').send(RECRUITER);
    const token = /tp_session=([^;]+)/.exec(String(login.headers['set-cookie']))?.[1];
    const session = await SessionModel.findOne().lean();
    expect(token).toBeTruthy();
    expect(session?.tokenHash).not.toBe(token);
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const app = makeApp();
    const wrongPassword = await request(app).post('/auth/login').send({ email: RECRUITER.email, password: 'nope' });
    const unknownEmail = await request(app).post('/auth/login').send({ email: 'nobody@example.com', password: 'nope' });
    for (const res of [wrongPassword, unknownEmail]) {
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({ code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect' });
    }
  });

  it('rejects a badly formed login request', async () => {
    const res = await request(makeApp()).post('/auth/login').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a made-up session cookie', async () => {
    const res = await request(makeApp()).get('/auth/me').set('Cookie', 'tp_session=made-up');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('hands out the demo account only when demo login is on', async () => {
    const off = await request(makeApp()).get('/auth/demo');
    expect(off.status).toBe(404);

    const app = createApp({
      corsOrigins: ['http://localhost:5173'],
      auth: { cookieSecure: false, sessionTtlHours: 12, demoCredentials: { email: RECRUITER.email, password: RECRUITER.password } },
    });
    const on = await request(app).get('/auth/demo');
    expect(on.body).toEqual({ email: RECRUITER.email, password: RECRUITER.password });
    // ...and those credentials really work.
    expect((await request(app).post('/auth/login').send(on.body)).status).toBe(200);
  });

  it('blocks password guessing after too many failed attempts', async () => {
    const app = makeApp(3);
    for (let i = 0; i < 3; i++) {
      await request(app).post('/auth/login').send({ email: RECRUITER.email, password: `guess-${i}` });
    }
    const blocked = await request(app).post('/auth/login').send(RECRUITER);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_ATTEMPTS');
  });
});
