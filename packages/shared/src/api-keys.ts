import { z } from 'zod';
import { totpCodeSchema } from './auth.js';

/**
 * What an API key may do. `read` covers market data, balances, orders and fills; `trade`
 * places and cancels orders. Keys can never manage sign-in, two-factor or other keys.
 */
export const API_KEY_SCOPES = ['read', 'trade'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const createApiKeyRequest = z.object({
  name: z.string().trim().min(1, 'Give the key a name').max(64),
  // Trading needs to see its own orders, so `trade` always comes with `read`.
  scopes: z
    .array(z.enum(API_KEY_SCOPES))
    .min(1, 'Pick at least one permission')
    .transform((s) => API_KEY_SCOPES.filter((x) => s.includes(x) || (x === 'read' && s.includes('trade')))),
  /** Days until the key stops working; null for no expiry. */
  expiresInDays: z.number().int().min(1).max(365).nullable().default(90),
  /** Creating a key is a sensitive action, so it asks for the password again... */
  password: z.string().min(1).max(128),
  /** ...and a two-factor code when two-factor is on. */
  code: totpCodeSchema.optional(),
});
export type CreateApiKeyRequest = z.input<typeof createApiKeyRequest>;

export interface ApiKey {
  id: string;
  name: string;
  /** The non-secret start of the key, shown so you can tell keys apart. */
  prefix: string;
  scopes: ApiKeyScope[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

/** Returned once, at creation. The full key is never shown again. */
export interface CreatedApiKey extends ApiKey {
  key: string;
}
