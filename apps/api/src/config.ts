import { z } from 'zod';

const base64Key = z
  .string()
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  WEB_ORIGIN: z.url().default('http://localhost:5173'),
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  ENCRYPTION_KEY: base64Key,
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(15 * 60),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(30 * 24 * 60 * 60),
  // Only trust X-Forwarded-For when a reverse proxy sets it; otherwise clients could spoof
  // their IP and dodge per-IP rate limits.
  TRUST_PROXY: z.stringbool().default(false),
  // Market data. Binance public data needs no key; equities use Alpaca when keys are set,
  // and generated prices otherwise.
  BINANCE_ENABLED: z.stringbool().default(true),
  ALPACA_KEY_ID: z.string().min(1).optional(),
  ALPACA_SECRET_KEY: z.string().min(1).optional(),
  ALPACA_FEED: z.enum(['iex', 'sip']).default('iex'),
  // Built web app (apps/web/dist) to serve from this server, so the app and API share one
  // origin. Unset when the web app is hosted separately or run with Vite.
  WEB_DIST_DIR: z.string().min(1).optional(),
  // Pre-trade risk limits.
  /** Largest single order, in units of the quote currency (USD or USDT). */
  MAX_ORDER_NOTIONAL: z.coerce.number().positive().default(1_000_000),
  MAX_OPEN_ORDERS: z.coerce.number().int().positive().default(100),
  /** Limit orders priced this far through the market (buying above, selling below) are refused as likely typos. */
  PRICE_BAND_PERCENT: z.coerce.number().positive().default(10),
  // Volatility circuit breaker: a move of more than CIRCUIT_BREAKER_PERCENT within the window
  // pauses that symbol for CIRCUIT_BREAKER_HALT_SECONDS. 0 turns it off.
  CIRCUIT_BREAKER_PERCENT: z.coerce.number().min(0).default(10),
  CIRCUIT_BREAKER_WINDOW_SECONDS: z.coerce.number().int().positive().default(5 * 60),
  CIRCUIT_BREAKER_HALT_SECONDS: z.coerce.number().int().positive().default(5 * 60),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema
    .superRefine((c, ctx) => {
      if (c.NODE_ENV === 'production' && !c.WEB_ORIGIN.startsWith('https://')) {
        // The refresh cookie is marked Secure in production and would never be sent over http.
        ctx.addIssue({ code: 'custom', path: ['WEB_ORIGIN'], message: 'must be https in production' });
      }
    })
    .safeParse({
      // Hosting dashboards often save blank fields as empty strings; treat them as unset.
      ...Object.fromEntries(Object.entries(env).filter(([, v]) => v !== '')),
      // On Render, default the origin to the service's own public URL.
      WEB_ORIGIN: env.WEB_ORIGIN || env.RENDER_EXTERNAL_URL || undefined,
    });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
