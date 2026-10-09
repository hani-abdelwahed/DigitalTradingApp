import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import {
  MAX_CHANNELS_PER_CONNECTION,
  ORDERS_CHANNEL,
  channelKey,
  clientMessage,
  parseChannel,
  type Order,
  type ServerMessage,
} from '@dta/shared';
import { isApiKey } from '../auth/api-keys.js';
import type { AccessClaims } from '../auth/service.js';
import type { HubClient } from '../market/hub.js';

const AUTH_TIMEOUT_MS = 5_000;
const HEARTBEAT_MS = 30_000;
// Connections opened with an API key re-check it this often, so revoking a key ends its streams.
const API_KEY_RECHECK_MS = 60_000;
// Close clients that fall this far behind instead of buffering without limit.
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
// Token bucket for client messages: bursts of 20, refilling 5 per second.
const MSG_BURST = 20;
const MSG_PER_SECOND = 5;

export const CLOSE = {
  unauthorized: 4401,
  rateLimited: 4429,
  slowConsumer: 4408,
  sessionExpired: 4440,
} as const;

export default async function marketWsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/ws/market', { websocket: true }, (socket: WebSocket, req) => {
    let authenticated = false;
    let userId: string | null = null;
    let stopOrders: (() => void) | null = null;
    let expiryTimer: NodeJS.Timeout | null = null;
    let recheckTimer: NodeJS.Timeout | null = null;
    let tokens = MSG_BURST;
    let lastRefill = Date.now();
    let alive = true;
    const channels = new Set<string>();

    const send = (msg: ServerMessage) => {
      if (socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        socket.close(CLOSE.slowConsumer, 'Too slow to keep up');
        return;
      }
      socket.send(JSON.stringify(msg));
    };
    const client: HubClient = { send };
    const fail = (code: string, message: string) => send({ type: 'error', code, message });

    const authTimer = setTimeout(() => socket.close(CLOSE.unauthorized, 'Authentication required'), AUTH_TIMEOUT_MS);
    const heartbeat = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, HEARTBEAT_MS);
    socket.on('pong', () => (alive = true));

    socket.on('message', async (raw, isBinary) => {
      const now = Date.now();
      tokens = Math.min(MSG_BURST, tokens + ((now - lastRefill) / 1000) * MSG_PER_SECOND);
      lastRefill = now;
      if (tokens < 1) return socket.close(CLOSE.rateLimited, 'Too many messages');
      tokens -= 1;

      let parsed;
      try {
        parsed = isBinary ? null : clientMessage.safeParse(JSON.parse(raw.toString()));
      } catch {
        parsed = null;
      }
      if (!parsed?.success) return fail('bad_message', 'Message not understood');
      const msg = parsed.data;

      if (msg.type === 'ping') return send({ type: 'pong' });

      if (msg.type === 'auth') {
        try {
          if (isApiKey(msg.token)) {
            const { user, key } = await app.apiKeys.authenticate(msg.token);
            if (!key.scopes.includes('read')) throw new Error('missing read scope');
            if (userId && userId !== user.id) throw new Error('user changed');
            userId = user.id;
            authenticated = true;
            clearTimeout(authTimer);
            if (expiryTimer) clearTimeout(expiryTimer);
            expiryTimer = null;
            if (!recheckTimer) {
              const token = msg.token;
              recheckTimer = setInterval(() => {
                app.apiKeys.authenticate(token).catch(() => socket.close(CLOSE.sessionExpired, 'API key revoked or expired'));
              }, API_KEY_RECHECK_MS);
            }
            return send({ type: 'authenticated' });
          }
          const claims = app.jwt.verify<AccessClaims & { exp: number }>(msg.token);
          if (claims.typ !== 'access') throw new Error('wrong token type');
          const user = await app.auth.authenticate(claims);
          // A connection belongs to one user; a fresh token must be for the same account.
          if (userId && userId !== user.id) throw new Error('user changed');
          userId = user.id;
          authenticated = true;
          clearTimeout(authTimer);
          // The stream lives only as long as the token; clients send a fresh token to extend it.
          if (expiryTimer) clearTimeout(expiryTimer);
          expiryTimer = setTimeout(
            () => socket.close(CLOSE.sessionExpired, 'Token expired'),
            Math.max(0, claims.exp * 1000 - Date.now()),
          );
          return send({ type: 'authenticated' });
        } catch {
          return socket.close(CLOSE.unauthorized, 'Invalid token');
        }
      }

      if (!authenticated) return socket.close(CLOSE.unauthorized, 'Authentication required');

      if (msg.type === 'subscribe') {
        const added: string[] = [];
        for (const raw of msg.channels) {
          if (raw === ORDERS_CHANNEL) {
            if (!stopOrders) {
              const owner = userId!;
              const onOrder = (uid: string, order: Order) => {
                if (uid === owner) send({ type: 'order', channel: ORDERS_CHANNEL, data: order });
              };
              app.trading.on('order', onOrder);
              stopOrders = () => app.trading.off('order', onOrder);
              added.push(ORDERS_CHANNEL);
            }
            continue;
          }
          const channel = parseChannel(raw);
          if (!channel) {
            fail('bad_channel', `Unknown channel ${raw}`);
            continue;
          }
          const key = channelKey(channel);
          if (channels.has(key)) continue;
          if (channels.size >= MAX_CHANNELS_PER_CONNECTION) {
            fail('too_many_channels', `At most ${MAX_CHANNELS_PER_CONNECTION} channels per connection`);
            break;
          }
          if (!app.marketHub.subscribe(client, channel)) {
            fail('unknown_symbol', `Unknown symbol ${channel.symbol}`);
            continue;
          }
          channels.add(key);
          added.push(key);
        }
        if (added.length) send({ type: 'subscribed', channels: added });
        return;
      }

      // unsubscribe
      const removed: string[] = [];
      for (const raw of msg.channels) {
        if (raw === ORDERS_CHANNEL && stopOrders) {
          stopOrders();
          stopOrders = null;
          removed.push(ORDERS_CHANNEL);
          continue;
        }
        const channel = parseChannel(raw);
        const key = channel && channelKey(channel);
        if (key && channels.delete(key)) {
          app.marketHub.unsubscribe(client, key);
          removed.push(key);
        }
      }
      if (removed.length) send({ type: 'unsubscribed', channels: removed });
    });

    socket.on('close', () => {
      clearTimeout(authTimer);
      if (expiryTimer) clearTimeout(expiryTimer);
      if (recheckTimer) clearInterval(recheckTimer);
      clearInterval(heartbeat);
      stopOrders?.();
      app.marketHub.removeClient(client);
    });

    req.log.debug('Market stream connected');
  });
}
