import type { ServerMessage } from '@dta/shared';
import { getAccessToken, onAccessToken, refreshSession } from '../api';

type DataMessage = Extract<ServerMessage, { channel: string }>;
type Listener = (msg: DataMessage) => void;
export type SocketStatus = 'connecting' | 'live' | 'reconnecting';

/**
 * One shared connection to /ws/market. Components subscribe to channels; the socket keeps
 * one server subscription per channel, re-authenticates when the access token is renewed,
 * and reconnects with backoff, restoring every subscription.
 */
export class MarketSocket {
  private ws: WebSocket | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly statusListeners = new Set<(s: SocketStatus) => void>();
  private status: SocketStatus = 'connecting';
  private authenticated = false;
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly offToken: () => void;

  constructor(private readonly url: string) {
    this.offToken = onAccessToken((token) => {
      if (token && this.ws?.readyState === WebSocket.OPEN) this.send({ type: 'auth', token });
    });
    this.connect();
  }

  subscribe(channel: string, listener: Listener): () => void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      if (this.authenticated) this.send({ type: 'subscribe', channels: [channel] });
    }
    set.add(listener);
    return () => {
      const s = this.listeners.get(channel);
      if (!s?.delete(listener) || s.size > 0) return;
      this.listeners.delete(channel);
      if (this.authenticated) this.send({ type: 'unsubscribe', channels: [channel] });
    };
  }

  onStatus(listener: (s: SocketStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  close(): void {
    this.stopped = true;
    this.offToken();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
  }

  private setStatus(s: SocketStatus): void {
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = async () => {
      const token = getAccessToken() ?? (await refreshSession())?.accessToken;
      if (!token) return ws.close();
      this.send({ type: 'auth', token });
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as ServerMessage;
      if (msg.type === 'authenticated') {
        if (!this.authenticated) {
          this.authenticated = true;
          this.attempts = 0;
          const channels = [...this.listeners.keys()];
          for (let i = 0; i < channels.length; i += 50) this.send({ type: 'subscribe', channels: channels.slice(i, i + 50) });
        }
        this.setStatus('live');
        return;
      }
      if ('channel' in msg) for (const l of this.listeners.get(msg.channel) ?? []) l(msg);
    };
    ws.onclose = (ev) => {
      this.ws = null;
      this.authenticated = false;
      if (this.stopped) return;
      this.setStatus('reconnecting');
      // 4401/4440: token rejected or expired, so get a fresh one before reconnecting.
      if (ev.code === 4401 || ev.code === 4440) void refreshSession();
      const delay = Math.min(30_000, 500 * 2 ** this.attempts++) * (0.5 + Math.random() / 2);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
  }
}
