# Security review

Reviewed as of step 4 (safety for going live). This covers the API (`apps/api`), the web app (`apps/web`) and their dependencies. It records what protects the app, what this review changed, and what is still needed before handling real money.

## What protects the app

### Accounts and sessions
- Passwords: Argon2id, 12 to 128 characters (NIST SP 800-63B style), with a dummy hash on unknown emails so response time does not reveal which emails exist at sign-in.
- Access tokens: HS256 JWTs, 15 minutes, held only in memory by the web app. The algorithm is pinned on verification, and every request re-checks that the session is still live, so sign-out and revocation take effect at once.
- Refresh tokens: 256-bit random, stored as SHA-256, in an `httpOnly`, `SameSite=Strict` cookie scoped to `/auth` (`Secure` in production). Rotated on every use; reusing an old one revokes every session for the account.
- Two-factor: TOTP. Secrets are encrypted with AES-256-GCM, each code is accepted once (the last step is claimed atomically), and an MFA challenge allows 5 attempts.
- Lockout: 10 failed sign-ins for an email in 15 minutes locks it for the rest of the window.
- Audit log: registrations, sign-ins, failures, two-factor changes, refresh-token reuse, API key changes, step-up failures and operator halts.

### API keys
- Format `dta_<12 hex prefix>_<256-bit secret>`. Only the SHA-256 of the whole key is stored; the comparison is constant-time.
- Scopes: `read` and `trade`. Keys are refused on every sign-in, two-factor and key-management endpoint, so a leaked key cannot take over the account or mint more keys.
- Creating a key needs the password again, plus a two-factor code when it is on. Keys that can trade need two-factor on; turning it off revokes all keys.
- Keys expire (30, 90 or 365 days by default, or never), can be revoked at once, and record when they were last used. WebSocket streams opened with a key re-check it every minute, so a revoked key's streams close.
- Orders record which key placed them.

### Trading
- Every order is validated twice: by the shared zod schema (decimal strings, no floats) and by the instrument's tick and lot size.
- Pre-trade limits: maximum order size, maximum open orders (enforced under a per-user lock so concurrent requests cannot exceed it), and a price band on limit orders.
- Slippage protection on everything that fills at the market price. Buy holds reserve the worst accepted price, so a fill can never overspend.
- Volatility circuit breaker per symbol, and an operator kill switch per symbol or global.
- The ledger is enforced by the database: balanced transactions, no negative user balances, balances equal to the sum of entries, append-only entries.
- Fills and cancels lock the order row, so each order settles exactly once.
- Idempotent placement with `clientOrderId`.

### Transport and abuse
- Helmet security headers (including HSTS) and CORS limited to the web app's origin with credentials.
- Request bodies limited to 64 KB; WebSocket messages to 4 KB, a token bucket of 5 a second, at most a fixed number of channels, a 5-second auth deadline, and slow consumers are closed.
- Rate limits in Redis, shared by all instances: 300 a minute per IP, 10 a minute per IP on credential endpoints, and 60 order placements or cancels a minute per account.
- Logs redact `Authorization`, `X-API-Key`, cookies and `Set-Cookie`.
- Fail closed: if Redis is unreachable, rate-limited requests and order placement fail instead of skipping their checks.

## Changes made in this review

| Finding | Risk | Fix |
| --- | --- | --- |
| `trustProxy` was on whenever `NODE_ENV=production` | Without a proxy in front, anyone could set `X-Forwarded-For` to dodge per-IP rate limits and lockouts | New `TRUST_PROXY` setting, off by default |
| `WEB_ORIGIN` could be `http://` in production | The `Secure` refresh cookie would never be sent, or a deployment would quietly run without TLS | Startup refuses a non-https origin in production |
| Order rate limit was per IP | Users behind one address shared a budget; one user could spread across addresses | 60 a minute per account, checked after authentication |
| Buy holds used fixed buffers (2% and 5%) | A fill beyond the buffer had to be rejected for lack of funds, unexplained | Holds now match the slippage limit, and the limit's rejection says why |
| Stops filled at any price | A gap or crash filled stops far below the trigger | Slippage protection and the volatility circuit breaker |
| No way to stop trading in an incident | | Kill switch (`pnpm --filter @dta/api halt`) |
| No pre-trade size limits | A typo could create a huge order | Order size cap, open-order cap, price band |
| Repeated failures upstream piled up behind 10-second timeouts | Slow responses and wasted connections during an exchange outage | Circuit breaker on market data REST calls |
| `esbuild` advisory GHSA-67mh-4wv8-2f99 via `drizzle-kit` (dev only) | A web page could read responses from esbuild's dev server | Override to esbuild 0.25; `pnpm audit` is clean |
| `X-API-Key` header would have been logged | Keys in logs | Added to log redaction |

## Accepted for the demo

- **Registration reveals whether an email is registered** (409). It is rate-limited per IP. Fix before launch by always replying "check your email" and sending a sign-in link instead.
- **Lockout is per email**, so someone can lock a user out for 15 minutes by guessing wrong passwords. Common trade-off; consider CAPTCHA after a few failures instead of a hard lock.
- **One HS256 secret** signs all JWTs and has no rotation. Fine for one service; move to asymmetric keys (EdDSA) with key IDs if other services need to verify tokens.
- **The audit log is not tamper-proof.** Ship it to append-only storage (a log service or object storage with retention lock) in production.
- **The circuit breaker only watches symbols with open orders or recent order activity**, so the first order after a quiet period has no price history to compare against.

## Before real money

These need accounts, providers or decisions from the owner.

1. **Broker and exchange routing.** Real orders go through a regulated broker (Alpaca for US stocks; an exchange such as Coinbase or Kraken for crypto, depending on your region). The broker's own pre-trade checks apply on top of ours. Partial fills, rejects and reconciliation against the broker's records need handling.
2. **Regulation and compliance.** Identity checks (KYC/AML), terms, risk disclosures, and record keeping. Who is the broker of record decides most of this; it is a legal question, not a code one.
3. **Secrets management.** Load `JWT_SECRET`, `ENCRYPTION_KEY` and broker keys from a secrets manager, never from files, and plan rotation. Broker API keys stored for users must be encrypted the way two-factor secrets are.
4. **Infrastructure.** TLS everywhere (including to Postgres and Redis), private networking for the database, backups with tested restores, and monitoring with alerts on circuit-breaker trips, reconciliation problems and error rates.
5. **Independent penetration test** before launch, and a dependency audit in CI (`pnpm audit --audit-level=high`).
6. **Account recovery.** Password reset and two-factor recovery codes, both of which need email sending.
7. **Content Security Policy for the web app**, set by whatever serves the built files: `default-src 'self'; connect-src 'self' wss://<api host>; img-src 'self' data:; frame-ancestors 'none'`.
