import { db } from './db.js';

// Daily mid-market rates from frankfurter (ECB data, no API key).
// Mirrors the Google Apps Script behaviour: rate is looked up for the
// transaction date; weekends/holidays resolve to the latest prior business day.

const getCached = db.prepare('SELECT rate FROM fx_rates WHERE date=? AND base=? AND quote=?');
const putCached = db.prepare('INSERT OR REPLACE INTO fx_rates (date, base, quote, rate) VALUES (?,?,?,?)');

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function getRate(from: string, to: string, date: string): Promise<number | null> {
  from = from.toUpperCase();
  to = to.toUpperCase();
  if (from === to) return 1;
  const today = todayStr();
  const d = !date || date > today ? today : date;

  const cached = getCached.get(d, from, to) as { rate: number } | undefined;
  if (cached) return cached.rate;

  const endpoints = [
    `https://api.frankfurter.dev/v1/${d >= today ? 'latest' : d}?base=${from}&symbols=${to}`,
    `https://api.frankfurter.app/${d >= today ? 'latest' : d}?from=${from}&to=${to}`,
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const data: any = await res.json();
      const rate = data?.rates?.[to];
      if (typeof rate === 'number' && rate > 0) {
        putCached.run(d, from, to, rate);
        return rate;
      }
    } catch {
      // try next endpoint
    }
  }
  return null;
}

// Best-effort rate when the network is unavailable: newest cached rate,
// then the newest rate recorded on a transaction in that currency.
export function latestKnownRate(from: string, to: string): number | null {
  from = from.toUpperCase();
  to = to.toUpperCase();
  if (from === to) return 1;
  const row = db
    .prepare('SELECT rate FROM fx_rates WHERE base=? AND quote=? ORDER BY date DESC LIMIT 1')
    .get(from, to) as { rate: number } | undefined;
  if (row) return row.rate;
  if (to === 'CZK') {
    const tx = db
      .prepare('SELECT fx_rate FROM transactions WHERE currency=? AND fx_rate IS NOT NULL ORDER BY date DESC LIMIT 1')
      .get(from) as { fx_rate: number } | undefined;
    if (tx) return tx.fx_rate;
  }
  return null;
}

export async function getRateWithFallback(from: string, to: string, date: string): Promise<number | null> {
  const live = await getRate(from, to, date);
  if (live !== null) return live;
  return latestKnownRate(from, to);
}
