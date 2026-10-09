import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { PublicUser } from '@dta/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { auditLog, sessions, users, type User } from '../db/schema.js';
import { randomToken, sha256, type SecretBox } from '../lib/crypto.js';
import { badRequest, conflict, tooManyRequests, unauthorized } from '../lib/errors.js';
import { dummyPasswordHash, hashPassword, verifyPassword } from './passwords.js';
import { generateSecret, otpauthUrl, verifyTotp } from './totp.js';

export const MFA_ISSUER = 'DigitalTradingApp';
const MAX_FAILED_LOGINS = 10;
const FAILED_LOGIN_WINDOW_SECONDS = 15 * 60;
const MFA_TOKEN_TTL_SECONDS = 5 * 60;
const MAX_MFA_ATTEMPTS = 5;

export interface RequestContext {
  ip: string;
  userAgent?: string | undefined;
}

export interface AccessClaims {
  sub: string;
  sid: string;
  typ: 'access';
}

export interface MfaClaims {
  sub: string;
  jti: string;
  typ: 'mfa';
}

export interface TokenSigner {
  sign(payload: AccessClaims | MfaClaims, expiresInSeconds: number): string;
}

export interface IssuedTokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
  user: PublicUser;
}

export type LoginResult = ({ status: 'ok' } & IssuedTokens) | { status: 'mfa_required'; mfaToken: string };

