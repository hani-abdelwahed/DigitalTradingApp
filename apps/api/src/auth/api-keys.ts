import { randomBytes } from 'node:crypto';
import { and, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { API_KEY_SCOPES, type ApiKey, type ApiKeyScope, type CreatedApiKey } from '@dta/shared';
import type { Db } from '../db/client.js';
import { apiKeys, users, type ApiKeyRow, type User } from '../db/schema.js';
import { randomToken, safeEqual, sha256 } from '../lib/crypto.js';
import { HttpError, conflict, forbidden, unauthorized } from '../lib/errors.js';
import type { AuthService, RequestContext } from './service.js';

export const API_KEY_PREFIX = 'dta_';
const KEY_PATTERN = /^dta_([0-9a-f]{12})_[A-Za-z0-9_-]{43}$/;
const MAX_ACTIVE_KEYS = 10;
const LAST_USED_RESOLUTION_MS = 60_000;

/** Who is making a request, and what they may do. */
export interface Principal {
  kind: 'session' | 'api_key';
  scopes: readonly ApiKeyScope[];
  apiKeyId: string | null;
}

export const SESSION_PRINCIPAL: Principal = { kind: 'session', scopes: API_KEY_SCOPES, apiKeyId: null };

export function isApiKey(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX);
}

function toApiKey(k: ApiKeyRow): ApiKey {
  return {
    id: k.id,
    name: k.name,
    prefix: `${API_KEY_PREFIX}${k.prefix}`,
    scopes: k.scopes,
    createdAt: k.createdAt.toISOString(),
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    expiresAt: k.expiresAt?.toISOString() ?? null,
  };
}

export class ApiKeyService {
  constructor(
    private readonly db: Db,
    private readonly auth: AuthService,
  ) {}

  async create(
    user: User,
    req: { name: string; scopes: ApiKeyScope[]; expiresInDays: number | null; password: string; code?: string | undefined },
    ctx: RequestContext,
  ): Promise<CreatedApiKey> {
    await this.auth.verifyStepUp(user, req.password, req.code, ctx);
    if (req.scopes.includes('trade') && !user.mfaEnabled) {
      throw forbidden('mfa_required', 'Turn on two-factor authentication before creating a key that can trade');
    }
    const active = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, user.id), this.activeCondition()));
    if ((active[0]?.n ?? 0) >= MAX_ACTIVE_KEYS) {
      throw conflict('too_many_keys', `You can have at most ${MAX_ACTIVE_KEYS} active keys. Revoke one first.`);
    }

    const prefix = randomBytes(6).toString('hex');
    const key = `${API_KEY_PREFIX}${prefix}_${randomToken(32)}`;
    const [row] = await this.db
      .insert(apiKeys)
      .values({
        userId: user.id,
        name: req.name,
        prefix,
        keyHash: sha256(key),
        scopes: req.scopes,
        expiresAt: req.expiresInDays ? new Date(Date.now() + req.expiresInDays * 86_400_000) : null,
      })
      .returning();
    await this.auth.audit('api_key_created', user.id, ctx, { apiKeyId: row!.id, scopes: req.scopes });
    return { ...toApiKey(row!), key };
  }

  async list(userId: string): Promise<ApiKey[]> {
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, userId), this.activeCondition()))
      .orderBy(desc(apiKeys.createdAt));
    return rows.map(toApiKey);
  }

  async revoke(userId: string, id: string, ctx: RequestContext): Promise<void> {
    const [row] = await this.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id });
    if (!row) throw new HttpError(404, 'not_found', 'Key not found');
    await this.auth.audit('api_key_revoked', userId, ctx, { apiKeyId: id });
  }

  /** Revokes every key a user has, for example when two-factor is turned off. */
  async revokeAll(userId: string): Promise<void> {
    await this.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)));
  }

  /** Resolves a presented key to its owner, rejecting malformed, unknown, revoked or expired keys. */
  async authenticate(key: string): Promise<{ user: User; key: ApiKeyRow }> {
    const prefix = KEY_PATTERN.exec(key)?.[1];
    if (!prefix) throw unauthorized('invalid_api_key', 'API key is not valid');
    const [row] = await this.db
      .select({ key: apiKeys, user: users })
      .from(apiKeys)
      .innerJoin(users, eq(users.id, apiKeys.userId))
      .where(eq(apiKeys.prefix, prefix));
    if (
      !row ||
      !safeEqual(sha256(key), row.key.keyHash) ||
      row.key.revokedAt ||
      (row.key.expiresAt && row.key.expiresAt <= new Date())
    ) {
      throw unauthorized('invalid_api_key', 'API key is not valid');
    }
    // Record use, at most once a minute per key.
    const now = new Date();
    if (!row.key.lastUsedAt || now.getTime() - row.key.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
      await this.db
        .update(apiKeys)
        .set({ lastUsedAt: now })
        .where(
          and(
            eq(apiKeys.id, row.key.id),
            or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, new Date(now.getTime() - LAST_USED_RESOLUTION_MS))),
          ),
        );
    }
    return row;
  }

  private activeCondition() {
    return and(isNull(apiKeys.revokedAt), or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())));
  }
}
