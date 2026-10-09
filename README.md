# DigitalTradingApp

A full-stack trading app for stocks/ETFs and crypto. So far: accounts with two-factor sign-in, and a trading screen with live charts, technical indicators, order book and recent trades. Order management and the ledger come next.

## Layout

| Path | What it is |
| --- | --- |
| `apps/api` | Node.js API (Fastify, Drizzle ORM, PostgreSQL, Redis) |
| `apps/web` | React web app (Vite) |
| `packages/shared` | Request/response contracts shared by both |

## Run it locally

You need Node.js 22 and pnpm (`corepack enable`). For the database and cache, either use free hosted tiers (Postgres on [Neon](https://neon.tech) or [Supabase](https://supabase.com), Redis on [Upstash](https://upstash.com)) or local servers.

```sh
pnpm install
cp apps/api/.env.example apps/api/.env   # then fill in the values
pnpm db:migrate
pnpm dev:api    # http://localhost:4000
pnpm dev:web    # http://localhost:5173
```

Generate `JWT_SECRET` and `ENCRYPTION_KEY` with:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Market data

| Market | Source | Account needed |
| --- | --- | --- |
| Crypto (BTC, ETH, SOL, BNB, XRP, DOGE vs USDT) | Binance public market data | No |
| US stocks and ETFs | Alpaca market data (IEX feed) | Free Alpaca account; set `ALPACA_KEY_ID` and `ALPACA_SECRET_KEY` |
| US stocks and ETFs, no Alpaca keys | Generated prices, labelled "Simulated prices" in the app | No |

The browser holds one WebSocket to `/ws/market`. It authenticates with the access token and subscribes to channels: `ticker:SYM`, `trades:SYM`, `book:SYM` and `candles:SYM:TF` (TF is one of `1m 5m 15m 1h 4h 1d`). The server opens one upstream subscription per channel however many users share it. It sends at most one ticker, book or live-candle update per channel every 100 ms, and every trade. Slow or abusive connections are closed. History comes from `GET /market/candles?symbol=&timeframe=&limit=`.

Binance blocks some regions, including the US, so check it is reachable where the API runs.

## Checks

```sh
pnpm typecheck
pnpm test       # needs Postgres and Redis; see apps/api/test/setup.ts for defaults
pnpm build
```

## Security model (sign-in)

- Passwords hashed with Argon2id; at least 12 characters.
- Access tokens are short-lived JWTs (15 minutes) kept in memory by the web app.
- Refresh tokens are random, stored only as SHA-256 hashes, sent as `httpOnly`, `SameSite=Strict` cookies, and rotated on every use. Reusing an old one ends every session for that account.
- TOTP two-factor authentication (any authenticator app). Secrets are encrypted at rest with AES-256-GCM, and each code works only once.
- Per-IP rate limits on credential endpoints, and a 15-minute lockout after 10 failed sign-ins for an account.
- Security events are recorded in `audit_log`.
