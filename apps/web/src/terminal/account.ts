import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ORDERS_CHANNEL, type Fill, type Order, type Portfolio } from '@dta/shared';
import { api } from '../api';
import { useChannel } from '../market/hooks';

export interface Account {
  portfolio: Portfolio | null;
  orders: Order[];
  fills: Fill[];
  refresh: () => void;
}

export const AccountContext = createContext<Account | null>(null);

export function useAccount(): Account {
  const a = useContext(AccountContext);
  if (!a) throw new Error('AccountContext missing');
  return a;
}

/** Loads the portfolio, orders and fills, and reloads them whenever an order changes. */
export function useAccountState(): Account {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [fills, setFills] = useState<Fill[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    void Promise.all([api.portfolio(), api.orders(), api.fills()])
      .then(([p, o, f]) => {
        setPortfolio(p);
        setOrders(o);
        setFills(f);
      })
      .catch(() => undefined);
  }, []);

  // Several updates often arrive together (placed, then filled), so reload once after a short pause.
  const refresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(load, 150);
  }, [load]);

  useEffect(() => {
    load();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  useChannel(ORDERS_CHANNEL, (msg) => {
    if (msg.type !== 'order') return;
    // Show the change at once, then reload balances and fills.
    setOrders((list) => {
      const i = list.findIndex((o) => o.id === msg.data.id);
      return i === -1 ? [msg.data, ...list] : list.map((o) => (o.id === msg.data.id ? msg.data : o));
    });
    refresh();
  });

  return { portfolio, orders, fills, refresh };
}
