import { db } from './db.js';

// Port of the Google Apps Script recurring-transaction detector, with fixes:
// - results replace previous auto-detected rows (no endless appending)
// - the `active` flag of an existing row with the same description is preserved
// - transfers are excluded (a recurring internal transfer isn't a bill)
// - a price change continues the same item instead of starting a new one (#3487)

interface Pattern {
  description: string;
  amount: number;
  currency: string;
  account: string;
  category: string | null;
  dates: string[];
  amounts: number[];
}

// One item over time: the amount-based patterns that follow each other without overlapping.
interface Chain {
  parts: Pattern[];
}

export function normaliseDescription(description: string): string {
  return description
    .toLowerCase()
    .trim()
    .replace(/\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}/g, '')
    .replace(/ref[\s:#]*\w+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function frequencyOf(avg: number): string | null {
  if (avg >= 5 && avg <= 10) return 'Weekly';
  if (avg >= 12 && avg <= 17) return 'Bi-Weekly';
  if (avg >= 25 && avg <= 35) return 'Monthly';
  if (avg >= 80 && avg <= 100) return 'Quarterly';
  if (avg >= 340 && avg <= 400) return 'Annually';
  return null;
}

function meanInterval(dates: string[]): number | null {
  if (dates.length < 2) return null;
  return daysBetween(dates[0], dates[dates.length - 1]) / (dates.length - 1);
}

// Joins patterns with the same description and currency when the next one starts about one interval
// after the previous one ends: that is a price change. Patterns that run at the same time stay
// separate (two products from one merchant).
function chainPatterns(patterns: Pattern[]): Chain[] {
  const sorted = [...patterns].sort((a, b) => a.dates[0].localeCompare(b.dates[0]));
  const chains: Chain[] = [];
  for (const p of sorted) {
    const next = chains.find((c) => {
      const last = c.parts[c.parts.length - 1];
      const end = last.dates[last.dates.length - 1];
      const gap = daysBetween(end, p.dates[0]);
      const interval = meanInterval(c.parts.flatMap((x) => x.dates)) ?? meanInterval(p.dates);
      if (interval == null || !frequencyOf(interval)) return false;
      return gap >= interval * 0.5 && gap <= interval * 1.5;
    });
    if (next) next.parts.push(p);
    else chains.push({ parts: [p] });
  }
  return chains;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

function addInterval(date: string, frequency: string): string {
  const d = new Date(date + 'T00:00:00Z');
  switch (frequency) {
    case 'Weekly': d.setUTCDate(d.getUTCDate() + 7); break;
    case 'Bi-Weekly': d.setUTCDate(d.getUTCDate() + 14); break;
    case 'Monthly': d.setUTCMonth(d.getUTCMonth() + 1); break;
    case 'Quarterly': d.setUTCMonth(d.getUTCMonth() + 3); break;
    case 'Annually': d.setUTCFullYear(d.getUTCFullYear() + 1); break;
  }
  return d.toISOString().slice(0, 10);
}

export function detectRecurring() {
  const txs = db
    .prepare(
      `SELECT date, description, account, category, amount, currency
       FROM transactions WHERE type != 'Transfer' ORDER BY date`
    )
    .all() as { date: string; description: string; account: string; category: string | null; amount: number; currency: string }[];

  // Transactions are in date order, so each pattern's dates and amounts are too.
  const patterns = new Map<string, Pattern>();
  for (const t of txs) {
    if (!t.date || !t.description || !t.amount) continue;
    const normDesc = normaliseDescription(t.description);
    const amountKey = Math.round(Math.abs(t.amount) / 10) * 10;
    const key = `${normDesc}|${amountKey}|${t.currency}`;
    let p = patterns.get(key);
    if (!p) {
      p = { description: t.description, amount: t.amount, currency: t.currency, account: t.account, category: t.category, dates: [], amounts: [] };
      patterns.set(key, p);
    }
    p.dates.push(t.date);
    p.amounts.push(t.amount);
    p.category = t.category ?? p.category;
  }

  const groups = new Map<string, Pattern[]>();
  for (const [key, p] of patterns) {
    const [normDesc, , currency] = key.split('|');
    const g = groups.get(`${normDesc}|${currency}`) ?? [];
    g.push(p);
    groups.set(`${normDesc}|${currency}`, g);
  }

  const recurring: {
    description: string; amount: number; currency: string; account: string;
    category: string | null; frequency: string; lastSeen: string; nextExpected: string; occurrences: number;
    previousAmount: number | null; priceChangedOn: string | null;
  }[] = [];

  for (const chain of [...groups.values()].flatMap(chainPatterns)) {
    const dates = chain.parts.flatMap((p) => p.dates).sort();
    if (dates.length < 2) continue;
    const intervals: number[] = [];
    for (let j = 1; j < dates.length; j++) intervals.push(daysBetween(dates[j - 1], dates[j]));
    const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;

    const frequency = frequencyOf(avg);
    if (!frequency) continue;

    const variance = intervals.reduce((s, v) => s + (v - avg) ** 2, 0) / intervals.length;
    if (Math.sqrt(variance) > avg * 0.3 && dates.length < 4) continue;

    const first = chain.parts[0];
    const latest = chain.parts[chain.parts.length - 1];
    const before = chain.parts.length > 1 ? chain.parts[chain.parts.length - 2] : null;
    const lastSeen = dates[dates.length - 1];
    recurring.push({
      description: first.description,
      amount: latest.amounts[latest.amounts.length - 1],
      currency: latest.currency,
      account: latest.account,
      category: latest.category,
      frequency,
      lastSeen,
      nextExpected: addInterval(lastSeen, frequency),
      occurrences: dates.length,
      previousAmount: before ? before.amounts[before.amounts.length - 1] : null,
      priceChangedOn: before ? latest.dates[0] : null,
    });
  }

  recurring.sort((a, b) => b.occurrences - a.occurrences);

  // Upsert keyed on lowercased description, preserving the active flag. One merchant can have two
  // items (two products): those match the existing row with the nearest amount.
  const existing = db.prepare('SELECT id, description, amount, active FROM recurring').all() as { id: number; description: string; amount: number | null; active: number }[];
  const seen = new Set<number>();
  const findExisting = (r: (typeof recurring)[number]) => {
    const desc = r.description.toLowerCase().trim();
    const candidates = existing.filter((e) => !seen.has(e.id) && e.description.toLowerCase().trim() === desc);
    const distance = (e: (typeof existing)[number]) =>
      Math.min(...[r.amount, r.previousAmount].filter((a): a is number => a != null).map((a) => Math.abs((e.amount ?? 0) - a)));
    return candidates.sort((a, b) => distance(a) - distance(b))[0];
  };
  const insert = db.prepare(
    `INSERT INTO recurring (description, amount, currency, account, category, frequency, last_seen, next_expected, active, occurrences, previous_amount, price_changed_on)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const update = db.prepare(
    `UPDATE recurring SET amount=?, currency=?, account=?, category=?, frequency=?, last_seen=?, next_expected=?, occurrences=?, previous_amount=?, price_changed_on=? WHERE id=?`
  );

  const applyAll = db.transaction(() => {
    for (const r of recurring) {
      const prev = findExisting(r);
      if (prev) {
        update.run(r.amount, r.currency, r.account, r.category, r.frequency, r.lastSeen, r.nextExpected, r.occurrences, r.previousAmount, r.priceChangedOn, prev.id);
        seen.add(prev.id);
      } else {
        insert.run(r.description, r.amount, r.currency, r.account, r.category, r.frequency, r.lastSeen, r.nextExpected, 1, r.occurrences, r.previousAmount, r.priceChangedOn);
      }
    }
    // Flag matching transactions
    db.prepare('UPDATE transactions SET recurring = 0').run();
    const mark = db.prepare('UPDATE transactions SET recurring = 1 WHERE lower(trim(description)) = ?');
    for (const r of recurring) mark.run(r.description.toLowerCase().trim());
  });
  applyAll();

  return { patternsAnalyzed: patterns.size, found: recurring.length, updated: seen.size, added: recurring.length - seen.size };
}
