import { mockEmailAuth, registerVerified, changeVerifiedPassword, changeVerifiedEmail } from './support/email-auth-fixture';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';
import { DatabaseService } from '../src/database/database.service';
import { AuthService } from '../src/auth/auth.service';
import { ResetDeliveryService } from '../src/auth/reset-delivery.service';
import { environment } from '../src/config/env';
import { deleteFixtureUsers } from './support/delete-fixture-users';

describe.skipIf(process.env.RUN_DB_TESTS !== '1')('real PostgreSQL auth and role regression', () => {
  const db = new DatabaseService();
  const owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
  let auth: AuthService;
  const email = `ci+${randomUUID()}@example.com`;
  const password = randomBytes(24).toString('hex');
  let userId: string;
  let session: Awaited<ReturnType<AuthService['response']>>;

  beforeAll(async () => {
    auth = mockEmailAuth(db);
    session = await registerVerified(auth,{acceptedTerms:true,acceptedPrivacy:true, email, password, displayName: 'Isolated CI account', workspaceType: 'household' }, { userAgent: 'HomeMind CI' });
    userId = session.user.id;
  });
  afterAll(async () => {
    if (userId) {
      const memberships = await owner.workspaceMember.findMany({ where: { userId }, select: { workspaceId: true } });
      await deleteFixtureUsers(owner,[userId],memberships.map(m => m.workspaceId));
    }
    await Promise.all([owner.$disconnect(), db.$disconnect()]);
  });
  it('runtime cannot bypass RLS, own business tables, or change schema', async () => {
    const flags = await db.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`select rolsuper,rolbypassrls from pg_roles where rolname=current_user`;
    expect(flags[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const owned = await db.$queryRaw<Array<{ count: bigint }>>`select count(*) from pg_class where relowner=(select oid from pg_roles where rolname=current_user) and relnamespace='public'::regnamespace`;
    expect(Number(owned[0].count)).toBe(0);
    await expect(db.$executeRawUnsafe('create table public.ci_must_not_exist(id int)')).rejects.toThrow();
  });
  it('register/login and an access token preserve application identity', async () => {
    expect((await auth.authenticate(session.accessToken)).userId).toBe(userId);
    const login = await auth.login(email, password, { userAgent: 'HomeMind CI login' });
    expect((await auth.authenticate(login.accessToken)).userId).toBe(userId);
    await expect(auth.login(email, randomBytes(12).toString('hex'), {})).rejects.toThrow();
    await auth.logout(login.refreshToken);
    await expect(auth.authenticate(login.accessToken)).rejects.toThrow();
  });
  it('rotation/replay commits family revocation', async () => {
    const old = await auth.login(email, password, {});
    const fresh = await auth.refresh(old.refreshToken, {});
    expect(fresh.refreshToken !== old.refreshToken).toBe(true);
    await expect(auth.refresh(old.refreshToken, {})).rejects.toThrow();
    await expect(auth.authenticate(fresh.accessToken)).rejects.toThrow();
    await expect(auth.refresh(fresh.refreshToken, {})).rejects.toThrow();
  });
  it('rejects expired, wrong-audience and wrong-signature tokens', async () => {
    const config = environment();
    const identity = await auth.authenticate(session.accessToken);
    for (const kind of ['expired', 'audience', 'signature']) {
      const token = await new SignJWT({ typ: 'access', sid: identity.sessionId }).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuedAt()
        .setIssuer(config.issuer).setAudience(kind === 'audience' ? 'wrong-audience' : config.audience)
        .setExpirationTime(kind === 'expired' ? '0s' : '5m')
        .sign(new TextEncoder().encode(kind === 'signature' ? randomBytes(32).toString('hex') : config.accessSecret));
      await expect(auth.authenticate(token)).rejects.toThrow();
    }
  });
  it('password change invalidates existing sessions and old credentials', async () => {
    const next = randomBytes(24).toString('hex');
    const changed = await changeVerifiedPassword(auth,userId,email,password,next);
    await expect(auth.authenticate(session.accessToken)).rejects.toThrow();
    await expect(auth.login(email, password, {})).rejects.toThrow();
    expect((await auth.authenticate(changed.accessToken)).userId).toBe(userId);
    await auth.logout(changed.refreshToken);
  });
});
