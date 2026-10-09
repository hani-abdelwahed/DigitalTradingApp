import type { Instrument, Venue } from '@dta/shared';

const EQUITIES: [symbol: string, name: string][] = [
  ['AAPL', 'Apple'],
  ['MSFT', 'Microsoft'],
  ['NVDA', 'NVIDIA'],
  ['AMZN', 'Amazon'],
  ['TSLA', 'Tesla'],
  ['SPY', 'SPDR S&P 500 ETF'],
  ['QQQ', 'Invesco QQQ ETF'],
];

export function equityInstruments(venue: Venue): Instrument[] {
  return EQUITIES.map(([symbol, name]) => ({
    symbol,
    name,
    assetClass: 'equity',
    venue,
    base: symbol,
    quote: 'USD',
    pricePrecision: 2,
    sizePrecision: 0,
  }));
}
