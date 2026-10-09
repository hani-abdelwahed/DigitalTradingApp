import type { Channel, ServerMessage } from '@dta/shared';
import { describe, expect, it } from 'vitest';
import { MarketHub } from '../src/market/hub.js';
import { MarketRegistry } from '../src/market/registry.js';
import { SimulatedProvider } from '../src/market/simulated.js';
import type { Listener } from '../src/market/types.js';

class CountingProvider extends SimulatedProvider {
  upstream = 0;
  override subscribe(channel: Channel, listener: Listener) {
    this.upstream++;
    const stop = super.subscribe(channel, listener);
    return () => {
      this.upstream--;
      stop();
    };
  }
}

function setup() {
  const sim = new CountingProvider({ autoTick: false, now: () => Date.UTC(2026, 0, 5, 15, 0, 0) });
  const hub = new MarketHub(new MarketRegistry([sim]), 0);
  const client = () => {
    const got: ServerMessage[] = [];
    return { got, send: (m: ServerMessage) => got.push(m) };
  };
  return { sim, hub, client };
}

describe('MarketHub', () => {
  it('shares one upstream subscription between clients and drops it after the last leaves', () => {
    const { sim, hub, client } = setup();
    const a = client();
    const b = client();
    expect(hub.subscribe(a, { kind: 'ticker', symbol: 'AAPL' })).toBe(true);
    hub.subscribe(b, { kind: 'ticker', symbol: 'AAPL' });
    expect(sim.upstream).toBe(1);

    hub.removeClient(a);
    expect(sim.upstream).toBe(1);
    hub.unsubscribe(b, 'ticker:AAPL');
    expect(sim.upstream).toBe(0);
    expect(hub.channelCount).toBe(0);
  });

  it('refuses unknown symbols', () => {
    const { hub, client } = setup();
    expect(hub.subscribe(client(), { kind: 'ticker', symbol: 'NOPE' })).toBe(false);
  });

  it('coalesces tickers to the latest per flush but forwards every trade', () => {
    const { sim, hub, client } = setup();
    const a = client();
    hub.subscribe(a, { kind: 'ticker', symbol: 'AAPL' });
    hub.subscribe(a, { kind: 'trades', symbol: 'AAPL' });
    sim.tick();
    sim.tick();
    sim.tick();
    expect(a.got.filter((m) => m.type === 'trade')).toHaveLength(3);
    expect(a.got.filter((m) => m.type === 'ticker')).toHaveLength(0);
    hub.flush();
    const tickers = a.got.filter((m) => m.type === 'ticker');
    const trades = a.got.filter((m) => m.type === 'trade');
    expect(tickers).toHaveLength(1);
    expect(tickers[0]!.type === 'ticker' && tickers[0]!.data.last).toBe(trades[2]!.type === 'trade' && trades[2]!.data.price);
  });

  it('sends the latest snapshot to a client that joins later', () => {
    const { sim, hub, client } = setup();
    hub.subscribe(client(), { kind: 'book', symbol: 'MSFT' });
    sim.tick();
    hub.flush();
    const late = client();
    hub.subscribe(late, { kind: 'book', symbol: 'MSFT' });
    expect(late.got).toHaveLength(1);
    expect(late.got[0]).toMatchObject({ type: 'book', channel: 'book:MSFT' });
  });

  it('does not lose the final update of a bar when the next bar starts before a flush', () => {
    let now = Date.UTC(2026, 0, 5, 15, 0, 30);
    const sim = new SimulatedProvider({ autoTick: false, now: () => now });
    const hub = new MarketHub(new MarketRegistry([sim]), 0);
    const got: ServerMessage[] = [];
    hub.subscribe({ send: (m) => got.push(m) }, { kind: 'candles', symbol: 'SPY', timeframe: '1m' });
    sim.tick();
    now += 60_000;
    sim.tick();
    hub.flush();
    expect(got.map((m) => m.type === 'candle' && m.data.time)).toEqual([
      Date.UTC(2026, 0, 5, 15, 0) / 1000,
      Date.UTC(2026, 0, 5, 15, 1) / 1000,
    ]);
  });
});
