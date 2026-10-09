type WebSocketCtor = new (url: string) => WebSocket;

export interface ReconnectingSocketOptions {
  url: string;
  onOpen(socket: ReconnectingSocket): void;
  onMessage(data: unknown): void;
  onError?(err: unknown): void;
  WebSocketImpl?: WebSocketCtor;
  minDelayMs?: number;
  maxDelayMs?: number;
}

/** A WebSocket client that reconnects with exponential backoff and jitter. */
export class ReconnectingSocket {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly WS: WebSocketCtor;

  constructor(private readonly opts: ReconnectingSocketOptions) {
    this.WS = opts.WebSocketImpl ?? (globalThis.WebSocket as WebSocketCtor);
  }

  get isOpen(): boolean {
    return this.ws?.readyState === 1;
  }

  connect(): void {
    if (this.closed || this.ws) return;
    const ws = new this.WS(this.opts.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.opts.onOpen(this);
    };
    ws.onmessage = (ev) => {
      let data: unknown;
      try {
        data = JSON.parse(String(ev.data));
      } catch (err) {
        this.opts.onError?.(err);
        return;
      }
      this.opts.onMessage(data);
    };
    ws.onerror = (ev) => this.opts.onError?.(ev);
    ws.onclose = () => {
      this.ws = null;
      this.scheduleReconnect();
    };
  }

  send(message: unknown): boolean {
    if (!this.isOpen) return false;
    this.ws!.send(JSON.stringify(message));
    return true;
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const min = this.opts.minDelayMs ?? 1000;
    const max = this.opts.maxDelayMs ?? 30_000;
    const delay = Math.min(max, min * 2 ** this.attempts++) * (0.5 + Math.random() / 2);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }
}