export function toPublicUser(u: User): PublicUser {
  return { id: u.id, email: u.email, mfaEnabled: u.mfaEnabled, createdAt: u.createdAt.toISOString() };
}

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly redis: Redis,
    private readonly config: Config,
    private readonly box: SecretBox,
    private readonly signer: TokenSigner,
  ) {}

  async register(email: string, password: string, ctx: RequestContext): Promise<IssuedTokens> {
    const passwordHash = await hashPassword(password);
    const [user] = await this.db
      .insert(users)
      .values({ email, passwordHash })
      .onConflictDoNothing()
      .returning();
    if (!user) throw conflict('email_taken', 'An account with this email already exists');
    await this.audit('user_registered', user.id, ctx);
    return this.createSession(user, ctx);
  }

  async login(email: string, password: string, ctx: RequestContext): Promise<LoginResult> {
    const failKey = `auth:login_fail:${sha256(email)}`;
    const failures = Number((await this.redis.get(failKey)) ?? 0);
    if (failures >= MAX_FAILED_LOGINS) {
      await this.audit('login_locked', null, ctx, { email });
      throw tooManyRequests('Too many failed sign-in attempts. Try again in 15 minutes.');
    }

    const user = await this.findByEmail(email);
    const ok = user
      ? await verifyPassword(user.passwordHash, password)
      : (await verifyPassword(await dummyPasswordHash(), password), false);

    if (!user || !ok) {
      await this.redis.multi().incr(failKey).expire(failKey, FAILED_LOGIN_WINDOW_SECONDS).exec();
      await this.audit('login_failed', user?.id ?? null, ctx, { email });
      throw unauthorized('invalid_credentials', 'Email or password is incorrect');
    }

    await this.redis.del(failKey);

    if (user.mfaEnabled) {
      const jti = randomToken(16);
      const mfaToken = this.signer.sign({ sub: user.id, jti, typ: 'mfa' }, MFA_TOKEN_TTL_SECONDS);
      await this.audit('login_mfa_challenge', user.id, ctx);
      return { status: 'mfa_required', mfaToken };
    }

    await this.audit('login_succeeded', user.id, ctx);
    return { status: 'ok', ...(await this.createSession(user, ctx)) };
  }

  async completeMfaLogin(claims: MfaClaims, code: string, ctx: RequestContext): Promise<IssuedTokens> {
    const attemptsKey = `auth:mfa_attempts:${claims.jti}`;
    const attempts = await this.redis.incr(attemptsKey);
    if (attempts === 1) await this.redis.expire(attemptsKey, MFA_TOKEN_TTL_SECONDS);
    if (attempts > MAX_MFA_ATTEMPTS) throw tooManyRequests('Too many incorrect codes. Sign in again.');

    const user = await this.findById(claims.sub);
    if (!user || !user.mfaEnabled || !user.mfaSecretEnc) throw unauthorized();

    await this.consumeTotp(user, code, ctx);
    // An MFA challenge can only be completed once.
    await this.redis.set(attemptsKey, String(MAX_MFA_ATTEMPTS + 1), 'EX', MFA_TOKEN_TTL_SECONDS);
    await this.audit('login_succeeded', user.id, ctx, { mfa: true });
    return this.createSession(user, ctx);
  }

  async refresh(refreshToken: string, ctx: RequestContext): Promise<IssuedTokens> {
    const hash = sha256(refreshToken);
    const [session] = await this.db.select().from(sessions).where(eq(sessions.refreshTokenHash, hash));
    if (!session) throw unauthorized('invalid_session', 'Session expired, sign in again');

    if (session.revokedAt) {
      // A rotated-out token was presented again: assume it was stolen and end every session.
      await this.revokeAllSessions(session.userId);
      await this.audit('refresh_token_reuse', session.userId, ctx, { sessionId: session.id });
      throw unauthorized('invalid_session', 'Session expired, sign in again');
    }
    if (session.expiresAt <= new Date()) throw unauthorized('invalid_session', 'Session expired, sign in again');

    // Revoke conditionally so two concurrent refreshes with the same token cannot both succeed.
    const revoked = await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.id, session.id), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    if (revoked.length === 0) throw unauthorized('invalid_session', 'Session expired, sign in again');

    const user = await this.findById(session.userId);
    if (!user) throw unauthorized();
    return this.createSession(user, ctx);
  }

  async logout(refreshToken: string, ctx: RequestContext): Promise<void> {
    const [session] = await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.refreshTokenHash, sha256(refreshToken)), isNull(sessions.revokedAt)))
      .returning({ userId: sessions.userId });
    if (session) await this.audit('logout', session.userId, ctx);
  }

  /** Resolves the user behind a verified access token, rejecting revoked or expired sessions. */
  async authenticate(claims: AccessClaims): Promise<User> {
    const [row] = await this.db
      .select({ user: users, revokedAt: sessions.revokedAt, expiresAt: sessions.expiresAt })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.id, claims.sid), eq(sessions.userId, claims.sub)));
    if (!row || row.revokedAt || row.expiresAt <= new Date()) throw unauthorized();
    return row.user;
  }

  async beginMfaSetup(user: User, ctx: RequestContext): Promise<{ secret: string; otpauthUrl: string }> {
    if (user.mfaEnabled) throw conflict('mfa_already_enabled', 'Two-factor authentication is already on');
    const secret = generateSecret();
    await this.db
      .update(users)
      .set({ mfaSecretEnc: this.box.encrypt(secret), updatedAt: new Date() })
      .where(eq(users.id, user.id));
    await this.audit('mfa_setup_started', user.id, ctx);
    return { secret, otpauthUrl: otpauthUrl(secret, user.email, MFA_ISSUER) };
  }

  async enableMfa(user: User, code: string, ctx: RequestContext): Promise<User> {
    if (user.mfaEnabled) throw conflict('mfa_already_enabled', 'Two-factor authentication is already on');
    if (!user.mfaSecretEnc) throw conflict('mfa_not_started', 'Start two-factor setup first');
    await this.consumeTotp(user, code, ctx);
    const [updated] = await this.db
      .update(users)
      .set({ mfaEnabled: true, updatedAt: new Date() })
      .where(eq(users.id, user.id))
      .returning();
    await this.audit('mfa_enabled', user.id, ctx);
    return updated!;
  }

  async disableMfa(user: User, code: string, password: string, ctx: RequestContext): Promise<User> {
    if (!user.mfaEnabled) throw conflict('mfa_not_enabled', 'Two-factor authentication is off');
    if (!(await verifyPassword(user.passwordHash, password))) {
      await this.audit('mfa_disable_failed', user.id, ctx);
      throw unauthorized('invalid_credentials', 'Password is incorrect');
    }
    await this.consumeTotp(user, code, ctx);
    const [updated] = await this.db
      .update(users)
      .set({ mfaEnabled: false, mfaSecretEnc: null, mfaLastStep: null, updatedAt: new Date() })
      .where(eq(users.id, user.id))
      .returning();
    await this.audit('mfa_disabled', user.id, ctx);
    return updated!;
  }

  /**
   * Re-checks the password, and the two-factor code when two-factor is on, before a sensitive
   * action such as creating an API key.
   */
  async verifyStepUp(user: User, password: string, code: string | undefined, ctx: RequestContext): Promise<void> {
    if (!(await verifyPassword(user.passwordHash, password))) {
      await this.audit('step_up_failed', user.id, ctx);
      throw unauthorized('invalid_credentials', 'Password is incorrect');
    }
    if (user.mfaEnabled) {
      if (!code) throw badRequest('mfa_code_required', 'Enter the code from your authenticator app');
      await this.consumeTotp(user, code, ctx);
    }
  }

  private async consumeTotp(user: User, code: string, ctx: RequestContext): Promise<void> {
    const secret = this.box.decrypt(user.mfaSecretEnc!);
    const step = verifyTotp(secret, code, { afterStep: user.mfaLastStep });
    // Record the step atomically so the same code cannot be used twice, even concurrently.
    const claimed =
      step !== null &&
      (
        await this.db
          .update(users)
          .set({ mfaLastStep: step })
          .where(and(eq(users.id, user.id), or(isNull(users.mfaLastStep), lt(users.mfaLastStep, step))))
          .returning({ id: users.id })
      ).length === 1;
    if (!claimed) {
      await this.audit('mfa_code_rejected', user.id, ctx);
      throw unauthorized('invalid_mfa_code', 'That code is not valid');
    }
  }

  private async createSession(user: User, ctx: RequestContext): Promise<IssuedTokens> {
    const refreshToken = randomToken(32);
    const refreshExpiresAt = new Date(Date.now() + this.config.REFRESH_TOKEN_TTL_SECONDS * 1000);
    const [session] = await this.db
      .insert(sessions)
      .values({
        userId: user.id,
        refreshTokenHash: sha256(refreshToken),
        userAgent: ctx.userAgent?.slice(0, 512),
        ip: ctx.ip,
        expiresAt: refreshExpiresAt,
      })
      .returning({ id: sessions.id });
    const expiresIn = this.config.ACCESS_TOKEN_TTL_SECONDS;
    const accessToken = this.signer.sign({ sub: user.id, sid: session!.id, typ: 'access' }, expiresIn);
    return { accessToken, expiresIn, refreshToken, refreshExpiresAt, user: toPublicUser(user) };
  }

  private async revokeAllSessions(userId: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  }

  private async findByEmail(email: string): Promise<User | undefined> {
    const [user] = await this.db.select().from(users).where(sql`lower(${users.email}) = ${email.toLowerCase()}`);
    return user;
  }

  private async findById(id: string): Promise<User | undefined> {
    const [user] = await this.db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async audit(
    event: string,
    userId: string | null,
    ctx: RequestContext,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.db.insert(auditLog).values({
      event,
      userId,
      ip: ctx.ip,
      userAgent: ctx.userAgent?.slice(0, 512),
      metadata: metadata ?? null,
    });
  }
}
