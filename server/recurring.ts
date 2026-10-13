import { db } from './db.js';

// Port of the Google Apps Script recurring-transaction detector, with fixes:
// - results replace previous auto-detected rows (no endless appending)
// - the `active` flag of an existing row with the same description is preserved
// - transfers are excluded (a recurring internal transfer isn't a bill)

interface Pattern {
  description: string;
  amount: number;
  currency: string;
  account: string;
  category: string | null;
  dates: string[];
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

  const patterns = new Map<string, Pattern>();
  for (const t of txs) {
    if (!t.date || !t.description || !t.amount) continue;
    const normDesc = t.description
      .toLowerCase()
      .trim()
      .replace(/\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}/g, '')
      .replace(/ref[\s:#]*\w+/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    const amountKey = Math.round(Math.abs(t.amount) / 10) * 10;
    const key = `${normDesc}|${amountKey}|${t.currency}`;
    let p = patterns.get(key);
    if (!p) {
      p = { description: t.description, amount: t.amount, currency: t.currency, account: t.account, category: t.category, dates: [] };
      patterns.set(key, p);
    }
    p.dates.push(t.date);
  }

  const recurring: {
    description: string; amount: number; currency: string; account: string;
    category: string | null; frequency: string; lastSeen: string; nextExpected: string; occurrences: number;
  }[] = [];

  for (const p of patterns.values()) {
    if (p.dates.length < 2) continue;
    p.dates.sort();
    const intervals: number[] = [];
    for (let j = 1; j < p.dates.length; j++) intervals.push(daysBetween(p.dates[j - 1], p.dates[j]));
    const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;

    let frequency: string | null = null;
    if (avg >= 5 && avg <= 10) frequency = 'Weekly';
    else if (avg >= 12 && avg <= 17) frequency = 'Bi-Weekly';
    else if (avg >= 25 && avg <= 35) frequency = 'Monthly';
    else if (avg >= 80 && avg <= 100) frequency = 'Quarterly';
    else if (avg >= 340 && avg <= 400) frequency = 'Annually';
    if (!frequency) continue;

    const variance = intervals.reduce((s, v) => s + (v - avg) ** 2, 0) / intervals.length;
    if (Math.sqrt(variance) > avg * 0.3 && p.dates.length < 4) continue;

    const lastSeen = p.dates[p.dates.length - 1];
    recurring.push({
      description: p.description,
      amount: p.amount,
      currency: p.currency,
      account: p.account,
      category: p.category,
      frequency,
      lastSeen,
      nextExpected: addInterval(lastSeen, frequency),
      occurrences: p.dates.length,
    });
  }

  recurring.sort((a, b) => b.occurrences - a.occurrences);

  // Upsert keyed on lowercased description, preserving the active flag.
  const existing = db.prepare('SELECT id, description, active FROM recurring').all() as { id: number; description: string; active: number }[];
  const existingByDesc = new Map(existing.map((r) => [r.description.toLowerCase().trim(), r]));
  const seen = new Set<number>();
  const insert = db.prepare(
    `INSERT INTO recurring (description, amount, currency, account, category, frequency, last_seen, next_expected, active, occurrences)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );
  const update = db.prepare(
    `UPDATE recurring SET amount=?, currency=?, account=?, category=?, frequency=?, last_seen=?, next_expected=?, occurrences=? WHERE id=?`
  );

  const applyAll = db.transaction(() => {
    for (const r of recurring) {
      const prev = existingByDesc.get(r.description.toLowerCase().trim());
      if (prev) {
        update.run(r.amount, r.currency, r.account, r.category, r.frequency, r.lastSeen, r.nextExpected, r.occurrences, prev.id);
        seen.add(prev.id);
      } else {
        insert.run(r.description, r.amount, r.currency, r.account, r.category, r.frequency, r.lastSeen, r.nextExpected, 1, r.occurrences);
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
