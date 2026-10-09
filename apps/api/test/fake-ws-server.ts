import { WebSocketServer, type WebSocket } from 'ws';

/** A local WebSocket server standing in for an exchange's stream endpoint. */
export class FakeWsServer {
  readonly received: unknown[] = [];
  readonly sockets: WebSocket[] = [];
  private readonly wss: WebSocketServer;
  onConnect: (ws: WebSocket) => void = () => {};

  constructor() {
    this.wss = new WebSocketServer({ port: 0 });
    this.wss.on('connection', (ws) => {
      this.sockets.push(ws);
      ws.on('message', (raw) => this.received.push(JSON.parse(raw.toString())));
      this.onConnect(ws);
    });
  }

  get url(): string {
    const addr = this.wss.address();
    return `ws://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  }

  get latest(): WebSocket {
    return this.sockets[this.sockets.length - 1]!;
  }

  broadcast(msg: unknown): void {
    for (const s of this.sockets) if (s.readyState === s.OPEN) s.send(JSON.stringify(msg));
  }

  close(): Promise<void> {
    for (const s of this.sockets) s.terminate();
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }
}

export async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
