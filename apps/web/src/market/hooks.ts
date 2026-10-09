import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ServerMessage } from '@dta/shared';
import type { MarketSocket, SocketStatus } from './socket';

export const MarketSocketContext = createContext<MarketSocket | null>(null);

export function useMarketSocket(): MarketSocket {
  const s = useContext(MarketSocketContext);
  if (!s) throw new Error('MarketSocketContext missing');
  return s;
}

type DataMessage = Extract<ServerMessage, { channel: string }>;

/** Calls `handler` for every message on `channel` while mounted. */
export function useChannel(channel: string | null, handler: (msg: DataMessage) => void): void {
  const socket = useMarketSocket();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!channel) return;
    return socket.subscribe(channel, (m) => ref.current(m));
  }, [socket, channel]);
}

export function useSocketStatus(): SocketStatus {
  const socket = useMarketSocket();
  const [status, setStatus] = useState<SocketStatus>('connecting');
  useEffect(() => socket.onStatus(setStatus), [socket]);
  return status;
}
